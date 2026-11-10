import { describe, expect, it } from 'vitest';
import { GAME_LOG, VALUE, type ValueConfig } from '../src/model/config.ts';
import { bestLineups, capHits, fantasyValues, frontOffices, linearFit } from '../src/model/value.ts';
import type { ModelInputs, PlayerProfile, PlayerResult } from '../src/model/types.ts';

const empty: ModelInputs = {
  season: 2026, games: [], teamGames: [], playerGames: [], pfrPass: [], pfrRush: [], pfrRec: [], pfrDef: [], snaps: [],
  ngsPassing: [], ngsReceiving: [], ngsRushing: [], roster: [], contracts: [], playerWeeks: [],
};
const ppr = GAME_LOG.columns.SKILL.findIndex((c) => c.label === 'PPR');
const skill = (id: string, pos: string, team: string, pts: number[]): PlayerProfile => ({
  id, name: id, team, pos, kind: 'SKILL', contract: null,
  log: pts.map((p, i) => ({ wk: i + 1, team, opp: 'ZZZ', home: true, result: '', snapPct: 50, v: GAME_LOG.columns.SKILL.map((_, k) => (k === ppr ? p : 0)) })),
});
const cand = (id: string, pos: string, points: number, cap: number) => ({ id, name: id, team: 'AAA', pos, points, cap, cost: Math.ceil(cap / VALUE.fantasy.budgetStepMillions - 1e-9) });

