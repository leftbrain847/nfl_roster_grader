/**
 * Players side by side: production score and rank; a box score from the game log by section (COMPARE.boxScore:
 * passing, rushing, receiving, defense, with rates and per-game figures; only the sections and rows that apply to the
 * players picked); the advanced stats behind the score (real value, percentile underneath); contract; value. Any mix
 * of positions; a row a player has no number for shows "-". The best number in a row is marked when at least two
 * players have one and the row means the same thing for each (a rank only within one position, costs never).
 * Offensive linemen have no player page or score, so they can't be picked.
 */
import { COMPARE, GAME_LOG, STATS, type CompareConfig, type StatKey } from './config.ts';
import { logTotals } from './profiles.ts';
import { ordinal, round } from './stats.ts';
import type { ModelOutput, PlayerProfile, PlayerResult } from './types.ts';

export interface CompareCell {
  text: string;
  /** Small second line, e.g. a stat's percentile. */
  sub?: string;
  best: boolean;
}

export interface CompareRow {
  section: string;
  label: string;
  /** Short column label, for a tooltip. */
  title?: string;
  cells: CompareCell[];
}

export interface ComparePlayer {
  id: string;
  name: string;
  team: string;
  pos: string;
}

export interface Comparison {
  players: ComparePlayer[];
  rows: CompareRow[];
}

type CompareData = Pick<ModelOutput, 'season' | 'players' | 'profiles' | 'value'>;

/** Can this player be compared (a player page or a production score)? */
export const comparable = (out: Pick<ModelOutput, 'players' | 'profiles'>, id: string): boolean =>
  out.players.some((p) => p.id === id) || out.profiles.some((p) => p.id === id);

const DASH: CompareCell = { text: '-', best: false };
const money = (m: number, d = 1): string => `$${m.toFixed(d)}M`;
const signedMoney = (m: number): string => `${m >= 0 ? '+' : '-'}$${Math.abs(m).toFixed(1)}M`;

interface RowOpts {
  lowerIsBetter?: boolean;
  /** false: never mark a best (costs, or ranks across positions). */
  compare?: boolean;
  title?: string;
}

/** One row: format each number, and mark the best of those present (ties all marked) when two or more have one. */
function row(section: string, label: string, values: (number | null)[], fmt: (v: number, i: number) => string, opts: RowOpts = {}): CompareRow {
  const have = values.filter((v): v is number => v !== null);
  const best = have.length >= 2 && opts.compare !== false ? (opts.lowerIsBetter ? Math.min(...have) : Math.max(...have)) : null;
  return {
    section,
    label,
    ...(opts.title ? { title: opts.title } : {}),
    cells: values.map((v, i) => (v === null ? DASH : { text: fmt(v, i), best: best !== null && v === best })),
  };
}

