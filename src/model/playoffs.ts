/**
 * Team strength, schedule left and a rough playoff-odds simulation.
 *
 * Strength (points per game better than average) blends opponent-adjusted net EPA/play x plays per game with actual
 * point differential per game, then regresses toward zero. The sim plays out every remaining regular-season game
 * many times: each game's margin is Normal(strength difference + home field, marginSd). Per conference, the four
 * division winners and the next best records make it. Simplification, stated on the page: ties in the standings
 * are broken at random, not by the NFL's tiebreakers.
 */
import { DIVISIONS, PLAYOFF_SIM, STRENGTH, type PlayoffSimConfig, type StrengthConfig } from './config.ts';
import { prng, ranks } from './stats.ts';
import type { Game } from './types.ts';

export interface Record3 { wins: number; losses: number; ties: number; pointDiff: number; games: number }

export function records(games: Game[], teams: string[]): Record<string, Record3> {
  const r: Record<string, Record3> = {};
  for (const t of teams) r[t] = { wins: 0, losses: 0, ties: 0, pointDiff: 0, games: 0 };
  for (const g of games) {
    if (g.homeScore === null || g.awayScore === null) continue;
    const h = r[g.home];
    const a = r[g.away];
    if (!h || !a) continue;
    const d = g.homeScore - g.awayScore;
    h.games++;
    a.games++;
    h.pointDiff += d;
    a.pointDiff -= d;
    if (d > 0) { h.wins++; a.losses++; }
    else if (d < 0) { a.wins++; h.losses++; }
    else { h.ties++; a.ties++; }
  }
  return r;
}

export const recordText = (r: Record3): string => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;

/**
 * netEpa: offense adjusted EPA/play minus defense adjusted EPA/play allowed, both relative to league average
 * (play-weighted across pass and rush). Returns points per game better than average.
 */
export function strengths(
  netEpa: Record<string, number>,
  recs: Record<string, Record3>,
  cfg: StrengthConfig = STRENGTH,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of Object.keys(netEpa)) {
    const r = recs[t];
    const pd = r && r.games ? r.pointDiff / r.games : 0;
    const epaPts = (netEpa[t] ?? 0) * cfg.playsPerGame;
    out[t] = cfg.regression * (cfg.weights.adjustedEpa * epaPts + cfg.weights.pointDifferential * pd);
  }
  return out;
}

export function scheduleLeft(games: Game[], strength: Record<string, number>): { mean: Record<string, number>; left: Record<string, number>; rank: Record<string, number> } {
  const teams = Object.keys(strength);
  const sum: Record<string, number> = {};
  const left: Record<string, number> = {};
  for (const t of teams) { sum[t] = 0; left[t] = 0; }
  for (const g of games) {
    if (g.homeScore !== null) continue;
    if (!(g.home in sum) || !(g.away in sum)) continue;
    sum[g.home] = (sum[g.home] ?? 0) + (strength[g.away] ?? 0);
    sum[g.away] = (sum[g.away] ?? 0) + (strength[g.home] ?? 0);
    left[g.home] = (left[g.home] ?? 0) + 1;
    left[g.away] = (left[g.away] ?? 0) + 1;
  }
  const mean: Record<string, number> = {};
  for (const t of teams) mean[t] = (left[t] ?? 0) > 0 ? (sum[t] ?? 0) / (left[t] as number) : 0;
  const rk = ranks(teams.map((t) => mean[t] ?? 0), true); // 1 = strongest opponents = hardest
  const rank: Record<string, number> = {};
  teams.forEach((t, i) => (rank[t] = rk[i] as number));
  return { mean, left, rank };
}

/** Standard normal draw from a uniform stream (Box-Muller). */
function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function divisionOf(team: string): string | null {
  for (const [d, ts] of Object.entries(DIVISIONS)) if (ts.includes(team)) return d;
  return null;
}

export function simulatePlayoffs(
  games: Game[],
  strength: Record<string, number>,
  cfg: PlayoffSimConfig = PLAYOFF_SIM,
): Record<string, number> {
  const teams = Object.keys(strength);
  const base = records(games, teams);
  const remaining = games.filter((g) => g.homeScore === null && g.home in strength && g.away in strength);
  const rand = prng(cfg.seed);
  const made: Record<string, number> = {};
  for (const t of teams) made[t] = 0;
  const conferences = new Map<string, string[]>(); // "AFC" -> divisions
  for (const d of Object.keys(DIVISIONS)) {
    const c = d.split(' ')[0] as string;
    conferences.set(c, [...(conferences.get(c) ?? []), d]);
  }

  for (let s = 0; s < cfg.simulations; s++) {
    const w: Record<string, number> = {};
    for (const t of teams) w[t] = (base[t]?.wins ?? 0) + 0.5 * (base[t]?.ties ?? 0);
    for (const g of remaining) {
      if (rand() < cfg.tieProbability) {
        w[g.home] = (w[g.home] ?? 0) + 0.5;
        w[g.away] = (w[g.away] ?? 0) + 0.5;
        continue;
      }
      const hfa = g.neutral ? 0 : cfg.homeFieldPoints;
      const margin = (strength[g.home] ?? 0) - (strength[g.away] ?? 0) + hfa + cfg.marginSd * normal(rand);
      const winner = margin > 0 ? g.home : g.away;
      w[winner] = (w[winner] ?? 0) + 1;
    }
    const tiebreak: Record<string, number> = {};
    for (const t of teams) tiebreak[t] = rand();
    const better = (a: string, b: string): number => (w[b] ?? 0) - (w[a] ?? 0) || (tiebreak[b] ?? 0) - (tiebreak[a] ?? 0);
    for (const divs of conferences.values()) {
      const winners: string[] = [];
      const rest: string[] = [];
      for (const d of divs) {
        const ts = (DIVISIONS[d] ?? []).filter((t) => t in strength).sort(better);
        if (ts[0]) winners.push(ts[0]);
        rest.push(...ts.slice(1));
      }
      const wild = rest.sort(better).slice(0, Math.max(0, cfg.spotsPerConference - winners.length));
      for (const t of [...winners, ...wild]) made[t] = (made[t] ?? 0) + 1;
    }
  }
  const odds: Record<string, number> = {};
  for (const t of teams) odds[t] = (made[t] ?? 0) / cfg.simulations;
  return odds;
}
