/**
 * Raw nflverse files -> the compact inputs the model needs. One function per source. Each returns its data plus
 * what it covers (game ids or latest week), which decides fresh / lagging / kept.
 */
import { gunzipSync } from 'node:zlib';
import { PLAY_FILTER } from '../src/model/config.ts';
import type {
  Contract, Game, NgsPassing, NgsReceiving, NgsRushing, PfrDefRow, PfrPassRow, PfrRecRow, PfrRushRow, PlayerGame,
  RosterPlayer, SnapRow, TeamGame,
} from '../src/model/types.ts';
import { parseCsv, reader, type Table } from './csv.ts';
import type { SourceId } from './sources.ts';

export interface Extracted<T = unknown> {
  data: T;
  /** Game ids present (coverage 'games'). */
  games?: string[];
  /** Latest week present (coverage 'weeks'). */
  maxWeek?: number;
}

export function decode(buf: Uint8Array, name: string): string {
  const bytes = name.endsWith('.gz') ? gunzipSync(buf) : buf;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

const table = (buf: Uint8Array, name: string): Table => parseCsv(decode(buf, name));
const isReg = (v: string): boolean => v === 'REG';

export function extractSchedules(t: Table, season: number): Extracted<Game[]> {
  const r = reader(t);
  r.require('season', 'game_type', 'game_id', 'week', 'gameday', 'home_team', 'away_team', 'home_score', 'away_score', 'location');
  const games: Game[] = [];
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'game_type'))) continue;
    const hs = r.opt(row, 'home_score');
    const as = r.opt(row, 'away_score');
    const done = hs !== null && as !== null;
    games.push({
      id: r.str(row, 'game_id'),
      week: r.num(row, 'week'),
      gameday: r.str(row, 'gameday'),
      home: r.str(row, 'home_team'),
      away: r.str(row, 'away_team'),
      homeScore: done ? hs : null,
      awayScore: done ? as : null,
      neutral: r.str(row, 'location') === 'Neutral',
    });
  }
  return { data: games, games: games.filter((g) => g.homeScore !== null).map((g) => g.id) };
}

export interface PbpData { teamGames: TeamGame[]; playerGames: PlayerGame[] }

