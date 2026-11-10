/**
 * Every weight, threshold and label the model uses. Logic files import from here; they hold no magic numbers.
 * Change a value here, run `npm test`, and the nightly refresh picks it up.
 */

// ---------------------------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------------------------

export type UnitKey = 'passOffense' | 'rushOffense' | 'passDefense' | 'rushDefense';
export const UNIT_KEYS: readonly UnitKey[] = ['passOffense', 'rushOffense', 'passDefense', 'rushDefense'];

export interface UnitLabel {
  /** Column header in the league table. */
  short: string;
  /** Used in the one-line reason ("pass D 27th"). */
  reason: string;
  /** Full name on the team sheet. */
  long: string;
  /** Offense units: high EPA is good. Defense units: low EPA allowed is good. */
  side: 'offense' | 'defense';
  play: 'pass' | 'rush';
}

export const UNITS: Record<UnitKey, UnitLabel> = {
  passOffense: { short: 'Pass O', reason: 'pass O', long: 'Pass offense', side: 'offense', play: 'pass' },
  rushOffense: { short: 'Rush O', reason: 'rush O', long: 'Rush offense', side: 'offense', play: 'rush' },
  passDefense: { short: 'Pass D', reason: 'pass D', long: 'Pass defense', side: 'defense', play: 'pass' },
  rushDefense: { short: 'Rush D', reason: 'rush D', long: 'Rush defense', side: 'defense', play: 'rush' },
};

// ---------------------------------------------------------------------------------------------------------------
// Opponent adjustment (ridge regression; see src/model/adjust.ts for why ridge)
// ---------------------------------------------------------------------------------------------------------------

export interface AdjustConfig {
  /**
   * Ridge penalty, in plays. Each team's offense and defense effect is shrunk toward league average as if it had
   * this many extra league-average plays. Half a season is ~250 dropbacks and ~200 runs per team, so 120 pulls a
   * small, noisy sample noticeably toward the mean and barely moves a full season.
   */
  lambdaPlays: { pass: number; rush: number };
  /** Fit a single home-field term (offense at home vs away). Neutral-site games count as neither. */
  homeField: boolean;
  /** Gauss-Seidel stops when no coefficient moves more than this (EPA/play)... */
  tolerance: number;
  /** ...or after this many sweeps. */
  maxIterations: number;
}

export const ADJUST: AdjustConfig = {
  lambdaPlays: { pass: 120, rush: 120 },
  homeField: true,
  tolerance: 1e-9,
  maxIterations: 500,
};

/** Which plays count toward team unit grades. */
export interface PlayFilterConfig {
  /** Drop garbage time: plays where the offense's win probability is outside [min, max]. */
  winProbability: { min: number; max: number };
  /** Regular season only. */
  seasonType: 'REG';
}

export const PLAY_FILTER: PlayFilterConfig = {
  winProbability: { min: 0.05, max: 0.95 },
  seasonType: 'REG',
};

// ---------------------------------------------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------------------------------------------

export interface GradeConfig {
  /**
   * 0-100 grade = 100 x normal CDF of the team's z-score among all teams (sign flipped for defense), so 50 is
   * league average and each 10 points is roughly a quarter of a standard deviation near the middle.
   */
  scale: 'normal-cdf';
  /** Round grades to this many decimals. */
  decimals: number;
}

export const GRADE: GradeConfig = { scale: 'normal-cdf', decimals: 0 };

// ---------------------------------------------------------------------------------------------------------------
// Team strength and the playoff-odds estimate
// ---------------------------------------------------------------------------------------------------------------

export interface StrengthConfig {
  /** Plays per team per game, to turn net adjusted EPA/play into points per game (EPA is in points). */
  playsPerGame: number;
  /** Blend of the two strength signals (sums to 1): opponent-adjusted EPA vs actual point differential. */
  weights: { adjustedEpa: number; pointDifferential: number };
  /** Multiply the blend by this to regress toward average (a half season is a small sample). */
  regression: number;
}

export const STRENGTH: StrengthConfig = {
  playsPerGame: 62,
  weights: { adjustedEpa: 0.6, pointDifferential: 0.4 },
  regression: 0.7,
};

