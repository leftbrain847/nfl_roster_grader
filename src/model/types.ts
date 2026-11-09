/** Shapes shared by the refresh pipeline (pipeline/), the model (src/model/) and the page (src/client/). */
import type { PositionGroup, RankingMode, StatKey, UnitKey, Verdict } from './config.ts';

// ------------------------------------------------------------------ model inputs (compact, built from nflverse)

export interface Game {
  id: string;
  week: number;
  gameday: string;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  neutral: boolean;
}

/** One offense's plays in one game (garbage time filtered out), for the unit grades. */
export interface TeamGame {
  game: string;
  off: string;
  def: string;
  /** 1 if the offense was at home, 0 if away or at a neutral site. */
  offHome: 0 | 1;
  passN: number;
  passEpa: number;
  rushN: number;
  rushEpa: number;
  /** Sacks + QB hits by this defense (pass-rush half of pass D). */
  rushHits: number;
  /** Non-sack pass attempts and their EPA (coverage half of pass D). */
  covN: number;
  covEpa: number;
}

/** One player's counting stats in one game, from play-by-play (all plays, no garbage-time filter). */
export interface PlayerGame {
  p: string;
  g: string;
  t: string;
  db?: number; dbEpa?: number; dbSucc?: number; sk?: number; cpoeSum?: number; cpoeN?: number;
  car?: number; carEpa?: number; carSucc?: number;
  tgt?: number; tgtEpa?: number;
  tkl?: number; tfl?: number; sck?: number; qbh?: number; pd?: number; int?: number;
}

export interface PfrPassRow { p: string; g: string; t: string; pressured: number; sacked: number }
export interface PfrRushRow { p: string; g: string; t: string; carries: number; yac: number; btRush: number; btRec: number }
export interface PfrRecRow { p: string; g: string; t: string; drops: number; btRec: number }
export interface PfrDefRow {
  p: string; g: string; t: string;
  targets: number; completions: number; yards: number; ratingSum: number; ints: number;
  pressures: number; tackles: number; missed: number;
}
export interface SnapRow { p: string; g: string; t: string; off: number; def: number }

export interface NgsPassing { p: string; att: number; cpoe: number }
export interface NgsReceiving { p: string; tgt: number; separation: number; yacOverExpected: number }
export interface NgsRushing { p: string; att: number; ryoePerAtt: number }

export interface RosterPlayer {
  gsis: string;
  pfr: string | null;
  name: string;
  team: string;
  depth: string;
  week: number;
  status: string;
}

export interface Contract { gsis: string; apyMillions: number; capPct: number; lastYear: number }

export interface ModelInputs {
  season: number;
  games: Game[];
  teamGames: TeamGame[];
  playerGames: PlayerGame[];
  pfrPass: PfrPassRow[];
  pfrRush: PfrRushRow[];
  pfrRec: PfrRecRow[];
  pfrDef: PfrDefRow[];
  snaps: SnapRow[];
  ngsPassing: NgsPassing[];
  ngsReceiving: NgsReceiving[];
  ngsRushing: NgsRushing[];
  roster: RosterPlayer[];
  contracts: Contract[];
  /** gsis_id -> 0-100, only when the optional ratings source is enabled. */
  ratings?: Record<string, number>;
}

// ------------------------------------------------------------------ freshness of each source

export type SourceState = 'fresh' | 'lagging' | 'kept' | 'missing';

export interface SourceStatus {
  id: string;
  label: string;
  /** Last-Modified of the file we're using, YYYY-MM-DD (UTC). */
  asOf: string | null;
  /** Coverage in plain words: "through week 9", "135 of 135 games". */
  coverage: string;
  state: SourceState;
  /** Why it's lagging, kept or missing. Empty when fresh. */
  note: string;
}

// ------------------------------------------------------------------ model output (what the page renders)

export interface UnitResult {
  /** Opponent-adjusted EPA per play (EPA allowed for defense). */
  adjusted: number;
  raw: number;
  plays: number;
  grade: number;
  rank: number;
}

export interface TeamResult {
  team: string;
  name: string;
  conference: string;
  division: string;
  wins: number;
  losses: number;
  ties: number;
  record: string;
  pointDiff: number;
  units: Record<UnitKey, UnitResult>;
  /** Points per game better than an average team, after regression. */
  strength: number;
  /** Mean strength of remaining opponents; rank 1 = hardest schedule left. */
  scheduleLeft: number;
  scheduleLeftRank: number;
  gamesLeft: number;
  playoffOdds: number;
  verdict: Verdict;
  reason: string;
  weakest: UnitKey;
  /** What this team should shop for (buyers only). */
  need: { label: string; positions: PositionGroup[] } | null;
  /** Buyers: top producers at the need positions on seller teams. */
  buyTargets: string[];
  /** Sellers: their best producers. */
  chips: string[];
}

export interface PlayerStat {
  key: StatKey;
  value: number;
  /** Percentile within the position (0-100, higher is better after flipping lower-is-better stats). */
  pct: number;
}

export interface PlayerResult {
  id: string;
  name: string;
  team: string;
  group: PositionGroup;
  depth: string;
  /** Latest weekly roster status (ACT, RES, ...). */
  status: string;
  /** The qualifying volume: "212 dropbacks". */
  volume: string;
  stats: PlayerStat[];
  scores: Partial<Record<RankingMode, number>> & { production: number };
  /** Rank within the position by production score. */
  rank: number;
  qualifiedAtPosition: number;
  contract: { apyMillions: number; capPct: number; lastYear: number } | null;
}

export interface ModelOutput {
  schemaVersion: 1;
  /** True only for the built-in sample (no real data yet): the page shows a banner. */
  sample: boolean;
  season: number;
  throughWeek: number;
  /** Newest Last-Modified among the sources used, YYYY-MM-DD. */
  dataAsOf: string;
  teams: TeamResult[];
  players: PlayerResult[];
  sources: SourceStatus[];
  rankingModes: RankingMode[];
  ratingsCredit: string | null;
}