export function extractPbp(t: Table, season: number): Extracted<PbpData> {
  const r = reader(t);
  r.require('season', 'season_type', 'game_id', 'pass', 'rush', 'epa', 'qb_epa', 'wp', 'success', 'sack', 'qb_hit', 'pass_attempt', 'cpoe',
    'posteam', 'defteam', 'posteam_type', 'location', 'passer_player_id', 'receiver_player_id', 'rusher_player_id',
    'solo_tackle_1_player_id', 'tackle_for_loss_1_player_id', 'sack_player_id', 'qb_hit_1_player_id', 'pass_defense_1_player_id', 'interception_player_id');
  const cells = new Map<string, TeamGame>();
  const players = new Map<string, PlayerGame>();
  const gameIds = new Set<string>();
  const pg = (p: string, g: string, team: string): PlayerGame => {
    const k = `${p}|${g}`;
    let x = players.get(k);
    if (!x) players.set(k, (x = { p, g, t: team }));
    return x;
  };
  const add = (x: PlayerGame, key: keyof PlayerGame, v: number): void => {
    (x as unknown as Record<string, number>)[key] = ((x as unknown as Record<string, number>)[key] ?? 0) + v;
  };
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || r.str(row, 'season_type') !== PLAY_FILTER.seasonType) continue;
    const g = r.str(row, 'game_id');
    gameIds.add(g);
    const pass = r.num(row, 'pass') === 1;
    const rush = r.num(row, 'rush') === 1;
    if (!pass && !rush) continue;
    if (r.num(row, 'qb_kneel') === 1 || r.num(row, 'qb_spike') === 1 || r.num(row, 'two_point_attempt') === 1) continue;
    const epa = r.opt(row, 'epa');
    const off = r.str(row, 'posteam');
    const def = r.str(row, 'defteam');
    if (epa === null || !off || !def) continue;
    const success = r.num(row, 'success');
    const sack = r.num(row, 'sack') === 1;
    const attempt = r.num(row, 'pass_attempt') === 1;

    // team cells (garbage time filtered)
    const wp = r.opt(row, 'wp');
    if (wp !== null && wp >= PLAY_FILTER.winProbability.min && wp <= PLAY_FILTER.winProbability.max) {
      const k = `${g}|${off}`;
      let c = cells.get(k);
      if (!c) {
        const home = r.str(row, 'posteam_type') === 'home' && r.str(row, 'location') !== 'Neutral' ? 1 : 0;
        cells.set(k, (c = { game: g, off, def, offHome: home, passN: 0, passEpa: 0, rushN: 0, rushEpa: 0, rushHits: 0, covN: 0, covEpa: 0 }));
      }
      if (pass) {
        c.passN++;
        c.passEpa += epa;
        if (sack || r.num(row, 'qb_hit') === 1) c.rushHits++;
        if (attempt && !sack) {
          c.covN++;
          c.covEpa += epa;
        }
      } else {
        c.rushN++;
        c.rushEpa += epa;
      }
    }

    // players (every play)
    if (pass) {
      const qb = r.str(row, 'passer_id') || r.str(row, 'passer_player_id');
      if (qb) {
        const x = pg(qb, g, off);
        add(x, 'db', 1);
        add(x, 'dbEpa', r.opt(row, 'qb_epa') ?? epa);
        add(x, 'dbSucc', success);
        if (sack) add(x, 'sk', 1);
        const cpoe = r.opt(row, 'cpoe');
        if (cpoe !== null) {
          add(x, 'cpoeSum', cpoe);
          add(x, 'cpoeN', 1);
        }
      }
      const rec = r.str(row, 'receiver_player_id');
      if (rec && attempt && !sack) {
        const x = pg(rec, g, off);
        add(x, 'tgt', 1);
        add(x, 'tgtEpa', epa);
      }
    } else {
      const rb = r.str(row, 'rusher_player_id');
      if (rb) {
        const x = pg(rb, g, off);
        add(x, 'car', 1);
        add(x, 'carEpa', epa);
        add(x, 'carSucc', success);
      }
    }
    const credit = (col: string, key: keyof PlayerGame, v: number): void => {
      const id = r.str(row, col);
      if (id) add(pg(id, g, def), key, v);
    };
    for (const c of ['solo_tackle_1_player_id', 'solo_tackle_2_player_id', 'assist_tackle_1_player_id', 'assist_tackle_2_player_id',
      'assist_tackle_3_player_id', 'assist_tackle_4_player_id', 'tackle_with_assist_1_player_id', 'tackle_with_assist_2_player_id']) credit(c, 'tkl', 1);
    credit('tackle_for_loss_1_player_id', 'tfl', 1);
    credit('tackle_for_loss_2_player_id', 'tfl', 1);
    credit('sack_player_id', 'sck', 1);
    credit('half_sack_1_player_id', 'sck', 0.5);
    credit('half_sack_2_player_id', 'sck', 0.5);
    credit('qb_hit_1_player_id', 'qbh', 1);
    credit('qb_hit_2_player_id', 'qbh', 1);
    credit('pass_defense_1_player_id', 'pd', 1);
    credit('pass_defense_2_player_id', 'pd', 1);
    credit('interception_player_id', 'int', 1);
  }
  const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
  const teamGames = [...cells.values()].map((c) => ({ ...c, passEpa: round4(c.passEpa), rushEpa: round4(c.rushEpa), covEpa: round4(c.covEpa) }));
  const playerGames = [...players.values()].map((x) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) o[k] = typeof v === 'number' ? round4(v) : v;
    return o as unknown as PlayerGame;
  });
  return { data: { teamGames, playerGames }, games: [...gameIds] };
}

