import { describe, expect, it } from 'vitest';
import { BUY, DEPTH_TO_GROUP, POSITION_GROUPS, POSITIONS, STATS, UNIT_KEYS, UNIT_NEEDS, type PositionGroup } from '../src/model/config.ts';
import { buyTargets, tradeChips, type BuyTeam } from '../src/model/buy.ts';
import type { PlayerResult } from '../src/model/types.ts';

const player = (id: string, team: string, group: PositionGroup, production: number, status = 'ACT'): PlayerResult => ({
  id, name: id, team, group, depth: group, status, volume: '', stats: [], scores: { production }, rank: 1, qualifiedAtPosition: 1, contract: null,
});

describe('unit -> position mapping', () => {
  it('every unit maps to needs whose positions are ranked groups with weighted, defined stats', () => {
    for (const u of UNIT_KEYS) {
      const n = UNIT_NEEDS[u];
      for (const need of [n.primary, ...(n.alternate ? [n.alternate] : [])]) {
        expect(need.positions.length).toBeGreaterThan(0);
        for (const p of need.positions) {
          expect(POSITION_GROUPS).toContain(p);
          for (const k of Object.keys(POSITIONS[p].weights)) expect(STATS).toHaveProperty(k);
        }
      }
    }
  });

  it('depth-chart positions map onto every group, and OL / specialists are left out', () => {
    expect(new Set(Object.values(DEPTH_TO_GROUP))).toEqual(new Set(POSITION_GROUPS));
    for (const p of ['T', 'G', 'C', 'K', 'P', 'LS']) expect(DEPTH_TO_GROUP[p]).toBeUndefined();
    expect(DEPTH_TO_GROUP.OLB).toBe('EDGE');
    expect(DEPTH_TO_GROUP.NT).toBe('IDL');
  });

  it('pass D maps to pass rush (EDGE, IDL) or coverage (CB, S); rush D to IDL and LB', () => {
    expect(UNIT_NEEDS.passDefense.primary.positions).toEqual(['EDGE', 'IDL']);
    expect(UNIT_NEEDS.passDefense.alternate?.positions).toEqual(['CB', 'S']);
    expect(UNIT_NEEDS.rushDefense.primary.positions).toEqual(['IDL', 'LB']);
  });
});

describe('where to buy', () => {
  const teams: BuyTeam[] = [
    { team: 'BUY', verdict: 'buy', need: { positions: ['EDGE', 'IDL'] } },
    { team: 'S1', verdict: 'sell', need: null },
    { team: 'S2', verdict: 'sell', need: null },
    { team: 'PAT', verdict: 'stand pat', need: null },
  ];
  const players = [
    player('s1-edge', 'S1', 'EDGE', 90),
    player('s2-idl', 'S2', 'IDL', 95),
    player('s2-cb', 'S2', 'CB', 99),
    player('pat-edge', 'PAT', 'EDGE', 99),
    player('buy-edge', 'BUY', 'EDGE', 99),
    player('s1-ir', 'S1', 'EDGE', 98, 'RES'),
    ...Array.from({ length: 8 }, (_, i) => player(`s1-e${i}`, 'S1', 'EDGE', 10 + i)),
  ];

  it('lists the best producers at the need positions, from sellers only, active only, capped', () => {
    const t = buyTargets(teams[0]!, teams, players);
    expect(t).toHaveLength(BUY.targetsPerTeam);
    expect(t.slice(0, 2)).toEqual(['s2-idl', 's1-edge']);
    expect(t).not.toContain('s2-cb');
    expect(t).not.toContain('pat-edge');
    expect(t).not.toContain('buy-edge');
    expect(t).not.toContain('s1-ir');
  });

  it('non-buyers get no targets; sellers list their chips', () => {
    expect(buyTargets(teams[1]!, teams, players)).toEqual([]);
    expect(tradeChips(teams[2]!, players)).toEqual(['s2-cb', 's2-idl']);
    expect(tradeChips(teams[0]!, players)).toEqual([]);
  });
});
