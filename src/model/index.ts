/** The whole model: inputs (compact nflverse data) -> what the page shows. Pure: no clock, no I/O, no randomness
 * beyond the seeded playoff sim. */
import { BUY, DIVISIONS, RATINGS_SOURCE, TEAM_NAMES, UNIT_KEYS, UNITS, type RankingMode, type RatingsSourceConfig, type UnitKey } from './config.ts';
import { ranks } from './stats.ts';
import { buyTargets, tradeChips } from './buy.ts';
import { playerContract } from './contracts.ts';
import { gradeLines, lineRaw, lineStarters, lineTargets } from './line.ts';
import { weakestUnit } from './grades.ts';
import { seasonState } from './odds.ts';
import { divisionOf, recordText, scheduleLeft } from './playoffs.ts';
import { rankPlayers } from './players.ts';
import { buildProfiles } from './profiles.ts';
import { buildMoves } from './moves.ts';
import { gradeMoves } from './moveGrades.ts';
import { buildValue } from './value.ts';
import { assertRatingsAllowed } from './ratings.ts';
import { round } from './stats.ts';
import { decideVerdict } from './verdict.ts';
import { currentWeek, fantasyAllowed } from './fantasyAllowed.ts';
import type { ModelInputs, ModelOutput, SourceStatus, TeamResult } from './types.ts';

export interface BuildOptions {
  sources: SourceStatus[];
  dataAsOf: string;
  sample?: boolean;
  ratingsCfg?: RatingsSourceConfig;
}

export function buildModel(inp: ModelInputs, opts: BuildOptions): ModelOutput {
  const ratingsCfg = opts.ratingsCfg ?? RATINGS_SOURCE;
  assertRatingsAllowed(ratingsCfg);
  const teams = Object.values(DIVISIONS).flat().filter((t) => inp.games.some((g) => g.home === t || g.away === t)).sort();
  const season = seasonState(inp.games, inp.teamGames, teams);
  const { grades, recs, strength, odds } = season;
  const sched = scheduleLeft(inp.games, strength);

  const played: Record<string, number> = {};
  for (const t of teams) played[t] = recs[t]?.games ?? 0;
  const playedWeeks = inp.games.filter((g) => g.homeScore !== null).map((g) => g.week);
  const throughWeek = playedWeeks.length ? Math.max(...playedWeeks) : 0;
  const players = rankPlayers(inp, { teamGames: played, weeksPlayed: throughWeek, ratings: ratingsCfg.enabled ? inp.ratings : undefined, ratingsCfg });

  // offensive line (team level) and the halves of each unit, for choosing what a buyer needs
  const raw = lineRaw(inp);
  const lines = gradeLines(raw, teams);
  const rankOf = (values: Record<string, number>, higherIsBetter: boolean): Record<string, number> => {
    const have = teams.filter((t) => values[t] !== undefined);
    const rk = ranks(have.map((t) => values[t] as number), higherIsBetter);
    return Object.fromEntries(have.map((t, i) => [t, rk[i] as number]));
  };
  const rbYacRank = rankOf(raw.rbYac, true);
  const halves = (t: string, unit: UnitKey): { primaryRank?: number; alternateRank?: number } => {
    switch (unit) {
      case 'passDefense': return { primaryRank: grades.passRushRank[t], alternateRank: grades.coverageRank[t] };
      case 'passOffense': return { primaryRank: grades.airRank[t], alternateRank: lines[t]?.passPro?.rank };
      case 'rushOffense': return { primaryRank: rbYacRank[t], alternateRank: lines[t]?.runBlock?.rank };
      default: return {};
    }
  };

  const results: TeamResult[] = teams.map((t) => {
    const units = grades.units[t] as TeamResult['units'];
    const weakest = weakestUnit(units);
    const r = recs[t] ?? { wins: 0, losses: 0, ties: 0, pointDiff: 0, games: 0 };
    const v = decideVerdict({
      record: recordText(r),
      playoffOdds: odds[t] ?? 0,
      scheduleLeftRank: sched.rank[t] ?? 0,
      teams: teams.length,
      weakest,
      weakestGrade: units[weakest].grade,
      weakestRank: units[weakest].rank,
      ...halves(t, weakest),
    });
    const division = divisionOf(t) ?? '';
    return {
      team: t,
      name: TEAM_NAMES[t] ?? t,
      conference: division.split(' ')[0] ?? '',
      division,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      record: recordText(r),
      pointDiff: r.pointDiff,
      units,
      strength: round(strength[t] ?? 0, 2),
      scheduleLeft: round(sched.mean[t] ?? 0, 2),
      scheduleLeftRank: sched.rank[t] ?? 0,
      gamesLeft: sched.left[t] ?? 0,
      playoffOdds: round(odds[t] ?? 0, 3),
      verdict: v.verdict,
      reason: v.reason,
      weakest,
      need: v.need ? { label: v.need.label, positions: [...v.need.positions], ...(v.need.line ? { line: v.need.line } : {}) } : null,
      buyTargets: [],
      chips: [],
      line: lines[t] ?? { passPro: null, runBlock: null },
      lineTargets: [],
    };
  });
  const starters = lineStarters(inp);
  const contracts = new Map(inp.contracts.map((c) => [c.gsis, playerContract(c, throughWeek)]));
  const sellers = new Set(results.filter((t) => BUY.fromVerdicts.includes(t.verdict)).map((t) => t.team));
  for (const t of results) {
    t.buyTargets = buyTargets(t, results, players);
    t.chips = tradeChips(t, players);
    if (t.verdict === 'buy' && t.need?.line) t.lineTargets = lineTargets(t.need.line, t.team, sellers, starters, lines, contracts, BUY.statuses);
  }

  const profiles = buildProfiles(inp, throughWeek);
  const value = buildValue(inp, profiles, players, teams, played);
  const moves = gradeMoves(buildMoves(inp), {
    season: inp.season, games: inp.games, teamGames: inp.teamGames, teams, seasonNow: season,
    players, values: value.players, contracts: inp.contracts,
  });
  const modes: RankingMode[] = ratingsCfg.enabled && inp.ratings ? ['production', 'ratings', 'composite'] : ['production'];
  return {
    schemaVersion: 1,
    sample: opts.sample ?? false,
    season: inp.season,
    throughWeek,
    dataAsOf: opts.dataAsOf,
    teams: results,
    players,
    profiles,
    value,
    moves,
    sources: opts.sources,
    rankingModes: modes,
    ratingsCredit: modes.length > 1 ? `${ratingsCfg.label} (${ratingsCfg.license})` : null,
    thisWeek: {
      week: currentWeek(inp.games),
      fantasyAllowed: fantasyAllowed(inp.playerWeeks, inp.games, teams),
    },
  };
}

export { UNIT_KEYS, UNITS };
