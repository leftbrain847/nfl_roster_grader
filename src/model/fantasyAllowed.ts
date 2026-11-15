/**
 * Fantasy points allowed by position: what each defense gave up to QBs, RBs, WRs and TEs, per game, over the season
 * and the last few weeks, raw and opponent-adjusted (the unit grades' ridge regression, on game totals).
 */
import { FANTASY_ALLOWED, GAME_LOG, type FantasyAllowedConfig, type FantasyPos } from './config.ts';
import { ridgeAdjust, type Cell } from './adjust.ts';
import { mean, ranks, round } from './stats.ts';
import type { FantasyAllowed, FantasyAllowedWindow, Game, PlayerWeek } from './types.ts';

/** The week the This week tab is about: the first week with a game not played yet, else the last week played. */
export function currentWeek(games: Game[]): number {
  const open = games.filter((g) => g.homeScore === null).map((g) => g.week);
  if (open.length) return Math.min(...open);
  return games.reduce((m, g) => Math.max(m, g.week), 0);
}

/** One offense's points by fantasy position in one game: the regression's unit of data. */
export interface PointsCell {
  game: string;
  week: number;
  off: string;
  def: string;
  home: 0 | 1;
  points: Record<FantasyPos, number>;
}

/** Weekly player stats -> one cell per team-game: the points the offense scored at each position. */
export function pointsCells(playerWeeks: PlayerWeek[], games: Game[], cfg: FantasyAllowedConfig = FANTASY_ALLOWED): PointsCell[] {
  const sched = new Map(games.map((g) => [g.id, g]));
  const col: Record<string, number> = {
    QB: GAME_LOG.columns.QB.findIndex((c) => c.label === cfg.pointsColumn),
    SKILL: GAME_LOG.columns.SKILL.findIndex((c) => c.label === cfg.pointsColumn),
  };
  const cells = new Map<string, PointsCell>();
  for (const w of playerWeeks) {
    const g = sched.get(w.g);
    if (!g || !w.t || !w.opp) continue;
    const k = `${w.g}|${w.t}`;
    let c = cells.get(k);
    if (!c) {
      const home: 0 | 1 = !g.neutral && g.home === w.t ? 1 : 0;
      c = { game: w.g, week: g.week, off: w.t, def: w.opp, home, points: { QB: 0, RB: 0, WR: 0, TE: 0 } };
      cells.set(k, c);
    }
    const pos = cfg.positionMap[w.pos];
    const i = col[w.kind];
    if (!pos || i === undefined || i < 0) continue;
    c.points[pos] += w.v[i] ?? 0;
  }
  // a team-game where only one side's players appear is still a game: add the missing side with zero points
  for (const c of [...cells.values()]) {
    const k = `${c.game}|${c.def}`;
    if (!cells.has(k)) cells.set(k, { game: c.game, week: c.week, off: c.def, def: c.off, home: sched.get(c.game)?.neutral ? 0 : sched.get(c.game)?.home === c.def ? 1 : 0, points: { QB: 0, RB: 0, WR: 0, TE: 0 } });
  }
  return [...cells.values()].sort((a, b) => a.game.localeCompare(b.game) || a.off.localeCompare(b.off));
}

/** Raw and adjusted points allowed per game for one position over a set of cells, with ranks (1 = allows the most). */
export function allowedWindow(cells: PointsCell[], pos: FantasyPos, teams: string[], cfg: FantasyAllowedConfig = FANTASY_ALLOWED): Record<string, FantasyAllowedWindow> {
  const rc: Cell[] = cells.map((c) => ({ off: c.off, def: c.def, home: c.home, n: 1, sum: c.points[pos] }));
  const fit = ridgeAdjust(rc, { lambda: cfg.lambdaGames, homeField: cfg.homeField, tolerance: cfg.tolerance, maxIterations: cfg.maxIterations });
  const have = teams.filter((t) => (fit.rawDef[t]?.n ?? 0) > 0);
  const centre = mean(have.map((t) => fit.def[t] ?? 0));
  const raw = have.map((t) => fit.rawDef[t]?.mean ?? 0);
  const adj = have.map((t) => fit.leagueMean + (fit.def[t] ?? 0) - centre);
  const rawRank = ranks(raw, true);
  const adjRank = ranks(adj, true);
  const out: Record<string, FantasyAllowedWindow> = {};
  have.forEach((t, i) => {
    out[t] = {
      games: fit.rawDef[t]?.n ?? 0,
      raw: round(raw[i] as number, 1),
      adjusted: round(adj[i] as number, 1),
      rawRank: rawRank[i] as number,
      adjustedRank: adjRank[i] as number,
    };
  });
  return out;
}

export function fantasyAllowed(playerWeeks: PlayerWeek[], games: Game[], teams: string[], cfg: FantasyAllowedConfig = FANTASY_ALLOWED): FantasyAllowed {
  const cells = pointsCells(playerWeeks, games, cfg);
  const lastWeek = cells.reduce((m, c) => Math.max(m, c.week), 0);
  const fromWeek = Math.max(1, lastWeek - cfg.recentWeeks + 1);
  const recentCells = cells.filter((c) => c.week >= fromWeek);
  const out: FantasyAllowed = { recentWeeks: cfg.recentWeeks, fromWeek, throughWeek: lastWeek, teams: {} };
  for (const pos of cfg.positions) {
    const season = allowedWindow(cells, pos, teams, cfg);
    const recent = allowedWindow(recentCells, pos, teams, cfg);
    for (const t of teams) {
      const s = season[t];
      if (!s) continue;
      out.teams[t] ??= {};
      (out.teams[t] as FantasyAllowed['teams'][string])[pos] = { season: s, recent: recent[t] ?? null };
    }
  }
  return out;
}