export interface PlayoffSimConfig {
  /** Label shown next to every odds number: it is a rough model, not a betting line. */
  label: string;
  simulations: number;
  /** Seed for the deterministic random stream (same data, same odds). */
  seed: number;
  /** Home-field advantage, points. */
  homeFieldPoints: number;
  /** Standard deviation of an NFL game's margin around the expected margin, points. */
  marginSd: number;
  /** Playoff spots per conference: division winners first, then the best remaining records. */
  spotsPerConference: number;
  /** Probability a simulated game ends tied. */
  tieProbability: number;
}

export const PLAYOFF_SIM: PlayoffSimConfig = {
  label: 'Playoff odds (rough sim)',
  simulations: 10000,
  seed: 20261109,
  homeFieldPoints: 1.5,
  marginSd: 13.5,
  spotsPerConference: 7,
  tieProbability: 0.003,
};

// ---------------------------------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------------------------------

export type Verdict = 'buy' | 'sell' | 'stand pat';

export interface VerdictConfig {
  /** At or above: a contender. It buys if it has a hole, else stands pat. */
  contenderOdds: number;
  /** At or below: a seller. */
  sellerOdds: number;
  /** In between (the bubble), the remaining schedule decides. */
  bubble: {
    /** Buy if odds are at least this AND the schedule left is among the easiest `easyThird` teams' schedules. */
    buyOdds: number;
    /** Sell if odds are at most this AND the schedule left is among the hardest `hardThird` teams' schedules. */
    sellOdds: number;
  };
  /** Schedule-left rank cutoffs (1 = hardest remaining schedule). */
  schedule: { hardRankMax: number; easyRankMin: number };
  /** A unit graded below this is a hole worth buying for. */
  holeGrade: number;
  labels: Record<Verdict, string>;
}

export const VERDICT: VerdictConfig = {
  contenderOdds: 0.55,
  sellerOdds: 0.15,
  bubble: { buyOdds: 0.35, sellOdds: 0.3 },
  schedule: { hardRankMax: 11, easyRankMin: 22 },
  holeGrade: 45,
  labels: { buy: 'Buy', sell: 'Sell', 'stand pat': 'Stand pat' },
};

// ---------------------------------------------------------------------------------------------------------------
// Positions, the stats behind each position's production score, and qualifying minimums
// ---------------------------------------------------------------------------------------------------------------

export type PositionGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'EDGE' | 'IDL' | 'LB' | 'CB' | 'S';
export const POSITION_GROUPS: readonly PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'EDGE', 'IDL', 'LB', 'CB', 'S'];

/**
 * Roster depth-chart position -> position group. OL, K, P and LS have no open per-player production stat good
 * enough to rank, so they are left out (documented in the README). OLB counts as EDGE: in most fronts it rushes.
 */
export const DEPTH_TO_GROUP: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB', FB: 'RB', HB: 'RB',
  WR: 'WR',
  TE: 'TE',
  DE: 'EDGE', OLB: 'EDGE',
  DT: 'IDL', NT: 'IDL',
  ILB: 'LB', MLB: 'LB', LB: 'LB',
  CB: 'CB',
  FS: 'S', SS: 'S', S: 'S', SAF: 'S',
};

/** Every stat a position score can use. Each is computed in src/model/players.ts from the sources named here. */
export type StatKey =
  | 'epaPerDropback' | 'successRate' | 'cpoe' | 'sackRate' | 'pressureToSack'
  | 'rushEpaPerCarry' | 'rushSuccessRate' | 'ryoePerCarry' | 'yacPerCarry' | 'brokenTacklesPerCarry'
  | 'epaPerTarget' | 'targetShare' | 'separation' | 'yacOverExpected' | 'dropRate'
  | 'pressuresPer100' | 'sacksPer100' | 'tflPer100' | 'bigPlaysPer100' | 'tacklesPer100' | 'missedTackleRate'
  | 'yardsPerTargetAllowed' | 'ratingAllowed' | 'completionAllowed' | 'ballsPlayedPerTarget';

export interface StatDef {
  label: string;
  /** How it's shown: decimals and an optional unit suffix. */
  decimals: number;
  suffix?: string;
  /** Lower is better (sack rate, drops, yards allowed). */
  lowerIsBetter?: boolean;
  /** Where it comes from, for the footnote on each score. */
  source: string;
}

