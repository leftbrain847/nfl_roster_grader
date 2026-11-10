/** Player pages: each player's game log (weekly stats joined to the schedule and snap counts) and contract. */
import { GAME_LOG, type GameLogConfig } from './config.ts';
import { contractDetail } from './contracts.ts';
import { round } from './stats.ts';
import type { GameLogRow, ModelInputs, PlayerProfile } from './types.ts';

export function buildProfiles(inp: ModelInputs, weeksPlayed: number, cfg: GameLogConfig = GAME_LOG): PlayerProfile[] {
  const games = new Map(inp.games.map((g) => [g.id, g]));
  // snap counts are keyed by PFR id; the roster maps a player to his
  const pfrOf = new Map<string, string>();
  const teamNow = new Map<string, { team: string; week: number }>();
  for (const r of inp.roster) {
    if (r.pfr) pfrOf.set(r.gsis, r.pfr);
    const prev = teamNow.get(r.gsis);
    if (!prev || r.week >= prev.week) teamNow.set(r.gsis, { team: r.team, week: r.week });
  }
  // a team's snaps in a game = the most any one of its players played on that side
  const teamSnaps = new Map<string, { off: number; def: number }>();
  const mySnaps = new Map<string, { off: number; def: number }>();
  for (const s of inp.snaps) {
    const k = `${s.t}|${s.g}`;
    const m = teamSnaps.get(k) ?? { off: 0, def: 0 };
    m.off = Math.max(m.off, s.off);
    m.def = Math.max(m.def, s.def);
    teamSnaps.set(k, m);
    mySnaps.set(`${s.p}|${s.g}`, { off: s.off, def: s.def });
  }
  const contracts = new Map(inp.contracts.map((c) => [c.gsis, c]));

  const byPlayer = new Map<string, ModelInputs['playerWeeks']>();
  for (const w of inp.playerWeeks) byPlayer.set(w.p, [...(byPlayer.get(w.p) ?? []), w]);

  const out: PlayerProfile[] = [];
  for (const [id, weeks] of byPlayer) {
    const sorted = [...weeks].sort((a, b) => a.wk - b.wk || a.g.localeCompare(b.g));
    const last = sorted[sorted.length - 1];
    if (!last) continue;
    const side = cfg.snapSide[last.kind];
    const pfr = pfrOf.get(id);
    const log: GameLogRow[] = [];
    for (const w of sorted) {
      // a player whose position group changed mid-season keeps the columns of his latest one
      if (w.kind !== last.kind) continue;
      // a saved copy from before the columns changed can't be shown under today's labels
      if (w.v.length !== cfg.columns[w.kind].length) continue;
      const g = games.get(w.g);
      const mine = pfr ? mySnaps.get(`${pfr}|${w.g}`) : undefined;
      const team = teamSnaps.get(`${w.t}|${w.g}`);
      const snapPct = mine && team && team[side] > 0 ? round((100 * mine[side]) / team[side], 0) : null;
      // a line of zeros with no snaps on his side is special teams only: not part of this log
      if (!w.v.some((x) => x !== 0) && !snapPct) continue;
      const home = g ? g.home === w.t : false;
      let result = '';
      if (g && g.homeScore !== null && g.awayScore !== null) {
        const [us, them] = home ? [g.homeScore, g.awayScore] : [g.awayScore, g.homeScore];
        result = `${us > them ? 'W' : us < them ? 'L' : 'T'} ${us}-${them}`;
      }
      log.push({ wk: w.wk, team: w.t, opp: w.opp, home, result, snapPct, v: w.v });
    }
    if (!log.length) continue;
    const c = contracts.get(id);
    out.push({
      id,
      name: last.name,
      team: teamNow.get(id)?.team ?? last.t,
      pos: last.pos,
      kind: last.kind,
      log,
      contract: c ? contractDetail(c, weeksPlayed) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Season totals of a log, one per column. */
export function logTotals(log: GameLogRow[], decimals: number[]): number[] {
  return decimals.map((d, i) => round(log.reduce((s, r) => s + (r.v[i] ?? 0), 0), d));
}
