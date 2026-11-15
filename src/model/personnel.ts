/**
 * Offensive personnel. Estimated every week from snap counts (method in PERSONNEL, config.ts); exact for a season once
 * FTN's participation data for it is on nflverse (credited, CC BY-SA 4.0), or from the optional PERSONNEL_SOURCE slot.
 */
import { PERSONNEL, PERSONNEL_SOURCE, type PersonnelConfig, type PersonnelSourceConfig } from './config.ts';
import { round } from './stats.ts';
import type {
  ExactGrouping, ExactTeam, Game, Participation, Personnel, PersonnelCounts, PersonnelEstimate, PersonnelExact, PersonnelTeam, PlayEpa, SnapRow,
} from './types.ts';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Rates from average players on the field per snap (the method in PERSONNEL). */
export function estimateRates(rb: number, te: number, wr: number, cfg: PersonnelConfig = PERSONNEL): { p11: number; p12: number; heavy: number } {
  const twoTe = clamp01(te - 1);
  const twoRb = clamp01(rb - 1);
  const fourWr = clamp01(wr - 3);
  const heavy = clamp01(cfg.heavyScale * (twoTe + twoRb));
  return { p11: clamp01(1 - heavy - fourWr), p12: clamp01(cfg.twoTeScale * twoTe), heavy };
}

interface Tally { snaps: number; RB: number; TE: number; WR: number }

function toEstimate(x: Tally, cfg: PersonnelConfig): PersonnelEstimate {
  const avg = (n: number): number => (x.snaps > 0 ? n / x.snaps : 0);
  const r = estimateRates(avg(x.RB), avg(x.TE), avg(x.WR), cfg);
  return {
    snaps: x.snaps, rb: round(avg(x.RB), 3), te: round(avg(x.TE), 3), wr: round(avg(x.WR), 3),
    p11: round(r.p11, 3), p12: round(r.p12, 3), heavy: round(r.heavy, 3),
  };
}

/** Per team: one estimate per game and one for the season to date (from season-to-date averages). */
export function personnelEstimate(snaps: SnapRow[], games: Game[], cfg: PersonnelConfig = PERSONNEL): Record<string, PersonnelTeam> {
  const sched = new Map(games.map((g) => [g.id, g]));
  // a team's offense snaps in a game = the most any one of its players played (the QB and line play nearly all)
  const tally = new Map<string, Tally>();
  for (const s of snaps) {
    const k = `${s.t}|${s.g}`;
    const x = tally.get(k) ?? { snaps: 0, RB: 0, TE: 0, WR: 0 };
    tally.set(k, x);
    x.snaps = Math.max(x.snaps, s.off);
    const grp = s.pos ? cfg.positions[s.pos] : undefined;
    if (grp) x[grp] += s.off;
  }
  const out: Record<string, PersonnelTeam> = {};
  const season = new Map<string, Tally>();
  for (const [k, x] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [team, gid] = k.split('|') as [string, string];
    const g = sched.get(gid);
    if (!g || x.snaps <= 0) continue;
    const t = (out[team] ??= { season: toEstimate({ snaps: 0, RB: 0, TE: 0, WR: 0 }, cfg), weeks: [] });
    t.weeks.push({ ...toEstimate(x, cfg), wk: g.week, opp: g.home === team ? g.away : g.home });
    const s = season.get(team) ?? { snaps: 0, RB: 0, TE: 0, WR: 0 };
    season.set(team, { snaps: s.snaps + x.snaps, RB: s.RB + x.RB, TE: s.TE + x.TE, WR: s.WR + x.WR });
  }
  for (const [team, t] of Object.entries(out)) {
    t.season = toEstimate(season.get(team) as Tally, cfg);
    t.weeks.sort((a, b) => a.wk - b.wk);
  }
  return out;
}

const isHeavy = (code: string): boolean => code.length === 2 && (Number(code[0]) >= 2 || Number(code[1]) >= 2);