export function extractRosters(t: Table, season: number): Extracted<RosterPlayer[]> {
  const r = reader(t);
  r.require('season', 'game_type', 'gsis_id', 'week', 'team', 'pfr_id', 'full_name', 'depth_chart_position', 'status');
  const latest = new Map<string, RosterPlayer>();
  const teamWeek = new Map<string, number>();
  let maxWeek = 0;
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'game_type'))) continue;
    const gsis = r.str(row, 'gsis_id');
    const week = r.num(row, 'week');
    const team = r.str(row, 'team');
    if (!gsis || !team) continue;
    maxWeek = Math.max(maxWeek, week);
    teamWeek.set(team, Math.max(teamWeek.get(team) ?? 0, week));
    const prev = latest.get(gsis);
    if (prev && prev.week >= week) continue;
    latest.set(gsis, {
      gsis,
      pfr: r.str(row, 'pfr_id') || null,
      name: r.str(row, 'full_name') || r.str(row, 'football_name'),
      team,
      depth: r.str(row, 'depth_chart_position') || r.str(row, 'position'),
      week,
      status: r.str(row, 'status'),
    });
  }
  // keep a player only if his latest row is his team's latest week (otherwise he has since left that roster)
  const data = [...latest.values()].filter((p) => p.week === teamWeek.get(p.team));
  return { data, maxWeek };
}

function ngsRows(t: Table, season: number, cols: string[]): { rows: string[][]; maxWeek: number; r: ReturnType<typeof reader> } {
  const r = reader(t);
  r.require('season', 'season_type', 'week', 'player_gsis_id', ...cols);
  let maxWeek = 0;
  const rows: string[][] = [];
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'season_type'))) continue;
    const w = r.num(row, 'week');
    if (w === 0) rows.push(row);
    else maxWeek = Math.max(maxWeek, w);
  }
  return { rows, maxWeek, r };
}

export function extractNgsPassing(t: Table, season: number): Extracted<NgsPassing[]> {
  const { rows, maxWeek, r } = ngsRows(t, season, ['attempts', 'completion_percentage_above_expectation']);
  return { data: rows.map((x) => ({ p: r.str(x, 'player_gsis_id'), att: r.num(x, 'attempts'), cpoe: r.num(x, 'completion_percentage_above_expectation') })).filter((x) => x.p), maxWeek };
}

export function extractNgsReceiving(t: Table, season: number): Extracted<NgsReceiving[]> {
  const { rows, maxWeek, r } = ngsRows(t, season, ['targets', 'avg_separation', 'avg_yac_above_expectation']);
  return {
    data: rows.map((x) => ({ p: r.str(x, 'player_gsis_id'), tgt: r.num(x, 'targets'), separation: r.num(x, 'avg_separation'), yacOverExpected: r.num(x, 'avg_yac_above_expectation') })).filter((x) => x.p),
    maxWeek,
  };
}

export function extractNgsRushing(t: Table, season: number): Extracted<NgsRushing[]> {
  const { rows, maxWeek, r } = ngsRows(t, season, ['rush_attempts', 'rush_yards_over_expected_per_att']);
  return { data: rows.map((x) => ({ p: r.str(x, 'player_gsis_id'), att: r.num(x, 'rush_attempts'), ryoePerAtt: r.num(x, 'rush_yards_over_expected_per_att') })).filter((x) => x.p), maxWeek };
}

function pfrRows<T>(t: Table, season: number, cols: string[], map: (row: string[], r: ReturnType<typeof reader>) => T): Extracted<T[]> {
  const r = reader(t);
  r.require('season', 'game_type', 'game_id', 'pfr_player_id', 'team', ...cols);
  const data: T[] = [];
  const games = new Set<string>();
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'game_type'))) continue;
    const g = r.str(row, 'game_id');
    if (!g || !r.str(row, 'pfr_player_id')) continue;
    games.add(g);
    data.push(map(row, r));
  }
  return { data, games: [...games] };
}

const base = (row: string[], r: ReturnType<typeof reader>) => ({ p: r.str(row, 'pfr_player_id'), g: r.str(row, 'game_id'), t: r.str(row, 'team') });

export const extractPfrPass = (t: Table, s: number): Extracted<PfrPassRow[]> =>
  pfrRows(t, s, ['times_pressured', 'times_sacked'], (row, r) => ({ ...base(row, r), pressured: r.num(row, 'times_pressured'), sacked: r.num(row, 'times_sacked') }));

