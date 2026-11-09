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
}

export function cellsFor(teamGames: TeamGame[], play: 'pass' | 'rush'): Cell[] {
  return teamGames.map((g) => ({
    off: g.off,
    def: g.def,
    home: g.offHome,
    n: play === 'pass' ? g.passN : g.rushN,
    sum: play === 'pass' ? g.passEpa : g.rushEpa,
  }));
}

export function gradeUnits(teamGames: TeamGame[], teams: string[], cfg: AdjustConfig = ADJUST): UnitGrades {
  const fit = (play: 'pass' | 'rush'): RidgeFit =>
    ridgeAdjust(cellsFor(teamGames, play), {
      lambda: cfg.lambdaPlays[play],
      homeField: cfg.homeField,
      tolerance: cfg.tolerance,
      maxIterations: cfg.maxIterations,
    });
  const fits = { pass: fit('pass'), rush: fit('rush') };

  const units: Record<string, Record<UnitKey, UnitResult>> = {};
  for (const t of teams) units[t] = {} as Record<UnitKey, UnitResult>;

  for (const key of UNIT_KEYS) {
    const u = UNITS[key];
    const f = fits[u.play];
    const effects = u.side === 'offense' ? f.off : f.def;
    const centre = mean(teams.map((t) => effects[t] ?? 0));
    // displayed as EPA/play on the league's scale: league mean + the team's effect relative to the average team
    const adjusted = teams.map((t) => f.leagueMean + ((effects[t] ?? 0) - centre));
    const good = u.side === 'offense' ? 1 : -1;
    const m = mean(adjusted);
    const s = sd(adjusted) || 1;
    const rk = ranks(adjusted, u.side === 'offense');
    teams.forEach((t, i) => {
      const raw = u.side === 'offense' ? f.rawOff[t] : f.rawDef[t];
      const a = adjusted[i] as number;
      (units[t] as Record<UnitKey, UnitResult>)[key] = {
        adjusted: round(a, 4),
        raw: round(raw?.mean ?? 0, 4),
        plays: raw?.n ?? 0,
        grade: round(100 * normalCdf((good * (a - m)) / s), GRADE.decimals),
        rank: rk[i] as number,
      };
    });
  }

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
  const prRank = ranks(rushRate, true);
  const cvRank = ranks(covRate, false);
  const passRushRank: Record<string, number> = {};
  const coverageRank: Record<string, number> = {};
  teams.forEach((t, i) => {
    passRushRank[t] = prRank[i] as number;
    coverageRank[t] = cvRank[i] as number;
  });
  return { units, fits, passRushRank, coverageRank };
}

/** The lowest-graded unit (ties: the order in UNIT_KEYS). */
export function weakestUnit(units: Record<UnitKey, UnitResult>): UnitKey {
  let worst: UnitKey = UNIT_KEYS[0] as UnitKey;
  for (const k of UNIT_KEYS) if (units[k].grade < units[worst].grade) worst = k;
  return worst;
}
