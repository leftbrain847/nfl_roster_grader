/**
 * The nflverse files the refresh downloads, and how fresh each must be. Everything comes from the nflverse-data
 * GitHub releases; the page itself makes no network calls.
 */

export const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

export type SourceId =
  | 'schedules' | 'pbp' | 'rosters'
  | 'ngs_passing' | 'ngs_receiving' | 'ngs_rushing'
  | 'pfr_pass' | 'pfr_rush' | 'pfr_rec' | 'pfr_def'
  | 'snaps' | 'contracts' | 'player_weeks' | 'roster_moves' | 'trades' | 'draft'
  | 'depth_charts' | 'injuries' | 'pbp_prev' | 'participation' | 'participation_prev';

export type CoverageKind = 'games' | 'weeks' | 'age';

export interface SourceDef {
  id: SourceId;
  label: string;
  /** Release tag / file name; `{season}` is replaced. */
  path: string;
  /** How completeness is measured: games present, latest week present, or file age. */
  coverage: CoverageKind;
  /** A game counts as "should be in this file" once this many days have passed since its game day. */
  lagDays: number;
  /** For coverage 'age': older than this many days is lagging. */
  maxAgeDays?: number;
  /** Without these the page can't be built at all (a kept copy still works). */
  required: boolean;
  /** Read another season's file: -1 = last season. */
  seasonOffset?: number;
  /** Shown instead of the download error when there is no copy yet and that is expected. */
  missingNote?: string;
}

export const SOURCES: SourceDef[] = [
  { id: 'schedules', label: 'Schedules', path: 'schedules/games.csv', coverage: 'games', lagDays: 1, required: true },
  { id: 'pbp', label: 'Play-by-play (EPA)', path: 'pbp/play_by_play_{season}.csv.gz', coverage: 'games', lagDays: 1, required: true },
  { id: 'rosters', label: 'Weekly rosters', path: 'weekly_rosters/roster_weekly_{season}.csv', coverage: 'weeks', lagDays: 3, required: true },
  { id: 'ngs_passing', label: 'Next Gen Stats: passing', path: 'nextgen_stats/ngs_passing.csv.gz', coverage: 'weeks', lagDays: 3, required: false },
  { id: 'ngs_receiving', label: 'Next Gen Stats: receiving', path: 'nextgen_stats/ngs_receiving.csv.gz', coverage: 'weeks', lagDays: 3, required: false },
  { id: 'ngs_rushing', label: 'Next Gen Stats: rushing', path: 'nextgen_stats/ngs_rushing.csv.gz', coverage: 'weeks', lagDays: 3, required: false },
  { id: 'pfr_pass', label: 'PFR advanced: passing', path: 'pfr_advstats/advstats_week_pass_{season}.csv', coverage: 'games', lagDays: 3, required: false },
  { id: 'pfr_rush', label: 'PFR advanced: rushing', path: 'pfr_advstats/advstats_week_rush_{season}.csv', coverage: 'games', lagDays: 3, required: false },
  { id: 'pfr_rec', label: 'PFR advanced: receiving', path: 'pfr_advstats/advstats_week_rec_{season}.csv', coverage: 'games', lagDays: 3, required: false },
  { id: 'pfr_def', label: 'PFR advanced: defense', path: 'pfr_advstats/advstats_week_def_{season}.csv', coverage: 'games', lagDays: 3, required: false },
  { id: 'snaps', label: 'Snap counts (PFR)', path: 'snap_counts/snap_counts_{season}.csv', coverage: 'games', lagDays: 3, required: false },
  // The contracts table (OverTheCap via nflverse) is only kept current as parquet; the old csv.gz stopped in 2022.
  { id: 'contracts', label: 'Contracts (OverTheCap)', path: 'contracts/historical_contracts.parquet', coverage: 'age', lagDays: 0, maxAgeDays: 30, required: false },
  { id: 'player_weeks', label: 'Weekly player stats', path: 'stats_player/stats_player_week_{season}.csv', coverage: 'games', lagDays: 2, required: false },
  // the move tracker reads the weekly roster file a second time, for every player's week-by-week team and status
  { id: 'roster_moves', label: 'Roster moves (weekly rosters)', path: 'weekly_rosters/roster_weekly_{season}.csv', coverage: 'weeks', lagDays: 3, required: false },
  // nflverse updates the trades file a few times a year, so in-season trades show up as roster moves until it catches up
  { id: 'trades', label: 'Trades', path: 'trades/trades.csv', coverage: 'age', lagDays: 0, maxAgeDays: 400, required: false },
  { id: 'draft', label: 'Draft picks', path: 'draft_picks/draft_picks.csv', coverage: 'age', lagDays: 0, maxAgeDays: 400, required: false },
  // dated ESPN depth chart snapshots (about two a day), one file per season from 2025 on; ~75 MB by midseason
  { id: 'depth_charts', label: 'Depth charts', path: 'depth_charts/depth_charts_{season}.csv', coverage: 'age', lagDays: 0, maxAgeDays: 3, required: false },
  { id: 'injuries', label: 'Injury reports', path: 'injuries/injuries_{season}.csv', coverage: 'weeks', lagDays: 3, required: false },
  // personnel: FTN participation is published for a season after it ends; last season's needs its play-by-play for EPA
  { id: 'participation', label: 'FTN participation (this season)', path: 'pbp_participation/pbp_participation_{season}.csv', coverage: 'age', lagDays: 0, maxAgeDays: 400, required: false, missingNote: 'published after the season ends; until then personnel is estimated from snap counts' },
  { id: 'participation_prev', label: 'FTN participation (last season)', path: 'pbp_participation/pbp_participation_{season}.csv', coverage: 'age', lagDays: 0, maxAgeDays: 400, required: false, seasonOffset: -1 },
  { id: 'pbp_prev', label: 'Play-by-play (last season, for personnel EPA)', path: 'pbp/play_by_play_{season}.csv.gz', coverage: 'age', lagDays: 0, maxAgeDays: 400, required: false, seasonOffset: -1 },
];

export const sourceUrl = (s: SourceDef, season: number): string => `${NFLVERSE_BASE}/${s.path.replace('{season}', String(season))}`;
export const rawFileName = (s: SourceDef, season: number): string => s.path.replace('{season}', String(season)).replace(/\//g, '__');

/** First month of a new season's data (games start in September; before that the page keeps last season). */
export const SEASON_START_MONTH = 9;

/** The NFL season the page shows on a date: September onward is that year's season, January to August the previous one. */
export function seasonFor(dateIso: string): number {
  const [y, m] = dateIso.split('-').map(Number) as [number, number];
  return m >= SEASON_START_MONTH ? y : y - 1;
}
