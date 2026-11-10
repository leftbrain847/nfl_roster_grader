/**
 * The nightly refresh: download each nflverse source, extract what the model needs, decide per source whether to
 * use the new copy or keep the last good one, then build data/roster_grader.json.
 *
 * Per source:
 * - Download fails, or the file won't parse, or it holds LESS than our last good copy -> keep the last good copy
 *   (state "kept", with the reason). Never fail the page over an optional source.
 * - Otherwise use the new copy. It is "fresh" if it has every game (or week) that should be in it by now, given the
 *   source's lagDays, else "lagging" (PFR often is).
 * - No copy at all: "missing". The page still builds, without those stats, unless the source is required
 *   (schedules, play-by-play, rosters); then the refresh fails and the workflow commits nothing.
 *
 * Nothing here reads the clock: `today` comes from the caller.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GAME_LOG_VERSION, RATINGS_SOURCE, type RatingsSourceConfig } from '../src/model/config.ts';
import { buildModel } from '../src/model/index.ts';
import { matchLinemen } from '../src/model/line.ts';
import { parseRatings } from '../src/model/ratings.ts';
import type { Game, ModelInputs, ModelOutput, SourceStatus } from '../src/model/types.ts';
import { extract, type Extracted, type PbpData } from './extract.ts';
import { rawFileName, seasonFor, SOURCES, sourceUrl, type SourceDef, type SourceId } from './sources.ts';

export interface Fetched {
  ok: boolean;
  status: number;
  bytes?: Uint8Array;
  /** The Last-Modified header, as sent. */
  lastModified?: string | null;
  error?: string;
}
export type Fetcher = (url: string) => Promise<Fetched>;

export interface RefreshOptions {
  /** Repo root: data/ is written under it. */
  root: string;
  /** Today in America/New_York, YYYY-MM-DD. */
  today: string;
  fetcher: Fetcher;
  /** Save each download here too (a cache for debugging; not committed). */
  rawDir?: string;
  log?: (line: string) => void;
  ratingsCfg?: RatingsSourceConfig;
}

/** What data/sources/<id>.json holds: the last good copy of one source. */
export interface Snapshot {
  id: SourceId;
  season: number;
  lastModified: string | null;
  games?: string[];
  maxWeek?: number;
  /** Layout version of `data`, for sources in SNAPSHOT_VERSION. */
  version?: number;
  data: unknown;
}

/** Sources whose saved layout can change with config: a last good copy with another version is not reused. */
export const SNAPSHOT_VERSION: Partial<Record<SourceId, number>> = { player_weeks: GAME_LOG_VERSION };

export const DATA_DIR = 'data';
export const OUTPUT_FILE = 'data/roster_grader.json';
export const snapshotPath = (id: SourceId): string => `data/sources/${id}.json`;

const isoDate = (header: string | null | undefined): string | null => {
  if (!header) return null;
  const d = new Date(header);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const daysBetween = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

function size(s: SourceDef, x: Pick<Snapshot, 'games' | 'maxWeek' | 'lastModified'>): number {
  if (s.coverage === 'games') return x.games?.length ?? 0;
  if (s.coverage === 'weeks') return x.maxWeek ?? 0;
  return x.lastModified ? Date.parse(x.lastModified) : 0;
}

function readSnapshot(root: string, id: SourceId, season: number): Snapshot | null {
  const p = join(root, snapshotPath(id));
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as Snapshot;
    return s.id === id && s.season === season && s.version === SNAPSHOT_VERSION[id] ? s : null;
  } catch {
    return null;
  }
}

