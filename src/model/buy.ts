/** Where to buy: for each buyer's need, the top producers at the matching positions on teams that sell. */
import { BUY, type BuyConfig, type PositionGroup, type Verdict } from './config.ts';
import type { PlayerResult } from './types.ts';

export interface BuyTeam {
  team: string;
  verdict: Verdict;
  need: { positions: PositionGroup[] } | null;
}

/** Players at `positions` on seller teams, best production first. */
export function buyTargets(
  buyer: BuyTeam,
  teams: BuyTeam[],
  players: PlayerResult[],
  cfg: BuyConfig = BUY,
): string[] {
  if (buyer.verdict !== 'buy' || !buyer.need) return [];
  const sellers = new Set(teams.filter((t) => cfg.fromVerdicts.includes(t.verdict) && t.team !== buyer.team).map((t) => t.team));
  const want = new Set(buyer.need.positions);
  return players
    .filter((p) => sellers.has(p.team) && want.has(p.group) && cfg.statuses.includes(p.status))
    .sort((a, b) => b.scores.production - a.scores.production || a.id.localeCompare(b.id))
    .slice(0, cfg.targetsPerTeam)
    .map((p) => p.id);
}

/** A seller's best producers at any position: what it could trade. */
export function tradeChips(seller: BuyTeam, players: PlayerResult[], cfg: BuyConfig = BUY): string[] {
  if (seller.verdict !== 'sell') return [];
  return players
    .filter((p) => p.team === seller.team && cfg.statuses.includes(p.status))
    .sort((a, b) => b.scores.production - a.scores.production || a.id.localeCompare(b.id))
    .slice(0, cfg.chipsPerSeller)
    .map((p) => p.id);
}
