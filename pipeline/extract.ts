/**
 * Raw nflverse files -> the compact inputs the model needs. One function per source. Each returns its data plus
 * what it covers (game ids or latest week), which decides fresh / lagging / kept.
 */
import { gunzipSync } from 'node:zlib';
import { BIG_PLAYS, GAME_LOG, LINE_TARGETS, MOVES, PLAY_FILTER } from '../src/model/config.ts';
import type {
  Contract, ContractSeason, DraftPick, Game, NgsPassing, NgsReceiving, NgsRushing, PfrDefRow, PfrPassRow, PfrRecRow, PfrRushRow, PlayerGame,
  PlayerWeek, RosterHistory, RosterPlayer, SnapRow, TeamGame, TradeRow,
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
    // forced fumbles: optional columns (an older file without them just has none)
    credit('forced_fumble_player_1_player_id', 'ff', 1);
    credit('forced_fumble_player_2_player_id', 'ff', 1);
    // big plays: the EPA the play took from the offense, split evenly among the defenders who made one on it
    const makers = new Set(BIG_PLAYS.columns.map((c) => r.str(row, c)).filter(Boolean));
    if (makers.size && epa < 0) for (const id of makers) add(pg(id, g, def), 'big', -epa / makers.size);
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

/** Weekly rosters -> each player's team and status by week, keeping only the weeks where one of them changed. */
export function extractRosterHistory(t: Table, season: number): Extracted<RosterHistory[]> {
  const r = reader(t);
  r.require('season', 'game_type', 'gsis_id', 'week', 'team', 'pfr_id', 'full_name', 'position', 'status');
  const by = new Map<string, { f: string | null; n: string; pos: string; weeks: Map<number, [string, string]> }>();
  let maxWeek = 0;
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'game_type'))) continue;
    const p = r.str(row, 'gsis_id');
    const team = r.str(row, 'team');
    if (!p || !team) continue;
    const week = r.num(row, 'week');
    maxWeek = Math.max(maxWeek, week);
    let x = by.get(p);
    if (!x) by.set(p, (x = { f: null, n: '', pos: '', weeks: new Map() }));
    x.f = r.str(row, 'pfr_id') || x.f;
    x.n = r.str(row, 'full_name') || x.n;
    x.pos = r.str(row, 'position') || x.pos;
    x.weeks.set(week, [team, r.str(row, 'status')]);
  }
  const data: RosterHistory[] = [];
  for (const [p, x] of by) {
    const h: [number, string, string][] = [];
    for (const w of [...x.weeks.keys()].sort((a, b) => a - b)) {
      const [team, status] = x.weeks.get(w) as [string, string];
      const last = h[h.length - 1];
      if (!last || last[1] !== team || last[2] !== status) h.push([w, team, status]);
    }
    data.push({ p, f: x.f, n: x.n, pos: x.pos, h });
  }
  return { data, maxWeek };
}

const team = (code: string): string => MOVES.teamCodes[code] ?? code;

/** Trades file -> this season's trade assets (players and picks). */
export function extractTrades(t: Table, season: number): Extracted<TradeRow[]> {
  const r = reader(t);
  r.require('trade_id', 'season', 'trade_date', 'gave', 'received', 'pick_season', 'pick_round', 'pfr_id', 'pfr_name');
  const data: TradeRow[] = [];
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season) continue;
    data.push({
      id: r.str(row, 'trade_id'),
      date: r.str(row, 'trade_date'),
      gave: team(r.str(row, 'gave')),
      received: team(r.str(row, 'received')),
      pfr: r.str(row, 'pfr_id') || null,
      name: r.str(row, 'pfr_name'),
      pickSeason: r.opt(row, 'pick_season'),
      pickRound: r.opt(row, 'pick_round'),
      pickNumber: t.col('pick_number') >= 0 ? r.opt(row, 'pick_number') : null,
      conditional: t.col('conditional') >= 0 && r.opt(row, 'conditional') === 1,
    });
  }
  return { data };
}

