/** Red zone usage: each player's targets and carries inside each RED_ZONE cutoff, by week, and his team's totals. */
import { RED_ZONE, type RedZoneConfig } from './config.ts';
import type { Game, ModelInputs, RedZonePlayer, RedZoneTeam, RedZoneUsage } from './types.ts';

const addInto = (into: number[], from: number[]): void => {
  for (let i = 0; i < from.length; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
};

/** Share of a team total, 0-1 (0 when the team had none). */
export const share = (n: number, total: number): number => (total > 0 ? n / total : 0);

/** Targets + carries in zone `z` from a flattened counts array. */
export const opportunities = (counts: number[], z: number): number => (counts[2 * z] ?? 0) + (counts[2 * z + 1] ?? 0);

export function redZoneUsage(inp: Pick<ModelInputs, 'playerGames' | 'games' | 'roster' | 'playerWeeks'>, cfg: RedZoneConfig = RED_ZONE): RedZoneUsage {
  const n = 2 * cfg.zones.length;
  const week = new Map<string, number>(inp.games.map((g: Game) => [g.id, g.week]));
  const names = new Map<string, { name: string; pos: string }>();
  for (const w of inp.playerWeeks) names.set(w.p, { name: w.name, pos: w.pos });
  for (const r of inp.roster) if (!names.has(r.gsis)) names.set(r.gsis, { name: r.name, pos: r.depth });

  const teams: Record<string, RedZoneTeam> = {};
  const players = new Map<string, RedZonePlayer>();
  const weekTotals = new Map<string, Map<number, number[]>>();
  const weeks = new Set<number>();
  for (const g of inp.playerGames) {
    const wk = week.get(g.g);
    if (wk === undefined) continue;
    weeks.add(wk);
    if (!g.rz) continue;
    const team = (teams[g.t] ??= { season: Array(n).fill(0), weeks: [], players: [] });
    addInto(team.season, g.rz);
    const wt = weekTotals.get(g.t) ?? new Map<number, number[]>();
    weekTotals.set(g.t, wt);
    if (!wt.has(wk)) wt.set(wk, Array(n).fill(0));
    addInto(wt.get(wk) as number[], g.rz);
    // a traded player is listed once per team, with that team's weeks
    const key = `${g.t}|${g.p}`;
    let p = players.get(key);
    if (!p) {
      const who = names.get(g.p);
      p = { id: g.p, name: who?.name ?? g.p, pos: who?.pos ?? '', season: Array(n).fill(0), weeks: [] };
      players.set(key, p);
      team.players.push(p);
    }
    addInto(p.season, g.rz);
    const row = p.weeks.find((w) => w[0] === wk);
    if (row) for (let i = 0; i < n; i++) row[i + 1] = (row[i + 1] ?? 0) + (g.rz[i] ?? 0);
    else p.weeks.push([wk, ...g.rz]);
  }
  for (const [t, team] of Object.entries(teams)) {
    team.weeks = [...(weekTotals.get(t) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map(([wk, c]) => [wk, ...c]);
    for (const p of team.players) p.weeks.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    team.players.sort((a, b) => opportunities(b.season, 0) - opportunities(a.season, 0) || opportunities(b.season, 1) - opportunities(a.season, 1) || a.name.localeCompare(b.name));
  }
  return { zones: cfg.zones.map((z) => ({ ...z })), weeks: [...weeks].sort((a, b) => a - b), teams };
}