describe('value', () => {
  it('cap hit = the contract row for this season; none or zero means unknown', () => {
    const caps = capHits({ ...empty, contracts: [
      { gsis: 'a', apyMillions: 1, capPct: 0, lastYear: 2027, baseSalaryMillions: 1, seasons: [{ year: 2026, base: 1, cap: 4.5, cash: 1 }, { year: 2027, base: 1, cap: 9, cash: 1 }] },
      { gsis: 'b', apyMillions: 1, capPct: 0, lastYear: 2027, baseSalaryMillions: 1, seasons: [{ year: 2027, base: 1, cap: 9, cash: 1 }] },
      { gsis: 'c', apyMillions: 1, capPct: 0, lastYear: 2026, baseSalaryMillions: 1 },
    ] });
    expect([...caps]).toEqual([['a', 4.5]]);
  });

  it('fantasy per $: points per $1M of cap hit, only for players over the per-game and games minimums', () => {
    const caps = new Map([['cheap', 1], ['star', 20], ['bench', 1], ['hurt', 1]]);
    const list = fantasyValues([
      skill('cheap', 'RB', 'AAA', [10, 10, 10, 10]),
      skill('star', 'RB', 'AAA', [25, 25, 25, 25]),
      skill('bench', 'RB', 'AAA', [2, 2, 2, 2]), // under 8 a game
      skill('hurt', 'RB', 'AAA', [30]), // 1 of 4 team games
      skill('nocap', 'RB', 'AAA', [20, 20, 20, 20]),
    ], caps, { AAA: 4 });
    expect(list.map((f) => f.id)).toEqual(['cheap', 'star']);
    expect(list[0]).toMatchObject({ points: 40, perGame: 10, capMillions: 1, perMillion: 40 });
    expect(list[1]!.perMillion).toBe(5);
  });

  const cfg: ValueConfig = { ...VALUE, fantasy: { ...VALUE.fantasy, lineup: { slots: { QB: 1, RB: 1 }, flexFrom: ['RB'], flexLabel: 'FLEX' }, budgetsMillions: [5, 12] } };
  const pool = [cand('q1', 'QB', 30, 8), cand('q2', 'QB', 20, 1), cand('r1', 'RB', 25, 6), cand('r2', 'RB', 15, 2), cand('r3', 'RB', 12, 1.95), cand('r4', 'RB', 3, 1)];

  it('best lineup: the most points that fit the budget, checked against every possible lineup', () => {
    const brute = (budget: number): number => {
      let best = -1;
      for (const q of pool.filter((c) => c.pos === 'QB')) {
        const rbs = pool.filter((c) => c.pos === 'RB');
        for (let i = 0; i < rbs.length; i++) for (let j = i + 1; j < rbs.length; j++) {
          const cost = q.cost + rbs[i]!.cost + rbs[j]!.cost;
          if (cost <= Math.round(budget / VALUE.fantasy.budgetStepMillions)) best = Math.max(best, q.points + rbs[i]!.points + rbs[j]!.points);
        }
      }
      return best;
    };
    const [small, big] = bestLineups(pool, 'season', null, cfg);
    expect(small!.points).toBe(brute(5));
    expect(big!.points).toBe(brute(12));
    expect(small!.players.map((p) => p.id).sort()).toEqual(['q2', 'r2', 'r3']);
    expect(small!.capMillions).toBeLessThanOrEqual(5);
    expect(big!.capMillions).toBeLessThanOrEqual(12);
    // the extra back is the flex, and it is the lower scorer
    expect(big!.players.map((p) => p.slot)).toEqual(['QB', 'RB', 'FLEX']);
    expect(big!.players[2]!.points).toBeLessThanOrEqual(big!.players[1]!.points);
  });

  it('best lineup: a cap hit is rounded up, so a lineup never slips over the budget; no lineup when nothing fits', () => {
    // r3's 1.95 costs 2.0 in the search, so q2 (1) + r2 (2) + r3 doesn't fit 4.9: the next best is taken
    const [tight] = bestLineups(pool, 'season', null, { ...cfg, fantasy: { ...cfg.fantasy, budgetsMillions: [4.9] } });
    expect(tight!.players.map((p) => p.id).sort()).toEqual(['q2', 'r2', 'r4']);
    expect(tight!.capMillions).toBeLessThanOrEqual(4.9);
    expect(bestLineups(pool, 'season', null, { ...cfg, fantasy: { ...cfg.fantasy, budgetsMillions: [2] } })).toEqual([]);
  });

  it('straight-line fit', () => {
    expect(linearFit([0, 50, 100], [40, 50, 60])).toEqual({ intercept: 40, slope: 0.2 });
    expect(linearFit([5, 5], [10, 30])).toEqual({ intercept: 20, slope: 0 });
  });

  it('front offices: cheap producers lift a team, expensive non-producers sink it; unranked big cap hits are listed, not graded', () => {
    const pl = (id: string, team: string, production: number): PlayerResult => ({
      id, name: id, team, group: 'WR', depth: 'WR', status: 'ACT', volume: '', stats: [], scores: { production }, rank: 1, qualifiedAtPosition: 4, contract: null,
    });
    const players = [pl('goodCheap', 'AAA', 90), pl('goodDear', 'AAA', 90), pl('badCheap', 'BBB', 10), pl('badDear', 'BBB', 10)];
    const caps = new Map([['goodCheap', 1], ['goodDear', 20], ['badCheap', 1], ['badDear', 20], ['idle', 15]]);
    const inp = { ...empty, roster: [{ gsis: 'idle', pfr: null, name: 'Idle Star', team: 'BBB', depth: 'WR', week: 9, status: 'RES' }] };
    const fo = frontOffices(players, caps, inp, ['AAA', 'BBB'], { ...VALUE, frontOffice: { ...VALUE.frontOffice, minPlayers: 2 } });
    expect(fo.map((f) => f.team)).toEqual(['AAA', 'BBB']);
    expect(fo[0]!.rank).toBe(1);
    expect(fo[0]!.grade!).toBeGreaterThan(fo[1]!.grade!);
    expect(fo[0]!.surplus).toBeGreaterThan(0);
    expect(fo[0]!.bargains.map((p) => p.id)).toContain('goodCheap');
    expect(fo[1]!.overpays.map((p) => p.id)).toEqual(['badDear']);
    expect(fo[1]!.idle).toEqual([{ id: 'idle', name: 'Idle Star', pos: 'WR', capMillions: 15 }]);
    // too few priced players: listed without a grade
    const few = frontOffices(players, caps, inp, ['AAA', 'BBB'], VALUE);
    expect(few.every((f) => f.grade === null && f.rank === null)).toBe(true);
  });
});
