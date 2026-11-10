/**
 * Move grades: every addition or departure judged from the team's side, PFF-tracker style, on three parts:
 * - need: how weak the unit the player's position feeds was BEFORE the move (unit grades rebuilt from the games
 *   played before its date; offseason moves fall back to the season so far, and the reason says so)
 * - production: his production percentile at his position, this season to date
 * - cost: what that production is worth (the Value tab's cap hit at the same percentile) minus his cap hit, summed
 *   over the seasons left on his contract
 * - window: the team's playoff odds before the move (same re-run): adding talent fits a contender, selling fits a
 *   team out of the race
 * A departure scores each part from the other side: losing a good, fairly paid player at a weak unit grades low;
 * shedding an overpaid one at a strong unit grades high. Players with no ranked production aren't graded.
 * Not in the data: cap space, dead money, and what draft picks are worth.
 */
import { MOVE_GRADE, UNITS, type MoveGradeConfig } from './config.ts';
import { seasonStateBefore, type SeasonState } from './odds.ts';
import { pickPrice, tradeValues } from './tradeValue.ts';
import { round } from './stats.ts';
import type { Contract, Game, Move, MoveGrade, PlayerResult, PlayerValue, TeamGame } from './types.ts';

export interface MoveGradeInputs {
  season: number;
  games: Game[];
  teamGames: TeamGame[];
  teams: string[];
  /** The season so far (unit grades, playoff odds), for teams with too few games before the move. */
  seasonNow: Pick<SeasonState, 'grades' | 'odds'>;
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
export function combine(parts: { need: number | null; production: number; cost: number | null; window?: number | null }, adds: boolean, cfg: MoveGradeConfig = MOVE_GRADE): number {
  const W = cfg.weights;
  let sum = 0;
  let w = 0;
  for (const [k, v] of [['need', parts.need], ['production', parts.production], ['cost', parts.cost], ['window', parts.window ?? null]] as const) {
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
  const played = inp.games.filter((g) => g.homeScore !== null);

  // the season as it stood before each date (memoized: moves share a handful of dates)
  const before = new Map<string, Pick<SeasonState, 'grades' | 'odds'>>();
  const stateBefore = (date: string): Pick<SeasonState, 'grades' | 'odds'> => {
    let st = before.get(date);
    if (!st) {
      st = seasonStateBefore(inp.games, inp.teamGames, inp.teams, date);
      before.set(date, st);
    }
    return st;
  };
  const gamesBefore = (team: string, date: string): number => played.filter((g) => g.gameday < date && (g.home === team || g.away === team)).length;

  const one = (m: Move, team: string, adds: boolean): MoveGrade => {
    if (m.pick) {
      if (!m.pickOf) return { team, score: null, word: null, reason: 'Pick not identified' };
      const pp = pickPrice(m.pickOf, m.date);
      return { team, score: null, word: null, reason: `Worth $${pp.millions}M: ${pp.note}` };
    }
    if (!m.id) return { team, score: null, word: null, reason: 'Player not matched to a roster' };
    const p = players.get(m.id);
    if (!p) {
      const why = m.group === 'OL' || m.group === 'ST' ? 'No individual production stat at his position' : 'No ranked production this season';
      return { team, score: null, word: null, reason: why };
    }
    // need, before the move
    const early = !m.date || gamesBefore(team, m.date) < cfg.minGamesBefore;
    const state = early ? inp.seasonNow : stateBefore(m.date);
    const units = state.grades.units[team];
    // window: playoff odds before the move; contenders should add talent, teams out of it should sell
    const odds = state.odds[team];
    const window = odds === undefined ? null : 100 * odds;
    const keys = cfg.units[p.group];
    const worst = units ? keys.map((k) => ({ k, u: units[k] })).sort((a, b) => a.u.grade - b.u.grade)[0] : undefined;
    const need = worst ? 100 - worst.u.grade : null;
    // cost: worth against his cap hit in each season left (this one included), the same pay measure worth is built from
    const v = values.get(m.id);
    const c = contracts.get(m.id);
    const caps = (c?.seasons ?? []).filter((x) => x.year >= inp.season && x.cap !== null && x.cap > 0).slice(0, cfg.maxYears).map((x) => x.cap as number);
    if (!caps.length && v) caps.push(v.capMillions);
    const years = caps.length;
    const perYear = years ? caps.reduce((a, b) => a + b, 0) / years : null;
    const cost = v && perYear !== null ? costScore(v.worthMillions, perYear, years, cfg) : null;
    const score = round(combine({ need, production: p.scores.production, cost, window }, adds, cfg), 0);

    const bits: string[] = [];
    if (worst) bits.push(`${UNITS[worst.k].reason} ${ordinal(worst.u.rank)}${early ? ' (season so far)' : ' before'}`);
    if (odds !== undefined) bits.push(`${Math.round(100 * odds)}% playoff odds${early ? ' (season so far)' : ' before'}`);
    bits.push(`${ordinal(Math.round(p.scores.production))} pct producer`);
    if (v && perYear !== null) {
      const gap = round(v.worthMillions - perYear, 1);
      const yrs = years > 1 ? ` for ${years} yrs` : '';
      bits.push(gap >= 0 ? `$${gap}M/yr under his worth${yrs}` : `$${-gap}M/yr over his worth${yrs}`);
    } else bits.push('pay unknown');
    return { team, score, word: wordFor(score, cfg), reason: bits.join(' · ') };
  };

  const graded = moves.map((m) => {
    if (m.tradeId) return m;   // a trades-file trade is judged as a whole (tradeValues), not asset by asset
    const grades: MoveGrade[] = [];
    if (cfg.adds.includes(m.kind)) {
      grades.push(one(m, m.team, true));
      if (m.from && !m.pick && (m.kind === 'trade' || m.kind === 'moved')) grades.push(one(m, m.from, false));   // a pick's value is the same for both sides: shown once
    } else if (cfg.departs.includes(m.kind)) grades.push(one(m, m.team, false));   // detail reads "Released by <team>"
    return grades.length ? { ...m, grades } : m;
  });
  return tradeValues(graded, inp.season, values, contracts, undefined, cfg);
}
