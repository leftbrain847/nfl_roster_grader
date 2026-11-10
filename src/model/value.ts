/**
 * Value: what teams get for their cap dollars.
 * - Fantasy value: PPR points per $1M of this season's cap hit, and the best lineup that fits under a budget.
 * - Front offices: for every ranked player, what his production is worth at his position minus his cap hit
 *   ("surplus", in dollars); a team's score is the sum over its players.
 * Cap hits come from the contract's row for this season. Dead money isn't in the data, so it isn't counted.
 */
import { DEPTH_TO_GROUP, GAME_LOG, GRADE, VALUE, type LineupRules, type PositionGroup, type ValueConfig } from './config.ts';
import { mean, normalCdf, ranks, round, sd } from './stats.ts';
import type {
  FantasyValue, FrontOffice, Lineup, LineupPlayer, ModelInputs, PlayerProfile, PlayerResult, PlayerValue, ValueOutput,
} from './types.ts';

/** This season's cap hit per player, millions. */
export function capHits(inp: ModelInputs): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of inp.contracts) {
    const cap = c.seasons?.find((s) => s.year === inp.season)?.cap;
    if (typeof cap === 'number' && cap > 0) out.set(c.gsis, cap);
  }
  return out;
}

const pointsColumn = (p: PlayerProfile, cfg: ValueConfig): number => GAME_LOG.columns[p.kind].findIndex((c) => c.label === cfg.fantasy.pointsColumn);

export function fantasyValues(profiles: PlayerProfile[], caps: Map<string, number>, teamGames: Record<string, number>, cfg: ValueConfig = VALUE): FantasyValue[] {
  const out: FantasyValue[] = [];
  for (const p of profiles) {
    const min = cfg.fantasy.minPerGame[p.pos];
    const cap = caps.get(p.id);
    const col = pointsColumn(p, cfg);
    if (min === undefined || cap === undefined || col < 0) continue;
    const games = p.log.length;
    const points = p.log.reduce((s, r) => s + (r.v[col] ?? 0), 0);
    if (games < cfg.fantasy.minGameShare * (teamGames[p.team] ?? 0) || games === 0 || points / games < min) continue;
    out.push({
      id: p.id, name: p.name, team: p.team, pos: p.pos, games,
      points: round(points, 1), perGame: round(points / games, 1), capMillions: round(cap, 2), perMillion: round(points / cap, 1),
    });
  }
  return out.sort((a, b) => b.perMillion - a.perMillion || a.id.localeCompare(b.id));
}

export interface Candidate { id: string; name: string; team: string; pos: string; points: number; cap: number; cost: number }

/** Best `count` players of one position at every budget: points[k][b] = most points from exactly k players costing <= b units. */
function knapsack(items: Candidate[], maxCount: number, budget: number): { points: Float64Array[]; pick: (k: number, b: number) => Candidate[] } {
  const points = Array.from({ length: maxCount + 1 }, (_, k) => new Float64Array(budget + 1).fill(k === 0 ? 0 : -Infinity));
  const keep = items.map(() => Array.from({ length: maxCount + 1 }, () => new Uint8Array(budget + 1)));
  items.forEach((it, i) => {
    for (let k = maxCount; k >= 1; k--) {
      const prev = points[k - 1] as Float64Array;
      const cur = points[k] as Float64Array;
      for (let b = budget; b >= it.cost; b--) {
        const v = (prev[b - it.cost] as number) + it.points;
        if (v > (cur[b] as number)) {
          cur[b] = v;
          (keep[i]?.[k] as Uint8Array)[b] = 1;
        }
      }
    }
  });
  const pick = (k: number, b: number): Candidate[] => {
    const chosen: Candidate[] = [];
    for (let i = items.length - 1; i >= 0 && k > 0; i--) {
      if (!keep[i]?.[k]?.[b]) continue;
      const it = items[i] as Candidate;
      chosen.push(it);
      k--;
      b -= it.cost;
    }
    return chosen;
  };
  return { points, pick };
}

/**
 * The lineup with the most points whose cap hits fit each budget. Exact: a knapsack per position, then the budget
 * is split across positions, once for each position the flex spot could go to.
 */
