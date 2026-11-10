import { describe, expect, it } from 'vitest';
import { MOVE_GRADE, type UnitKey } from '../src/model/config.ts';
import { combine, costScore, gradeMoves, wordFor, type MoveGradeInputs } from '../src/model/moveGrades.ts';
import type { UnitGrades } from '../src/model/grades.ts';
import type { Contract, Game, Move, PlayerResult, PlayerValue, TeamGame, UnitResult } from '../src/model/types.ts';

const unit = (grade: number, rank: number): UnitResult => ({ adjusted: 0, raw: 0, plays: 100, grade, rank });
const units = (passD: number, rank: number): Record<UnitKey, UnitResult> => ({
  passOffense: unit(50, 16), rushOffense: unit(50, 16), passDefense: unit(passD, rank), rushDefense: unit(60, 10),
});
const player = (id: string, production: number): PlayerResult => ({ id, name: id, team: 'JAX', group: 'EDGE', scores: { production } } as unknown as PlayerResult);
const value = (id: string, worth: number, cap: number): PlayerValue => ({ id, name: id, team: 'JAX', group: 'EDGE', production: 0, capMillions: cap, worthMillions: worth, surplus: worth - cap });
const contract = (gsis: string, caps: number[]): Contract => ({
  gsis, apyMillions: 0, capPct: 0, lastYear: 2025 + caps.length, baseSalaryMillions: null,
  seasons: caps.map((cap, i) => ({ year: 2026 + i, base: null, cap, cash: null })),
});
const move = (over: Partial<Move>): Move => ({ date: '2026-11-08', when: 'Week 10', kind: 'moved', id: 'p1', name: 'P One', pos: 'DE', group: 'DL', team: 'JAX', from: 'PHI', detail: '', ...over });

const base: MoveGradeInputs = {
  season: 2026, games: [], teamGames: [], teams: ['JAX', 'PHI'],
  // JAX: contender with a weak pass D; PHI: out of the race with a strong one
  seasonNow: { grades: { units: { JAX: units(10, 30), PHI: units(90, 2) } } as unknown as UnitGrades, odds: { JAX: 0.9, PHI: 0.1 } },
  players: [player('p1', 90), player('p2', 20)],
  values: [value('p1', 20, 5), value('p2', 3, 15)],
  contracts: [contract('p1', [5, 5]), contract('p2', [15, 15, 15])],
};