/** Coverage words and state for the copy in use. */
export function judge(s: SourceDef, snap: Snapshot, schedule: Game[], today: string): { state: 'fresh' | 'lagging'; coverage: string; note: string } {
  const due = schedule.filter((g) => g.homeScore !== null && daysBetween(g.gameday, today) >= s.lagDays);
  const dueWeek = due.reduce((m, g) => Math.max(m, g.week), 0);
  if (s.coverage === 'age') {
    const age = snap.lastModified ? daysBetween(snap.lastModified, today) : Infinity;
    const ok = age <= (s.maxAgeDays ?? Infinity);
    return { state: ok ? 'fresh' : 'lagging', coverage: snap.lastModified ? `updated ${snap.lastModified}` : 'date unknown', note: ok ? '' : `not updated in ${Number.isFinite(age) ? Math.round(age) : 'many'} days` };
  }
  if (s.coverage === 'weeks') {
    const w = snap.maxWeek ?? 0;
    return w >= dueWeek
      ? { state: 'fresh', coverage: `through week ${w}`, note: '' }
      : { state: 'lagging', coverage: `through week ${w}`, note: `week ${dueWeek} not in yet` };
  }
  const have = new Set(snap.games ?? []);
  // coverage words count every played game, due or not, so the footer says exactly what's in the file
  const played = schedule.filter((g) => g.homeScore !== null);
  const lastWeek = played.reduce((m, g) => Math.max(m, g.week), 0);
  let through = 0;
  for (let w = 1; w <= lastWeek; w++) {
    if (played.some((g) => g.week === w && !have.has(g.id))) break;
    through = w;
  }
  const next = played.filter((g) => g.week === through + 1);
  const partial = next.filter((g) => have.has(g.id)).length;
  const coverage = `through week ${through}${partial ? ` + ${partial} of ${next.length} week ${through + 1} games` : ''}`;
  const missingDue = due.filter((g) => !have.has(g.id));
  const behind = played.filter((g) => !have.has(g.id)).length;
  if (!behind) return { state: 'fresh', coverage, note: '' };
  // anything short of every played game is "lagging"; the note says whether that's the usual lag or overdue
  return {
    state: 'lagging',
    coverage,
    note: missingDue.length
      ? `${missingDue.length} games played ${s.lagDays}+ days ago not in yet (${[...new Set(missingDue.map((g) => `wk ${g.week}`))].join(', ')})`
      : `newest ${behind} games not in yet (usual lag of up to ${s.lagDays} days)`,
  };
}

export interface RefreshResult {
  output: ModelOutput;
  statuses: SourceStatus[];
  /** Files written, repo-relative. */
  written: string[];
}

