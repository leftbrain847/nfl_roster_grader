import { describe, expect, it } from 'vitest';
import { parseCsv } from '../pipeline/csv.ts';
import { extractDepthCharts } from '../pipeline/extract.ts';
import { DEPTH } from '../src/model/config.ts';
import { depthChartView, designations, diffSlot } from '../src/model/depth.ts';
import type { DepthRow, PlayerResult } from '../src/model/types.ts';

const HEAD = 'dt,team,player_name,gsis_id,pos_grp,pos_abb,pos_slot,pos_rank';
const line = (dt: string, team: string, name: string, id: string, grp: string, pos: string, slot: number, rank: number): string =>
  [dt, team, name, id, grp, pos, slot, rank].join(',');
const offense = '3WR 1TE';

/** A team chart: QB slot (two QBs) and WR slot, in the given order. */
const chart = (dt: string, qbs: string[], wrs: string[], team = 'AAA'): string[] => [
  ...qbs.map((q, i) => line(dt, team, q.toUpperCase(), q, offense, 'QB', 9, i + 1)),
  ...wrs.map((w, i) => line(dt, team, w.toUpperCase(), w, offense, 'WR', 1, i + 1)),
  line(dt, team, 'K', 'k', 'Special Teams', 'PK', 1, 1),
];

describe('depth charts', () => {
  it('compares the newest snapshot with the newest from an earlier day, skipping partial pulls and special teams', () => {
    expect(DEPTH.minDaysBefore).toBe(1);
    const csv = [HEAD,
      ...chart('2026-10-01T07:00:00Z', ['q1', 'q2'], ['w1', 'w2', 'w3']),
      ...chart('2026-10-02T07:00:00Z', ['q1', 'q2'], ['w1', 'w3', 'w2']), // the compared one
      line('2026-10-02T14:00:00Z', 'AAA', 'Q1', 'q1', offense, 'QB', 9, 1), // a partial pull: skipped
      ...chart('2026-10-03T07:00:00Z', ['q2', 'q1'], ['w1', 'w3', 'w4']), // same day as the newest: not compared
      ...chart('2026-10-03T14:00:00Z', ['q2', 'q1'], ['w1', 'w3', 'w4']),
    ].join('\n');
    const [snap] = extractDepthCharts(parseCsv(csv)).data;
    expect(snap!.dt).toBe('2026-10-03T14:00:00Z');
    expect(snap!.prevDt).toBe('2026-10-02T07:00:00Z');
    expect(snap!.rows.every((r) => r.grp === offense)).toBe(true);
    expect(snap!.rows).toHaveLength(5);

    const players = new Map<string, PlayerResult>([['q2', { id: 'q2', group: 'QB', scores: { production: 71.6 } } as PlayerResult]]);
    const view = depthChartView(snap!, players, new Map([['w4', 'Questionable']]));
    expect(view.asOf).toBe('2026-10-03');
    expect(view.comparedWith).toBe('2026-10-02');
    const [wr, qb] = view.groups[0]!.slots; // slot 1 (WR) before slot 9 (QB)
    expect(qb!.players.map((p) => [p.id, p.change, p.prevRank])).toEqual([['q2', 'up', 2], ['q1', 'down', 1]]);
    expect(qb!.players[0]!.score).toBe(72);
    expect(wr!.players.map((p) => [p.id, p.change])).toEqual([['w1', null], ['w3', null], ['w4', 'new']]);
    expect(wr!.players[2]!.designation).toBe('Questionable');
    expect(wr!.gone).toEqual([{ id: 'w2', name: 'W2', prevRank: 3 }]);
    expect(view.changes).toBe(4);
  });

  it('no earlier snapshot: nothing is flagged', () => {
    const cur: DepthRow[] = [{ grp: offense, pos: 'QB', slot: 9, rank: 1, id: 'q1', name: 'Q1' }];
    const d = diffSlot(cur, null);
    expect(d.flags.get('q1')).toEqual({ change: null, prevRank: null });
    expect(d.gone).toEqual([]);
    const [snap] = extractDepthCharts(parseCsv([HEAD, ...chart('2026-10-03T07:00:00Z', ['q1'], ['w1'])].join('\n'))).data;
    expect(snap!.prevDt).toBeNull();
    expect(depthChartView(snap!, new Map(), new Map()).changes).toBe(0);
  });

  it('designation: this week\'s injury report status, else a reserve roster status', () => {
    const d = designations(
      [
        { p: 'a', t: 'AAA', wk: 5, name: 'A', pos: 'WR', report: 'Out', practice: '', injury: 'Knee' },
        { p: 'b', t: 'AAA', wk: 4, name: 'B', pos: 'WR', report: 'Questionable', practice: '', injury: '' }, // last week's
        { p: 'c', t: 'AAA', wk: 5, name: 'C', pos: 'WR', report: '', practice: 'Full Participation in Practice', injury: '' },
      ],
      [{ gsis: 'r', pfr: null, name: 'R', team: 'AAA', depth: 'WR', week: 5, status: 'RES' }],
      5,
    );
    expect(Object.fromEntries(d)).toEqual({ a: 'Out', r: 'Reserve/IR' });
  });
});
