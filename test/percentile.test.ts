import { describe, expect, it } from 'vitest';
import { MIN_WEIGHT_SHARE, POSITIONS } from '../src/model/config.ts';
import { scoreGroup, type Aggregates } from '../src/model/players.ts';
import { normalCdf, ordinal, percentileOf, percentiles } from '../src/model/stats.ts';

const vol = { dropbacks: 300, carries: 0, targets: 0, defenseSnaps: 0 };

describe('percentile math', () => {
  it('mid-rank percentile: ties share, a lone value is 50, order does not matter', () => {
    expect(percentileOf(5, [5])).toBe(50);
    expect(percentileOf(3, [1, 2, 3, 4])).toBe(62.5);
    expect(percentiles([4, 1, 3, 2])).toEqual([87.5, 12.5, 62.5, 37.5]);
    expect(percentiles([1, 2, 2, 3])).toEqual([12.5, 50, 50, 87.5]);
  });

  it('flips lower-is-better stats', () => {
    expect(percentiles([1, 2, 3, 4], true)).toEqual([87.5, 62.5, 37.5, 12.5]);
  });

  it('normal CDF and ordinals', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 27].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '27th']);
  });

  it('a position score is the percentile of the weighted stat percentiles, best first', () => {
    const qb = (id: string, epa: number, sr: number, cpoe: number, sack: number, p2s?: number): { id: string; agg: Aggregates } => ({
      id, agg: { volume: vol, stats: { epaPerDropback: epa, successRate: sr, cpoe, sackRate: sack, ...(p2s === undefined ? {} : { pressureToSack: p2s }) } },
    });
    const out = scoreGroup('QB', [qb('a', 0.25, 50, 4, 5, 15), qb('b', 0.05, 44, -1, 8, 25), qb('c', 0.15, 47, 2, 6, 20)]);
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(out.map((x) => x.production)).toEqual([100 * (2.5 / 3), 50, 100 * (0.5 / 3)].map((x) => Math.round(x * 10) / 10));
    const a = out[0]!;
    expect(a.stats.find((s) => s.key === 'sackRate')?.pct).toBeCloseTo(100 * (2.5 / 3), 1); // lowest sack rate is best
  });

  it('missing stats are re-weighted; too little weight leaves a player unscored', () => {
    const w = POSITIONS.QB.weights;
    const total = Object.values(w).reduce((s, x) => s + (x ?? 0), 0);
    expect((w.epaPerDropback ?? 0) / total).toBeLessThan(MIN_WEIGHT_SHARE);
    const out = scoreGroup('QB', [
      { id: 'full', agg: { volume: vol, stats: { epaPerDropback: 0.1, successRate: 45, cpoe: 1, sackRate: 6, pressureToSack: 20 } } },
      { id: 'noPfr', agg: { volume: vol, stats: { epaPerDropback: 0.2, successRate: 48, cpoe: 2, sackRate: 5 } } },
      { id: 'thin', agg: { volume: vol, stats: { epaPerDropback: 0.3 } } },
    ]);
    expect(out.map((x) => x.id).sort()).toEqual(['full', 'noPfr']);
    expect(out.find((x) => x.id === 'noPfr')!.stats).toHaveLength(4);
  });
});