export function buildComparison(ids: string[], out: CompareData, cfg: CompareConfig = COMPARE): Comparison {
  const ranked = new Map(out.players.map((p) => [p.id, p]));
  const profiles = new Map(out.profiles.map((p) => [p.id, p]));
  const values = new Map(out.value.players.map((p) => [p.id, p]));
  const fantasy = new Map(out.value.fantasy.map((p) => [p.id, p]));
  const picked = [...new Set(ids)].filter((id) => ranked.has(id) || profiles.has(id)).slice(0, cfg.max);
  const r: (PlayerResult | undefined)[] = picked.map((id) => ranked.get(id));
  const pr: (PlayerProfile | undefined)[] = picked.map((id) => profiles.get(id));
  const players = picked.map((id, i) => ({
    id, name: pr[i]?.name ?? r[i]?.name ?? id, team: pr[i]?.team ?? r[i]?.team ?? '', pos: pr[i]?.pos ?? r[i]?.depth ?? '',
  }));
  const S = cfg.sections;
  const rows: CompareRow[] = [];

  // production: the score and where it ranks
  rows.push(row(S.production, 'Production score', r.map((p) => (p ? Math.round(p.scores.production) : null)), (v) => String(v)));
  const oneGroup = r.every((p) => p) && new Set(r.map((p) => p?.group)).size === 1;
  rows.push(row(S.production, 'Position rank', r.map((p) => p?.rank ?? null), (v, i) => `#${v} of ${r[i]?.qualifiedAtPosition} ${r[i]?.group}`, { lowerIsBetter: true, compare: oneGroup }));

  // box score: season totals from the game log (found by column title, so positions line up) and rates of them
  const totals = pr.map((p) => {
    if (!p) return null;
    const cols = GAME_LOG.columns[p.kind];
    const sums = logTotals(p.log, cols.map((c) => c.decimals));
    const m = new Map<string, number>(cols.map((c, k) => [c.title, sums[k] ?? 0]));
    m.set('Games', p.log.length);
    return m;
  });
  const games = pr.map((p) => p?.log.length ?? 0);
  for (const block of cfg.boxScore) {
    for (const s of block.rows) {
      const vals = totals.map((t) => {
        if (!t) return null;
        if (s.ratio) {
          const num = t.get(s.ratio.num);
          const den = t.get(s.ratio.den);
          return num === undefined || !den ? null : round((s.ratio.scale * num) / den, s.ratio.decimals);
        }
        const title = s.titles?.find((x) => t.has(x));
        return title === undefined ? null : (t.get(title) as number);
      });
      // only rows that apply to the players picked: a number other than zero for at least one of them
      if (!vals.some((v) => v !== null && v !== 0)) continue;
      const decimals = s.ratio?.decimals ?? (vals.some((v) => v !== null && !Number.isInteger(v)) ? 1 : 0);
      const built = row(block.section, s.label, vals, (v) => `${v.toFixed(decimals)}${s.ratio?.suffix ?? ''}`, { lowerIsBetter: s.lowerIsBetter, compare: !s.noBest });
      if (s.perGame) built.cells = built.cells.map((cell, i) => (vals[i] === null || vals[i] === 0 || !games[i] ? cell : { ...cell, sub: `${((vals[i] as number) / (games[i] as number)).toFixed(1)} a game` }));
      rows.push(built);
    }
  }

  // advanced: each stat's real value, with its percentile at the position underneath
  rows.push({ section: S.advanced, label: 'Volume', cells: r.map((p) => (p ? { text: p.volume, best: false } : DASH)) });
  const keys: StatKey[] = [];
  for (const p of r) for (const s of p?.stats ?? []) if (!keys.includes(s.key)) keys.push(s.key);
  for (const k of keys) {
    const d = STATS[k];
    const stat = r.map((p) => p?.stats.find((s) => s.key === k));
    // the best is the highest percentile (already flipped for lower-is-better stats)
    const byPct = row(S.advanced, d.label, stat.map((s) => (s ? s.pct : null)), () => '');
    rows.push({
      section: S.advanced,
      label: d.label,
      cells: stat.map((s, i) => (s ? { text: `${s.value.toFixed(d.decimals)}${d.suffix ?? ''}`, sub: `${ordinal(Math.round(s.pct))} pct`, best: byPct.cells[i]?.best ?? false } : DASH)),
    });
  }

  // contract: a cost isn't good or bad on its own, so nothing is marked
  const c = pr.map((p) => p?.contract ?? null);
  rows.push(row(S.contract, `Cap hit ${out.season}`, c.map((x) => x?.seasons.find((s) => s.year === out.season)?.cap ?? null), (v) => money(v, 2), { compare: false }));
  rows.push(row(S.contract, 'Per year (APY)', c.map((x) => x?.apyMillions ?? null), (v) => money(v), { compare: false }));
  rows.push(row(S.contract, 'Guaranteed', c.map((x) => x?.guaranteedMillions ?? null), (v) => money(v), { compare: false }));
  rows.push(row(S.contract, 'Signed through', c.map((x) => x?.lastYear ?? null), (v) => String(v), { compare: false }));
  rows.push(row(S.contract, 'Base salary left', c.map((x) => x?.baseSalaryLeftMillions ?? null), (v) => money(v, 2), { compare: false }));

  // value
  const v = picked.map((id) => values.get(id));
  const f = picked.map((id) => fantasy.get(id));
  rows.push(row(S.value, 'Production worth', v.map((x) => x?.worthMillions ?? null), (x) => money(x), { compare: false }));
  rows.push(row(S.value, 'Surplus (worth - cap hit)', v.map((x) => (x ? round(x.surplus, 1) : null)), (x) => signedMoney(x)));
  rows.push(row(S.value, 'Fantasy points per $1M', f.map((x) => x?.perMillion ?? null), (x) => x.toFixed(1)));

  // leave out rows nobody has a number for
  return { players, rows: rows.filter((x) => x.cells.some((cell) => cell.text !== '-')) };
}