export const extractPfrRush = (t: Table, s: number): Extracted<PfrRushRow[]> =>
  pfrRows(t, s, ['carries', 'rushing_yards_after_contact', 'rushing_broken_tackles', 'receiving_broken_tackles'], (row, r) => ({
    ...base(row, r),
    carries: r.num(row, 'carries'),
    yac: r.num(row, 'rushing_yards_after_contact'),
    btRush: r.num(row, 'rushing_broken_tackles'),
    btRec: r.num(row, 'receiving_broken_tackles'),
  }));

export const extractPfrRec = (t: Table, s: number): Extracted<PfrRecRow[]> =>
  pfrRows(t, s, ['receiving_drop', 'receiving_broken_tackles'], (row, r) => ({ ...base(row, r), drops: r.num(row, 'receiving_drop'), btRec: r.num(row, 'receiving_broken_tackles') }));

export const extractPfrDef = (t: Table, s: number): Extracted<PfrDefRow[]> =>
  pfrRows(t, s, ['def_targets', 'def_completions_allowed', 'def_yards_allowed', 'def_passer_rating_allowed', 'def_ints', 'def_pressures', 'def_tackles_combined', 'def_missed_tackles'], (row, r) => {
    const targets = r.num(row, 'def_targets');
    return {
      ...base(row, r),
      targets,
      completions: r.num(row, 'def_completions_allowed'),
      yards: r.num(row, 'def_yards_allowed'),
      ratingSum: Math.round(r.num(row, 'def_passer_rating_allowed') * targets * 10) / 10,
      ints: r.num(row, 'def_ints'),
      pressures: r.num(row, 'def_pressures'),
      tackles: r.num(row, 'def_tackles_combined'),
      missed: r.num(row, 'def_missed_tackles'),
    };
  });

export const extractSnaps = (t: Table, s: number): Extracted<SnapRow[]> =>
  pfrRows(t, s, ['offense_snaps', 'defense_snaps'], (row, r) => ({ ...base(row, r), off: r.num(row, 'offense_snaps'), def: r.num(row, 'defense_snaps') }));

/** Contracts parquet -> the current contract per player (active, latest signed). hyparquet is loaded only here. */
export async function extractContracts(buf: Uint8Array): Promise<Extracted<Contract[]>> {
  const { parquetReadObjects } = await import('hyparquet');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  // only flat columns: the nested history columns are large and unused
  const rows = (await parquetReadObjects({ file: ab, columns: ['is_active', 'year_signed', 'years', 'apy', 'apy_cap_pct', 'gsis_id'] })) as Record<string, unknown>[];
  const best = new Map<string, { signed: number; c: Contract }>();
  const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN);
  for (const row of rows) {
    const gsis = typeof row.gsis_id === 'string' ? row.gsis_id : '';
    const signed = n(row.year_signed);
    const years = n(row.years);
    const apy = n(row.apy);
    if (!gsis || row.is_active !== true || !Number.isFinite(signed) || !Number.isFinite(apy)) continue;
    const prev = best.get(gsis);
    if (prev && prev.signed >= signed) continue;
    const capPct = n(row.apy_cap_pct);
    best.set(gsis, {
      signed,
      c: { gsis, apyMillions: Math.round(apy * 100) / 100, capPct: Number.isFinite(capPct) ? Math.round(capPct * 1000) / 1000 : 0, lastYear: signed + (Number.isFinite(years) ? years : 1) - 1 },
    });
  }
  return { data: [...best.values()].map((b) => b.c) };
}

/** Dispatch: raw bytes of one source -> its compact data. */
export async function extract(id: SourceId, buf: Uint8Array, name: string, season: number): Promise<Extracted> {
  if (id === 'contracts') return extractContracts(buf);
  const t = table(buf, name);
  switch (id) {
    case 'schedules': return extractSchedules(t, season);
    case 'pbp': return extractPbp(t, season);
    case 'rosters': return extractRosters(t, season);
    case 'ngs_passing': return extractNgsPassing(t, season);
    case 'ngs_receiving': return extractNgsReceiving(t, season);
    case 'ngs_rushing': return extractNgsRushing(t, season);
    case 'pfr_pass': return extractPfrPass(t, season);
    case 'pfr_rush': return extractPfrRush(t, season);
    case 'pfr_rec': return extractPfrRec(t, season);
    case 'pfr_def': return extractPfrDef(t, season);
    case 'snaps': return extractSnaps(t, season);
  }
}
