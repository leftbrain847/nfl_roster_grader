/** Shapes shared by the refresh pipeline (pipeline/), the model (src/model/) and the page (src/client/). */
import type { FantasyPos, LineKey, LogKind, MoveKind, PositionGroup, RankingMode, StatKey, UnitKey, Verdict } from './config.ts';

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
  /** Sums of nflfastR series_success (1 = the play's series earned a first down or touchdown) over the pass and rush
   * plays counted above. Absent in a saved copy from before series success. */
  passSs?: number;
  rushSs?: number;
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
  /** Red zone: [targets, carries] for each of RED_ZONE.zones in order, flattened. Absent when all zero. */
  rz?: number[];
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

/** One player's weekly roster history: only the weeks where his team or status changed (plus his first week). */
export interface RosterHistory {
  p: string;
  /** PFR id, to match trade rows. */
  f: string | null;
  n: string;
  pos: string;
  /** [week, team, status] */
  h: [number, string, string][];
}

/** One asset in a trade: a player (pfr id and name) or a draft pick. */
export interface TradeRow {
  id: string; date: string; gave: string; received: string; pfr: string | null; name: string; pickSeason: number | null; pickRound: number | null;
  /** Overall pick number, when known (picks in a draft that's already set). */
  pickNumber?: number | null;
  /** A conditional pick (its round or existence depends on something later). */
  conditional?: boolean;
}

/** One player on one depth chart snapshot. */
export interface DepthRow {
  /** Group (pos_grp), position (pos_abb), slot order on the chart, depth (1 = starter). */
  grp: string;
  pos: string;
  slot: number;
  rank: number;
  id: string;
  name: string;
}

/** A team's newest depth chart and the one it is compared with (DEPTH.minDaysBefore). */
export interface DepthSnapshot {
  team: string;
  /** Snapshot time, ISO (the file's dt). */
  dt: string;
  rows: DepthRow[];
  prevDt: string | null;
  prev: DepthRow[];
}

/** One line of the weekly injury report (nflverse injuries). */
export interface InjuryRow {
  p: string;
  t: string;
  wk: number;
  name: string;
  pos: string;
  /** Game designation: Out, Doubtful, Questionable, or '' (none). */
  report: string;
  /** The week's practice participation as nflverse has it (one value a week), or ''. */
  practice: string;
  injury: string;
}

export interface DraftPick { season: number; round: number; pick: number; team: string; gsis: string | null; name: string; pos: string }

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
  /** The move tracker's inputs; optional so older test inputs still build. */
  rosterHistory?: RosterHistory[];
  trades?: TradeRow[];
  draft?: DraftPick[];
  depthCharts?: DepthSnapshot[];
  injuries?: InjuryRow[];
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
  /** The same unit on series success (0-1: share of plays in series that earned a first down or TD), adjusted the
   * same way. Shown beside EPA; verdicts use EPA. Absent when the play-by-play has no series column. */
  series?: Omit<UnitResult, 'series'>;
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

/** One move in the tracker. */
export interface Move {
  /** YYYY-MM-DD, for sorting (newest first). Weekly roster moves take the date of that week's first game. */
  date: string;
  /** How the page shows when: "Mar 2", "Week 8", "2026 draft". */
  when: string;
  kind: MoveKind;
  /** gsis id when known (it links to the player's page if he has one). */
  id: string | null;
  name: string;
  pos: string;
  /** The position filter's group. */
  group: string;
  team: string;
  /** The other team, if any (traded from, signed from). */
  from: string | null;
  detail: string;
  /** A traded draft pick (not a player). */
  pick?: boolean;
  /** Trades file rows: the trade's id and, for a pick, which pick. */
  tradeId?: string;
  pickOf?: { season: number; round: number; number: number | null; conditional?: boolean };
  /** Trades file rows: the whole trade, valued for each team (the same card on every row of the trade). */
  trade?: TradeCard;
  /** The move judged for each team in it: the team first, then (trades) the team that gave the player up. */
  grades?: MoveGrade[];
}

