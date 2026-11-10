/** Unit grades -> team strength -> playoff odds, from any slice of the season (the whole of it, or the games before a date). */
import { gradeUnits, type UnitGrades } from './grades.ts';
import { records, simulatePlayoffs, strengths, type Record3 } from './playoffs.ts';
import type { Game, TeamGame } from './types.ts';

export interface SeasonState {
  grades: UnitGrades;
  recs: Record<string, Record3>;
  strength: Record<string, number>;
  odds: Record<string, number>;
}

export function seasonState(games: Game[], teamGames: TeamGame[], teams: string[]): SeasonState {
  const grades = gradeUnits(teamGames, teams);
  const recs = records(games, teams);
  // net EPA/play vs average, weighting pass and rush by the league's play mix
  const passN = grades.fits.pass.rawOff;
  const rushN = grades.fits.rush.rawOff;
  const totPass = teams.reduce((s, t) => s + (passN[t]?.n ?? 0), 0);
  const totRush = teams.reduce((s, t) => s + (rushN[t]?.n ?? 0), 0);
  const passShare = totPass + totRush > 0 ? totPass / (totPass + totRush) : 0.5;
  const net: Record<string, number> = {};
  for (const t of teams) {
    const u = grades.units[t];
    if (!u) continue;
    const off = passShare * (u.passOffense.adjusted - grades.fits.pass.leagueMean) + (1 - passShare) * (u.rushOffense.adjusted - grades.fits.rush.leagueMean);
    const def = passShare * (u.passDefense.adjusted - grades.fits.pass.leagueMean) + (1 - passShare) * (u.rushDefense.adjusted - grades.fits.rush.leagueMean);
    net[t] = off - def;
  }
  const strength = strengths(net, recs);
  return { grades, recs, strength, odds: simulatePlayoffs(games, strength) };
}

/** The season as it stood before `date`: later games unplayed, and only earlier plays graded. */
export function seasonStateBefore(games: Game[], teamGames: TeamGame[], teams: string[], date: string): SeasonState {
  const day = new Map(games.map((g) => [g.id, g.gameday]));
  const asOf = games.map((g) => (g.gameday < date ? g : { ...g, homeScore: null, awayScore: null }));
  return seasonState(asOf, teamGames.filter((g) => (day.get(g.game) ?? '9999') < date), teams);
}