export const STATS: Record<StatKey, StatDef> = {
  epaPerDropback: { label: 'EPA/dropback', decimals: 2, source: 'play-by-play' },
  successRate: { label: 'Success rate', decimals: 0, suffix: '%', source: 'play-by-play' },
  cpoe: { label: 'CPOE', decimals: 1, source: 'Next Gen Stats' },
  sackRate: { label: 'Sack rate', decimals: 1, suffix: '%', lowerIsBetter: true, source: 'play-by-play' },
  pressureToSack: { label: 'Pressure-to-sack', decimals: 0, suffix: '%', lowerIsBetter: true, source: 'PFR' },
  rushEpaPerCarry: { label: 'EPA/carry', decimals: 2, source: 'play-by-play' },
  rushSuccessRate: { label: 'Success rate', decimals: 0, suffix: '%', source: 'play-by-play' },
  ryoePerCarry: { label: 'RYOE/carry', decimals: 2, source: 'Next Gen Stats' },
  yacPerCarry: { label: 'Yds after contact/carry', decimals: 2, source: 'PFR' },
  brokenTacklesPerCarry: { label: 'Broken tackles/carry', decimals: 2, source: 'PFR' },
  epaPerTarget: { label: 'EPA/target', decimals: 2, source: 'play-by-play' },
  targetShare: { label: 'Target share', decimals: 0, suffix: '%', source: 'play-by-play' },
  separation: { label: 'Separation (yds)', decimals: 1, source: 'Next Gen Stats' },
  yacOverExpected: { label: 'YAC over expected', decimals: 1, source: 'Next Gen Stats' },
  dropRate: { label: 'Drop rate', decimals: 1, suffix: '%', lowerIsBetter: true, source: 'PFR' },
  pressuresPer100: { label: 'Pressures/100 snaps', decimals: 1, source: 'PFR' },
  sacksPer100: { label: 'Sacks/100 snaps', decimals: 1, source: 'play-by-play' },
  tflPer100: { label: 'TFL/100 snaps', decimals: 1, source: 'play-by-play' },
  bigPlaysPer100: { label: 'Big-play EPA/100 snaps', decimals: 1, source: 'play-by-play' },
  tacklesPer100: { label: 'Tackles/100 snaps', decimals: 1, source: 'play-by-play' },
  missedTackleRate: { label: 'Missed tackle rate', decimals: 0, suffix: '%', lowerIsBetter: true, source: 'PFR' },
  yardsPerTargetAllowed: { label: 'Yds/target allowed', decimals: 1, lowerIsBetter: true, source: 'PFR' },
  ratingAllowed: { label: 'Rating allowed', decimals: 0, lowerIsBetter: true, source: 'PFR' },
  completionAllowed: { label: 'Comp % allowed', decimals: 0, suffix: '%', lowerIsBetter: true, source: 'PFR' },
  ballsPlayedPerTarget: { label: 'INT+PD/target', decimals: 2, source: 'play-by-play + PFR' },
};

/**
 * Big plays: the defensive plays worth more than a tackle (a sack, interception, forced fumble, tackle for loss, pass
 * defensed or QB hit). Each is worth the EPA it took from the offense on that play (minus the play's EPA, never below
 * 0), so a takeaway counts more than a sack, a third-down sack more than a first-down one, and a forced fumble the
 * offense recovers little. When several defenders made a big play on one play, they split it evenly; a player
 * credited with several things on one play (a sack is nearly always also a QB hit) is counted once. Every defender
 * is credited the same way, whatever his position, and every defensive group weighs them the same.
 */
export interface BigPlaysConfig {
  /** Play-by-play columns that credit a defender with a big play. */
  columns: string[];
  /** Its weight in every defensive group's production score. */
  weight: number;
}

export const BIG_PLAYS: BigPlaysConfig = {
  columns: [
    'sack_player_id', 'half_sack_1_player_id', 'half_sack_2_player_id', 'interception_player_id',
    'forced_fumble_player_1_player_id', 'forced_fumble_player_2_player_id', 'tackle_for_loss_1_player_id', 'tackle_for_loss_2_player_id',
    'pass_defense_1_player_id', 'pass_defense_2_player_id', 'qb_hit_1_player_id', 'qb_hit_2_player_id',
  ],
  weight: 0.35,
};

