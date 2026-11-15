import { describe, expect, it } from 'vitest';
import { FANTASY_ALLOWED, GAME_LOG } from '../src/model/config.ts';
import { allowedWindow, currentWeek, fantasyAllowed, pointsCells } from '../src/model/fantasyAllowed.ts';
import type { Game, PlayerWeek } from '../src/model/types.ts';

const pprQB = GAME_LOG.columns.QB.findIndex((c) => c.label === 'PPR');
const pprSK = GAME_LOG.columns.SKILL.findIndex((c) => c.label === 'PPR');
const line = (p: string, pos: string, t: string, opp: string, g: string, wk: number, pts: number): PlayerWeek => {
  const kind = pos === 'QB' ? 'QB' : 'SKILL';
  const cols = GAME_LOG.columns[kind];
  return { p, name: p, pos, kind, t, opp, g, wk, v: cols.map((_, i) => (i === (kind === 'QB' ? pprQB : pprSK) ? pts : 0)) };
};
const game = (id: string, week: number, home: string, away: string, played = true): Game =>
  ({ id, week, gameday: `2026-09-${10 + week}`, home, away, homeScore: played ? 20 : null, awayScore: played ? 17 : null, neutral: false });

describe('fantasy points allowed', () => {
  it('adds each position\'s points up by the defense they were scored against', () => {
    const games = [game('g1', 1, 'AAA', 'BBB')];
    const weeks = [
      line('qb1', 'QB', 'AAA', 'BBB', 'g1', 1, 20),
      line('rb1', 'RB', 'AAA', 'BBB', 'g1', 1, 12),
      line('fb1', 'FB', 'AAA', 'BBB', 'g1', 1, 3), // a fullback counts as RB
      line('wr1', 'WR', 'AAA', 'BBB', 'g1', 1, 15),
      line('wr2', 'WR', 'AAA', 'BBB', 'g1', 1, 7.5),
      line('te1', 'TE', 'BBB', 'AAA', 'g1', 1, 9),
    ];
    const cells = pointsCells(weeks, games);
    const byOff = Object.fromEntries(cells.map((c) => [c.off, c]));
    expect(byOff.AAA!.def).toBe('BBB');
    expect(byOff.AAA!.home).toBe(1);
    expect(byOff.AAA!.points).toEqual({ QB: 20, RB: 15, WR: 22.5, TE: 0 });
    expect(byOff.BBB!.points).toEqual({ QB: 0, RB: 0, WR: 0, TE: 9 });
    const out = fantasyAllowed(weeks, games, ['AAA', 'BBB']);
    expect(out.teams.BBB!.WR!.season.raw).toBe(22.5);
    expect(out.teams.AAA!.TE!.season.raw).toBe(9);
    expect(out.teams.BBB!.WR!.season.rawRank).toBe(1); // allows the most
  });

  it('opponent adjustment: with no penalty it recovers each defense\'s true effect, crediting a hard schedule', () => {
    // points = 10 + offense + defense, every pair once each way at home and away, no noise
    const OFF: Record<string, number> = { A: 6, B: 2, C: -3, D: -5 };
    const DEF: Record<string, number> = { A: -4, B: 0, C: 1, D: 3 };
    const teams = Object.keys(OFF);
    const games: Game[] = [];
    const weeks: PlayerWeek[] = [];
    let n = 0;
    for (const h of teams) for (const a of teams) {
      if (h === a) continue;
      const id = `g${n++}`;
      games.push(game(id, 1 + (n % 17), h, a));
      weeks.push(line(`${h}wr`, 'WR', h, a, id, 1, 10 + OFF[h]! + DEF[a]!));
      weeks.push(line(`${a}wr`, 'WR', a, h, id, 1, 10 + OFF[a]! + DEF[h]!));
    }
    const exact = allowedWindow(pointsCells(weeks, games), 'WR', teams, { ...FANTASY_ALLOWED, lambdaGames: 0, homeField: false, tolerance: 1e-12, maxIterations: 5000 });
    for (const t of teams) expect(exact[t]!.adjusted).toBeCloseTo(10 + DEF[t]!, 1);

    // E's defense has faced only the best offense (A), F's only the worst (D); both are truly average (0)
    const extra: PlayerWeek[] = [];
    const g2: Game[] = [];
    for (let i = 0; i < 4; i++) {
      g2.push(game(`e${i}`, 1, 'A', 'E'), game(`f${i}`, 1, 'D', 'F'));
      extra.push(line('Awr', 'WR', 'A', 'E', `e${i}`, 1, 10 + OFF.A!), line('Ewr', 'WR', 'E', 'A', `e${i}`, 1, 10 + DEF.A!));
      extra.push(line('Dwr', 'WR', 'D', 'F', `f${i}`, 1, 10 + OFF.D!), line('Fwr', 'WR', 'F', 'D', `f${i}`, 1, 10 + DEF.D!));
    }
    const all = allowedWindow(pointsCells([...weeks, ...extra], [...games, ...g2]), 'WR', [...teams, 'E', 'F'], { ...FANTASY_ALLOWED, lambdaGames: 0, homeField: false, tolerance: 1e-12, maxIterations: 5000 });
    expect(all.E!.raw).toBeGreaterThan(all.F!.raw);
    expect(all.E!.adjusted).toBeCloseTo(all.F!.adjusted, 1);
    expect(all.E!.rawRank).toBeLessThan(all.F!.rawRank);
  });

  it('the recent window covers the last N weeks played; the penalty shrinks toward average', () => {
    const games: Game[] = [];
    const weeks: PlayerWeek[] = [];
    for (let w = 1; w <= 6; w++) {
      games.push(game(`w${w}`, w, 'AAA', 'BBB'));
      weeks.push(line('x', 'TE', 'AAA', 'BBB', `w${w}`, w, w <= 2 ? 30 : 5));
      weeks.push(line('y', 'TE', 'BBB', 'AAA', `w${w}`, w, 5));
    }
    games.push(game('w7', 7, 'AAA', 'BBB', false));
    const out = fantasyAllowed(weeks, games, ['AAA', 'BBB'], { ...FANTASY_ALLOWED, recentWeeks: 4 });
    expect(out.fromWeek).toBe(3);
    expect(out.throughWeek).toBe(6);
    expect(out.teams.BBB!.TE!.recent!.raw).toBe(5);
    expect(out.teams.BBB!.TE!.recent!.games).toBe(4);
    expect(out.teams.BBB!.TE!.season.raw).toBe(13.3); // (30 + 30 + 4 x 5) / 6
    const spread = (x: { BBB: number; AAA: number }) => Math.abs(x.BBB - x.AAA);
    const s0 = fantasyAllowed(weeks, games, ['AAA', 'BBB'], { ...FANTASY_ALLOWED, lambdaGames: 0 }).teams;
    const s9 = fantasyAllowed(weeks, games, ['AAA', 'BBB'], { ...FANTASY_ALLOWED, lambdaGames: 9 }).teams;
    expect(spread({ BBB: s9.BBB!.TE!.season.adjusted, AAA: s9.AAA!.TE!.season.adjusted }))
      .toBeLessThan(spread({ BBB: s0.BBB!.TE!.season.adjusted, AAA: s0.AAA!.TE!.season.adjusted }));
    expect(currentWeek(games)).toBe(7);
  });
});