/** One asset in a trade, valued in dollars of surplus, with the arithmetic spelled out. */
export interface TradeAsset {
  name: string;
  /** gsis id (links to the player page), null for a pick. */
  id: string | null;
  pos: string;
  /** null: no value (no ranked production, or a pick that can't be identified). */
  millions: number | null;
  how: string;
}

export interface TradeSide {
  team: string;
  /** 0-100 from net value; null when an asset in the trade has no value. */
  score: number | null;
  word: string | null;
  valueIn: number;
  valueOut: number;
  net: number;
  received: TradeAsset[];
}

export interface TradeCard {
  id: string;
  date: string;
  sides: TradeSide[];
  /** Why there's no grade, when there isn't one. */
  note: string | null;
}

export interface MoveGrade {
  team: string;
  /** 0-100, or null when it can't be graded (the reason says why). */
  score: number | null;
  word: string | null;
  reason: string;
}

/** Points one defense allowed to one position per game over a window, raw and opponent-adjusted. */
export interface FantasyAllowedWindow {
  games: number;
  /** PPR points per game. */
  raw: number;
  adjusted: number;
  /** 1 = allows the most. */
  rawRank: number;
  adjustedRank: number;
}

export interface FantasyAllowed {
  /** The recent window: weeks fromWeek..throughWeek. */
  recentWeeks: number;
  fromWeek: number;
  throughWeek: number;
  /** team -> position -> season and recent windows (recent is null for a team with no game in it). */
  teams: Record<string, Partial<Record<FantasyPos, { season: FantasyAllowedWindow; recent: FantasyAllowedWindow | null }>>>;
}

export interface RedZonePlayer {
  id: string;
  name: string;
  pos: string;
  /** Season [targets, carries] per zone, flattened like PlayerGame.rz. */
  season: number[];
  /** [week, ...counts] for each week he had a red zone target or carry. */
  weeks: number[][];
}

export interface RedZoneTeam {
  /** Team totals, season and by week ([week, ...counts]). */
  season: number[];
  weeks: number[][];
  /** Everyone with a red zone target or carry, most opportunities in the first zone first. */
  players: RedZonePlayer[];
}

export interface RedZoneUsage {
  zones: { key: string; label: string; maxYardline: number }[];
  /** Weeks with play-by-play. */
  weeks: number[];
  teams: Record<string, RedZoneTeam>;
}

export interface DepthEntry {
  id: string;
  name: string;
  rank: number;
  /** Production score (0-100) and rank at his position group, when he is ranked. */
  score: number | null;
  group: PositionGroup | null;
  /** This week's game designation or a reserve status, short label; null when healthy / not listed. */
  designation: string | null;
  /** Versus the compared snapshot: new to this slot, moved up or down (prevRank says from where), or unchanged. */
  change: 'new' | 'up' | 'down' | null;
  prevRank: number | null;
}

export interface DepthSlotView {
  pos: string;
  players: DepthEntry[];
  /** Players on this slot in the compared snapshot who are no longer on it. */
  gone: { id: string; name: string; prevRank: number }[];
}

export interface DepthChartView {
  team: string;
  /** Snapshot dates, YYYY-MM-DD. */
  asOf: string;
  comparedWith: string | null;
  groups: { name: string; side: 'offense' | 'defense'; slots: DepthSlotView[] }[];
  /** Number of flagged changes (new, up, down, gone). */
  changes: number;
}

/** The This week tab. Optional in the output so a data file from before it still loads. */
export interface ThisWeek {
  /** The first week with a game not yet played (or the last week, after the season). */
  week: number;
  fantasyAllowed: FantasyAllowed;
  redZone?: RedZoneUsage;
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
  moves: Move[];
  sources: SourceStatus[];
  rankingModes: RankingMode[];
  ratingsCredit: string | null;
  thisWeek?: ThisWeek;
  /** Team depth charts (team sheets). */
  depthCharts?: DepthChartView[];
}
