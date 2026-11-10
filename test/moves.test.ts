import { describe, expect, it } from 'vitest';
import { MOVES } from '../src/model/config.ts';
import { buildMoves, positionGroup, rosterMove } from '../src/model/moves.ts';
import type { Game, ModelInputs } from '../src/model/types.ts';

const empty: ModelInputs = {
  season: 2026, games: [], teamGames: [], playerGames: [], pfrPass: [], pfrRush: [], pfrRec: [], pfrDef: [], snaps: [],
  ngsPassing: [], ngsReceiving: [], ngsRushing: [], roster: [], contracts: [], playerWeeks: [],
};
const game = (week: number, gameday: string): Game => ({ id: `g${week}`, week, gameday, home: 'AAA', away: 'BBB', homeScore: null, awayScore: null, neutral: false });

describe('roster moves (week to week)', () => {
  it('names each change: released, signed, re-signed, reserve, activated, practice squad, promoted, changed teams', () => {
    const at = (team: string, status: string): [number, string, string] => [2, team, status];
    expect(rosterMove(at('AAA', 'ACT'), at('AAA', 'CUT'))?.kind).toBe('released');
    expect(rosterMove(at('AAA', 'CUT'), at('BBB', 'ACT'))).toEqual({ kind: 'signed', from: 'AAA', detail: 'Signed by BBB (released by AAA)' });
    expect(rosterMove(at('AAA', 'DEV'), at('BBB', 'ACT'))?.detail).toBe("Signed by BBB, off AAA's practice squad");
    expect(rosterMove(at('AAA', 'CUT'), at('AAA', 'DEV'))?.detail).toBe("Re-signed to AAA's practice squad");
    expect(rosterMove(at('AAA', 'ACT'), at('AAA', 'RES'))?.kind).toBe('reserve');
    expect(rosterMove(at('AAA', 'RES'), at('AAA', 'ACT'))?.kind).toBe('activated');
    expect(rosterMove(at('AAA', 'ACT'), at('AAA', 'DEV'))?.kind).toBe('practice');
    expect(rosterMove(at('AAA', 'DEV'), at('AAA', 'ACT'))?.kind).toBe('promoted');
    expect(rosterMove(at('AAA', 'ACT'), at('BBB', 'ACT'))?.kind).toBe('moved');
    expect(rosterMove(at('AAA', 'TRC'), at('BBB', 'DEV'))).toEqual({ kind: 'signed', from: 'AAA', detail: "Signed to BBB's practice squad, from AAA" });
    expect(rosterMove(null, at('BBB', 'DEV'))?.detail).toBe("Signed to BBB's practice squad");
  });

  it('a game-day inactive and back is not a move', () => {
    expect(rosterMove([1, 'AAA', 'ACT'], [2, 'AAA', 'INA'])).toBeNull();
    expect(rosterMove([1, 'AAA', 'INA'], [2, 'AAA', 'ACT'])).toBeNull();
  });

  it('players on a roster from week 1 are not listed as signed; a move is dated by its week\'s first game', () => {
    const moves = buildMoves({
      ...empty, games: [game(1, '2026-09-10'), game(2, '2026-09-17'), game(3, '2026-09-24')],
      rosterHistory: [
        { p: 'x', f: null, n: 'Starter', pos: 'WR', h: [[1, 'AAA', 'ACT'], [3, 'AAA', 'RES']] },
        { p: 'y', f: null, n: 'Newcomer', pos: 'OT', h: [[2, 'BBB', 'ACT']] },
      ],
    });
    expect(moves.map((m) => [m.name, m.kind, m.date, m.when, m.group])).toEqual([
      ['Starter', 'reserve', '2026-09-24', 'Week 3', 'WR'],
      ['Newcomer', 'signed', '2026-09-17', 'Week 2', 'OL'],
    ]);
  });
});

describe('trades and the draft', () => {
  it('a trade lists each asset, what came back, and links a player by his PFR id', () => {
    const moves = buildMoves({
      ...empty,
      rosterHistory: [{ p: '00-1', f: 'SweaTV01', n: "T'Vondre Sweat", pos: 'DT', h: [[1, 'NYJ', 'ACT']] }],
      trades: [
        { id: '1', date: '2026-02-26', gave: 'TEN', received: 'NYJ', pfr: 'SweaTV01', name: "T'Vondre Sweat", pickSeason: null, pickRound: null },
        { id: '1', date: '2026-02-26', gave: 'NYJ', received: 'TEN', pfr: null, name: '', pickSeason: 2026, pickRound: 5 },
      ],
    });
    const p = moves.find((m) => m.name === "T'Vondre Sweat");
    expect(p).toMatchObject({ kind: 'trade', id: '00-1', team: 'NYJ', from: 'TEN', group: 'DL', when: 'Feb 26', detail: 'Traded from TEN to NYJ for 2026 round 5 pick' });
    expect(moves.find((m) => m.name === '2026 round 5 pick')).toMatchObject({ team: 'TEN', from: 'NYJ', id: null, group: MOVES.other });
  });

  it('draft picks sort by pick on draft day, after trades on the same day; newest first overall', () => {
    const moves = buildMoves({
      ...empty,
      draft: [
        { season: 2026, round: 1, pick: 2, team: 'NYJ', gsis: 'b', name: 'Second', pos: 'DE' },
        { season: 2026, round: 1, pick: 1, team: 'LV', gsis: 'a', name: 'First', pos: 'QB' },
      ],
      trades: [{ id: '9', date: '2026-10-30', gave: 'AAA', received: 'BBB', pfr: null, name: 'Late Deal', pickSeason: null, pickRound: null }],
    });
    expect(moves.map((m) => m.name)).toEqual(['Late Deal', 'First', 'Second']);
    expect(moves[1]).toMatchObject({ when: '2026 draft', date: MOVES.draftDay[2026], detail: 'Round 1, pick 1 overall' });
  });

  it('positions from any file map to one filter group', () => {
    expect(['OT', 'G', 'C', 'T'].map((p) => positionGroup(p))).toEqual(['OL', 'OL', 'OL', 'OL']);
    expect(['DE', 'NT', 'OLB', 'SAF', 'LS', 'xx'].map((p) => positionGroup(p))).toEqual(['DL', 'DL', 'LB', 'DB', 'ST', MOVES.other]);
  });
});
