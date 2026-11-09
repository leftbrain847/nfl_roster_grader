/** Small, pure math helpers. */

/**
 * Percentile of `value` within `population`, 0-100, using the mid-rank definition:
 *     100 x (number below + half the number equal) / n
 * so ties share a percentile, the order of the population doesn't matter, and a lone player is the 50th.
 * `population` must include `value` itself.
 */
export function percentileOf(value: number, population: readonly number[]): number {
  if (population.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const x of population) {
    if (x < value) below++;
    else if (x === value) equal++;
  }
  return (100 * (below + equal / 2)) / population.length;
}

/** Percentiles for every value in `values`, flipped so higher is always better when `lowerIsBetter`. */
export function percentiles(values: readonly number[], lowerIsBetter = false): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  return values.map((v) => {
    const below = lowerBound(sorted, v);
    const equal = upperBound(sorted, v) - below;
    const p = n === 0 ? 50 : (100 * (below + equal / 2)) / n;
    return lowerIsBetter ? 100 - p : p;
  });
}

function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf; max error ~1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Rank 1 = best. Ties share the better rank. */
export function ranks(values: readonly number[], higherIsBetter: boolean): number[] {
  return values.map((v) => 1 + values.filter((w) => (higherIsBetter ? w > v : w < v)).length);
}

export function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (x: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
