/**
 * Player production rankings: for each position group, a percentile within the position built from the stats in
 * POSITIONS (config.ts). Every rate stat uses numerator and denominator from the same games, so a source that lags
 * a week (PFR often does) never divides last week's numbers by this week's volume.
 */
import {
  DEPTH_TO_GROUP, MIN_WEIGHT_SHARE, POSITIONS, POSITION_GROUPS, RATE_MINIMUMS, RATINGS_SOURCE, STATS,
  type PositionGroup, type RatingsSourceConfig, type StatKey,
} from './config.ts';
import { playerContract } from './contracts.ts';
import { percentiles, round } from './stats.ts';
import type { ModelInputs, PlayerGame, PlayerResult, PlayerStat } from './types.ts';

type ByGame<T> = Map<string, T>;

function index<T extends { p: string; g: string }>(rows: T[], merge?: (a: T, b: T) => T): Map<string, ByGame<T>> {
  const m = new Map<string, ByGame<T>>();
  for (const r of rows) {
    let g = m.get(r.p);
    if (!g) m.set(r.p, (g = new Map()));
    const prev = g.get(r.g);
    g.set(r.g, prev && merge ? merge(prev, r) : r);
  }
  return m;
}

const coverage = (rows: { t: string; g: string }[]): Set<string> => new Set(rows.map((r) => `${r.t}|${r.g}`));

const sum = <T>(xs: Iterable<T>, f: (x: T) => number | undefined): number => {
  let s = 0;
  for (const x of xs) s += f(x) ?? 0;
  return s;
};

export interface Aggregates {
  stats: Partial<Record<StatKey, number>>;
  volume: { dropbacks: number; carries: number; targets: number; defenseSnaps: number };
}

/** Every stat a player has enough data for, plus the volumes used for the qualifying minimums. */
export function aggregatePlayer(
  gsis: string,
  pfr: string | null,
  ctx: Context,
): Aggregates {
  const pg = ctx.pbp.get(gsis) ?? new Map<string, PlayerGame>();
  const games = [...pg.values()];
  const s: Partial<Record<StatKey, number>> = {};
  const db = sum(games, (g) => g.db);
  const car = sum(games, (g) => g.car);
  const tgt = sum(games, (g) => g.tgt);

  if (db > 0) {
    s.epaPerDropback = sum(games, (g) => g.dbEpa) / db;
    s.successRate = (100 * sum(games, (g) => g.dbSucc)) / db;
    s.sackRate = (100 * sum(games, (g) => g.sk)) / db;
    const ngs = ctx.ngsPass.get(gsis);
    const cpoeN = sum(games, (g) => g.cpoeN);
    if (ngs && ngs.att > 0) s.cpoe = ngs.cpoe;
    else if (cpoeN > 0) s.cpoe = sum(games, (g) => g.cpoeSum) / cpoeN;
  }
  if (car > 0) {
    s.rushEpaPerCarry = sum(games, (g) => g.carEpa) / car;
    s.rushSuccessRate = (100 * sum(games, (g) => g.carSucc)) / car;
    const ngs = ctx.ngsRush.get(gsis);
    if (ngs && ngs.att > 0) s.ryoePerCarry = ngs.ryoePerAtt;
  }
  if (tgt > 0) {
    s.epaPerTarget = sum(games, (g) => g.tgtEpa) / tgt;
    let teamTargets = 0;
    for (const g of games) teamTargets += ctx.teamTargets.get(`${g.t}|${g.g}`) ?? 0;
    if (teamTargets > 0) s.targetShare = (100 * tgt) / teamTargets;
    const ngs = ctx.ngsRec.get(gsis);
    if (ngs && ngs.tgt > 0) {
      s.separation = ngs.separation;
      s.yacOverExpected = ngs.yacOverExpected;
    }
  }

  let defenseSnaps = 0;
  if (pfr) {
    // PFR-sourced stats, matched game by game
    const pass = ctx.pfrPass.get(pfr);
    if (pass) {
      const pressured = sum(pass.values(), (r) => r.pressured);
      if (pressured >= RATE_MINIMUMS.qbPressures) s.pressureToSack = (100 * sum(pass.values(), (r) => r.sacked)) / pressured;
    }
    const rush = ctx.pfrRush.get(pfr);
    if (rush) {
      const carries = sum(rush.values(), (r) => r.carries);
      if (carries > 0) {
        s.yacPerCarry = sum(rush.values(), (r) => r.yac) / carries;
        s.brokenTacklesPerCarry = sum(rush.values(), (r) => r.btRush) / carries;
      }
    }
    const rec = ctx.pfrRec.get(pfr);
    if (tgt > 0) {
      // drops over targets in the team-games PFR's receiving file covers
      const covered = games.filter((g) => ctx.pfrRecCoverage.has(`${g.t}|${g.g}`));
      const t = sum(covered, (g) => g.tgt);
      if (t >= RATE_MINIMUMS.dropTargets) s.dropRate = (100 * sum(rec?.values() ?? [], (r) => r.drops)) / t;
    }
    const snaps = ctx.snaps.get(pfr);
    if (snaps) {
      const defGames = [...snaps.values()].filter((r) => r.def > 0);
      defenseSnaps = sum(defGames, (r) => r.def);
      if (defenseSnaps > 0) {
        const at = (g: string): PlayerGame | undefined => pg.get(g);
        s.tacklesPer100 = (100 * sum(defGames, (r) => at(r.g)?.tkl)) / defenseSnaps;
        s.tflPer100 = (100 * sum(defGames, (r) => at(r.g)?.tfl)) / defenseSnaps;
        s.sacksPer100 = (100 * sum(defGames, (r) => at(r.g)?.sck)) / defenseSnaps;
        s.bigPlaysPer100 = (100 * sum(defGames, (r) => at(r.g)?.big)) / defenseSnaps;
        const def = ctx.pfrDef.get(pfr);
        const pfrGames = defGames.filter((r) => ctx.pfrDefCoverage.has(`${r.t}|${r.g}`));
        const pfrSnaps = sum(pfrGames, (r) => r.def);
        if (pfrSnaps > 0) s.pressuresPer100 = (100 * sum(pfrGames, (r) => def?.get(r.g)?.pressures)) / pfrSnaps;
        if (def) {
          const rows = [...def.values()];
          const tackles = sum(rows, (r) => r.tackles);
          const missed = sum(rows, (r) => r.missed);
          if (tackles + missed >= RATE_MINIMUMS.tackleAttempts) s.missedTackleRate = (100 * missed) / (tackles + missed);
          const targets = sum(rows, (r) => r.targets);
          if (targets >= RATE_MINIMUMS.coverageTargets) {
            s.yardsPerTargetAllowed = sum(rows, (r) => r.yards) / targets;
            s.ratingAllowed = sum(rows, (r) => r.ratingSum) / targets;
            s.completionAllowed = (100 * sum(rows, (r) => r.completions)) / targets;
            // passes defensed from play-by-play, in the same games PFR covers
            const pd = sum(rows, (r) => at(r.g)?.pd);
            s.ballsPlayedPerTarget = (sum(rows, (r) => r.ints) + pd) / targets;
          }
        }
      }
    }
  }
  return { stats: s, volume: { dropbacks: db, carries: car, targets: tgt, defenseSnaps } };
}

