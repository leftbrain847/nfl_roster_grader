import { describe, expect, it } from 'vitest';
import { MATCHUP } from '../src/model/config.ts';
import { buildMatchups, clash, edgeWord, matchupPlayers, playerEdgeWord } from '../src/model/matchups.ts';
import type { Game, Matchup, PlayerResult, TeamResult } from '../src/model/types.ts';

const unit = (grade: number, rank: number) => ({ adjusted: 0, raw: 0, plays: 100, grade, rank });
const team = (code: string, po: number, ro: number, pd: number, rd: number): TeamResult => ({
  team: code, units: { passOffense: unit(po, 1), rushOffense: unit(ro, 2), passDefense: unit(pd, 3), rushDefense: unit(rd, 4) },
} as TeamResult);

describe('matchups', () => {
  it('edge = offense grade - defense grade, with words from config', () => {
    expect(MATCHUP.edgeWords[0]![0]).toBe(20);
    expect(edgeWord(25)).toBe('Big edge offense');
    expect(edgeWord(10)).toBe('Edge offense');
    expect(edgeWord(0)).toBe('Even');
    expect(edgeWord(-10)).toBe('Edge defense');
    expect(edgeWord(-30)).toBe('Big edge defense');
    expect(clash({ grade: 80, rank: 3 }, { grade: 45, rank: 18 })).toEqual({ offGrade: 80, offRank: 3, defGrade: 45, defRank: 18, edge: 35, word: 'Big edge offense' });
  });

  it('one card per game this week: each offense against the other defense, with the other parts joined in', () => {
    const games: Game[] = [
      { id: 'g1', week: 4, gameday: '2026-10-04', home: 'HHH', away: 'AAA', homeScore: null, awayScore: null, neutral: false },
      { id: 'g0', week: 3, gameday: '2026-09-27', home: 'HHH', away: 'AAA', homeScore: 10, awayScore: 7, neutral: false },
    ];
    const ms = buildMatchups(games, 4, {
      teams: [team('AAA', 70, 40, 60, 50), team('HHH', 30, 55, 20, 65)],
      fantasyAllowed: { recentWeeks: 4, fromWeek: 1, throughWeek: 3, teams: { HHH: { WR: { season: { games: 3, raw: 40, adjusted: 38, rawRank: 1, adjustedRank: 2 }, recent: null } } } },
      redZone: { zones: [{ key: 'a', label: 'A', maxYardline: 20 }], weeks: [3], teams: { AAA: { season: [6, 4], weeks: [], players: [
        { id: 'w', name: 'W', pos: 'WR', season: [3, 0], weeks: [] }, { id: 'r', name: 'R', pos: 'RB', season: [1, 4], weeks: [] },
      ] } } },
      practice: { week: 4, published: true, latestWeek: 4, note: '', teams: { AAA: [
        { id: 'x', name: 'X', pos: 'WR', practice: 'DNP', game: 'Out', injury: 'Knee' },
        { id: 'y', name: 'Y', pos: 'WR', practice: 'Full', game: null, injury: 'Rest' },
      ] } },
    });
    expect(ms).toHaveLength(1);
    const [away, home] = ms[0]!.sides;
    expect(away.team).toBe('AAA');
    expect(away.pass).toMatchObject({ offGrade: 70, defGrade: 20, edge: 50 });
    expect(away.rush).toMatchObject({ offGrade: 40, defGrade: 65, edge: -25, word: 'Big edge defense' });
    expect(home.pass.edge).toBe(30 - 60);
    expect(away.fantasyAllowed).toEqual({ WR: { adjusted: 38, rank: 2 } }); // what HHH's defense allows
    expect(away.redZone.map((p) => [p.id, p.shares[0]])).toEqual([['w', 0.3], ['r', 0.5]]);
    expect(away.status.map((s) => s.id)).toEqual(['x']);
    expect(home.redZone).toEqual([]);
    expect(away.personnel).toBeNull();
  });

  it('players view: each ranked player in a game this week against the opposing unit his position faces', () => {
    const teams = [
      { ...team('AAA', 70, 40, 60, 50), line: { passPro: { value: 30, grade: 35, rank: 25 }, runBlock: null } },
      { ...team('HHH', 30, 55, 20, 65), line: { passPro: null, runBlock: null } },
      { ...team('ZZZ', 50, 50, 50, 50), line: { passPro: null, runBlock: null } },
    ] as TeamResult[];
    const ms = [{ id: 'g1', away: 'AAA', home: 'HHH' }] as Matchup[];
    const pl = (id: string, t: string, group: PlayerResult['group'], production: number): PlayerResult =>
      ({ id, name: id.toUpperCase(), team: t, group, scores: { production }, rank: 1, qualifiedAtPosition: 10 } as PlayerResult);
    const out = matchupPlayers(ms, [pl('qb', 'AAA', 'QB', 90), pl('edge', 'HHH', 'EDGE', 60), pl('cb', 'HHH', 'CB', 40), pl('idl', 'AAA', 'IDL', 50), pl('bye', 'ZZZ', 'QB', 99)], teams, {
      week: 4, published: true, latestWeek: 4, note: '', teams: { HHH: [{ id: 'edge', name: 'E', pos: 'DE', practice: 'Limited', game: 'Questionable', injury: 'Knee' }] },
    });
    expect(out.map((p) => p.id)).toEqual(['qb', 'edge', 'idl', 'cb']); // best score first; the team on a bye is left out
    expect(out[0]).toMatchObject({ opp: 'HHH', game: 'g1', vs: { label: MATCHUP.versus.QB.label, grade: 20, rank: 3 }, edge: 70, word: 'Big edge', status: null });
    // an edge rusher faces the other team's pass protection
    expect(out[1]).toMatchObject({ opp: 'AAA', vs: { label: 'pass pro', grade: 35, rank: 25 }, edge: 25, status: 'Questionable' });
    // no line grade for the opponent: listed without a matchup
    expect(out[2]).toMatchObject({ vs: null, edge: null, word: null });
    // a corner faces the other team's pass offense
    expect(out[3]).toMatchObject({ vs: { grade: 70 }, edge: -30, word: MATCHUP.playerFallbackWord });
    expect(playerEdgeWord(0)).toBe('Even');
    expect(playerEdgeWord(-10)).toBe('Tough');
  });
});
