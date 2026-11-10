import { describe, expect, it } from 'vitest';
import { PICK_VALUE } from '../src/model/config.ts';
import { PICK_SURPLUS_PCT_OF_CAP } from '../src/model/pickChart.ts';
import { nextDraft, pickPrice, playerSurplus, tradeValues } from '../src/model/tradeValue.ts';
import type { Contract, Move, PlayerValue } from '../src/model/types.ts';

const dollars = (pick: number): number => Math.round((PICK_SURPLUS_PCT_OF_CAP[pick - 1] as number) / 100 * PICK_VALUE.capMillions * PICK_VALUE.rookieYears * 10) / 10;

describe('pick values (Baldwin chart)', () => {
  it('is the published chart: 256 picks, peak at 12', () => {
    expect(PICK_SURPLUS_PCT_OF_CAP).toHaveLength(256);
    expect([PICK_SURPLUS_PCT_OF_CAP[0], PICK_SURPLUS_PCT_OF_CAP[11], PICK_SURPLUS_PCT_OF_CAP[31], PICK_SURPLUS_PCT_OF_CAP[255]]).toEqual([2.33, 3.68, 2.98, 0.03]);
  });

  it('next draft: this year until its draft is over, then next year', () => {
    expect(nextDraft('2026-03-01')).toBe(2026);
    expect(nextDraft('2026-04-24')).toBe(2026);   // during the draft (starts Apr 23)
    expect(nextDraft('2026-04-26')).toBe(2027);
    expect(nextDraft('2026-11-01')).toBe(2027);
    // a 2026 pick traded during the 2025 draft is one draft away
    expect(pickPrice({ season: 2026, round: 2, number: null }, '2025-04-25').draftsAway).toBe(1);
  });

  it('labels conditional picks and the rate rule', () => {
    expect(pickPrice({ season: 2027, round: 3, number: null, conditional: true }, '2026-11-09').note).toBe('2027 3rd (valued as pick 80, the middle of the round; conditional, valued in full)');
    expect(pickPrice({ season: 2028, round: 1, number: null }, '2026-11-09', { ...PICK_VALUE, future: { rule: 'rate', rate: 0.1 } }).note).toBe('2028 1st (valued as pick 16, less 10% per draft away)');
  });

  it('a known slot uses it; an unknown one the middle of its round; a future pick one round later per draft', () => {
    expect(pickPrice({ season: 2026, round: 1, number: 12 }, '2026-03-01')).toMatchObject({ slot: 12, draftsAway: 0, millions: dollars(12) });
    expect(pickPrice({ season: 2027, round: 1, number: null }, '2026-11-09')).toMatchObject({ slot: 16, draftsAway: 0 });
    expect(pickPrice({ season: 2028, round: 1, number: null }, '2026-11-09')).toMatchObject({ slot: 48, draftsAway: 1, millions: dollars(48) });
    expect(pickPrice({ season: 2029, round: 7, number: null }, '2026-11-09').slot).toBe(256);   // past round 7: the last pick
    const rate = pickPrice({ season: 2028, round: 1, number: null }, '2026-11-09', { ...PICK_VALUE, future: { rule: 'rate', rate: 0.1 } });
    expect(rate.slot).toBe(16);
    expect(rate.millions).toBeCloseTo(dollars(16) * 0.9, 0);
  });
});

describe('whole-trade value', () => {
  const values = new Map<string, PlayerValue>([['p1', { id: 'p1', name: 'Star', team: 'JAX', group: 'IDL', production: 90, capMillions: 10, worthMillions: 18, surplus: 8 }]]);
  const contracts = new Map<string, Contract>([['p1', {
    gsis: 'p1', apyMillions: 0, capPct: 0, lastYear: 2027, baseSalaryMillions: null,
    seasons: [{ year: 2026, base: null, cap: 10, cash: null }, { year: 2027, base: null, cap: 12, cash: null }],
  }]]);
  const row = (over: Partial<Move>): Move => ({ date: '2026-11-09', when: 'Nov 9', kind: 'trade', id: null, name: '', pos: '', group: 'Other', team: '', from: null, detail: '', tradeId: 't1', ...over });

  it('player surplus sums worth minus cap hit over the seasons left', () => {
    expect(playerSurplus('p1', 2026, values, contracts)).toBe(14);
    expect(playerSurplus('nobody', 2026, values, contracts)).toBeNull();
  });

  const pick1 = row({ name: '2027 round 1 pick', team: 'PHI', from: 'JAX', pick: true, pickOf: { season: 2027, round: 1, number: null } });

  it('each team: value in minus value out, both sides mirror, every row of the trade carries it', () => {
    const out = tradeValues([row({ id: 'p1', name: 'Star', team: 'JAX', from: 'PHI' }), pick1], 2026, values, contracts);
    const [jax, phi] = out[0]?.tradeValue ?? [];
    expect(jax?.team).toBe('JAX');
    expect(jax?.reason).toBe(`Whole trade: value in $14M, out $${dollars(16)}M (net -$${Math.round((dollars(16) - 14) * 10) / 10}M)`);
    expect((jax?.score ?? 0) + (phi?.score ?? 0)).toBe(100);
    expect(out[1]?.tradeValue).toEqual(out[0]?.tradeValue);
  });

  it('an asset with no value (a lineman, an unranked backup): no grade for anyone in the trade, and it says why', () => {
    const out = tradeValues([row({ id: 'ol', name: 'Tackle', team: 'JAX', from: 'PHI' }), pick1], 2026, values, contracts);
    for (const g of out[0]?.tradeValue ?? []) expect(g).toMatchObject({ score: null, word: null, reason: expect.stringContaining('Whole trade not graded: no value for Tackle') });
  });

  it('three teams: each gets its own in and out', () => {
    const out = tradeValues([
      row({ id: 'p1', name: 'Star', team: 'JAX', from: 'PHI' }),
      row({ name: 'pick A', team: 'PHI', from: 'NYG', pick: true, pickOf: { season: 2027, round: 1, number: null } }),
      row({ name: 'pick B', team: 'NYG', from: 'JAX', pick: true, pickOf: { season: 2027, round: 1, number: null } }),
    ], 2026, values, contracts);
    const by = Object.fromEntries((out[0]?.tradeValue ?? []).map((g) => [g.team, g.reason]));
    expect(Object.keys(by).sort()).toEqual(['JAX', 'NYG', 'PHI']);
    expect(by.NYG).toContain(`value in $${dollars(16)}M, out $${dollars(16)}M (net +$0M)`);
  });
});
