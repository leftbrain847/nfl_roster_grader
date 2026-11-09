/**
 * Opponent adjustment: ridge regression, solved by Gauss-Seidel sweeps.
 *
 * Model, for each play type separately (pass, rush):
 *     EPA(play) = mu + off[offense] + def[defense] + home * (offense at home) + noise
 * minimizing  sum over plays of squared error  +  lambda * (sum off^2 + sum def^2).
 *
 * Why ridge, not the simpler iterative "subtract the opponents' average" adjustment:
 * - It fits every team's offense and defense jointly, so a schedule full of good defenses is credited correctly even
 *   when those defenses' own numbers were earned against weak offenses. The iterative method approximates the same
 *   least-squares fit but has no answer for small samples.
 * - Half a season is ~9 games. The penalty shrinks each effect toward league average in proportion to how few plays
 *   back it (lambda is in plays: a team's effect is estimated as if it also had lambda average plays), which is what
 *   keeps one blowout from dominating a grade.
 * - With lambda = 0 it is ordinary least squares, so the tiny-fixture tests can check it recovers known effects.
 *
 * Plays are aggregated to cells (offense, defense, home) with a count and an EPA sum. Least squares on cell means
 * weighted by the count gives the same coefficients as play-level least squares, so nothing is lost.
 */

export interface Cell {
  off: string;
  def: string;
  home: 0 | 1;
  n: number;
  sum: number;
}

export interface RidgeOptions {
  lambda: number;
  homeField: boolean;
  tolerance: number;
  maxIterations: number;
}

export interface RidgeFit {
  mu: number;
  home: number;
  off: Record<string, number>;
  def: Record<string, number>;
  iterations: number;
  converged: boolean;
  /** Raw (unadjusted) EPA per play and play count by team, as offense and as defense. */
  rawOff: Record<string, { n: number; mean: number }>;
  rawDef: Record<string, { n: number; mean: number }>;
  /** Plain league mean EPA/play over all cells. */
  leagueMean: number;
}

export function ridgeAdjust(cells: Cell[], opts: RidgeOptions): RidgeFit {
  const teams = new Set<string>();
  for (const c of cells) {
    teams.add(c.off);
    teams.add(c.def);
  }
  const off: Record<string, number> = {};
  const def: Record<string, number> = {};
  for (const t of teams) {
    off[t] = 0;
    def[t] = 0;
  }
  const live = cells.filter((c) => c.n > 0);
  const totalN = live.reduce((s, c) => s + c.n, 0);
  const leagueMean = totalN > 0 ? live.reduce((s, c) => s + c.sum, 0) / totalN : 0;
  let mu = leagueMean;
  let home = 0;

  const byOff = groupBy(live, (c) => c.off);
  const byDef = groupBy(live, (c) => c.def);
  const homeCells = live.filter((c) => c.home === 1);
  const homeN = homeCells.reduce((s, c) => s + c.n, 0);

  // residual sum for a cell, excluding one term
  const pred = (c: Cell): number => mu + (off[c.off] ?? 0) + (def[c.def] ?? 0) + home * c.home;

  let iterations = 0;
  let converged = false;
  while (iterations < opts.maxIterations) {
    iterations++;
    let maxDelta = 0;
    // intercept (unpenalized)
    if (totalN > 0) {
      const next = live.reduce((s, c) => s + (c.sum - c.n * (pred(c) - mu)), 0) / totalN;
      maxDelta = Math.max(maxDelta, Math.abs(next - mu));
      mu = next;
    }
    // home field (unpenalized)
    if (opts.homeField && homeN > 0) {
      const next = homeCells.reduce((s, c) => s + (c.sum - c.n * (pred(c) - home)), 0) / homeN;
      maxDelta = Math.max(maxDelta, Math.abs(next - home));
      home = next;
    }
    for (const t of teams) {
      const oc = byOff.get(t) ?? [];
      const on = oc.reduce((s, c) => s + c.n, 0);
      const onext = oc.reduce((s, c) => s + (c.sum - c.n * (pred(c) - (off[t] ?? 0))), 0) / (on + opts.lambda || 1);
      maxDelta = Math.max(maxDelta, Math.abs(onext - (off[t] ?? 0)));
      off[t] = on > 0 ? onext : 0;
      const dc = byDef.get(t) ?? [];
      const dn = dc.reduce((s, c) => s + c.n, 0);
      const dnext = dc.reduce((s, c) => s + (c.sum - c.n * (pred(c) - (def[t] ?? 0))), 0) / (dn + opts.lambda || 1);
      maxDelta = Math.max(maxDelta, Math.abs(dnext - (def[t] ?? 0)));
      def[t] = dn > 0 ? dnext : 0;
    }
    if (maxDelta < opts.tolerance) {
      converged = true;
      break;
    }
  }

  const rawOff: RidgeFit['rawOff'] = {};
  const rawDef: RidgeFit['rawDef'] = {};
  for (const t of teams) {
    rawOff[t] = rawMean(byOff.get(t) ?? []);
    rawDef[t] = rawMean(byDef.get(t) ?? []);
  }
  return { mu, home, off, def, iterations, converged, rawOff, rawDef, leagueMean };
}

function rawMean(cells: Cell[]): { n: number; mean: number } {
  const n = cells.reduce((s, c) => s + c.n, 0);
  return { n, mean: n > 0 ? cells.reduce((s, c) => s + c.sum, 0) / n : 0 };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}
