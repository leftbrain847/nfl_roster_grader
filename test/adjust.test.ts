import { describe, expect, it } from 'vitest';
import { ridgeAdjust, type Cell } from '../src/model/adjust.ts';
import { ADJUST } from '../src/model/config.ts';
import { gradeUnits, seriesGrades } from '../src/model/grades.ts';
import type { TeamGame } from '../src/model/types.ts';

// Tiny league: 4 teams with known effects. Every pairing played once each way, 10 plays per cell, no noise.
const OFF = { A: 0.2, B: 0.0, C: -0.1, D: -0.13 };
const DEF = { A: 0.0, B: -0.15, C: 0.05, D: 0.1 }; // EPA allowed: negative = good defense
const MU = 0.02;
const HOME = 0.03;
const teams = Object.keys(OFF) as (keyof typeof OFF)[];

function league(home = true): Cell[] {
  const cells: Cell[] = [];
  for (const o of teams)
    for (const d of teams) {
      if (o === d) continue;
      for (const h of [0, 1] as const) {
        const y = MU + OFF[o] + DEF[d] + (home ? HOME * h : 0);
        cells.push({ off: o, def: d, home: h, n: 10, sum: 10 * y });
      }
    }
  return cells;
}

const opts = { lambda: 0, homeField: true, tolerance: 1e-12, maxIterations: 5000 };
const centred = (x: Record<string, number>) => {
  const m = teams.reduce((s, t) => s + (x[t] ?? 0), 0) / teams.length;
  return Object.fromEntries(teams.map((t) => [t, (x[t] ?? 0) - m]));
};

describe('opponent adjustment (ridge)', () => {
  it('with lambda 0 recovers the true offense, defense and home effects on noise-free data', () => {
    const fit = ridgeAdjust(league(), opts);
    expect(fit.converged).toBe(true);
    const o = centred(fit.off);
    const d = centred(fit.def);
    const to = centred(OFF);
    const td = centred(DEF);
    for (const t of teams) {
      expect(o[t]).toBeCloseTo(to[t] as number, 6);
      expect(d[t]).toBeCloseTo(td[t] as number, 6);
    }
    expect(fit.home).toBeCloseTo(HOME, 6);
  });

  it('credits an offense that faced the good defenses (raw EPA understates it)', () => {
    // Unbalanced schedule: E plays only B (best defense), F plays only D (worst). Same true offense.
    const cells: Cell[] = league(false);
    const add = (off: string, def: string, y: number) => cells.push({ off, def, home: 0, n: 30, sum: 30 * y });
    add('E', 'B', MU + 0.05 + DEF.B);
    add('F', 'D', MU + 0.05 + DEF.D);
    const fit = ridgeAdjust(cells, { ...opts, homeField: false });
    expect(fit.rawOff.E!.mean).toBeLessThan(fit.rawOff.F!.mean);
    expect(fit.off.E!).toBeCloseTo(fit.off.F!, 6);
  });

  it('shrinks small samples toward average as lambda grows, keeping the order', () => {
    const exact = centred(ridgeAdjust(league(), opts).off);
    const shrunk = centred(ridgeAdjust(league(), { ...opts, lambda: 60 }).off);
    const ss = (x: Record<string, number>) => teams.reduce((s, t) => s + (x[t] ?? 0) ** 2, 0);
    expect(ss(shrunk)).toBeLessThan(ss(exact));
    expect(Math.abs(shrunk.A as number)).toBeLessThan(Math.abs(exact.A as number));
    const order = (x: Record<string, number>) => [...teams].sort((a, b) => (x[b] ?? 0) - (x[a] ?? 0));
    expect(order(shrunk)).toEqual(order(exact));
  });

  it('grades: best offense and best defense rank 1 with the highest grades', () => {
    const tg: TeamGame[] = league().map((c, i) => ({
      game: `g${i}`, off: c.off, def: c.def, offHome: c.home, passN: c.n, passEpa: c.sum, rushN: c.n, rushEpa: c.sum,
      rushHits: 1, covN: c.n, covEpa: c.sum,
    }));
    const g = gradeUnits(tg, [...teams]);
    expect(g.units.A!.passOffense.rank).toBe(1);
    expect(g.units.B!.passDefense.rank).toBe(1);
    expect(g.units.D!.passDefense.rank).toBe(4);
    expect(g.units.A!.passOffense.grade).toBeGreaterThan(g.units.B!.passOffense.grade);
    for (const t of teams) for (const u of Object.values(g.units[t]!)) expect(u.grade).toBeGreaterThanOrEqual(0);
  });
});

describe('series success grades', () => {
  it('are fitted like EPA: best offense ranks 1, a defense that allows less ranks better; missing column -> null', () => {
    // series success = 0.65 + offense + defense, no noise
    const SO: Record<string, number> = { A: 0.1, B: 0.03, C: -0.05, D: -0.08 };
    const SD: Record<string, number> = { A: -0.06, B: 0.0, C: 0.02, D: 0.04 };
    const tg: TeamGame[] = league().map((c, i) => {
      const rate = 0.65 + SO[c.off]! + SD[c.def]!;
      return {
        game: `g${i}`, off: c.off, def: c.def, offHome: c.home, passN: 20, passEpa: c.sum, rushN: 10, rushEpa: c.sum,
        rushHits: 1, covN: 10, covEpa: c.sum, passSs: 20 * rate, rushSs: 10 * rate,
      };
    });
    const s = seriesGrades(tg, [...teams], { ...ADJUST, lambdaPlays: { pass: 0, rush: 0 }, homeField: false, tolerance: 1e-12, maxIterations: 5000 })!;
    expect(s.A!.passOffense.rank).toBe(1);
    expect(s.D!.passOffense.rank).toBe(4);
    expect(s.A!.passDefense.rank).toBe(1);
    expect(s.D!.rushDefense.rank).toBe(4);
    const avgDef = Object.values(SD).reduce((a, b) => a + b, 0) / 4;
    // adjusted is on the league's scale: league mean + (effect - average effect)
    expect(s.B!.passDefense.adjusted - s.A!.passDefense.adjusted).toBeCloseTo(SD.B! - SD.A!, 4);
    expect(s.C!.passOffense.raw).toBeCloseTo(0.65 + SO.C! + (4 * avgDef - SD.C!) / 3, 4);
    expect(seriesGrades(tg.map(({ passSs, ...g }) => g), [...teams])).toBeNull();
  });
});