export interface PositionConfig {
  label: string;
  /** Stats and their weights in the production score (weights are normalized over the stats a player has). */
  weights: Partial<Record<StatKey, number>>;
  /**
   * Qualifying minimum, per team game played, so it scales through the season: `per` is the volume measure.
   * dropbacks/carries/targets come from play-by-play; snaps from PFR snap counts (defense snaps).
   */
  minimum: { per: 'dropbacks' | 'carries' | 'targets' | 'defenseSnaps'; perTeamGame: number };
}

export const POSITIONS: Record<PositionGroup, PositionConfig> = {
  QB: {
    label: 'Quarterback',
    weights: { epaPerDropback: 0.4, successRate: 0.2, cpoe: 0.2, sackRate: 0.1, pressureToSack: 0.1 },
    minimum: { per: 'dropbacks', perTeamGame: 14 },
  },
  RB: {
    label: 'Running back',
    weights: { rushEpaPerCarry: 0.3, rushSuccessRate: 0.2, ryoePerCarry: 0.25, yacPerCarry: 0.15, brokenTacklesPerCarry: 0.1 },
    minimum: { per: 'carries', perTeamGame: 6 },
  },
  WR: {
    label: 'Wide receiver',
    weights: { epaPerTarget: 0.35, targetShare: 0.25, separation: 0.15, yacOverExpected: 0.1, dropRate: 0.15 },
    minimum: { per: 'targets', perTeamGame: 3.5 },
  },
  TE: {
    label: 'Tight end',
    weights: { epaPerTarget: 0.4, targetShare: 0.2, separation: 0.15, yacOverExpected: 0.1, dropRate: 0.15 },
    minimum: { per: 'targets', perTeamGame: 2.5 },
  },
  EDGE: {
    label: 'Edge rusher',
    weights: { pressuresPer100: 0.5, bigPlaysPer100: BIG_PLAYS.weight, missedTackleRate: 0.15 },
    minimum: { per: 'defenseSnaps', perTeamGame: 20 },
  },
  IDL: {
    label: 'Interior D-line',
    weights: { pressuresPer100: 0.35, bigPlaysPer100: BIG_PLAYS.weight, tacklesPer100: 0.15, missedTackleRate: 0.15 },
    minimum: { per: 'defenseSnaps', perTeamGame: 20 },
  },
  LB: {
    label: 'Linebacker',
    weights: { bigPlaysPer100: BIG_PLAYS.weight, tacklesPer100: 0.2, missedTackleRate: 0.15, yardsPerTargetAllowed: 0.15, pressuresPer100: 0.15 },
    minimum: { per: 'defenseSnaps', perTeamGame: 25 },
  },
  CB: {
    label: 'Cornerback',
    weights: { bigPlaysPer100: BIG_PLAYS.weight, yardsPerTargetAllowed: 0.25, ratingAllowed: 0.2, completionAllowed: 0.1, missedTackleRate: 0.1 },
    minimum: { per: 'defenseSnaps', perTeamGame: 30 },
  },
  S: {
    label: 'Safety',
    weights: { bigPlaysPer100: BIG_PLAYS.weight, yardsPerTargetAllowed: 0.2, ratingAllowed: 0.15, tacklesPer100: 0.15, missedTackleRate: 0.15 },
    minimum: { per: 'defenseSnaps', perTeamGame: 30 },
  },
};

/** Rate stats need a floor on their own denominator, or one target or one tackle attempt decides them. */
export const RATE_MINIMUMS = {
  /** Coverage stats (yards/rating/comp % allowed, INT+PD per target): targets in coverage. */
  coverageTargets: 10,
  /** Missed tackle rate: tackles + missed tackles. */
  tackleAttempts: 10,
  /** Pressure-to-sack: times pressured. */
  qbPressures: 15,
  /** Drop rate: targets in the games PFR covers. */
  dropTargets: 15,
};

/**
 * A player is scored only if the stats they have carry at least this share of the position's total weight
 * (e.g. a QB with no NGS row still has 80% of the weight from play-by-play and PFR).
 */
export const MIN_WEIGHT_SHARE = 0.6;

