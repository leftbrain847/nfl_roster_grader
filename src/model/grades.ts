/** Unit grades: opponent-adjusted EPA/play per unit, a 0-100 grade and a league rank. */
import { ADJUST, GRADE, UNIT_KEYS, UNITS, type AdjustConfig, type UnitKey } from './config.ts';
import { ridgeAdjust, type Cell, type RidgeFit } from './adjust.ts';
import { mean, normalCdf, ranks, round, sd } from './stats.ts';
import type { TeamGame, UnitResult } from './types.ts';

export interface UnitGrades {
  units: Record<string, Record<UnitKey, UnitResult>>;
  fits: { pass: RidgeFit; rush: RidgeFit };
  /** Pass-rush and coverage ranks (1 = best) for the pass-defense need split. */
  passRushRank: Record<string, number>;
  coverageRank: Record<string, number>;
  /** Offense EPA per non-sack pass attempt rank (1 = best): the pass-catching half of pass O. */
  airRank: Record<string, number>;
}

/** What a unit is graded on: EPA per play, or series success (the share of plays in series that earned a first
 * down or a touchdown). */
export type UnitMetric = 'epa' | 'series';

export function cellsFor(teamGames: TeamGame[], play: 'pass' | 'rush', metric: UnitMetric = 'epa'): Cell[] {
  return teamGames.map((g) => ({
    off: g.off,
    def: g.def,
    home: g.offHome,
    n: play === 'pass' ? g.passN : g.rushN,
    sum: metric === 'epa' ? (play === 'pass' ? g.passEpa : g.rushEpa) : (play === 'pass' ? g.passSs ?? 0 : g.rushSs ?? 0),
  }));
}

function fitBoth(teamGames: TeamGame[], cfg: AdjustConfig, metric: UnitMetric): { pass: RidgeFit; rush: RidgeFit } {
  const fit = (play: 'pass' | 'rush'): RidgeFit =>
    ridgeAdjust(cellsFor(teamGames, play, metric), {
      lambda: cfg.lambdaPlays[play],
      homeField: cfg.homeField,
      tolerance: cfg.tolerance,
      maxIterations: cfg.maxIterations,
    });
  return { pass: fit('pass'), rush: fit('rush') };
}

/** Each team's four units from a pair of fits: adjusted value on the league's scale, raw value, grade and rank. */
function unitResults(fits: { pass: RidgeFit; rush: RidgeFit }, teams: string[], decimals: number): Record<string, Record<UnitKey, UnitResult>> {
  const units: Record<string, Record<UnitKey, UnitResult>> = {};
  for (const t of teams) units[t] = {} as Record<UnitKey, UnitResult>;
  for (const key of UNIT_KEYS) {
    const u = UNITS[key];
    const f = fits[u.play];
    const effects = u.side === 'offense' ? f.off : f.def;
    const centre = mean(teams.map((t) => effects[t] ?? 0));
    // displayed on the league's scale: league mean + the team's effect relative to the average team
    const adjusted = teams.map((t) => f.leagueMean + ((effects[t] ?? 0) - centre));
    const good = u.side === 'offense' ? 1 : -1;
    const m = mean(adjusted);
    const s = sd(adjusted) || 1;
    const rk = ranks(adjusted, u.side === 'offense');
    teams.forEach((t, i) => {
      const raw = u.side === 'offense' ? f.rawOff[t] : f.rawDef[t];
      const a = adjusted[i] as number;
      (units[t] as Record<UnitKey, UnitResult>)[key] = {
        adjusted: round(a, decimals),
        raw: round(raw?.mean ?? 0, decimals),
        plays: raw?.n ?? 0,
        grade: round(100 * normalCdf((good * (a - m)) / s), GRADE.decimals),
        rank: rk[i] as number,
      };
    });
  }
  return units;
}

/**
 * Series success per unit, opponent-adjusted with the same ridge regression and penalty as EPA, on the same plays
 * (garbage time removed). Shown beside EPA/play; the verdicts and odds still use EPA. Null when the play-by-play
 * extract has no series column (an older saved copy).
 */
export function seriesGrades(teamGames: TeamGame[], teams: string[], cfg: AdjustConfig = ADJUST): Record<string, Record<UnitKey, UnitResult>> | null {
  if (!teamGames.length || teamGames.some((g) => g.passSs === undefined || g.rushSs === undefined)) return null;
  return unitResults(fitBoth(teamGames, cfg, 'series'), teams, 4);
}

export function gradeUnits(teamGames: TeamGame[], teams: string[], cfg: AdjustConfig = ADJUST): UnitGrades {
  const fits = fitBoth(teamGames, cfg, 'epa');
  const units = unitResults(fits, teams, 4);

  // pass-defense split: pass rush (sacks + hits per dropback, higher better) vs coverage (EPA/attempt, lower better)
  const rushRate: number[] = [];
  const covRate: number[] = [];
  for (const t of teams) {
    const rows = teamGames.filter((g) => g.def === t);
    const db = rows.reduce((s, g) => s + g.passN, 0);
    const covN = rows.reduce((s, g) => s + g.covN, 0);
    rushRate.push(db ? rows.reduce((s, g) => s + g.rushHits, 0) / db : 0);
    covRate.push(covN ? rows.reduce((s, g) => s + g.covEpa, 0) / covN : 0);
  }
  const air = teams.map((t) => {
    const rows = teamGames.filter((g) => g.off === t);
    const n = rows.reduce((s, g) => s + g.covN, 0);
    return n ? rows.reduce((s, g) => s + g.covEpa, 0) / n : 0;
  });
  const arRank = ranks(air, true);
  const airRank: Record<string, number> = {};
  teams.forEach((t, i) => (airRank[t] = arRank[i] as number));
  const prRank = ranks(rushRate, true);
  const cvRank = ranks(covRate, false);
  const passRushRank: Record<string, number> = {};
  const coverageRank: Record<string, number> = {};
  teams.forEach((t, i) => {
    passRushRank[t] = prRank[i] as number;
    coverageRank[t] = cvRank[i] as number;
  });
  return { units, fits, passRushRank, coverageRank, airRank };
}

/** The lowest-graded unit (ties: the order in UNIT_KEYS). */
export function weakestUnit(units: Record<UnitKey, UnitResult>): UnitKey {
  let worst: UnitKey = UNIT_KEYS[0] as UnitKey;
  for (const k of UNIT_KEYS) if (units[k].grade < units[worst].grade) worst = k;
  return worst;
}