export function bestLineups(cands: Candidate[], scope: Lineup['scope'], week: number | null, rules: LineupRules = VALUE.fantasy): Lineup[] {
  const L = rules.lineup;
  const step = rules.budgetStepMillions;
  const B = Math.floor(Math.max(...rules.budgetsMillions) / step + 1e-9);
  const positions = Object.keys(L.slots);
  const tables = new Map(positions.map((pos) => {
    const items = cands
      .filter((c) => c.pos === pos && c.points > 0)
      .sort((a, b) => b.points - a.points || a.cost - b.cost || a.id.localeCompare(b.id));
    return [pos, knapsack(items, (L.slots[pos] ?? 0) + (L.flexFrom.includes(pos) ? 1 : 0), B)] as const;
  }));
  const out: Lineup[] = [];
  for (const budgetMillions of rules.budgetsMillions) {
    const budget = Math.floor(budgetMillions / step + 1e-9);
    let best: { points: number; picks: Candidate[] } | null = null;
    // no flex spot: one pass with nothing extra
    for (const flex of L.flexFrom.length ? L.flexFrom : [null]) {
      // split the budget across positions one at a time, remembering how much each one got
      let total = new Float64Array(budget + 1);
      const spent: Int32Array[] = [];
      for (const pos of positions) {
        const need = (L.slots[pos] ?? 0) + (pos === flex ? 1 : 0);
        const t = tables.get(pos)?.points[need] as Float64Array;
        const next = new Float64Array(budget + 1).fill(-Infinity);
        const at = new Int32Array(budget + 1);
        for (let b = 0; b <= budget; b++) {
          for (let x = 0; x <= b; x++) {
            const v = (total[b - x] as number) + (t[x] as number);
            if (v > (next[b] as number)) {
              next[b] = v;
              at[b] = x;
            }
          }
        }
        total = next;
        spent.push(at);
      }
      const pts = total[budget] as number;
      if (!Number.isFinite(pts) || (best && pts <= best.points)) continue;
      const picks: Candidate[] = [];
      let b = budget;
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i] as string;
        const x = (spent[i] as Int32Array)[b] as number;
        picks.push(...(tables.get(pos)?.pick((L.slots[pos] ?? 0) + (pos === flex ? 1 : 0), x) ?? []));
        b -= x;
      }
      best = { points: pts, picks };
    }
    if (!best) continue;
    const players: LineupPlayer[] = [];
    for (const pos of positions) {
      const mine = best.picks.filter((c) => c.pos === pos).sort((a, c) => c.points - a.points || a.id.localeCompare(c.id));
      mine.forEach((c, i) => players.push({
        slot: i < (L.slots[pos] ?? 0) ? pos : L.flexLabel,
        id: c.id, name: c.name, team: c.team, pos: c.pos, points: round(c.points, 1), capMillions: round(c.cap, 2),
      }));
    }
    players.sort((a, c) => Number(a.slot === L.flexLabel) - Number(c.slot === L.flexLabel));
    out.push({
      budgetMillions, scope, week,
      points: round(players.reduce((s, p) => s + p.points, 0), 1),
      capMillions: round(players.reduce((s, p) => s + p.capMillions, 0), 2),
      players,
    });
  }
  return out;
}

/** The best 17 the money can buy: lineup spots by position group, scored by production instead of fantasy points. */
export function rosterCandidates(values: PlayerValue[], cfg: ValueConfig = VALUE): Candidate[] {
  return values.map((v) => ({
    id: v.id, name: v.name, team: v.team, pos: v.group, points: v.production, cap: v.capMillions,
    cost: Math.ceil(v.capMillions / cfg.roster.budgetStepMillions - 1e-9),
  }));
}

function lineupCandidates(profiles: PlayerProfile[], caps: Map<string, number>, week: number | null, cfg: ValueConfig): Candidate[] {
  const step = cfg.fantasy.budgetStepMillions;
  const out: Candidate[] = [];
  for (const p of profiles) {
    const cap = caps.get(p.id);
    const col = pointsColumn(p, cfg);
    if (cap === undefined || col < 0 || cfg.fantasy.lineup.slots[p.pos] === undefined) continue;
    const rows = week === null ? p.log : p.log.filter((r) => r.wk === week);
    const points = rows.reduce((s, r) => s + (r.v[col] ?? 0), 0);
    // round the cost up so a lineup never slips over the budget
    out.push({ id: p.id, name: p.name, team: p.team, pos: p.pos, points, cap, cost: Math.ceil(cap / step - 1e-9) });
  }
  return out;
}

/** The value at fraction q (0-1) of an ascending list, interpolating between neighbours. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const x = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(x);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (x - lo);
}

/**
 * Player value, in dollars. A ranked player's production is "worth" the cap hit found at the same percentile
 * of pay at his position: the 90th-percentile producer is worth what the 90th-percentile-paid player costs.
 * Surplus = worth - cap hit.
 */
