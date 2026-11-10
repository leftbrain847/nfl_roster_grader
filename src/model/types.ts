/** Shapes shared by the refresh pipeline (pipeline/), the model (src/model/) and the page (src/client/). */
import type { LineKey, LogKind, PositionGroup, RankingMode, StatKey, UnitKey, Verdict } from './config.ts';

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
  tkl?: number; tfl?: number; sck?: number; qbh?: number; pd?: number; int?: number; ff?: number;
  /** Big-play EPA (BIG_PLAYS in config.ts): the EPA taken from the offense on plays he made one, his share. */
  big?: number;
}

export interface PfrPassRow { p: string; g: string; t: string; pressured: number; sacked: number }
export interface PfrRushRow { p: string; g: string; t: string; carries: number; ybc: number; yac: number; btRush: number; btRec: number }
export interface PfrRecRow { p: string; g: string; t: string; drops: number; btRec: number }
export interface PfrDefRow {
  p: string; g: string; t: string;
  targets: number; completions: number; yards: number; ratingSum: number; ints: number;
  pressures: number; tackles: number; missed: number;
}
export interface SnapRow {
  p: string; g: string; t: string; off: number; def: number;
  /** Player name, kept only for offensive linemen: the roster file has no PFR id for them, so they join by name. */
  n?: string;
}

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

/** One player's stat line in one game, from the nflverse weekly player stats. */
export interface PlayerWeek {
  p: string;
  name: string;
  /** nflverse position (WR, CB, DT, ...). */
  pos: string;
  kind: LogKind;
  t: string;
  opp: string;
  g: string;
  wk: number;
  /** One value per column of GAME_LOG.columns[kind], in that order. */
  v: number[];
}

/** One season of a contract, in millions. null = not in the file. */
export interface ContractSeason {
  year: number;
  base: number | null;
  /** Cap number: what the player counts against his team's cap that season. */
  cap: number | null;
  cash: number | null;
}

export interface Contract {
  gsis: string;
  apyMillions: number;
  capPct: number;
  lastYear: number;
  /** This season's base salary, millions (null if the contract has no row for this season). */
  baseSalaryMillions: number | null;
  /** The rest are optional so a last good copy saved before they existed still loads. */
  yearSigned?: number;
  years?: number | null;
  valueMillions?: number | null;
  guaranteedMillions?: number | null;
  /** This season and later. */
  seasons?: ContractSeason[];
}

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
  playerWeeks: PlayerWeek[];
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

export interface LineResult {
  /** Pressure rate allowed (%) or yards before contact per carry. */
  value: number;
  grade: number;
  rank: number;
}

export interface PlayerContract {
  apyMillions: number;
  capPct: number;
  lastYear: number;
  baseSalaryMillions: number | null;
  /** Base salary still to be paid this season: what a team trading for him now takes on (bonuses excluded). */
  baseSalaryLeftMillions: number | null;
}

/** An offensive-line starter on a selling team, ranked by his team's line grade (not an individual grade). */
export interface LineTarget {
  id: string;
  name: string;
  team: string;
  depth: string;
  /** Share of his team's offense snaps in the games he played, 0-1. */
  snapShare: number;
  lineGrade: number;
  contract: PlayerContract | null;
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
  need: { label: string; positions: PositionGroup[]; line?: LineKey } | null;
  /** Buyers: top producers at the need positions on seller teams. */
  buyTargets: string[];
  /** Sellers: their best producers. */
  chips: string[];
  /** Team-level offensive-line grades; null when the PFR data behind one is missing. */
  line: Record<LineKey, LineResult | null>;
  /** Buyers whose need is on the offensive line: starters from sellers' best lines. */
  lineTargets: LineTarget[];
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
  contract: PlayerContract | null;
}

/** The contract as the player page shows it: the summary plus the deal's terms and year-by-year numbers. */
export interface ContractDetail extends PlayerContract {
  yearSigned: number | null;
  years: number | null;
  valueMillions: number | null;
  guaranteedMillions: number | null;
  seasons: ContractSeason[];
}

export interface GameLogRow {
  wk: number;
  team: string;
  opp: string;
  home: boolean;
  /** "W 24-17", or empty when the schedule has no score. */
  result: string;
  /** Share of the team's offense (or defense) snaps, 0-100; null when snap counts don't have the game yet. */
  snapPct: number | null;
  v: number[];
}

/** One player's page: game log and contract. Every skill player and defender with a stat this season has one. */
export interface PlayerProfile {
  id: string;
  name: string;
  team: string;
  pos: string;
  kind: LogKind;
  log: GameLogRow[];
  contract: ContractDetail | null;
}

/** A fantasy-relevant player and what his points cost. */
export interface FantasyValue {
  id: string;
  name: string;
  team: string;
  pos: string;
  games: number;
  points: number;
  perGame: number;
  /** This season's cap hit. */
  capMillions: number;
  /** Points per $1M of cap hit. */
  perMillion: number;
}

export interface LineupPlayer { slot: string; id: string; name: string; team: string; pos: string; points: number; capMillions: number }

/** The highest-scoring lineup whose cap hits fit a budget, over the season or in one week. `points` are fantasy
 * points, or production scores for the best roster. */
export interface Lineup {
  budgetMillions: number;
  scope: 'season' | 'week';
  week: number | null;
  points: number;
  capMillions: number;
  players: LineupPlayer[];
}

/** A ranked player's production against his cap hit. */
export interface PlayerValue {
  id: string;
  name: string;
  team: string;
  group: PositionGroup;
  /** Production percentile at the position. */
  production: number;
  capMillions: number;
  /** What his production is worth: the cap hit at the same percentile of pay at his position, millions. */
  worthMillions: number;
  /** worthMillions - capMillions: positive = produces more than he costs. */
  surplus: number;
}

export interface FrontOffice {
  team: string;
  /** 0-100 among the 32 teams; null with too few priced players. */
  grade: number | null;
  rank: number | null;
  /** Sum of the team's ranked players' surplus, millions. */
  surplus: number;
  /** Cap dollars the grade covers (ranked players only). */
  capMillions: number;
  players: number;
  bargains: PlayerValue[];
  overpays: PlayerValue[];
  /** Big cap hits on players without the volume to be ranked (hurt, benched): listed, not graded. */
  idle: { id: string; name: string; pos: string; capMillions: number }[];
}

export interface ValueOutput {
  /** Every ranked player with a known cap hit, best surplus first. */
  players: PlayerValue[];
  /** Best rosters by production score under each budget. */
  rosters: Lineup[];
  fantasy: FantasyValue[];
  lineups: Lineup[];
  frontOffices: FrontOffice[];
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
  profiles: PlayerProfile[];
  value: ValueOutput;
  sources: SourceStatus[];
  rankingModes: RankingMode[];
  ratingsCredit: string | null;
}