/** Players shown per position in the rankings view (all qualified players are scored). */
export const RANKING_LIST_LENGTH = 40;

// ---------------------------------------------------------------------------------------------------------------
// Where to buy: the unit -> need -> positions mapping
// ---------------------------------------------------------------------------------------------------------------

export interface NeedConfig {
  /** Shown in the reason: "Buy pass rush". */
  label: string;
  /** Ranked positions whose producers are listed as targets. Empty for an offensive-line need. */
  positions: PositionGroup[];
  /** Offensive-line needs: which team line grade picks the targets (OL starters on the best such lines). */
  line?: LineKey;
}

/**
 * Each unit maps to a primary need and, for three units, an alternate chosen when that half of the unit ranks worse:
 * - pass O: a pass catcher (rank: EPA per non-sack attempt) vs pass protection (rank: pressure rate allowed)
 * - rush O: a running back (rank: yards after contact per carry) vs run blocking (rank: yards before contact per carry)
 * - pass D: pass rush (rank: sacks + QB hits per dropback) vs coverage (rank: EPA per non-sack attempt allowed)
 * Rush D has one need. If either half's data is missing, the primary need is used.
 */
export interface UnitNeeds {
  primary: NeedConfig;
  /** Chosen when the alternate half ranks worse (a larger rank number) than the primary half. */
  alternate?: NeedConfig;
}

export const UNIT_NEEDS: Record<UnitKey, UnitNeeds> = {
  passOffense: {
    primary: { label: 'a pass catcher', positions: ['WR', 'TE'] },
    alternate: { label: 'pass protection', positions: [], line: 'passPro' },
  },
  rushOffense: {
    primary: { label: 'a running back', positions: ['RB'] },
    alternate: { label: 'run blocking', positions: [], line: 'runBlock' },
  },
  passDefense: {
    primary: { label: 'pass rush', positions: ['EDGE', 'IDL'] },
    alternate: { label: 'coverage', positions: ['CB', 'S'] },
  },
  rushDefense: { primary: { label: 'run defense', positions: ['IDL', 'LB'] } },
};

// ---------------------------------------------------------------------------------------------------------------
// Offensive line: team-level grades (open data has no per-lineman production stat)
// ---------------------------------------------------------------------------------------------------------------

export type LineKey = 'passPro' | 'runBlock';
export const LINE_KEYS: readonly LineKey[] = ['passPro', 'runBlock'];

export interface LineDef {
  label: string;
  stat: string;
  decimals: number;
  suffix?: string;
  lowerIsBetter?: boolean;
  source: string;
}

export const LINE: Record<LineKey, LineDef> = {
  /** QB pressures (PFR) per dropback (play-by-play), in the games PFR covers. */
  passPro: { label: 'Pass protection', stat: 'pressure rate allowed', decimals: 1, suffix: '%', lowerIsBetter: true, source: 'PFR + play-by-play' },
  /** Rushing yards before contact per carry (PFR), all ball carriers. Scheme and backs affect it too. */
  runBlock: { label: 'Run blocking', stat: 'yds before contact/carry', decimals: 2, source: 'PFR' },
};

export interface LineTargetConfig {
  /** Depth-chart positions that count as offensive line. */
  depth: string[];
  /** A starter played at least this share of his team's offense snaps (over the games he played). */
  starterShare: number;
  /** Line targets listed per buyer. */
  perTeam: number;
  /** At most this many from one selling team, so the list shows more than one line. */
  perSeller: number;
}

export const LINE_TARGETS: LineTargetConfig = { depth: ['T', 'G', 'C', 'OT', 'OG', 'OL'], starterShare: 0.6, perTeam: 5, perSeller: 2 };

// ---------------------------------------------------------------------------------------------------------------
// Contracts: base salary a buyer takes on
// ---------------------------------------------------------------------------------------------------------------

export interface TradeCostConfig {
  /**
   * Base salary is paid in this many weekly checks over the regular season; a team acquiring a player owes the
   * checks left. Base salary left = this season's base salary x (payWeeks - weeks played) / payWeeks. Signing bonus
   * proration stays with the old team, so it isn't counted.
   */
  payWeeks: number;
}

export const TRADE_COST: TradeCostConfig = { payWeeks: 18 };