describe('move grades', () => {
  it('a good, cheap player at a weak unit is a great add; the team that gave him up at a strong unit still loses value', () => {
    const [m] = gradeMoves([move({})], base);
    const [jax, phi] = m?.grades ?? [];
    expect(jax?.team).toBe('JAX');
    expect(jax?.word).toBe('Great');
    expect(jax?.reason).toBe('pass D 30th (season so far) · 90% playoff odds (season so far) · 90th pct producer · $15M/yr under his worth for 2 yrs');
    expect(phi?.team).toBe('PHI');
    expect(phi?.score).toBeLessThan(jax?.score ?? 0);
  });

  it('releasing an overpaid low producer at a strong unit grades well; adding him grades badly', () => {
    const [rel] = gradeMoves([move({ kind: 'released', id: 'p2', team: 'PHI', from: null })], base);
    const [add] = gradeMoves([move({ kind: 'signed', id: 'p2', team: 'PHI', from: null })], base);
    expect(rel?.grades?.[0]?.score).toBeGreaterThan(65);
    expect(add?.grades?.[0]?.score).toBeLessThan(35);
    expect((rel?.grades?.[0]?.score ?? 0) + (add?.grades?.[0]?.score ?? 0)).toBe(100);
  });

  it('leaves out what it cannot judge: picks, unranked players, linemen, and non-decisions', () => {
    const out = gradeMoves([
      move({ kind: 'trade', id: null, name: '2027 round 1 pick', group: 'Other', pick: true, pickOf: { season: 2027, round: 1, number: null } }),
      move({ kind: 'signed', id: 'nobody', from: null }),
      move({ kind: 'signed', id: 'ol1', group: 'OL', from: null }),
      move({ kind: 'reserve', from: null }),
    ], base);
    expect(out[0]?.grades?.[0]).toMatchObject({ score: null, reason: expect.stringMatching(/^Worth \$[\d.]+M: 2027 1st \(valued as pick 16, the middle of the round\)$/) });
    expect(out[1]?.grades?.[0]).toMatchObject({ score: null, reason: 'No ranked production this season' });
    expect(out[2]?.grades?.[0]?.reason).toBe('No individual production stat at his position');
    expect(out[3]?.grades).toBeUndefined();
    // a traded player the roster couldn't match is not called a pick
    expect(gradeMoves([move({ kind: 'trade', id: null })], base)[0]?.grades?.[0]?.reason).toBe('Player not matched to a roster');
  });

  it('pay unknown and a team with no unit grades still grade on what is there', () => {
    const [m] = gradeMoves([move({ kind: 'signed', id: 'p3', team: 'NYG', from: null })], { ...base, players: [...base.players, player('p3', 60)] });
    expect(m?.grades?.[0]).toMatchObject({ team: 'NYG', score: 60, reason: '60th pct producer · pay unknown' });
  });

  it('need comes from the games before the move once the team has enough of them', () => {
    const games: Game[] = [1, 2, 3].map((w) => ({ id: `g${w}`, week: w, gameday: `2026-09-0${w}`, home: 'JAX', away: 'PHI', homeScore: 20, awayScore: 10, neutral: false }));
    const tg = (game: string, off: string, def: string, epa: number): TeamGame => ({ game, off, def, offHome: off === 'JAX' ? 1 : 0, passN: 30, passEpa: epa * 30, rushN: 20, rushEpa: 0, rushHits: 3, covN: 25, covEpa: epa * 25 });
    const teamGames = games.flatMap((g) => [tg(g.id, 'JAX', 'PHI', 0.2), tg(g.id, 'PHI', 'JAX', -0.2)]);
    const inp = { ...base, games, teamGames };
    const late = gradeMoves([move({ date: '2026-09-03' })], inp)[0]?.grades?.[0]?.reason ?? '';
    const early = gradeMoves([move({ date: '2026-09-02' })], inp)[0]?.grades?.[0]?.reason ?? '';
    expect(late).toMatch(/^pass D \d+(st|nd|rd|th) before · /);
    expect(late).not.toContain('30th');   // not the season-so-far stand-in
    expect(early).toContain('(season so far)');
    expect(gradeMoves([move({ date: '' })], inp)[0]?.grades?.[0]?.reason).toContain('(season so far)');
  });

  it('playoff odds: selling talent grades better for a team out of the race than for a contender', () => {
    const sell = (odds: number): number => gradeMoves([move({ kind: 'released', team: 'PHI', from: null })], { ...base, seasonNow: { ...base.seasonNow, odds: { PHI: odds } } })[0]?.grades?.[0]?.score ?? 0;
    expect(sell(0.05)).toBeGreaterThan(sell(0.95));
    expect(sell(0.05) - sell(0.95)).toBeCloseTo(100 * 0.9 * MOVE_GRADE.weights.window / (MOVE_GRADE.weights.need + MOVE_GRADE.weights.production + MOVE_GRADE.weights.cost + MOVE_GRADE.weights.window), -0.5);
  });

  it('parts: cost is 50 at fair pay, words follow the thresholds, missing parts drop out of the mean', () => {
    expect(costScore(10, 10, 3)).toBe(50);
    expect(costScore(20, 10, 1)).toBeGreaterThan(80);
    expect(wordFor(80)).toBe('Great');
    expect(wordFor(29)).toBe(MOVE_GRADE.fallbackWord);
    expect(combine({ need: null, production: 70, cost: null }, true)).toBe(70);
    expect(combine({ need: null, production: 70, cost: null }, false)).toBeCloseTo(30);
  });
});
