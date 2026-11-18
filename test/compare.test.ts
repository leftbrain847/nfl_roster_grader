import { describe, expect, it } from 'vitest';
import { COMPARE, GAME_LOG } from '../src/model/config.ts';
import { buildComparison, comparable } from '../src/model/compare.ts';
import type { ModelOutput, PlayerProfile, PlayerResult } from '../src/model/types.ts';

const ranked = (id: string, group: PlayerResult['group'], score: number, rank: number, stats: PlayerResult['stats']): PlayerResult => ({
  id, name: id.toUpperCase(), team: 'AAA', group, depth: group, status: 'ACT', volume: '100 plays', stats,
  scores: { production: score }, rank, qualifiedAtPosition: 30, contract: null,
});
const log = (kind: PlayerProfile['kind'], games: Record<string, number>[]): PlayerProfile['log'] =>
  games.map((g, i) => ({ wk: i + 1, team: 'AAA', opp: 'BBB', home: true, result: '', snapPct: 90, v: GAME_LOG.columns[kind].map((c) => g[c.label] ?? 0) }));
const profile = (id: string, pos: string, kind: PlayerProfile['kind'], games: Record<string, number>[], cap: number | null = null): PlayerProfile => ({
  id, name: id.toUpperCase(), team: 'AAA', pos, kind, log: log(kind, games),
  contract: cap === null ? null : {
    apyMillions: cap, capPct: 0.01, lastYear: 2028, baseSalaryMillions: 1, baseSalaryLeftMillions: 0.5,
    yearSigned: 2025, years: 4, valueMillions: 4 * cap, guaranteedMillions: cap, seasons: [{ year: 2026, base: 1, cap, cash: 1 }],
  },
});

const data = {
  season: 2026,
  players: [
    ranked('wr1', 'WR', 90, 2, [{ key: 'epaPerTarget', value: 0.4, pct: 95 }, { key: 'dropRate', value: 3.2, pct: 70 }]),
    ranked('wr2', 'WR', 60, 12, [{ key: 'epaPerTarget', value: 0.1, pct: 55 }, { key: 'dropRate', value: 1.1, pct: 90 }]),
    ranked('qb1', 'QB', 75, 5, [{ key: 'epaPerDropback', value: 0.2, pct: 80 }]),
  ],
  profiles: [
    profile('wr1', 'WR', 'SKILL', [{ ReYd: 100, Tgt: 9 }, { ReYd: 80, Tgt: 7 }], 20),
    profile('wr2', 'WR', 'SKILL', [{ ReYd: 50, Tgt: 5 }, { ReYd: 60, Tgt: 6 }, { ReYd: 40, Tgt: 4 }], 2),
    profile('qb1', 'QB', 'QB', [{ Yds: 250, Int: 2, Car: 3 }, { Yds: 300, Int: 0, Car: 2 }]),
    profile('wr3', 'WR', 'SKILL', [{ ReYd: 10 }]),
  ],
  value: {
    players: [
      { id: 'wr1', name: 'WR1', team: 'AAA', group: 'WR', production: 90, capMillions: 20, worthMillions: 25, surplus: 5 },
      { id: 'wr2', name: 'WR2', team: 'AAA', group: 'WR', production: 60, capMillions: 2, worthMillions: 6, surplus: 4 },
    ],
    rosters: [], lineups: [], frontOffices: [],
    fantasy: [{ id: 'wr2', name: 'WR2', team: 'AAA', pos: 'WR', games: 3, points: 30, perGame: 10, capMillions: 2, perMillion: 15 }],
  },
} as unknown as Pick<ModelOutput, 'season' | 'players' | 'profiles' | 'value'>;

const find = (c: ReturnType<typeof buildComparison>, label: string) => c.rows.find((r) => r.label === label);

describe('compare players', () => {
  it('shows real stat values with the percentile underneath, marking the best percentile', () => {
    const c = buildComparison(['wr1', 'wr2'], data);
    const epa = find(c, 'EPA/target')!;
    expect(epa.cells.map((x) => [x.text, x.sub, x.best])).toEqual([['0.40', '95th pct', true], ['0.10', '55th pct', false]]);
    // drop rate: lower is better; the percentile is already flipped, so the lower rate wins
    expect(find(c, 'Drop rate')!.cells.map((x) => [x.text, x.best])).toEqual([['3.2%', false], ['1.1%', true]]);
    expect(find(c, 'Position rank')!.cells.map((x) => [x.text, x.best])).toEqual([['#2 of 30 WR', true], ['#12 of 30 WR', false]]);
  });

  it('season totals are summed from the game log and marked; costs are never marked', () => {
    const c = buildComparison(['wr1', 'wr2'], data);
    expect(find(c, 'Receiving yards')!.cells.map((x) => [x.text, x.best])).toEqual([['180', true], ['150', false]]);
    expect(find(c, 'Games')!.cells.map((x) => x.text)).toEqual(['2', '3']);
    expect(find(c, 'Cap hit 2026')!.cells.map((x) => [x.text, x.best])).toEqual([['$20.00M', false], ['$2.00M', false]]);
    expect(find(c, 'Surplus (worth - cap hit)')!.cells.map((x) => [x.text, x.best])).toEqual([['+$5.0M', true], ['+$4.0M', false]]);
    // only one player has a fantasy line: shown, not marked
    expect(find(c, 'Fantasy points per game')!.cells.map((x) => [x.text, x.best])).toEqual([['-', false], ['10.0', false]]);
  });

  it('mixed positions: shared rows line up, others show a dash, ranks across positions are not marked', () => {
    const c = buildComparison(['qb1', 'wr1'], data);
    expect(c.players.map((p) => p.pos)).toEqual(['QB', 'WR']);
    expect(find(c, 'Production score')!.cells.map((x) => [x.text, x.best])).toEqual([['75', false], ['90', true]]);
    expect(find(c, 'Position rank')!.cells.every((x) => !x.best)).toBe(true);
    expect(find(c, 'Passing yards')!.cells.map((x) => x.text)).toEqual(['550', '-']);
    expect(find(c, 'Receiving yards')!.cells.map((x) => x.text)).toEqual(['-', '180']);
    expect(find(c, 'Carries')!.cells.map((x) => x.text)).toEqual(['5', '0']); // both logs have carries
  });

  it('fewer interceptions is better', () => {
    const more = { ...data, profiles: [...data.profiles, profile('qb2', 'QB', 'QB', [{ Int: 4 }])] };
    const c = buildComparison(['qb1', 'qb2'], more);
    expect(find(c, 'Interceptions thrown')!.cells.map((x) => [x.text, x.best])).toEqual([['2', true], ['4', false]]);
  });

  it(`at most ${COMPARE.max} players, no repeats, unknown ids (e.g. a lineman) dropped`, () => {
    const c = buildComparison(['wr1', 'wr1', 'lineman', 'wr2', 'qb1', 'wr3'], data);
    expect(c.players.map((p) => p.id)).toEqual(['wr1', 'wr2', 'qb1']);
    expect(comparable(data, 'wr3')).toBe(true); // a player page but no score
    expect(comparable(data, 'lineman')).toBe(false);
    const unranked = buildComparison(['wr3', 'wr1'], data);
    expect(find(unranked, 'Production score')!.cells.map((x) => x.text)).toEqual(['-', '90']);
  });
});
