/**
 * Move grades: every addition or departure judged from the team's side, PFF-tracker style, on three parts:
 * - need: how weak the unit the player's position feeds was BEFORE the move (unit grades rebuilt from the games
 *   played before its date; offseason moves fall back to the season so far, and the reason says so)
 * - production: his production percentile at his position, this season to date
 * - cost: what that production is worth (the Value tab's pay at the same percentile) minus his contract's average
 *   per year, times the years left on it
 * A departure scores each part from the other side: losing a good, fairly paid player at a weak unit grades low;
 * shedding an overpaid one at a strong unit grades high. Players with no ranked production aren't graded.
 * Not in the data: cap space, dead money, and what draft picks are worth.
 */
import { MOVE_GRADE, UNITS, type MoveGradeConfig, type UnitKey } from './config.ts';
import { gradeUnits } from './grades.ts';
import { round } from './stats.ts';
import type { Contract, Game, Move, MoveGrade, PlayerResult, PlayerValue, TeamGame, UnitResult } from './types.ts';

export interface MoveGradeInputs {
  season: number;
  games: Game[];
  teamGames: TeamGame[];
  teams: string[];
  /** Season-so-far unit grades, for teams with too few games before the move. */
  seasonUnits: Record<string, Record<UnitKey, UnitResult>>;
  players: PlayerResult[];
  values: PlayerValue[];
  contracts: Contract[];
}

const ordinal = (n: number): string => {
  const r = n % 100;
  return `${n}${r >= 11 && r <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

export function wordFor(score: number, cfg: MoveGradeConfig = MOVE_GRADE): string {
  return cfg.words.find(([min]) => score >= min)?.[1] ?? cfg.fallbackWord;
}

/** Pure: the cost part, 0-100 (50 = paid what he produces). */
export function costScore(worth: number, perYear: number, years: number, cfg: MoveGradeConfig = MOVE_GRADE): number {
  return 50 + 50 * Math.tanh(((worth - perYear) * years) / cfg.costScaleMillions);
}

/** Pure: weighted mean of the parts present; a departure flips each part. */
export function combine(parts: { need: number | null; production: number; cost: number | null }, adds: boolean, cfg: MoveGradeConfig = MOVE_GRADE): number {
  const W = cfg.weights;
  let sum = 0;
  let w = 0;
  for (const [k, v] of [['need', parts.need], ['production', parts.production], ['cost', parts.cost]] as const) {
    if (v === null) continue;
    sum += W[k] * (adds ? v : 100 - v);
    w += W[k];
  }
  return w > 0 ? sum / w : 50;
}

export function gradeMoves(moves: Move[], inp: MoveGradeInputs, cfg: MoveGradeConfig = MOVE_GRADE): Move[] {
  const players = new Map(inp.players.map((p) => [p.id, p]));
  const values = new Map(inp.values.map((v) => [v.id, v]));
  const contracts = new Map(inp.contracts.map((c) => [c.gsis, c]));
  const gameDay = new Map(inp.games.map((g) => [g.id, g.gameday]));
  const played = inp.games.filter((g) => g.homeScore !== null);

  // unit grades from the games before each date (memoized: moves share a handful of dates)
  const before = new Map<string, Record<string, Record<UnitKey, UnitResult>>>();
  const unitsBefore = (date: string): Record<string, Record<UnitKey, UnitResult>> => {
    let u = before.get(date);
    if (!u) {
      const tg = inp.teamGames.filter((g) => (gameDay.get(g.game) ?? '9999') < date);
      u = tg.length ? gradeUnits(tg, inp.teams).units : {};
      before.set(date, u);
    }
    return u;
  };
  const gamesBefore = (team: string, date: string): number => played.filter((g) => g.gameday < date && (g.home === team || g.away === team)).length;

  const one = (m: Move, team: string, adds: boolean): MoveGrade => {
    if (!m.id) return { team, score: null, word: null, reason: 'Draft picks aren’t priced' };
    const p = players.get(m.id);
    if (!p) {
      const why = m.group === 'OL' || m.group === 'ST' ? 'No individual production stat at his position' : 'No ranked production this season';
      return { team, score: null, word: null, reason: why };
    }
    // need, before the move
    const early = !m.date || gamesBefore(team, m.date) < cfg.minGamesBefore;
    const units = (early ? inp.seasonUnits : unitsBefore(m.date))[team];
    const keys = cfg.units[p.group];
    const worst = units ? keys.map((k) => ({ k, u: units[k] })).sort((a, b) => a.u.grade - b.u.grade)[0] : undefined;
    const need = worst ? 100 - worst.u.grade : null;
    // cost: worth minus pay per year, over the years left
    const v = values.get(m.id);
    const c = contracts.get(m.id);
    const perYear = c?.apyMillions ?? v?.capMillions ?? null;
    const years = c ? Math.min(cfg.maxYears, Math.max(1, c.lastYear - inp.season + 1)) : 1;
    const cost = v && perYear !== null ? costScore(v.worthMillions, perYear, years, cfg) : null;
    const score = round(combine({ need, production: p.scores.production, cost }, adds, cfg), 0);

    const bits: string[] = [];
    if (worst) bits.push(`${UNITS[worst.k].reason} ${ordinal(worst.u.rank)}${early ? ' (season so far)' : ' before'}`);
    bits.push(`${ordinal(Math.round(p.scores.production))} pct producer`);
    if (v && perYear !== null) {
      const gap = round(v.worthMillions - perYear, 1);
      const yrs = years > 1 ? ` for ${years} yrs` : '';
      bits.push(gap >= 0 ? `$${gap}M/yr under his worth${yrs}` : `$${-gap}M/yr over his worth${yrs}`);
    } else bits.push('pay unknown');
    return { team, score, word: wordFor(score, cfg), reason: bits.join(' · ') };
  };

  return moves.map((m) => {
    const grades: MoveGrade[] = [];
    if (cfg.adds.includes(m.kind)) {
      grades.push(one(m, m.team, true));
      if (m.from && (m.kind === 'trade' || m.kind === 'moved')) grades.push(one(m, m.from, false));
    } else if (cfg.departs.includes(m.kind)) grades.push(one(m, m.team, false));   // detail reads "Released by <team>"
    return grades.length ? { ...m, grades } : m;
  });
}
