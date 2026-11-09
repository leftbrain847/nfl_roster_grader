import { describe, expect, it } from 'vitest';
import { LINE_TARGETS, TRADE_COST } from '../src/model/config.ts';
import { playerContract } from '../src/model/contracts.ts';
import { gradeLine, lineRaw, lineStarters, lineTargets, normName } from '../src/model/line.ts';
import type { ModelInputs, RosterPlayer } from '../src/model/types.ts';

const empty: ModelInputs = {
  season: 2026, games: [], teamGames: [], playerGames: [], pfrPass: [], pfrRush: [], pfrRec: [], pfrDef: [], snaps: [],
  ngsPassing: [], ngsReceiving: [], ngsRushing: [], roster: [], contracts: [],
};
const ol = (gsis: string, team: string, pfr: string, depth = 'T', status = 'ACT'): RosterPlayer => ({ gsis, pfr, name: gsis, team, depth, week: 9, status });

describe('offensive line (team level)', () => {
  it('pass protection = PFR pressures per play-by-play dropback, only in team-games PFR covers', () => {
    const raw = lineRaw({
      ...empty,
      pfrPass: [{ p: 'q1', g: 'g1', t: 'AAA', pressured: 10, sacked: 2 }],
      playerGames: [
        { p: 'qb', g: 'g1', t: 'AAA', db: 40 },
        { p: 'qb', g: 'g2', t: 'AAA', db: 35 }, // g2 not in PFR yet: left out of the denominator
      ],
    });
    expect(raw.passPro.AAA).toBe(25);
  });

  it('run blocking = yards before contact per carry; the backs half = yards after contact per carry', () => {
    const raw = lineRaw({ ...empty, pfrRush: [
      { p: 'r1', g: 'g1', t: 'BBB', carries: 10, ybc: 20, yac: 30, btRush: 1, btRec: 0 },
      { p: 'r2', g: 'g1', t: 'BBB', carries: 10, ybc: 40, yac: 10, btRush: 0, btRec: 0 },
    ] });
    expect(raw.runBlock.BBB).toBe(3);
    expect(raw.rbYac.BBB).toBe(2);
  });

  it('grades: a lower pressure rate is better, teams without data get null', () => {
    const g = gradeLine({ A: 20, B: 30, C: 40 }, 'passPro', ['A', 'B', 'C', 'D']);
    expect(g.A!.rank).toBe(1);
    expect(g.C!.rank).toBe(3);
    expect(g.A!.grade).toBeGreaterThan(g.C!.grade);
    expect(g.D).toBeNull();
  });

  it('starters are linemen over the snap-share threshold; targets come from the best lines on sellers', () => {
    const inp: ModelInputs = {
      ...empty,
      roster: [ol('s1', 'SEL', 'p1'), ol('s2', 'SEL', 'p2', 'G'), ol('b1', 'BAD', 'p3'), ol('ir', 'SEL', 'p4', 'C', 'RES'), ol('qb', 'SEL', 'p5', 'QB')],
      snaps: [
        { p: 'p1', g: 'g1', t: 'SEL', off: 60, def: 0 },
        { p: 'p2', g: 'g1', t: 'SEL', off: 20, def: 0 }, // 20 of 60: a backup
        { p: 'p3', g: 'g2', t: 'BAD', off: 55, def: 0 },
        { p: 'p4', g: 'g1', t: 'SEL', off: 60, def: 0 },
        { p: 'p5', g: 'g1', t: 'SEL', off: 60, def: 0 },
      ],
    };
    const starters = lineStarters(inp);
    expect(starters.map((s) => s.id).sort()).toEqual(['b1', 'ir', 's1']);
    expect(LINE_TARGETS.starterShare).toBeGreaterThan(20 / 60);
    const lines = { SEL: { passPro: { value: 20, grade: 90, rank: 1 }, runBlock: null }, BAD: { passPro: { value: 40, grade: 10, rank: 30 }, runBlock: null } };
    const t = lineTargets('passPro', 'BUY', new Set(['SEL', 'BAD']), starters, lines, new Map(), ['ACT']);
    expect(t.map((x) => x.id)).toEqual(['s1', 'b1']); // best line first; the injured starter is left out
    expect(lineTargets('runBlock', 'BUY', new Set(['SEL']), starters, lines, new Map(), ['ACT'])).toEqual([]);
  });

  it('takes at most perSeller starters from one selling team', () => {
    const roster = Array.from({ length: 5 }, (_, i) => ol(`s${i}`, 'SEL', `p${i}`));
    const snaps = roster.map((r) => ({ p: r.pfr as string, g: 'g1', t: 'SEL', off: 60, def: 0 }));
    const starters = lineStarters({ ...empty, roster, snaps });
    const lines = { SEL: { passPro: { value: 20, grade: 90, rank: 1 }, runBlock: null } };
    expect(lineTargets('passPro', 'BUY', new Set(['SEL']), starters, lines, new Map(), ['ACT'])).toHaveLength(LINE_TARGETS.perSeller);
  });
});

describe('line starters without PFR ids (the roster file has none for linemen)', () => {
  it('match snap counts by name, only when the name is unambiguous', () => {
    const inp: ModelInputs = {
      ...empty,
      roster: [
        { gsis: 'a', pfr: null, name: "D'Andre Smith Jr.", team: 'SEL', depth: 'T', week: 9, status: 'ACT' },
        { gsis: 'b', pfr: null, name: 'John Doe', team: 'SEL', depth: 'G', week: 9, status: 'ACT' },
      ],
      snaps: [
        { p: 'p1', g: 'g1', t: 'SEL', off: 60, def: 0, n: 'DAndre Smith' },
        { p: 'p2', g: 'g1', t: 'SEL', off: 60, def: 0, n: 'John Doe' },
        { p: 'p3', g: 'g2', t: 'OTH', off: 60, def: 0, n: 'John Doe' }, // a second John Doe: ambiguous, skipped
      ],
    };
    expect(normName("D'Andre Smith Jr.")).toBe(normName('DAndre Smith'));
    expect(lineStarters(inp).map((s) => s.id)).toEqual(['a']);
  });
});

describe('trade cost', () => {
  it('is the base salary still to be paid this season', () => {
    const c = playerContract({ gsis: 'x', apyMillions: 20, capPct: 0.07, lastYear: 2028, baseSalaryMillions: 9 }, 9);
    expect(c.tradeCostMillions).toBe(9 * (TRADE_COST.payWeeks - 9) / TRADE_COST.payWeeks);
    expect(playerContract({ gsis: 'x', apyMillions: 1, capPct: 0, lastYear: 2026, baseSalaryMillions: null }, 9).tradeCostMillions).toBeNull();
    expect(playerContract({ gsis: 'x', apyMillions: 1, capPct: 0, lastYear: 2026, baseSalaryMillions: 4 }, 25).tradeCostMillions).toBe(0);
  });
});