export interface Context {
  pbp: Map<string, ByGame<PlayerGame>>;
  teamTargets: Map<string, number>;
  pfrPass: Map<string, ByGame<ModelInputs['pfrPass'][number]>>;
  pfrRush: Map<string, ByGame<ModelInputs['pfrRush'][number]>>;
  pfrRec: Map<string, ByGame<ModelInputs['pfrRec'][number]>>;
  pfrDef: Map<string, ByGame<ModelInputs['pfrDef'][number]>>;
  snaps: Map<string, ByGame<ModelInputs['snaps'][number]>>;
  pfrRecCoverage: Set<string>;
  pfrDefCoverage: Set<string>;
  ngsPass: Map<string, ModelInputs['ngsPassing'][number]>;
  ngsRec: Map<string, ModelInputs['ngsReceiving'][number]>;
  ngsRush: Map<string, ModelInputs['ngsRushing'][number]>;
}

export function buildContext(inp: ModelInputs): Context {
  const teamTargets = new Map<string, number>();
  for (const r of inp.playerGames) if (r.tgt) teamTargets.set(`${r.t}|${r.g}`, (teamTargets.get(`${r.t}|${r.g}`) ?? 0) + r.tgt);
  const addSnaps = (a: ModelInputs['snaps'][number], b: ModelInputs['snaps'][number]) => ({ ...a, off: a.off + b.off, def: a.def + b.def });
  return {
    pbp: index(inp.playerGames),
    teamTargets,
    pfrPass: index(inp.pfrPass),
    pfrRush: index(inp.pfrRush),
    pfrRec: index(inp.pfrRec),
    pfrDef: index(inp.pfrDef),
    snaps: index(inp.snaps, addSnaps),
    pfrRecCoverage: coverage(inp.pfrRec),
    pfrDefCoverage: coverage(inp.pfrDef),
    ngsPass: new Map(inp.ngsPassing.map((r) => [r.p, r])),
    ngsRec: new Map(inp.ngsReceiving.map((r) => [r.p, r])),
    ngsRush: new Map(inp.ngsRushing.map((r) => [r.p, r])),
  };
}