// ---------------------------------------------------------------------------------------------------------------
// Player pages: the game log
// ---------------------------------------------------------------------------------------------------------------

export type LogKind = 'QB' | 'SKILL' | 'DEF';

export interface LogColumn {
  label: string;
  /** Spoken name, for the column's tooltip and screen readers. */
  title: string;
  /** Columns of the nflverse weekly player stats file, added together. */
  from: string[];
  decimals: number;
}

export interface GameLogConfig {
  /** nflverse position_group -> which set of columns the player's log shows. Groups not listed get no page. */
  groupKind: Record<string, LogKind>;
  columns: Record<LogKind, LogColumn[]>;
  /** Which snap count is the player's share: offense or defense. */
  snapSide: Record<LogKind, 'off' | 'def'>;
  /** Player search: characters typed before results show, and how many show. */
  searchMinChars: number;
  searchResults: number;
}

export const GAME_LOG: GameLogConfig = {
  groupKind: { QB: 'QB', RB: 'SKILL', WR: 'SKILL', TE: 'SKILL', DL: 'DEF', LB: 'DEF', DB: 'DEF' },
  columns: {
    QB: [
      { label: 'Cmp', title: 'Completions', from: ['completions'], decimals: 0 },
      { label: 'Att', title: 'Pass attempts', from: ['attempts'], decimals: 0 },
      { label: 'Yds', title: 'Passing yards', from: ['passing_yards'], decimals: 0 },
      { label: 'TD', title: 'Passing touchdowns', from: ['passing_tds'], decimals: 0 },
      { label: 'Int', title: 'Interceptions thrown', from: ['passing_interceptions'], decimals: 0 },
      { label: 'Sk', title: 'Sacks taken', from: ['sacks_suffered'], decimals: 0 },
      { label: 'Car', title: 'Carries', from: ['carries'], decimals: 0 },
      { label: 'RuYd', title: 'Rushing yards', from: ['rushing_yards'], decimals: 0 },
      { label: 'RuTD', title: 'Rushing touchdowns', from: ['rushing_tds'], decimals: 0 },
      { label: 'EPA', title: 'Expected points added, passing plus rushing', from: ['passing_epa', 'rushing_epa'], decimals: 1 },
      { label: 'PPR', title: 'Fantasy points (PPR scoring)', from: ['fantasy_points_ppr'], decimals: 1 },
    ],
    SKILL: [
      { label: 'Car', title: 'Carries', from: ['carries'], decimals: 0 },
      { label: 'RuYd', title: 'Rushing yards', from: ['rushing_yards'], decimals: 0 },
      { label: 'RuTD', title: 'Rushing touchdowns', from: ['rushing_tds'], decimals: 0 },
      { label: 'Tgt', title: 'Targets', from: ['targets'], decimals: 0 },
      { label: 'Rec', title: 'Receptions', from: ['receptions'], decimals: 0 },
      { label: 'ReYd', title: 'Receiving yards', from: ['receiving_yards'], decimals: 0 },
      { label: 'ReTD', title: 'Receiving touchdowns', from: ['receiving_tds'], decimals: 0 },
      { label: 'EPA', title: 'Expected points added, rushing plus receiving', from: ['rushing_epa', 'receiving_epa'], decimals: 1 },
      { label: 'PPR', title: 'Fantasy points (PPR scoring)', from: ['fantasy_points_ppr'], decimals: 1 },
    ],
    DEF: [
      { label: 'Tkl', title: 'Tackles, solo and assisted', from: ['def_tackles_solo', 'def_tackles_with_assist', 'def_tackle_assists'], decimals: 0 },
      { label: 'TFL', title: 'Tackles for loss', from: ['def_tackles_for_loss'], decimals: 0 },
      { label: 'Sck', title: 'Sacks', from: ['def_sacks'], decimals: 1 },
      { label: 'QBH', title: 'Quarterback hits', from: ['def_qb_hits'], decimals: 0 },
      { label: 'Int', title: 'Interceptions', from: ['def_interceptions'], decimals: 0 },
      { label: 'PD', title: 'Passes defended', from: ['def_pass_defended'], decimals: 0 },
      { label: 'FF', title: 'Forced fumbles', from: ['def_fumbles_forced'], decimals: 0 },
    ],
  },
  snapSide: { QB: 'off', SKILL: 'off', DEF: 'def' },
  searchMinChars: 2,
  searchResults: 12,
};

