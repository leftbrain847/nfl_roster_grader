import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_LOG } from '../src/model/config.ts';
import { contractDetail } from '../src/model/contracts.ts';
import { buildProfiles, logTotals } from '../src/model/profiles.ts';
import type { ModelInputs, PlayerWeek } from '../src/model/types.ts';
import { parseCsv } from '../pipeline/csv.ts';
import { contractSeasons, extractPlayerWeeks } from '../pipeline/extract.ts';

const empty: ModelInputs = {
  season: 2026, games: [], teamGames: [], playerGames: [], pfrPass: [], pfrRush: [], pfrRec: [], pfrDef: [], snaps: [],
  ngsPassing: [], ngsReceiving: [], ngsRushing: [], roster: [], contracts: [], playerWeeks: [],
};
const zeros = (kind: PlayerWeek['kind']): number[] => GAME_LOG.columns[kind].map(() => 0);
const wr = (wk: number, g: string, t: string, opp: string, v: number[]): PlayerWeek => ({ p: 'w1', name: 'Wide Out', pos: 'WR', kind: 'SKILL', t, opp, g, wk, v });

describe('player pages', () => {
  const tgt = GAME_LOG.columns.SKILL.findIndex((c) => c.label === 'Tgt');
  const line = (targets: number): number[] => zeros('SKILL').map((_, i) => (i === tgt ? targets : 0));
  const inp: ModelInputs = {
    ...empty,
    games: [
      { id: 'g1', week: 1, gameday: '2026-09-13', home: 'AAA', away: 'BBB', homeScore: 24, awayScore: 17, neutral: false },
      { id: 'g2', week: 2, gameday: '2026-09-20', home: 'CCC', away: 'AAA', homeScore: 30, awayScore: 10, neutral: false },
      { id: 'g3', week: 3, gameday: '2026-09-27', home: 'AAA', away: 'DDD', homeScore: null, awayScore: null, neutral: false },
    ],
    roster: [{ gsis: 'w1', pfr: 'WideOu00', name: 'Wide Out', team: 'AAA', depth: 'WR', week: 3, status: 'ACT' }],
    snaps: [
      { p: 'WideOu00', g: 'g1', t: 'AAA', off: 30, def: 0 },
      { p: 'LineMa00', g: 'g1', t: 'AAA', off: 60, def: 0 },
      { p: 'WideOu00', g: 'g2', t: 'AAA', off: 0, def: 0 },
      { p: 'LineMa00', g: 'g2', t: 'AAA', off: 50, def: 0 },
    ],
    playerWeeks: [wr(2, 'g2', 'AAA', 'CCC', line(0)), wr(1, 'g1', 'AAA', 'BBB', line(7)), wr(3, 'g3', 'AAA', 'DDD', line(4))],
    contracts: [{ gsis: 'w1', apyMillions: 10, capPct: 0.04, lastYear: 2027, baseSalaryMillions: 9, yearSigned: 2025, years: 3, valueMillions: 30, guaranteedMillions: 12, seasons: [{ year: 2026, base: 9, cap: 11, cash: 9 }] }],
  };

  it('a game log line has the opponent, home or away, the result and the snap share, in week order', () => {
    const [p] = buildProfiles(inp, 2);
    expect(p!.log.map((r) => r.wk)).toEqual([1, 3]);
    expect(p!.log[0]).toMatchObject({ opp: 'BBB', home: true, result: 'W 24-17', snapPct: 50 });
    // week 3: no score yet, and snap counts don't have the game
    expect(p!.log[1]).toMatchObject({ opp: 'DDD', result: '', snapPct: null });
  });

  it('drops a week with no stats and no snaps on his side (special teams only), and a player with nothing at all', () => {
    const [p] = buildProfiles(inp, 2);
    expect(p!.log.some((r) => r.wk === 2)).toBe(false);
    expect(buildProfiles({ ...inp, playerWeeks: [wr(2, 'g2', 'AAA', 'CCC', line(0))] }, 2)).toEqual([]);
  });

  it('totals add each column; the contract carries terms, yearly rows and base salary left', () => {
    const [p] = buildProfiles(inp, 9);
    expect(logTotals(p!.log, GAME_LOG.columns.SKILL.map((c) => c.decimals))[tgt]).toBe(11);
    expect(p!.contract).toMatchObject({ years: 3, valueMillions: 30, guaranteedMillions: 12, yearSigned: 2025, baseSalaryLeftMillions: 4.5 });
    expect(p!.contract!.seasons).toEqual([{ year: 2026, base: 9, cap: 11, cash: 9 }]);
  });

  it('a contract saved before the yearly rows existed still shows, with those parts empty', () => {
    const d = contractDetail({ gsis: 'x', apyMillions: 5, capPct: 0.02, lastYear: 2026, baseSalaryMillions: null }, 3);
    expect(d).toMatchObject({ years: null, valueMillions: null, seasons: [], baseSalaryLeftMillions: null });
  });

  it('contract years: this season onward, without the file\'s Total row', () => {
    const rows = contractSeasons([
      { year: '2025', base_salary: 1, cap_number: 2, cash_paid: 3 },
      { year: '2027', base_salary: 15, cap_number: 21.02, cash_paid: 16.02 },
      { year: '2026', base_salary: 6.98, cap_number: 16.187, cash_paid: null },
      { year: 'Total', base_salary: 55, cap_number: 96, cash_paid: 96 },
    ], 2026);
    expect(rows).toEqual([{ year: 2026, base: 6.98, cap: 16.187, cash: null }, { year: 2027, base: 15, cap: 21.02, cash: 16.02 }]);
    expect(contractSeasons(undefined, 2026)).toEqual([]);
  });

  it('the weekly stats file becomes one line per skill player and defender; a renamed column is an error', () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'raw', 'stats_player__stats_player_week_2026.csv'), 'utf8');
    const ex = extractPlayerWeeks(parseCsv(text), 2026);
    expect(ex.games!.length).toBe(32);
    expect(new Set(ex.data.map((r) => r.kind))).toEqual(new Set(['QB', 'SKILL', 'DEF']));
    for (const r of ex.data) expect(r.v).toHaveLength(GAME_LOG.columns[r.kind].length);
    const qb = ex.data.find((r) => r.name === 'Aaron Rodgers' && r.wk === 1)!;
    const col = (label: string): number => qb.v[GAME_LOG.columns.QB.findIndex((c) => c.label === label)]!;
    expect([col('Cmp'), col('Att'), col('Yds'), col('TD')]).toEqual([24, 40, 221, 1]);
    expect(() => extractPlayerWeeks(parseCsv(text.replace('passing_yards', 'pass_yards')), 2026)).toThrow(/missing columns: passing_yards/);
  });
});