/** Draft picks file -> this season's draft. */
export function extractDraft(t: Table, season: number): Extracted<DraftPick[]> {
  const r = reader(t);
  r.require('season', 'round', 'pick', 'team', 'gsis_id', 'pfr_player_name', 'position');
  const data: DraftPick[] = [];
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season) continue;
    data.push({
      season, round: r.num(row, 'round'), pick: r.num(row, 'pick'), team: team(r.str(row, 'team')),
      gsis: r.str(row, 'gsis_id') || null, name: r.str(row, 'pfr_player_name'), pos: r.str(row, 'position'),
    });
  }
  return { data };
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
  pfrRows(t, s, ['carries', 'rushing_yards_before_contact', 'rushing_yards_after_contact', 'rushing_broken_tackles', 'receiving_broken_tackles'], (row, r) => ({
    ...base(row, r),
    carries: r.num(row, 'carries'),
    ybc: r.num(row, 'rushing_yards_before_contact'),
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
  pfrRows(t, s, ['offense_snaps', 'defense_snaps', 'player', 'position'], (row, r) => ({
    ...base(row, r),
    off: r.num(row, 'offense_snaps'),
    def: r.num(row, 'defense_snaps'),
    ...(LINE_TARGETS.depth.includes(r.str(row, 'position')) ? { n: r.str(row, 'player') } : {}),
  }));

/** Weekly player stats -> one game-log line per skill player and defender (columns set in GAME_LOG). */
export function extractPlayerWeeks(t: Table, season: number): Extracted<PlayerWeek[]> {
  const r = reader(t);
  const stats = [...new Set(Object.values(GAME_LOG.columns).flat().flatMap((c) => c.from))];
  r.require('player_id', 'player_display_name', 'position', 'position_group', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent_team', ...stats);
  const games = new Set<string>();
  const data: PlayerWeek[] = [];
  for (const row of t.rows) {
    if (r.num(row, 'season') !== season || !isReg(r.str(row, 'season_type'))) continue;
    const g = r.str(row, 'game_id');
    if (g) games.add(g);
    const kind = GAME_LOG.groupKind[r.str(row, 'position_group')];
    const p = r.str(row, 'player_id');
    if (!kind || !p || !g) continue;
    data.push({
      p,
      name: r.str(row, 'player_display_name'),
      pos: r.str(row, 'position'),
      kind,
      t: r.str(row, 'team'),
      opp: r.str(row, 'opponent_team'),
      g,
      wk: r.num(row, 'week'),
      v: GAME_LOG.columns[kind].map((c) => {
        const k = 10 ** c.decimals;
        return Math.round(c.from.reduce((s, col) => s + r.num(row, col), 0) * k) / k;
      }),
    });
  }
  return { data, games: [...games] };
}

const millions = (v: unknown): number | null => {
  const x = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
};

/**
 * A contract's year-by-year rows, this season onward. The file's "Total" row and earlier years are dropped, and so
 * are void years: placeholder years after the deal really ends, listed with a made-up base salary and no cash. They
 * are the trailing rows with $0 cash paid.
 */
export function contractSeasons(history: unknown, season: number): ContractSeason[] {
  if (!Array.isArray(history)) return [];
  const out: ContractSeason[] = [];
  for (const h of history as Record<string, unknown>[]) {
    const year = Number(h?.year);
    if (!Number.isInteger(year) || year < season) continue;
    out.push({ year, base: millions(h.base_salary), cap: millions(h.cap_number), cash: millions(h.cash_paid) });
  }
  out.sort((a, b) => a.year - b.year);
  while (out.length && out[out.length - 1]?.cash === 0) out.pop();
  return out;
}

/**
 * Contracts parquet -> the current contract per player (active, latest signed), with this season's base salary from
 * its year-by-year `season_history`. hyparquet is loaded only here. Reading `season_history` takes ~1.3 GB of memory
 * (it holds every contract's every year), which is why the refresh runs Node with a larger heap. A file without that
 * column still gives the contract terms, with base salary unknown.
 */
export async function extractContracts(buf: Uint8Array, season: number): Promise<Extracted<Contract[]>> {
  const { parquetMetadataAsync, parquetReadObjects } = await import('hyparquet');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const meta = await parquetMetadataAsync(ab);
  const names = new Set(meta.schema.map((x) => x.name));
  const flat = ['is_active', 'year_signed', 'years', 'apy', 'apy_cap_pct', 'gsis_id'];
  const missing = flat.filter((c) => !names.has(c));
  if (missing.length) throw new Error(`missing columns: ${missing.join(', ')}`);
  // total value, guarantee and the yearly rows are extras: a file without them still gives the core terms
  const extra = ['value', 'guaranteed', 'season_history'].filter((c) => names.has(c));
  const rows = (await parquetReadObjects({ file: ab, columns: [...flat, ...extra] })) as Record<string, unknown>[];
  const best = new Map<string, { signed: number; c: Contract }>();
  const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN);
  for (const row of rows) {
    const gsis = typeof row.gsis_id === 'string' ? row.gsis_id : '';
    const signed = n(row.year_signed);
    const years = n(row.years);
    const apy = n(row.apy);
    if (!gsis || row.is_active !== true || !Number.isFinite(signed) || !Number.isFinite(apy)) continue;
    const prev = best.get(gsis);
    if (prev && prev.signed >= signed) continue;
    const capPct = n(row.apy_cap_pct);
    const year = Array.isArray(row.season_history)
      ? (row.season_history as Record<string, unknown>[]).find((h) => n(h?.year) === season)
      : undefined;
    const base = year ? n(year.base_salary) : NaN;
    const seasons = contractSeasons(row.season_history, season);
    // an extension keeps its old years, so the deal runs to the last real year listed; without yearly rows, to
    // signed + years
    const lastYear = seasons[seasons.length - 1]?.year ?? signed + (Number.isFinite(years) ? years : 1) - 1;
    best.set(gsis, {
      signed,
      c: {
        gsis,
        apyMillions: Math.round(apy * 100) / 100,
        capPct: Number.isFinite(capPct) ? Math.round(capPct * 1000) / 1000 : 0,
        lastYear,
        baseSalaryMillions: Number.isFinite(base) ? Math.round(base * 1000) / 1000 : null,
        yearSigned: signed,
        years: Number.isFinite(years) ? years : null,
        valueMillions: millions(row.value),
        guaranteedMillions: millions(row.guaranteed),
        seasons,
      },
    });
  }
  return { data: [...best.values()].map((b) => b.c) };
}

/** Dispatch: raw bytes of one source -> its compact data. */
export async function extract(id: SourceId, buf: Uint8Array, name: string, season: number): Promise<Extracted> {
  if (id === 'contracts') return extractContracts(buf, season);
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
    case 'player_weeks': return extractPlayerWeeks(t, season);
    case 'roster_moves': return extractRosterHistory(t, season);
    case 'trades': return extractTrades(t, season);
    case 'draft': return extractDraft(t, season);
  }
}