const VOLUME_WORDS = { dropbacks: 'dropbacks', carries: 'carries', targets: 'targets', defenseSnaps: 'defense snaps' } as const;

export interface RankOptions {
  /** Team games played so far, for the per-game qualifying minimums. */
  teamGames: Record<string, number>;
  /** Regular-season weeks played, for the base salary left. */
  weeksPlayed: number;
  ratings?: Record<string, number>;
  ratingsCfg?: RatingsSourceConfig;
}

/**
 * Score one position group. `players` are those already in the group with their aggregates; returns results sorted
 * best first. Exported separately so the percentile math can be tested on a hand-made group.
 */
export function scoreGroup(
  group: PositionGroup,
  players: { id: string; agg: Aggregates }[],
): { id: string; stats: PlayerStat[]; production: number }[] {
  const pos = POSITIONS[group];
  const keys = Object.keys(pos.weights) as StatKey[];
  const totalW = keys.reduce((s, k) => s + (pos.weights[k] ?? 0), 0);
  const pctByKey = new Map<StatKey, Map<string, number>>();
  for (const k of keys) {
    const have = players.filter((p) => p.agg.stats[k] !== undefined && Number.isFinite(p.agg.stats[k]));
    const pcts = percentiles(have.map((p) => p.agg.stats[k] as number), STATS[k].lowerIsBetter);
    pctByKey.set(k, new Map(have.map((p, i) => [p.id, pcts[i] as number])));
  }
  const composite: { id: string; stats: PlayerStat[]; c: number }[] = [];
  for (const p of players) {
    let w = 0;
    let acc = 0;
    const stats: PlayerStat[] = [];
    for (const k of keys) {
      const pct = pctByKey.get(k)?.get(p.id);
      if (pct === undefined) continue;
      const wk = pos.weights[k] ?? 0;
      w += wk;
      acc += wk * pct;
      stats.push({ key: k, value: round(p.agg.stats[k] as number, 4), pct: round(pct, 1) });
    }
    if (totalW > 0 && w / totalW >= MIN_WEIGHT_SHARE) composite.push({ id: p.id, stats, c: acc / w });
  }
  const prod = percentiles(composite.map((x) => x.c));
  return composite
    .map((x, i) => ({ id: x.id, stats: x.stats, production: round(prod[i] as number, 1), c: x.c }))
    .sort((a, b) => b.c - a.c || a.id.localeCompare(b.id))
    .map(({ id, stats, production }) => ({ id, stats, production }));
}

export function rankPlayers(inp: ModelInputs, opts: RankOptions): PlayerResult[] {
  const ctx = buildContext(inp);
  const ratingsCfg = opts.ratingsCfg ?? RATINGS_SOURCE;
  const contracts = new Map(inp.contracts.map((c) => [c.gsis, c]));
  const out: PlayerResult[] = [];
  const byGroup = new Map<PositionGroup, { id: string; agg: Aggregates; r: ModelInputs['roster'][number] }[]>();
  for (const r of inp.roster) {
    const group = DEPTH_TO_GROUP[r.depth];
    if (!group) continue;
    const agg = aggregatePlayer(r.gsis, r.pfr, ctx);
    const min = POSITIONS[group].minimum;
    const need = min.perTeamGame * (opts.teamGames[r.team] ?? 0);
    if (need <= 0 || agg.volume[min.per] < need) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), { id: r.gsis, agg, r }]);
  }
  for (const group of POSITION_GROUPS) {
    const players = byGroup.get(group) ?? [];
    const scored = scoreGroup(group, players);
    const meta = new Map(players.map((p) => [p.id, p]));
    scored.forEach((s, i) => {
      const p = meta.get(s.id);
      if (!p) return;
      const per = POSITIONS[group].minimum.per;
      const c = contracts.get(s.id);
      const scores: PlayerResult['scores'] = { production: s.production };
      const rating = opts.ratings?.[s.id];
      if (rating !== undefined) {
        scores.ratings = rating;
        const w = ratingsCfg.compositeProductionWeight;
        scores.composite = round(w * s.production + (1 - w) * rating, 1);
      }
      out.push({
        id: s.id,
        name: p.r.name,
        team: p.r.team,
        group,
        depth: p.r.depth,
        status: p.r.status,
        volume: `${Math.round(p.agg.volume[per])} ${VOLUME_WORDS[per]}`,
        stats: s.stats,
        scores,
        rank: i + 1,
        qualifiedAtPosition: scored.length,
        contract: c ? playerContract(c, opts.weeksPlayed) : null,
      });
    });
  }
  return out;
}
