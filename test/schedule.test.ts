import { describe, expect, it } from 'vitest';
import { GAME_LOG, TEAM_SCHEDULE } from '../src/model/config.ts';
import { columnIndexes, teamSchedules } from '../src/model/schedule.ts';
import type { Game, PlayerWeek, TeamGame } from '../src/model/types.ts';

const col = (kind: 'QB' | 'SKILL' | 'DEF', title: string): number => GAME_LOG.columns[kind].findIndex((c) => c.title === title);
const line = (kind: 'QB' | 'SKILL' | 'DEF', vals: Record<string, number>): number[] => {
  const v = Array(GAME_LOG.columns[kind].length).fill(0);
  for (const [t, x] of Object.entries(vals)) v[col(kind, t)] = x;
  return v;
};
const pw = (p: string, t: string, opp: string, g: string, kind: 'QB' | 'SKILL' | 'DEF', vals: Record<string, number>): PlayerWeek =>
  ({ p, name: p, pos: kind, kind, t, opp, g, wk: 1, v: line(kind, vals) });
const tg = (game: string, off: string, def: string, passN: number, passEpa: number, rushN: number, rushEpa: number): TeamGame =>
  ({ game, off, def, offHome: 0, passN, passEpa, rushN, rushEpa, rushHits: 0, covN: 0, covEpa: 0 });

describe('team schedule', () => {
  it('every config column names a real game log column', () => {
    expect(columnIndexes().flat().every(([, i]) => i >= 0)).toBe(true);
    expect(() => columnIndexes({ ...TEAM_SCHEDULE, stats: [{ label: 'X', title: 'X', rows: 'team', from: [['QB', 'Nope']], decimals: 0 }] })).toThrow(/Nope/);
  });

  it('result, EPA per play both ways and box-score totals per game; unplayed games listed without stats', () => {
    const games: Game[] = [
      { id: 'g2', week: 2, gameday: '2026-09-20', home: 'BBB', away: 'AAA', homeScore: null, awayScore: null, neutral: false },
      { id: 'g1', week: 1, gameday: '2026-09-13', home: 'AAA', away: 'BBB', homeScore: 24, awayScore: 17, neutral: false },
    ];
    const tgs = [tg('g1', 'AAA', 'BBB', 30, 6, 20, -1), tg('g1', 'BBB', 'AAA', 40, -4, 10, 0)];
    const weeks = [
      pw('q', 'AAA', 'BBB', 'g1', 'QB', { 'Passing yards': 250, 'Rushing yards': 10, 'Sacks taken': 2, 'Interceptions thrown': 1 }),
      pw('r', 'AAA', 'BBB', 'g1', 'SKILL', { 'Rushing yards': 90 }),
      pw('d', 'AAA', 'BBB', 'g1', 'DEF', { Sacks: 1.5, Interceptions: 1 }),
      pw('e', 'AAA', 'BBB', 'g1', 'DEF', { Sacks: 1 }),
      pw('q2', 'BBB', 'AAA', 'g1', 'QB', { 'Passing yards': 200, 'Rushing yards': 5 }),
      pw('r2', 'BBB', 'AAA', 'g1', 'SKILL', { 'Rushing yards': 40 }),
    ];
    const [a, b] = teamSchedules(games, tgs, weeks, ['AAA', 'BBB']);
    expect(a!.games.map((g) => [g.wk, g.opp, g.home, g.result])).toEqual([[1, 'BBB', true, 'W 24-17'], [2, 'BBB', false, '']]);
    const labels = TEAM_SCHEDULE.stats.map((s) => s.label);
    const byLabel = (v: (number | null)[] | null) => Object.fromEntries(labels.map((l, i) => [l, v?.[i]]));
    expect(a!.games[0]!.offEpa).toBe(0.1);
    expect(a!.games[0]!.defEpa).toBe(-0.08);
    expect(byLabel(a!.games[0]!.v)).toEqual({ PaYd: 250, RuYd: 100, SkA: 2, IntT: 1, PaYdA: 200, RuYdA: 45, Sck: 2.5, Int: 1 });
    expect(a!.games[1]).toMatchObject({ offEpa: null, defEpa: null, v: null });
    expect(b!.games[0]!.result).toBe('L 17-24');
    expect(byLabel(b!.games[0]!.v)).toMatchObject({ PaYd: 200, PaYdA: 250, Sck: 0 });
    expect(a!.season).toMatchObject({ offEpa: 0.1, defEpa: -0.08 });
    expect(byLabel(a!.season.v).PaYd).toBe(250);
  });
});
