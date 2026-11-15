import { describe, expect, it } from 'vitest';
import { parseCsv } from '../pipeline/csv.ts';
import { extractParticipation, grouping } from '../pipeline/extract.ts';
import { PERSONNEL } from '../src/model/config.ts';
import { estimateRates, exactPersonnel, personnelEstimate } from '../src/model/personnel.ts';
import type { Game, SnapRow } from '../src/model/types.ts';

const game: Game = { id: '2026_03_AAA_BBB', week: 3, gameday: '2026-09-27', home: 'BBB', away: 'AAA', homeScore: 20, awayScore: 17, neutral: false };

/**
 * A known personnel mix on 100 snaps: 60 in 11 (1 RB, 1 TE, 3 WR), 30 in 12 (1 RB, 2 TE, 2 WR), 10 in 21 (2 RB, 1 TE,
 * 2 WR). Snap counts are per player, so the fixture lists who played when: RB1 every snap, FB the 21 snaps, TE1 every
 * snap, TE2 the 12 snaps, WR1-2 every snap, WR3 the 11 snaps. QB and the line play every snap.
 */
const snaps: SnapRow[] = [
  ['QB', 'qb', 100], ['T', 'lt', 100], ['RB', 'rb1', 100], ['FB', 'fb', 10], ['TE', 'te1', 100], ['TE', 'te2', 30],
  ['WR', 'wr1', 100], ['WR', 'wr2', 100], ['WR', 'wr3', 60],
].map(([pos, p, off]) => ({ p: p as string, g: game.id, t: 'AAA', off: off as number, def: 0, ...(PERSONNEL.positions[pos as string] ? { pos: pos as string } : {}) }));

describe('personnel estimate from snap counts', () => {
  it('averages players on the field per snap by position (fullbacks count as backs)', () => {
    const est = personnelEstimate(snaps, [game])!.AAA!;
    expect(est.season).toMatchObject({ snaps: 100, rb: 1.1, te: 1.3, wr: 2.6 });
    expect(est.weeks).toHaveLength(1);
    expect(est.weeks[0]).toMatchObject({ wk: 3, opp: 'BBB' });
  });

  it('with the scales at 1, recovers the exact rates of a mix that only uses 1-2 TEs and 1-2 RBs', () => {
    const r = estimateRates(1.1, 1.3, 2.6, { ...PERSONNEL, heavyScale: 1, twoTeScale: 1 });
    expect(r.heavy).toBeCloseTo(0.4, 9); // 12 (30%) + 21 (10%)
    expect(r.p12).toBeCloseTo(0.3, 9);
    expect(r.p11).toBeCloseTo(0.6, 9);
  });

  it('applies the fitted scales, and clamps to 0-1', () => {
    const r = estimateRates(1.1, 1.3, 2.6);
    expect(r.heavy).toBeCloseTo(PERSONNEL.heavyScale * 0.4, 9);
    expect(r.p12).toBeCloseTo(PERSONNEL.twoTeScale * 0.3, 9);
    expect(r.p11).toBeCloseTo(1 - PERSONNEL.heavyScale * 0.4, 9);
    const empty = estimateRates(1, 0.5, 4.2); // 10 personnel: no heavy, 11 squeezed by 4-WR snaps
    expect(empty).toEqual({ p11: 0, p12: 0, heavy: 0 });
    expect(estimateRates(2.5, 3, 0).heavy).toBe(1);
  });
});

describe('exact personnel (FTN participation)', () => {
  it('reads groupings: backs incl. fullbacks, then tight ends; plays without a QB are not offense', () => {
    expect(grouping('1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR')).toBe('11');
    expect(grouping('1 C, 1 FB, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 2 WR')).toBe('21');
    expect(grouping('1 C, 2 G, 1 QB, 3 T, 2 TE, 1 RB, 1 WR')).toBe('12');
    expect(grouping('2 CB, 1 FB, 1 FS, 1 ILB, 2 OLB, 1 SS, 1 TE, 2 WR')).toBeNull();
    const csv = ['nflverse_game_id,play_id,possession_team,offense_personnel',
      '2025_01_AAA_BBB,1,AAA,"1 QB, 1 RB, 1 TE, 3 WR, 5 OL"',
      '2025_19_AAA_BBB,1,AAA,"1 QB, 1 RB, 1 TE, 3 WR, 5 OL"', // playoffs: left out
      '2024_01_AAA_BBB,1,AAA,"1 QB, 1 RB, 1 TE, 3 WR, 5 OL"', // another season
    ].join('\n');
    expect(extractParticipation(parseCsv(csv), 2025).data).toEqual({ '2025_01_AAA_BBB': [[1, 'AAA', '11']] });
  });

  it('rates and EPA per grouping, counting only plays that join play-by-play', () => {
    const part = { g1: [[1, 'AAA', '11'], [2, 'AAA', '11'], [3, 'AAA', '12'], [4, 'AAA', '21'], [5, 'AAA', '11'], [6, 'AAA', '13']] as [number, string, string][] };
    const plays = { g1: [[1, 0.5], [2, -0.1], [3, 0.2], [4, 1], [6, -0.3]] as [number, number][] }; // play 5: a penalty, no EPA row
    const ex = exactPersonnel(2025, part, plays, 'credit')!;
    const t = ex.teams.AAA!;
    expect(t.plays).toBe(5);
    expect(t).toMatchObject({ p11: 0.4, p12: 0.2, heavy: 0.6 });
    expect(t.groupings.find((g) => g.code === '11')).toEqual({ code: '11', plays: 2, rate: 0.4, epa: 0.2 });
    expect(t.groupings.find((g) => g.code === '13')?.epa).toBe(-0.3);
    expect(ex.credit).toBe('credit');
  });
});
