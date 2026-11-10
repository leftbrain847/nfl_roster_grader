import { describe, expect, it } from 'vitest';
import { GAME_LOG, VALUE, type LineupRules } from '../src/model/config.ts';
import { bestLineups, capHits, fantasyValues, frontOffices, lastFullWeek, playerValues, quantile, rosterCandidates } from '../src/model/value.ts';
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

  const cfg: LineupRules = { lineup: { slots: { QB: 1, RB: 1 }, flexFrom: ['RB'], flexLabel: 'FLEX' }, budgetsMillions: [5, 12], budgetStepMillions: VALUE.fantasy.budgetStepMillions };
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
    const [tight] = bestLineups(pool, 'season', null, { ...cfg, budgetsMillions: [4.9] });
    expect(tight!.players.map((p) => p.id).sort()).toEqual(['q2', 'r2', 'r4']);
    expect(tight!.capMillions).toBeLessThanOrEqual(4.9);
    expect(bestLineups(pool, 'season', null, { ...cfg, budgetsMillions: [2] })).toEqual([]);
  });

  it('best lineup: every priced scorer is considered, and a budget between steps is rounded down', () => {
    // 70 backs at 100 pts / $10M would crowd out the cheap ones if only the top scorers were tried
    const many = [cand('q', 'QB', 10, 1), ...Array.from({ length: 70 }, (_, i) => cand(`dear${i}`, 'RB', 100, 10)), cand('c1', 'RB', 50, 1), cand('c2', 'RB', 40, 1)];
    const [l] = bestLineups(many, 'season', null, { ...cfg, budgetsMillions: [3] });
    expect(l!.players.map((p) => p.id).sort()).toEqual(['c1', 'c2', 'q']);
    const [odd] = bestLineups(pool, 'season', null, { ...cfg, budgetsMillions: [5.05] });
    expect(odd!.capMillions).toBeLessThanOrEqual(5.05);
  });

  it('quantile interpolates; the latest full week skips a week in progress', () => {
    expect(quantile([1, 2, 10], 0.5)).toBe(2);
    expect(quantile([1, 2, 10], 0.75)).toBe(6);
    expect(quantile([], 0.5)).toBe(0);
    const g = (id: string, week: number, done: boolean) => ({ id, week, gameday: '2026-09-13', home: 'AAA', away: 'BBB', homeScore: done ? 20 : null, awayScore: done ? 10 : null, neutral: false });
    expect(lastFullWeek({ ...empty, games: [g('a', 1, true), g('b', 1, true), g('c', 2, true), g('d', 2, false)] })).toBe(1);
    expect(lastFullWeek({ ...empty, games: [g('a', 1, false)] })).toBeNull();
  });

  it('front offices: production is worth the pay at the same percentile; cheap producers add, expensive non-producers cost, a star paid like one is even', () => {
    const pl = (id: string, team: string, production: number): PlayerResult => ({
      id, name: id, team, group: 'WR', depth: 'WR', status: 'ACT', volume: '', stats: [], scores: { production }, rank: 1, qualifiedAtPosition: 5, contract: null,
    });
    const players = [pl('rookie', 'AAA', 100), pl('star', 'AAA', 100), pl('mid', 'AAA', 50), pl('dud', 'BBB', 0), pl('cheapDud', 'BBB', 0)];
    const caps = new Map([['rookie', 1], ['star', 21], ['mid', 11], ['dud', 21], ['cheapDud', 1], ['idle', 15]]);
    const inp = { ...empty, roster: [{ gsis: 'idle', pfr: null, name: 'Idle Star', team: 'BBB', depth: 'WR', week: 9, status: 'RES' }] };
    const values = playerValues(players, caps);
    const ids = new Set(players.map((p) => p.id));
    const fo = frontOffices(values, ids, caps, inp, ['AAA', 'BBB'], { ...VALUE, frontOffice: { ...VALUE.frontOffice, minPlayers: 2 } });
    // the league-wide list runs from the best bargain to the worst overpay
    expect([values[0]!.id, values[values.length - 1]!.id]).toEqual(['rookie', 'dud']);
    const by = Object.fromEntries(fo.flatMap((f) => [...f.bargains, ...f.overpays]).map((p) => [p.id, p]));
    // pay runs 1, 1, 11, 21, 21: the top producer is worth 21, the bottom 1
    expect(by.rookie).toMatchObject({ worthMillions: 21, surplus: 20 });
    expect(by.dud).toMatchObject({ worthMillions: 1, surplus: -20 });
    expect(fo.find((f) => f.team === 'AAA')).toMatchObject({ rank: 1, surplus: 20, capMillions: 33, players: 3 });
    expect(fo[0]!.bargains.map((p) => p.id)).toEqual(['rookie']); // star: worth 21, paid 21; mid: worth 11, paid 11
    expect(fo[1]).toMatchObject({ team: 'BBB', surplus: -20 });
    expect(fo[1]!.overpays.map((p) => p.id)).toEqual(['dud']);
    expect(fo[0]!.grade!).toBeGreaterThan(fo[1]!.grade!);
    expect(fo[1]!.idle).toEqual([{ id: 'idle', name: 'Idle Star', pos: 'WR', capMillions: 15 }]);
    // surplus is zero-sum across the league
    expect(fo.reduce((s, f) => s + f.surplus, 0)).toBe(0);
    // too few priced players: listed without a grade
    expect(frontOffices(values, ids, caps, inp, ['AAA', 'BBB'], VALUE).every((f) => f.grade === null && f.rank === null)).toBe(true);
    // best roster by production: one spot per group here, no flex; the rookie beats the equally good star on price
    const rules: LineupRules = { lineup: { slots: { WR: 2 }, flexFrom: [], flexLabel: '' }, budgetsMillions: [12, 40], budgetStepMillions: 0.1 };
    const [tight, loose] = bestLineups(rosterCandidates(values), 'season', null, rules);
    expect(tight!.players.map((p) => p.id).sort()).toEqual(['mid', 'rookie']);
    expect(loose!.points).toBe(200);
  });
});
