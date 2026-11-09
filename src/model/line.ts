/**
 * Offensive line, graded as a unit. Open data has no per-lineman production stat, so the line is graded at team
 * level from what it allows:
 * - pass protection: QB pressures (PFR) per dropback (play-by-play), counting only team-games PFR covers;
 * - run blocking: rushing yards before contact per carry (PFR), all ball carriers.
 * Both also reflect the QB (holding the ball) and the backs and scheme, and the page says so.
 * Line targets are starters on the best such lines among selling teams: a team grade, not an individual one.
 */
import { GRADE, LINE, LINE_KEYS, LINE_TARGETS, type LineKey, type LineTargetConfig } from './config.ts';
import { mean, normalCdf, ranks, round, sd } from './stats.ts';
import type { LineResult, LineTarget, ModelInputs, PlayerContract } from './types.ts';

export interface LineRaw {
  passPro: Record<string, number>;
  runBlock: Record<string, number>;
  /** Yards after contact per carry by team: the backs' half of the run game, for the rush-offense need split. */
  rbYac: Record<string, number>;
}

export function lineRaw(inp: ModelInputs): LineRaw {
  const covered = new Set(inp.pfrPass.map((r) => `${r.t}|${r.g}`));
  const pressured: Record<string, number> = {};
  for (const r of inp.pfrPass) pressured[r.t] = (pressured[r.t] ?? 0) + r.pressured;
  const dropbacks: Record<string, number> = {};
  for (const r of inp.playerGames) if (r.db && covered.has(`${r.t}|${r.g}`)) dropbacks[r.t] = (dropbacks[r.t] ?? 0) + r.db;
  const passPro: Record<string, number> = {};
  for (const [t, db] of Object.entries(dropbacks)) if (db > 0) passPro[t] = (100 * (pressured[t] ?? 0)) / db;

  const carries: Record<string, number> = {};
  const ybc: Record<string, number> = {};
  const yac: Record<string, number> = {};
  for (const r of inp.pfrRush) {
    carries[r.t] = (carries[r.t] ?? 0) + r.carries;
    ybc[r.t] = (ybc[r.t] ?? 0) + r.ybc;
    yac[r.t] = (yac[r.t] ?? 0) + r.yac;
  }
  const runBlock: Record<string, number> = {};
  const rbYac: Record<string, number> = {};
  for (const [t, n] of Object.entries(carries)) {
    if (n <= 0) continue;
    runBlock[t] = (ybc[t] ?? 0) / n;
    rbYac[t] = (yac[t] ?? 0) / n;
  }
  return { passPro, runBlock, rbYac };
}

/** 0-100 grade and rank for one line measure among the teams that have it. */
export function gradeLine(values: Record<string, number>, key: LineKey, teams: string[]): Record<string, LineResult | null> {
  const have = teams.filter((t) => values[t] !== undefined);
  const xs = have.map((t) => values[t] as number);
  const m = mean(xs);
  const s = sd(xs) || 1;
  const better = LINE[key].lowerIsBetter ? -1 : 1;
  const rk = ranks(xs, !LINE[key].lowerIsBetter);
  const out: Record<string, LineResult | null> = {};
  for (const t of teams) out[t] = null;
  have.forEach((t, i) => {
    const v = xs[i] as number;
    out[t] = { value: round(v, 3), grade: round(100 * normalCdf((better * (v - m)) / s), GRADE.decimals), rank: rk[i] as number };
  });
  return out;
}

export function gradeLines(raw: LineRaw, teams: string[]): Record<string, Record<LineKey, LineResult | null>> {
  const by = Object.fromEntries(LINE_KEYS.map((k) => [k, gradeLine(raw[k], k, teams)])) as Record<LineKey, Record<string, LineResult | null>>;
  return Object.fromEntries(teams.map((t) => [t, { passPro: by.passPro[t] ?? null, runBlock: by.runBlock[t] ?? null }]));
}

export interface LineStarter { id: string; name: string; team: string; depth: string; status: string; snapShare: number }

export interface LinemanMatch {
  /** Roster gsis id -> PFR id in the snap counts. */
  ids: Map<string, string>;
  /** Roster linemen with no confident match (names, for the refresh log). */
  unmatched: string[];
}

