/**
 * Trade value: every asset in a trades-file trade in the same dollars, so a player-for-picks deal can be judged.
 * - A pick: the Baldwin chart's surplus for its slot (% of cap per season) x the cap x the 4 rookie seasons.
 *   A slot not known yet is the middle of its round; a future pick is valued one round later per draft away
 *   (or discounted by a rate; PICK_VALUE.future).
 * - A player: what his production is worth (Value tab) minus his cap hit, summed over the seasons left on his deal
 *   (up to MOVE_GRADE.maxYears), the same surplus idea the pick chart measures.
 * Each team's trade grade comes from what it got minus what it gave. Unpriced assets are named, not guessed.
 */
import { MOVE_GRADE, MOVES, PICK_VALUE, type PickValueConfig } from './config.ts';
import { PICK_SURPLUS_PCT_OF_CAP } from './pickChart.ts';
import { round } from './stats.ts';
import type { Contract, Move, MoveGrade, PlayerValue } from './types.ts';
import { wordFor } from './moveGrades.ts';

const ROUND_NAMES = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];
const roundName = (r: number): string => ROUND_NAMES[r - 1] ?? `round ${r}`;

/** The next draft as of a date: this year's if its draft day hasn't come, else next year's. */
export function nextDraft(date: string, draftDay: Record<number, string> = MOVES.draftDay): number {
  const y = Number(date.slice(0, 4));
  return date < (draftDay[y] ?? `${y}-04-30`) ? y : y + 1;
}

export interface PickPrice { millions: number; slot: number; draftsAway: number; note: string }

/** Pure: a pick's value as of the trade date. */
export function pickPrice(pick: { season: number; round: number; number: number | null }, tradeDate: string, cfg: PickValueConfig = PICK_VALUE): PickPrice {
  const chart = PICK_SURPLUS_PCT_OF_CAP;
  const away = Math.max(0, pick.season - nextDraft(tradeDate));
  const known = pick.number !== null && away === 0;
  const valuedRound = cfg.future.rule === 'round' ? pick.round + away : pick.round;
  const slot = known ? (pick.number as number) : Math.min(chart.length, (valuedRound - 1) * cfg.picksPerRound + cfg.unknownSlot);
  const pct = chart[Math.max(1, Math.min(chart.length, slot)) - 1] ?? 0;
  const discount = cfg.future.rule === 'rate' ? (1 - cfg.future.rate) ** away : 1;
  const millions = round((pct / 100) * cfg.capMillions * cfg.rookieYears * discount, 1);
  const label = `${pick.season} ${roundName(pick.round)}`;
  const how = known ? `pick ${slot}`
    : away === 0 ? `valued as pick ${slot}, the middle of the round`
    : cfg.future.rule === 'round' ? `valued as pick ${slot}: ${away} draft${away > 1 ? 's' : ''} away, one round later per draft`
    : `valued as pick ${slot}, less ${Math.round(cfg.future.rate * 100)}% per draft away`;
  return { millions, slot, draftsAway: away, note: `${label} (${how})` };
}

/** Pure: a player's surplus over the seasons left, millions (null when his production or pay isn't known). */
export function playerSurplus(id: string, season: number, values: Map<string, PlayerValue>, contracts: Map<string, Contract>, maxYears = MOVE_GRADE.maxYears): number | null {
  const v = values.get(id);
  if (!v) return null;
  const caps = (contracts.get(id)?.seasons ?? []).filter((x) => x.year >= season && x.cap !== null && x.cap > 0).slice(0, maxYears).map((x) => x.cap as number);
  if (!caps.length) caps.push(v.capMillions);
  return round(caps.reduce((s, c) => s + (v.worthMillions - c), 0), 1);
}

const money = (m: number): string => `${m < 0 ? '-' : ''}$${Math.abs(round(m, 1))}M`;

/** Each trades-file trade: every team's net value, attached to each of the trade's rows. */
export function tradeValues(moves: Move[], season: number, values: Map<string, PlayerValue>, contracts: Map<string, Contract>, cfg: PickValueConfig = PICK_VALUE): Move[] {
  const byTrade = new Map<string, Move[]>();
  for (const m of moves) if (m.tradeId) byTrade.set(m.tradeId, [...(byTrade.get(m.tradeId) ?? []), m]);
  const out = new Map<string, MoveGrade[]>();
  for (const [id, rows] of byTrade) {
    const priced = rows.map((m) => ({
      m,
      millions: m.pick ? (m.pickOf ? pickPrice(m.pickOf, m.date, cfg).millions : null) : m.id ? playerSurplus(m.id, season, values, contracts) : null,
    }));
    const teams = [...new Set(rows.flatMap((m) => [m.team, m.from ?? '']).filter(Boolean))];
    out.set(id, teams.map((team) => {
      const got = priced.filter((x) => x.m.team === team);
      const gave = priced.filter((x) => x.m.from === team);
      const sum = (xs: typeof priced): number => xs.reduce((s, x) => s + (x.millions ?? 0), 0);
      const unpriced = [...got, ...gave].filter((x) => x.millions === null).map((x) => x.m.name);
      const net = sum(got) - sum(gave);
      const score = round(50 + 50 * Math.tanh(net / cfg.scaleMillions), 0);
      const reason = `Whole trade: value in ${money(sum(got))}, out ${money(sum(gave))} (net ${net >= 0 ? '+' : ''}${money(net)})${unpriced.length ? ` · not priced: ${unpriced.join(', ')}` : ''}`;
      return { team, score, word: wordFor(score), reason };
    }));
  }
  return moves.map((m) => (m.tradeId && out.has(m.tradeId) ? { ...m, tradeValue: out.get(m.tradeId) } : m));
}
