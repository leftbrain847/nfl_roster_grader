import { describe, expect, it } from 'vitest';
import { VERDICT } from '../src/model/config.ts';
import { decideVerdict, needFor, scheduleWord, type VerdictInput } from '../src/model/verdict.ts';

const base: VerdictInput = {
  record: '9-3', playoffOdds: 0.8, scheduleLeftRank: 16, teams: 32,
  weakest: 'passDefense', weakestGrade: 20, weakestRank: 27, primaryRank: 30, alternateRank: 5,
};

describe('verdict rules', () => {
  it('a contender with a hole buys for it, with the one-line reason', () => {
    const v = decideVerdict(base);
    expect(v.verdict).toBe('buy');
    expect(v.reason).toBe('Buy pass rush: 9-3, pass D 27th');
    expect(v.need?.positions).toEqual(['EDGE', 'IDL']);
  });

  it('a contender with no unit below the hole grade stands pat', () => {
    const v = decideVerdict({ ...base, weakestGrade: VERDICT.holeGrade, weakestRank: 14 });
    expect(v.verdict).toBe('stand pat');
    expect(v.reason).toBe('Stand pat: 9-3, no weak unit (lowest: pass D 14th)');
  });

  it('long odds sell', () => {
    const v = decideVerdict({ ...base, record: '2-8', playoffOdds: 0.04 });
    expect(v.verdict).toBe('sell');
    expect(v.reason).toBe('Sell: 2-8, 4% playoff odds');
    expect(decideVerdict({ ...base, playoffOdds: VERDICT.sellerOdds }).verdict).toBe('sell');
  });

  it('the bubble: easy schedule + hole buys, hard schedule + low odds sells, else stand pat', () => {
    const bubble = { ...base, record: '5-5', playoffOdds: 0.4 };
    expect(decideVerdict({ ...bubble, scheduleLeftRank: VERDICT.schedule.easyRankMin }).verdict).toBe('buy');
    expect(decideVerdict({ ...bubble, scheduleLeftRank: 16 }).verdict).toBe('stand pat');
    expect(decideVerdict({ ...bubble, playoffOdds: 0.25, scheduleLeftRank: 3 }).reason).toBe('Sell: 5-5, 25% playoff odds, hard schedule left');
    expect(decideVerdict({ ...bubble, scheduleLeftRank: 16 }).reason).toBe('Stand pat: 5-5, 40% playoff odds, average schedule left');
  });

  it('a unit splits into its two halves by which ranks worse', () => {
    expect(needFor('passDefense', 30, 5).label).toBe('pass rush');
    expect(needFor('passDefense', 5, 30).label).toBe('coverage');
    expect(needFor('passOffense', 5, 30)).toMatchObject({ label: 'pass protection', line: 'passPro' });
    expect(needFor('passOffense', 30, 5).positions).toEqual(['WR', 'TE']);
    expect(needFor('rushOffense', 3, 28)).toMatchObject({ label: 'run blocking', line: 'runBlock' });
    expect(needFor('rushOffense', 28, 3).positions).toEqual(['RB']);
    expect(needFor('rushDefense', 1, 32).positions).toEqual(['IDL', 'LB']);
  });

  it('with either half unknown, the primary need is used', () => {
    expect(needFor('passOffense', undefined, 32).label).toBe('a pass catcher');
    expect(needFor('rushOffense', 1, undefined).label).toBe('a running back');
    expect(decideVerdict({ ...base, weakest: 'passOffense', primaryRank: 4, alternateRank: 29 }).reason).toBe('Buy pass protection: 9-3, pass O 27th');
  });

  it('schedule words follow the configured cutoffs', () => {
    expect(scheduleWord(1)).toBe('hard');
    expect(scheduleWord(VERDICT.schedule.hardRankMax + 1)).toBe('average');
    expect(scheduleWord(32)).toBe('easy');
  });
});
