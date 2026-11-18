/**
 * Players side by side: production (score, rank and each stat's real value with its percentile), season totals from
 * the game log, contract and value. Any mix of positions; a row a player has no number for shows "-". The best number
 * in a row is marked when at least two players have one and the row means the same thing for each (a rank only within
 * one position). Offensive linemen have no player page or score, so they can't be picked.
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

  // production
  rows.push(row(S.production, 'Production score', r.map((p) => (p ? Math.round(p.scores.production) : null)), (v) => String(v)));
  const oneGroup = r.every((p) => p) && new Set(r.map((p) => p?.group)).size === 1;
  rows.push(row(S.production, 'Position rank', r.map((p) => p?.rank ?? null), (v, i) => `#${v} of ${r[i]?.qualifiedAtPosition} ${r[i]?.group}`, { lowerIsBetter: true, compare: oneGroup }));
  rows.push({ section: S.production, label: 'Volume', cells: r.map((p) => (p ? { text: p.volume, best: false } : DASH)) });
  const keys: StatKey[] = [];
  for (const p of r) for (const s of p?.stats ?? []) if (!keys.includes(s.key)) keys.push(s.key);
  for (const k of keys) {
    const d = STATS[k];
    const stat = r.map((p) => p?.stats.find((s) => s.key === k));
    // the real value is shown; the best is the highest percentile (already flipped for lower-is-better stats)
    const byPct = row(S.production, d.label, stat.map((s) => (s ? s.pct : null)), () => '');
    rows.push({
      section: S.production,
      label: d.label,
      cells: stat.map((s, i) => (s ? { text: `${s.value.toFixed(d.decimals)}${d.suffix ?? ''}`, sub: `${ordinal(Math.round(s.pct))} pct`, best: byPct.cells[i]?.best ?? false } : DASH)),
    });
  }

  // season totals from the game log, matched across positions by column title ("Receiving yards", ...)
  rows.push(row(S.season, 'Games', pr.map((p) => (p ? p.log.length : null)), (v) => String(v), { compare: false }));
  const cols: { title: string; label: string; decimals: number }[] = [];
  for (const p of pr) for (const c of p ? GAME_LOG.columns[p.kind] : []) if (!cols.some((t) => t.title === c.title)) cols.push({ title: c.title, label: c.label, decimals: c.decimals });
  const totals = pr.map((p) => (p ? logTotals(p.log, GAME_LOG.columns[p.kind].map((c) => c.decimals)) : null));
  for (const t of cols) {
    const vals = pr.map((p, i) => {
      const k = p ? GAME_LOG.columns[p.kind].findIndex((c) => c.title === t.title) : -1;
      return k >= 0 ? (totals[i]?.[k] ?? 0) : null;
    });
    rows.push(row(S.season, t.title, vals, (v) => v.toFixed(t.decimals), { lowerIsBetter: cfg.lowerIsBetterTotals.includes(t.title), title: t.label }));
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
  rows.push(row(S.value, 'Fantasy points per game', f.map((x) => x?.perGame ?? null), (x) => x.toFixed(1)));
  rows.push(row(S.value, 'Fantasy points per $1M', f.map((x) => x?.perMillion ?? null), (x) => x.toFixed(1)));

  // leave out rows nobody has a number for
  return { players, rows: rows.filter((x) => x.cells.some((cell) => cell.text !== '-')) };
}