/** Rates and EPA per grouping from per-play groupings; plays are counted only if they join play-by-play (a pass or run). */
export function exactPersonnel(season: number, part: Participation, plays: PlayEpa, credit: string, cfg: PersonnelConfig = PERSONNEL): PersonnelExact | null {
  const byTeam = new Map<string, Map<string, { n: number; epa: number }>>();
  const league = new Map<string, { n: number; epa: number }>();
  for (const [game, rows] of Object.entries(part)) {
    const epa = new Map((plays[game] ?? []).map(([id, e]) => [id, e]));
    for (const [id, team, code] of rows) {
      const e = epa.get(id);
      if (e === undefined) continue;
      if (!byTeam.has(team)) byTeam.set(team, new Map());
      for (const m of [byTeam.get(team) as Map<string, { n: number; epa: number }>, league]) {
        const x = m.get(code) ?? { n: 0, epa: 0 };
        x.n++;
        x.epa += e;
        m.set(code, x);
      }
    }
  }
  if (!league.size) return null;
  const summarize = (m: Map<string, { n: number; epa: number }>): ExactTeam => {
    const total = [...m.values()].reduce((s, x) => s + x.n, 0);
    const listed: ExactGrouping[] = [];
    const other = { n: 0, epa: 0 };
    let heavy = 0;
    for (const [code, x] of m) {
      if (isHeavy(code)) heavy += x.n;
      if (cfg.groupings.includes(code)) listed.push({ code, plays: x.n, rate: round(x.n / total, 3), epa: round(x.epa / x.n, 3) });
      else {
        other.n += x.n;
        other.epa += x.epa;
      }
    }
    listed.sort((a, b) => b.plays - a.plays || a.code.localeCompare(b.code));
    if (other.n) listed.push({ code: 'other', plays: other.n, rate: round(other.n / total, 3), epa: round(other.epa / other.n, 3) });
    return {
      plays: total,
      p11: round((m.get('11')?.n ?? 0) / total, 3),
      p12: round((m.get('12')?.n ?? 0) / total, 3),
      heavy: round(heavy / total, 3),
      groupings: listed,
    };
  };
  const teams: PersonnelExact['teams'] = {};
  for (const [t, m] of [...byTeam].sort((a, b) => a[0].localeCompare(b[0]))) teams[t] = summarize(m);
  return { season, credit, league: summarize(league).groupings, teams };
}

/** The optional exact source: rates per team per week and season (no EPA: the slot's format has none). */
export function slotPersonnel(season: number, counts: PersonnelCounts, src: PersonnelSourceConfig): PersonnelExact | null {
  const teams: PersonnelExact['teams'] = {};
  const league = new Map<string, number>();
  const rates = (m: Map<string, number>): Omit<ExactTeam, 'groupings'> & { groupings: ExactGrouping[] } => {
    const total = [...m.values()].reduce((s, n) => s + n, 0) || 1;
    const heavy = [...m].filter(([c]) => isHeavy(c)).reduce((s, [, n]) => s + n, 0);
    return {
      plays: total, p11: round((m.get('11') ?? 0) / total, 3), p12: round((m.get('12') ?? 0) / total, 3), heavy: round(heavy / total, 3),
      groupings: [...m].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, plays: n, rate: round(n / total, 3), epa: null })),
    };
  };
  for (const [team, weeks] of Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))) {
    const all = new Map<string, number>();
    const wk: (Omit<ExactTeam, 'groupings'> & { wk: number })[] = [];
    for (const [w, g] of Object.entries(weeks)) {
      const m = new Map(Object.entries(g).filter(([, n]) => Number.isFinite(n) && n > 0));
      for (const [c, n] of m) {
        all.set(c, (all.get(c) ?? 0) + n);
        league.set(c, (league.get(c) ?? 0) + n);
      }
      if (m.size) {
        const { groupings: _, ...r } = rates(m);
        wk.push({ ...r, wk: Number(w) });
      }
    }
    if (all.size) teams[team] = { ...rates(all), weeks: wk.sort((a, b) => a.wk - b.wk) };
  }
  if (!Object.keys(teams).length) return null;
  return { season, credit: `${src.label} (${src.license})`, league: rates(league).groupings, teams };
}

/** Refuse an enabled exact-personnel slot whose terms don't let us republish it. */
export function assertPersonnelAllowed(src: PersonnelSourceConfig = PERSONNEL_SOURCE): void {
  if (src.enabled && !src.republishAllowed) {
    throw new Error(`PERSONNEL_SOURCE "${src.label}" is enabled but republishAllowed is false: only data we may republish can go on the public page`);
  }
}

export function buildPersonnel(
  inp: { season: number; games: Game[]; snaps: SnapRow[]; plays?: PlayEpa; prevPlays?: PlayEpa; participation?: Participation; prevParticipation?: Participation; personnelCounts?: PersonnelCounts },
  src: PersonnelSourceConfig = PERSONNEL_SOURCE,
  cfg: PersonnelConfig = PERSONNEL,
): Personnel {
  assertPersonnelAllowed(src);
  return {
    method: cfg.label,
    estimate: personnelEstimate(inp.snaps, inp.games, cfg),
    exactCurrent: inp.participation && inp.plays ? exactPersonnel(inp.season, inp.participation, inp.plays, cfg.ftnCredit, cfg) : null,
    exactPrev: inp.prevParticipation && inp.prevPlays ? exactPersonnel(inp.season - 1, inp.prevParticipation, inp.prevPlays, cfg.ftnCredit, cfg) : null,
    slot: src.enabled && inp.personnelCounts ? slotPersonnel(inp.season, inp.personnelCounts, src) : null,
  };
}
