/**
 * Trade value: every asset in a trades-file trade in the same dollars, so a player-for-picks deal can be judged.
 * - A pick: the Baldwin chart's surplus for its slot (% of cap per season) x the cap x the 4 rookie seasons.
 *   A slot not known yet is the middle of its round; a future pick is valued one round later per draft away
 *   (or discounted by a rate; PICK_VALUE.future).
 * - A player: what his production is worth (Value tab) minus his cap hit, summed over the seasons left on his deal
 *   (up to MOVE_GRADE.maxYears), the same surplus idea the pick chart measures.
 * Each team's trade grade comes from what it got minus what it gave. Unpriced assets are named, not guessed.
 */
import { MOVE_GRADE, MOVES, PICK_VALUE, type MoveGradeConfig, type MovesConfig, type PickValueConfig } from './config.ts';
import { PICK_SURPLUS_PCT_OF_CAP } from './pickChart.ts';
import { ordinal, round } from './stats.ts';
import type { Contract, Move, PlayerValue, TradeAsset, TradeCard, TradeSide } from './types.ts';
import { wordFor } from './moveGrades.ts';

const ROUND_NAMES = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];
const roundName = (r: number): string => ROUND_NAMES[r - 1] ?? `round ${r}`;

const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The next draft as of a date: this year's until it's over (its first day + draftDays), else next year's. */
export function nextDraft(date: string, cfg: MovesConfig = MOVES): number {
  const y = Number(date.slice(0, 4));
  const first = cfg.draftDay[y] ?? `${y}-${cfg.draftDayFallback}`;
  return date < addDays(first, cfg.draftDays) ? y : y + 1;
}

export interface PickPrice { millions: number; slot: number; draftsAway: number; pct: number; discount: number; note: string }

/** Pure: a pick's value as of the trade date. */
export function pickPrice(pick: { season: number; round: number; number: number | null; conditional?: boolean }, tradeDate: string, cfg: PickValueConfig = PICK_VALUE): PickPrice {
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
  return { millions, slot, draftsAway: away, pct, discount, note: `${label} (${how}${pick.conditional ? '; conditional, valued in full' : ''})` };
}

const money = (m: number): string => `${m < 0 ? '-' : ''}$${Math.abs(round(m, 1))}M`;

/** Pure: a player's cap hits for the seasons counted (this one first), millions. */
function capsLeft(id: string, season: number, v: PlayerValue, contracts: Map<string, Contract>, maxYears: number): number[] {
  const caps = (contracts.get(id)?.seasons ?? []).filter((x) => x.year >= season && x.cap !== null && x.cap > 0).slice(0, maxYears).map((x) => x.cap as number);
  return caps.length ? caps : [v.capMillions];
}

/** Pure: a player's surplus over the seasons left, millions (null when his production or pay isn't known). */
export function playerSurplus(id: string, season: number, values: Map<string, PlayerValue>, contracts: Map<string, Contract>, maxYears = MOVE_GRADE.maxYears): number | null {
  const v = values.get(id);
  if (!v) return null;
  return round(capsLeft(id, season, v, contracts, maxYears).reduce((s, c) => s + (v.worthMillions - c), 0), 1);
}

/** Pure: one asset's value and how it was worked out. */
export function priceAsset(m: Move, season: number, values: Map<string, PlayerValue>, contracts: Map<string, Contract>, cfg: PickValueConfig = PICK_VALUE): TradeAsset {
  const base = { name: m.name, id: m.pick ? null : m.id, pos: m.pos };
  if (m.pick) {
    if (!m.pickOf) return { ...base, millions: null, how: 'Pick not identified in the trades file' };
    const p = pickPrice(m.pickOf, m.date, cfg);
    return { ...base, millions: p.millions, how: `${p.note}: Baldwin chart surplus ${p.pct}% of the cap per season × $${cfg.capMillions}M cap × ${cfg.rookieYears} rookie seasons${p.discount < 1 ? ` × ${round(p.discount, 2)}` : ''}` };
  }
  const v = m.id ? values.get(m.id) : undefined;
  if (!v || !m.id) {
    const why = m.group === 'OL' || m.group === 'ST' ? 'no individual production stat for his position' : 'not enough snaps this season to be ranked';
    return { ...base, millions: null, how: `No value: ${why}` };
  }
  // the shown numbers (to $0.1M) are the ones summed, so the text adds up to the value
  const caps = capsLeft(m.id, season, v, contracts, MOVE_GRADE.maxYears).map((c) => round(c, 1));
  const worth = round(v.worthMillions, 1);
  const millions = round(caps.reduce((s, c) => s + (worth - c), 0), 1);
  const seasons = caps.length === 1 ? '1 season' : `${caps.length} seasons`;
  return {
    ...base, millions,
    how: `${ordinal(Math.round(v.production))} pct ${v.group} producer, worth $${worth}M/yr (what the ${ordinal(Math.round(v.production))} pct ${v.group} is paid) − cap hit${caps.length > 1 ? 's' : ''} ${caps.map((c) => `$${c}M`).join(' + ')}, over ${seasons}`,
  };
}

/** Each trades-file trade as one card: what each team received, valued, and its grade from value in minus value out. */
export function tradeValues(moves: Move[], season: number, values: Map<string, PlayerValue>, contracts: Map<string, Contract>, cfg: PickValueConfig = PICK_VALUE, gradeCfg: MoveGradeConfig = MOVE_GRADE): Move[] {
  const byTrade = new Map<string, Move[]>();
  for (const m of moves) if (m.tradeId) byTrade.set(m.tradeId, [...(byTrade.get(m.tradeId) ?? []), m]);
  const cards = new Map<string, TradeCard>();
  for (const [id, rows] of byTrade) {
    const priced = rows.map((m) => ({ m, a: priceAsset(m, season, values, contracts, cfg) }));
    const unpriced = priced.filter((x) => x.a.millions === null).map((x) => x.a.name);
    const teams = [...new Set(rows.flatMap((m) => [m.team, m.from ?? '']).filter(Boolean))];
    const sides: TradeSide[] = teams.map((team) => {
      const total = (xs: typeof priced): number => round(xs.reduce((s, x) => s + (x.a.millions ?? 0), 0), 1);
      const got = priced.filter((x) => x.m.team === team);
      const valueIn = total(got);
      const valueOut = total(priced.filter((x) => x.m.from === team));
      const net = round(valueIn - valueOut, 1);
      // an unpriced asset would count as $0 and skew the grade: no grade then
      const score = unpriced.length ? null : round(50 + 50 * Math.tanh(net / cfg.scaleMillions), 0);
      return { team, score, word: score === null ? null : wordFor(score, gradeCfg), valueIn, valueOut, net, received: got.map((x) => x.a) };
    });
    cards.set(id, { id, date: rows[0]?.date ?? '', sides, note: unpriced.length ? `Not graded: no value for ${unpriced.join(', ')}` : null });
  }
  return moves.map((m) => (m.tradeId && cards.has(m.tradeId) ? { ...m, trade: cards.get(m.tradeId) } : m));
}
