/**
 * Value: what teams get for their cap dollars.
 * - Fantasy value: PPR points per $1M of this season's cap hit, and the best lineup that fits under a budget.
 * - Front offices: for every ranked player, production percentile minus what players paid that much usually
 *   produce ("surplus"); a team's score is the cap-weighted average of its players' surplus.
 * Cap hits come from the contract's row for this season. Dead money isn't in the data, so it isn't counted.
 */
import { DEPTH_TO_GROUP, GAME_LOG, GRADE, VALUE, type PositionGroup, type ValueConfig } from './config.ts';
import { mean, normalCdf, percentiles, ranks, round, sd } from './stats.ts';
import type {
  FantasyValue, FrontOffice, FrontOfficePlayer, Lineup, LineupPlayer, ModelInputs, PlayerProfile, PlayerResult, ValueOutput,
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

interface Candidate { id: string; name: string; team: string; pos: string; points: number; cap: number; cost: number }

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
export function bestLineups(cands: Candidate[], scope: Lineup['scope'], week: number | null, cfg: ValueConfig = VALUE): Lineup[] {
  const L = cfg.fantasy.lineup;
  const step = cfg.fantasy.budgetStepMillions;
  const B = Math.round(Math.max(...cfg.fantasy.budgetsMillions) / step);
  const positions = Object.keys(L.slots);
  const tables = new Map(positions.map((pos) => {
    const items = cands
      .filter((c) => c.pos === pos && c.points > 0)
      .sort((a, b) => b.points - a.points || a.cost - b.cost || a.id.localeCompare(b.id))
      .slice(0, cfg.fantasy.candidatesPerPosition);
    return [pos, knapsack(items, (L.slots[pos] ?? 0) + (L.flexFrom.includes(pos) ? 1 : 0), B)] as const;
  }));
  const out: Lineup[] = [];
  for (const budgetMillions of cfg.fantasy.budgetsMillions) {
    const budget = Math.round(budgetMillions / step);
    let best: { points: number; picks: Candidate[]; flex: string } | null = null;
    for (const flex of L.flexFrom) {
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
      best = { points: pts, picks, flex };
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

/** Least-squares line y = intercept + slope * x; a flat line at the mean when x doesn't vary. */
export function linearFit(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxx > 0 ? xs.reduce((s, x, i) => s + (x - mx) * ((ys[i] as number) - my), 0) / sxx : 0;
  return { intercept: my - slope * mx, slope };
}

export function frontOffices(players: PlayerResult[], caps: Map<string, number>, inp: ModelInputs, teams: string[], cfg: ValueConfig = VALUE): FrontOffice[] {
  const F = cfg.frontOffice;
  const priced = players.filter((p) => caps.has(p.id));
  const rows = new Map<string, FrontOfficePlayer[]>();
  const groups = new Map<PositionGroup, PlayerResult[]>();
  for (const p of priced) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const all: { p: PlayerResult; group: PositionGroup; capPct: number }[] = [];
  for (const [group, list] of groups) {
    const capPct = percentiles(list.map((p) => caps.get(p.id) as number));
    list.forEach((p, i) => all.push({ p, group, capPct: capPct[i] as number }));
  }
  // what a player paid at each level usually produces: a straight-line fit of production on pay, league-wide
  const fit = linearFit(all.map((x) => x.capPct), all.map((x) => x.p.scores.production));
  for (const { p, group, capPct } of all) {
    const expected = fit.intercept + fit.slope * capPct;
    rows.set(p.team, [...(rows.get(p.team) ?? []), {
      id: p.id, name: p.name, group, production: p.scores.production, capPct: round(capPct, 1), expected: round(expected, 1),
      capMillions: round(caps.get(p.id) as number, 2), surplus: round(p.scores.production - expected, 1),
    }]);
  }
  const ranked = new Set(players.map((p) => p.id));
  const raw = teams.map((team) => {
    const mine = rows.get(team) ?? [];
    const cap = mine.reduce((s, p) => s + p.capMillions, 0);
    const surplus = cap > 0 ? mine.reduce((s, p) => s + p.capMillions * p.surplus, 0) / cap : 0;
    const bySurplus = [...mine].sort((a, b) => b.surplus - a.surplus || a.id.localeCompare(b.id));
    const idle = inp.roster
      .filter((r) => r.team === team && !ranked.has(r.gsis) && DEPTH_TO_GROUP[r.depth] && (caps.get(r.gsis) ?? 0) >= F.idleCapMillions)
      .map((r) => ({ id: r.gsis, name: r.name, pos: r.depth, capMillions: round(caps.get(r.gsis) as number, 2) }))
      .sort((a, b) => b.capMillions - a.capMillions || a.id.localeCompare(b.id))
      .slice(0, F.listSize);
    return {
      team, surplus, cap, count: mine.length,
      bargains: bySurplus.filter((p) => p.surplus > 0 && p.production >= F.bargainMinProduction).slice(0, F.listSize),
      overpays: bySurplus.filter((p) => p.surplus < 0 && p.capPct >= F.overpayMinCapPct).reverse().slice(0, F.listSize),
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

export function buildValue(inp: ModelInputs, profiles: PlayerProfile[], players: PlayerResult[], teams: string[], teamGames: Record<string, number>, throughWeek: number, cfg: ValueConfig = VALUE): ValueOutput {
  const caps = capHits(inp);
  return {
    fantasy: fantasyValues(profiles, caps, teamGames, cfg),
    lineups: caps.size ? [
      ...bestLineups(lineupCandidates(profiles, caps, null, cfg), 'season', null, cfg),
      ...bestLineups(lineupCandidates(profiles, caps, throughWeek, cfg), 'week', throughWeek, cfg),
    ] : [],
    frontOffices: caps.size ? frontOffices(players, caps, inp, teams, cfg) : [],
  };
}