/** Bump when GAME_LOG.columns changes order or meaning: a saved copy of the weekly stats from before is then dropped
 * instead of being shown under the new labels. */
export const GAME_LOG_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Value: production per cap dollar
// ---------------------------------------------------------------------------------------------------------------

/** A best-lineup search: who starts, and the budgets to fit. */
export interface LineupRules {
  lineup: {
    /** Starters per position. */
    slots: Record<string, number>;
    /** One more starter from any of these (none = no flex spot). */
    flexFrom: string[];
    flexLabel: string;
  };
  /** Total cap hit the lineup must fit under, millions (rounded down to the step). A game rule, not an NFL number. */
  budgetsMillions: number[];
  /** Cap hits are rounded up to this for the search, millions. */
  budgetStepMillions: number;
}

export interface ValueConfig {
  /** Players listed per position in the value lists. */
  listSize: number;
  /** The best roster by production score: spots by position group (no linemen or specialists: they aren't ranked). */
  roster: LineupRules;
  fantasy: LineupRules & {
    /** The game-log column that holds fantasy points. */
    pointsColumn: string;
    /** To be listed: this many points per game, by nflverse position. Positions not listed aren't fantasy positions. */
    minPerGame: Record<string, number>;
    /** ...in at least this share of his team's games. */
    minGameShare: number;
  };
  frontOffice: {
    /** Bargains, overpays and idle players listed per team. */
    listSize: number;
    /** "Paid but not ranked": a cap hit at least this big, millions, on a player without the volume to be ranked. */
    idleCapMillions: number;
    /** A team needs this many ranked players with a known cap hit to get a grade. */
    minPlayers: number;
  };
}

export const VALUE: ValueConfig = {
  listSize: 25,
  roster: {
    lineup: { slots: { QB: 1, RB: 1, WR: 3, TE: 1, EDGE: 2, IDL: 2, LB: 2, CB: 3, S: 2 }, flexFrom: [], flexLabel: '' },
    budgetsMillions: [30, 75, 150],
    budgetStepMillions: 0.1,
  },
  fantasy: {
    pointsColumn: 'PPR',
    minPerGame: { QB: 12, RB: 8, WR: 8, TE: 6 },
    minGameShare: 0.5,
    lineup: { slots: { QB: 1, RB: 2, WR: 3, TE: 1 }, flexFrom: ['RB', 'WR', 'TE'], flexLabel: 'FLEX' },
    budgetsMillions: [15, 30, 60],
    budgetStepMillions: 0.1,
  },
  frontOffice: { listSize: 3, idleCapMillions: 8, minPlayers: 8 },
};

// ---------------------------------------------------------------------------------------------------------------
// Move tracker: trades, the draft, signings, releases, reserve and practice-squad moves
// ---------------------------------------------------------------------------------------------------------------

export type MoveKind = 'trade' | 'draft' | 'signed' | 'released' | 'reserve' | 'activated' | 'promoted' | 'practice' | 'retired' | 'moved';

export interface MovesConfig {
  /** A roster position (any file's spelling) -> the position filter's group. Unlisted positions go to `other`. */
  positionGroup: Record<string, string>;
  /** The filter's groups, in order. */
  positionGroups: string[];
  other: string;
  /** Pro Football Reference team codes (draft file) -> the nflverse codes used everywhere else. */
  teamCodes: Record<string, string>;
  /** The first day of each season's draft, for sorting draft picks by date (the draft file has no dates). */
  draftDay: Record<number, string>;
  /**
   * Weekly roster status codes: ACT active, INA game-day inactive, RES reserve (injured reserve and similar),
   * DEV practice squad, CUT released, RET retired. `traded` lists codes that mean the player was traded (none
   * documented today). Codes not listed here produce no move.
   */
  status: { active: string[]; reserve: string; practice: string; released: string; retired: string; traded: string[] };
  labels: Record<MoveKind, string>;
}

