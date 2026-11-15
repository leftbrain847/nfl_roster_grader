/** Team depth charts: the newest snapshot's order with each player's production score and injury designation, and
 * what changed since the compared snapshot (DEPTH.minDaysBefore). */
import { DEPTH, INJURY, type DepthConfig, type InjuryConfig } from './config.ts';
import type { DepthChartView, DepthEntry, DepthRow, DepthSlotView, DepthSnapshot, InjuryRow, PlayerResult, RosterPlayer } from './types.ts';

const slotKey = (r: DepthRow): string => `${r.grp}|${r.slot}|${r.pos}`;

/** This week's designation for each player: the injury report's game status, else a reserve roster status. */
export function designations(injuries: InjuryRow[], roster: RosterPlayer[], week: number, cfg: InjuryConfig = INJURY): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of roster) {
    const label = cfg.rosterStatus[r.status];
    if (label) out.set(r.gsis, label);
  }
  for (const i of injuries) {
    if (i.wk !== week || !i.report) continue;
    out.set(i.p, cfg.gameStatus[i.report] ?? i.report);
  }
  return out;
}

/** One slot: the current order, each player flagged against the compared snapshot, and who left the slot. */
export function diffSlot(cur: DepthRow[], prev: DepthRow[] | null): { flags: Map<string, { change: DepthEntry['change']; prevRank: number | null }>; gone: DepthSlotView['gone'] } {
  const flags = new Map<string, { change: DepthEntry['change']; prevRank: number | null }>();
  if (!prev) {
    for (const r of cur) flags.set(r.id || r.name, { change: null, prevRank: null });
    return { flags, gone: [] };
  }
  const was = new Map(prev.map((r) => [r.id || r.name, r.rank]));
  for (const r of cur) {
    const k = r.id || r.name;
    const p = was.get(k);
    flags.set(k, { change: p === undefined ? 'new' : r.rank < p ? 'up' : r.rank > p ? 'down' : null, prevRank: p ?? null });
  }
  const now = new Set(cur.map((r) => r.id || r.name));
  const gone = prev.filter((r) => !now.has(r.id || r.name)).map((r) => ({ id: r.id, name: r.name, prevRank: r.rank }));
  return { flags, gone };
}

export function depthChartView(snap: DepthSnapshot, players: Map<string, PlayerResult>, desig: Map<string, string>, cfg: DepthConfig = DEPTH): DepthChartView {
  const prevBySlot = new Map<string, DepthRow[]>();
  for (const r of snap.prev) prevBySlot.set(slotKey(r), [...(prevBySlot.get(slotKey(r)) ?? []), r]);
  const curBySlot = new Map<string, DepthRow[]>();
  for (const r of snap.rows) curBySlot.set(slotKey(r), [...(curBySlot.get(slotKey(r)) ?? []), r]);
  const hasPrev = snap.prevDt !== null;
  let changes = 0;
  const groups: DepthChartView['groups'] = [];
  // offense groups first, then defense, each in the file's slot order
  const names = [...new Set(snap.rows.map((r) => r.grp))].sort((a, b) => (cfg.groups[a] === cfg.groups[b] ? a.localeCompare(b) : cfg.groups[a] === 'offense' ? -1 : 1));
  for (const name of names) {
    const keys = [...curBySlot.keys()].filter((k) => k.startsWith(`${name}|`)).sort((a, b) => Number(a.split('|')[1]) - Number(b.split('|')[1]));
    const slots: DepthSlotView[] = keys.map((k) => {
      const cur = [...(curBySlot.get(k) ?? [])].sort((a, b) => a.rank - b.rank);
      const { flags, gone } = diffSlot(cur, hasPrev ? prevBySlot.get(k) ?? [] : null);
      const entries: DepthEntry[] = cur.map((r) => {
        const p = players.get(r.id);
        const f = flags.get(r.id || r.name) ?? { change: null, prevRank: null };
        if (f.change) changes++;
        return { id: r.id, name: r.name, rank: r.rank, score: p ? Math.round(p.scores.production) : null, group: p?.group ?? null, designation: desig.get(r.id) ?? null, change: f.change, prevRank: f.prevRank };
      });
      changes += gone.length;
      return { pos: cur[0]?.pos ?? k.split('|')[2] ?? '', players: entries, gone };
    });
    groups.push({ name, side: cfg.groups[name] ?? 'offense', slots });
  }
  return { team: snap.team, asOf: snap.dt.slice(0, 10), comparedWith: snap.prevDt ? snap.prevDt.slice(0, 10) : null, groups, changes };
}

export function depthCharts(snaps: DepthSnapshot[], players: PlayerResult[], injuries: InjuryRow[], roster: RosterPlayer[], week: number): DepthChartView[] {
  const byId = new Map(players.map((p) => [p.id, p]));
  const desig = designations(injuries, roster, week);
  return snaps.map((s) => depthChartView(s, byId, desig)).sort((a, b) => a.team.localeCompare(b.team));
}