export async function refresh(opts: RefreshOptions): Promise<RefreshResult> {
  const log = opts.log ?? (() => {});
  const season = seasonFor(opts.today);
  const used = new Map<SourceId, Snapshot>();
  const statuses: SourceStatus[] = [];
  const written: string[] = [];
  let schedule: Game[] = [];

  // schedules first: every other source's coverage is judged against it
  const ordered = [...SOURCES].sort((a, b) => Number(b.id === 'schedules') - Number(a.id === 'schedules'));
  for (const s of ordered) {
    const url = sourceUrl(s, season);
    const prev = readSnapshot(opts.root, s.id, season);
    let fresh: Snapshot | null = null;
    let why = '';
    try {
      const res = await opts.fetcher(url);
      if (!res.ok || !res.bytes) {
        why = res.status ? `download failed (HTTP ${res.status})` : 'download failed (network error)';
        if (res.error) log(`${s.id}: ${res.error}`);
      } else {
        if (opts.rawDir) {
          mkdirSync(opts.rawDir, { recursive: true });
          writeFileSync(join(opts.rawDir, rawFileName(s, season)), res.bytes);
        }
        const ex: Extracted = await extract(s.id, res.bytes, url, season);
        const empty = Array.isArray(ex.data) ? ex.data.length === 0 : (ex.data as PbpData).teamGames?.length === 0;
        if (empty && s.id !== 'schedules') why = 'file had no rows for this season';
        else fresh = { id: s.id, season, lastModified: isoDate(res.lastModified), games: ex.games?.slice().sort(), maxWeek: ex.maxWeek, ...(SNAPSHOT_VERSION[s.id] !== undefined ? { version: SNAPSHOT_VERSION[s.id] } : {}), data: ex.data };
      }
    } catch (e) {
      why = 'could not read the file';
      log(`${s.id}: ${(e as Error).message.split('\n')[0]}`);
    }
    let chosen: Snapshot | null = fresh;
    let kept = false;
    if (fresh && prev && size(s, prev) > size(s, fresh)) {
      chosen = prev;
      kept = true;
      why = 'the new file had less data than our last copy';
    } else if (!fresh && prev) {
      chosen = prev;
      kept = true;
    }
    if (s.id === 'schedules' && chosen) schedule = chosen.data as Game[];

    if (!chosen) {
      if (s.required) throw new Error(`${s.label}: ${why || 'unavailable'}, and there is no earlier copy; nothing to build from`);
      statuses.push({ id: s.id, label: s.label, asOf: null, coverage: '-', state: 'missing', note: why || 'unavailable' });
      log(`${s.id}: MISSING (${why})`);
      continue;
    }
    used.set(s.id, chosen);
    const j = judge(s, chosen, schedule, opts.today);
    const status: SourceStatus = kept
      ? { id: s.id, label: s.label, asOf: chosen.lastModified, coverage: j.coverage, state: 'kept', note: `${why}; using our last good copy${j.note ? `, ${j.note}` : ''}` }
      : { id: s.id, label: s.label, asOf: chosen.lastModified, coverage: j.coverage, state: j.state, note: j.note };
    statuses.push(status);
    log(`${s.id}: ${status.state} ${status.coverage}${status.note ? ` - ${status.note}` : ''}`);
    if (!kept) {
      const rel = snapshotPath(s.id);
      const abs = join(opts.root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(chosen)}\n`);
      written.push(rel);
    }
  }

  // keep the footer in the SOURCES order
  statuses.sort((a, b) => SOURCES.findIndex((s) => s.id === a.id) - SOURCES.findIndex((s) => s.id === b.id));

  const get = <T>(id: SourceId, fallback: T): T => (used.get(id)?.data as T | undefined) ?? fallback;
  const pbp = get<PbpData>('pbp', { teamGames: [], playerGames: [] });
  const ratingsCfg = opts.ratingsCfg ?? RATINGS_SOURCE;
  let ratings: Record<string, number> | undefined;
  if (ratingsCfg.enabled) {
    const p = join(opts.root, ratingsCfg.file);
    ratings = existsSync(p) ? parseRatings(JSON.parse(readFileSync(p, 'utf8'))) : undefined;
  }
  const inputs: ModelInputs = {
    season,
    games: schedule,
    teamGames: pbp.teamGames,
    playerGames: pbp.playerGames,
    pfrPass: get('pfr_pass', []),
    pfrRush: get('pfr_rush', []),
    pfrRec: get('pfr_rec', []),
    pfrDef: get('pfr_def', []),
    snaps: get('snaps', []),
    ngsPassing: get('ngs_passing', []),
    ngsReceiving: get('ngs_receiving', []),
    ngsRushing: get('ngs_rushing', []),
    roster: get('rosters', []),
    contracts: get('contracts', []),
    playerWeeks: get('player_weeks', []),
    ratings,
  };
  const dataAsOf = [...used.values()].map((s) => s.lastModified ?? '').filter((d) => d && d <= opts.today).sort().pop() ?? opts.today;
  const linemen = matchLinemen(inputs);
  log(`linemen matched to snap counts: ${linemen.ids.size}; no confident match (mostly linemen with no snaps yet): ${linemen.unmatched.length}${linemen.unmatched.length ? ` (${linemen.unmatched.slice(0, 20).join(', ')}${linemen.unmatched.length > 20 ? ', ...' : ''})` : ''}`);
  const output = buildModel(inputs, { sources: statuses, dataAsOf, ratingsCfg });
  const abs = join(opts.root, OUTPUT_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(output)}\n`);
  written.push(OUTPUT_FILE);
  return { output, statuses, written };
}