export const MOVES: MovesConfig = {
  positionGroup: {
    QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE',
    T: 'OL', OT: 'OL', G: 'OL', OG: 'OL', C: 'OL', OL: 'OL', IOL: 'OL',
    DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL',
    LB: 'LB', ILB: 'LB', MLB: 'LB', OLB: 'LB',
    CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', SAF: 'DB', DB: 'DB',
    K: 'ST', P: 'ST', LS: 'ST',
  },
  positionGroups: ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'ST'],
  other: 'Other',
  teamCodes: { GNB: 'GB', KAN: 'KC', LAR: 'LA', LVR: 'LV', NOR: 'NO', NWE: 'NE', SFO: 'SF', TAM: 'TB', SDG: 'LAC', STL: 'LA', OAK: 'LV' },
  draftDay: { 2025: '2025-04-24', 2026: '2026-04-23' },
  // TRD, TRT and TRC show up a handful of times a season with no documented meaning, so they mark no trade
  status: { active: ['ACT', 'INA'], reserve: 'RES', practice: 'DEV', released: 'CUT', retired: 'RET', traded: [] },
  labels: {
    trade: 'Trade', moved: 'Changed teams', draft: 'Drafted', signed: 'Signed', released: 'Released', reserve: 'Reserve',
    activated: 'Activated', promoted: 'Promoted', practice: 'Practice squad', retired: 'Retired',
  },
};

export interface BuyConfig {
  /** Targets listed per buyer. */
  targetsPerTeam: number;
  /** Teams whose players can be bought: sellers, and optionally stand-pat teams too. */
  fromVerdicts: Verdict[];
  /** Trade chips listed on a seller's sheet. */
  chipsPerSeller: number;
  /** Roster statuses that can be traded for (ACT = active roster; injured reserve and the like are left out). */
  statuses: string[];
}

export const BUY: BuyConfig = { targetsPerTeam: 5, fromVerdicts: ['sell'], chipsPerSeller: 5, statuses: ['ACT'] };

// ---------------------------------------------------------------------------------------------------------------
// Optional second ranking: a ratings source. OFF in this build.
// ---------------------------------------------------------------------------------------------------------------

export type RankingMode = 'production' | 'ratings' | 'composite';

export interface RatingsSourceConfig {
  /**
   * Off by default. When on, the refresh reads `file` (JSON: { "<gsis_id>": rating 0-100, ... }) and the page shows a
   * Production / Ratings / Composite toggle. Nothing else changes: every player already carries a `scores` map.
   */
  enabled: boolean;
  /** Short name shown on the toggle and in the footer credit. */
  label: string;
  /** Where the ratings come from and under what terms. */
  license: string;
  /**
   * Must be true to enable: only data we are allowed to republish on a public page. The refresh refuses to build
   * with a ratings source whose terms don't allow it (src/model/ratings.ts).
   */
  republishAllowed: boolean;
  /** Repo-relative path the refresh reads. */
  file: string;
  /** Composite = production x weight + ratings x (1 - weight). */
  compositeProductionWeight: number;
}

export const RATINGS_SOURCE: RatingsSourceConfig = {
  enabled: false,
  label: '',
  license: '',
  republishAllowed: false,
  file: 'data/ratings.json',
  compositeProductionWeight: 0.5,
};

// ---------------------------------------------------------------------------------------------------------------
// League structure (for the playoff sim)
// ---------------------------------------------------------------------------------------------------------------

export const DIVISIONS: Record<string, string[]> = {
  'AFC East': ['BUF', 'MIA', 'NE', 'NYJ'],
  'AFC North': ['BAL', 'CIN', 'CLE', 'PIT'],
  'AFC South': ['HOU', 'IND', 'JAX', 'TEN'],
  'AFC West': ['DEN', 'KC', 'LAC', 'LV'],
  'NFC East': ['DAL', 'NYG', 'PHI', 'WAS'],
  'NFC North': ['CHI', 'DET', 'GB', 'MIN'],
  'NFC South': ['ATL', 'CAR', 'NO', 'TB'],
  'NFC West': ['ARI', 'LA', 'SEA', 'SF'],
};

export const TEAM_NAMES: Record<string, string> = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals',
  CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts',
  JAX: 'Jaguars', KC: 'Chiefs', LA: 'Rams', LAC: 'Chargers', LV: 'Raiders', MIA: 'Dolphins', MIN: 'Vikings',
  NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks',
  SF: '49ers', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders',
};