export function playerValues(players: PlayerResult[], caps: Map<string, number>): PlayerValue[] {
  const out: PlayerValue[] = [];
  const groups = new Map<PositionGroup, PlayerResult[]>();
  for (const p of players) if (caps.has(p.id)) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  for (const [group, list] of groups) {
    const pay = list.map((p) => caps.get(p.id) as number).sort((a, b) => a - b);
    for (const p of list) {
      const cap = caps.get(p.id) as number;
      const worth = quantile(pay, p.scores.production / 100);
      out.push({
        id: p.id, name: p.name, team: p.team, group, production: p.scores.production,
        capMillions: round(cap, 2), worthMillions: round(worth, 2), surplus: round(worth - cap, 2),
      });
    }
  }
  return out.sort((a, b) => b.surplus - a.surplus || a.id.localeCompare(b.id));
}

/** Team scores: the sum of each team's players' surplus, graded across teams. */
export function frontOffices(values: PlayerValue[], rankedIds: Set<string>, caps: Map<string, number>, inp: ModelInputs, teams: string[], cfg: ValueConfig = VALUE): FrontOffice[] {
  const F = cfg.frontOffice;
  const rows = new Map<string, PlayerValue[]>();
  for (const v of values) rows.set(v.team, [...(rows.get(v.team) ?? []), v]);
  const ranked = rankedIds;
  const raw = teams.map((team) => {
    const mine = rows.get(team) ?? [];
    const bySurplus = [...mine].sort((a, b) => b.surplus - a.surplus || a.id.localeCompare(b.id));
    const idle = inp.roster
      .filter((r) => r.team === team && !ranked.has(r.gsis) && DEPTH_TO_GROUP[r.depth] && (caps.get(r.gsis) ?? 0) >= F.idleCapMillions)
      .map((r) => ({ id: r.gsis, name: r.name, pos: r.depth, capMillions: round(caps.get(r.gsis) as number, 2) }))
      .sort((a, b) => b.capMillions - a.capMillions || a.id.localeCompare(b.id))
      .slice(0, F.listSize);
    return {
      team, count: mine.length,
      surplus: mine.reduce((s, p) => s + p.surplus, 0),
      cap: mine.reduce((s, p) => s + p.capMillions, 0),
      bargains: bySurplus.filter((p) => p.surplus > 0).slice(0, F.listSize),
      overpays: bySurplus.filter((p) => p.surplus < 0).reverse().slice(0, F.listSize),
      idle,
    };
  });
  const scored = raw.filter((t) => t.count >= F.minPlayers);
  const m = mean(scored.map((t) => t.surplus));
  const s = sd(scored.map((t) => t.surplus)) || 1;
  const rk = ranks(raw.map((t) => (t.count >= F.minPlayers ? t.surplus : -Infinity)), true);
  return raw
    .map((t, i) => ({
      team: t.team,
      grade: t.count >= F.minPlayers ? round(100 * normalCdf((t.surplus - m) / s), GRADE.decimals) : null,
      rank: t.count >= F.minPlayers ? (rk[i] as number) : null,
      surplus: round(t.surplus, 1),
      capMillions: round(t.cap, 1),
      players: t.count,
      bargains: t.bargains,
      overpays: t.overpays,
      idle: t.idle,
    }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.team.localeCompare(b.team));
}

/** The latest week in which every scheduled game has a score: a week in progress would give a lopsided "best lineup". */
export function lastFullWeek(inp: ModelInputs): number | null {
  const weeks = [...new Set(inp.games.map((g) => g.week))].sort((a, b) => b - a);
  return weeks.find((w) => inp.games.filter((g) => g.week === w).every((g) => g.homeScore !== null)) ?? null;
}

export function buildValue(inp: ModelInputs, profiles: PlayerProfile[], players: PlayerResult[], teams: string[], teamGames: Record<string, number>, cfg: ValueConfig = VALUE): ValueOutput {
  const caps = capHits(inp);
  const week = lastFullWeek(inp);
  const values = playerValues(players, caps);
  return {
    fantasy: fantasyValues(profiles, caps, teamGames, cfg),
    lineups: caps.size ? [
      ...bestLineups(lineupCandidates(profiles, caps, null, cfg), 'season', null, cfg.fantasy),
      ...(week === null ? [] : bestLineups(lineupCandidates(profiles, caps, week, cfg), 'week', week, cfg.fantasy)),
    ] : [],
    players: values,
    rosters: bestLineups(rosterCandidates(values, cfg), 'season', null, cfg.roster),
    frontOffices: caps.size ? frontOffices(values, new Set(players.map((p) => p.id)), caps, inp, teams, cfg) : [],
  };
}