/**
 * The roster file has no PFR id for linemen, so they are matched to snap counts by name, always on the same team
 * (a snap row for the player's current team):
 * 1. the full normalized name, if exactly one PFR id has it on that team;
 * 2. else the last name, if exactly one lineman on that team has it ("Sam Cosmi" = "Samuel Cosmi").
 * Anything ambiguous is left unmatched rather than guessed.
 */
export function matchLinemen(inp: ModelInputs, cfg: LineTargetConfig = LINE_TARGETS): LinemanMatch {
  const full = new Map<string, Set<string>>();
  const last = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string): void => {
    m.set(k, (m.get(k) ?? new Set()).add(v));
  };
  for (const r of inp.snaps) {
    if (!r.n) continue;
    const n = normName(r.n);
    add(full, `${n}|${r.t}`, r.p);
    add(last, `${lastName(n)}|${r.t}`, r.p);
  }
  const one = (s: Set<string> | undefined): string | undefined => (s?.size === 1 ? [...s][0] : undefined);
  const ids = new Map<string, string>();
  const unmatched: string[] = [];
  for (const p of inp.roster) {
    if (!cfg.depth.includes(p.depth)) continue;
    const n = normName(p.name);
    const pfr = p.pfr ?? one(full.get(`${n}|${p.team}`)) ?? one(last.get(`${lastName(n)}|${p.team}`));
    if (pfr) ids.set(p.gsis, pfr);
    else unmatched.push(`${p.name} (${p.team})`);
  }
  return { ids, unmatched };
}

const lastName = (normalized: string): string => normalized.split(' ').pop() ?? '';

/** Offensive-line starters: OL by depth chart, on the current roster, over the snap-share threshold. */
export function lineStarters(inp: ModelInputs, cfg: LineTargetConfig = LINE_TARGETS): LineStarter[] {
  // team offense snaps per game = the most any one player on that team played (the QB and line play nearly all)
  const teamSnaps = new Map<string, number>();
  for (const r of inp.snaps) teamSnaps.set(`${r.t}|${r.g}`, Math.max(teamSnaps.get(`${r.t}|${r.g}`) ?? 0, r.off));
  const mine = new Map<string, { off: number; team: number }>();
  for (const r of inp.snaps) {
    if (r.off <= 0) continue;
    const m = mine.get(r.p) ?? { off: 0, team: 0 };
    m.off += r.off;
    m.team += teamSnaps.get(`${r.t}|${r.g}`) ?? 0;
    mine.set(r.p, m);
  }
  const ids = matchLinemen(inp, cfg).ids;
  const out: LineStarter[] = [];
  for (const p of inp.roster) {
    if (!cfg.depth.includes(p.depth)) continue;
    const pfr = ids.get(p.gsis);
    if (!pfr) continue;
    const m = mine.get(pfr);
    if (!m || m.team <= 0) continue;
    const share = m.off / m.team;
    if (share >= cfg.starterShare) out.push({ id: p.gsis, name: p.name, team: p.team, depth: p.depth, status: p.status, snapShare: round(share, 3) });
  }
  return out;
}

/** Lowercase, letters only, without Jr./Sr./II-V suffixes: "Jordan Mailata" == "jordan mailata". */
export function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For a buyer whose need is on the line: starters from the selling teams with the best grade of that kind. */
export function lineTargets(
  key: LineKey,
  buyer: string,
  sellers: Set<string>,
  starters: LineStarter[],
  lines: Record<string, Record<LineKey, LineResult | null>>,
  contracts: Map<string, PlayerContract>,
  statuses: string[],
  cfg: LineTargetConfig = LINE_TARGETS,
): LineTarget[] {
  return starters
    .filter((s) => s.team !== buyer && sellers.has(s.team) && statuses.includes(s.status) && lines[s.team]?.[key])
    .map((s) => ({ s, grade: lines[s.team]?.[key]?.grade ?? 0 }))
    .sort((a, b) => b.grade - a.grade || b.s.snapShare - a.s.snapShare || a.s.id.localeCompare(b.s.id))
    .filter(({ s }, _i, all) => all.filter((x) => x.s.team === s.team).findIndex((x) => x.s.id === s.id) < cfg.perSeller)
    .slice(0, cfg.perTeam)
    .map(({ s, grade }) => ({ id: s.id, name: s.name, team: s.team, depth: s.depth, snapShare: s.snapShare, lineGrade: grade, contract: contracts.get(s.id) ?? null }));
}
