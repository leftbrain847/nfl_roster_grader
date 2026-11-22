/** Each team's schedule: result, EPA per play on both sides (from the unit grades' plays) and core box-score totals
 * summed from the weekly player stats, game by game, plus season averages. */
import { GAME_LOG, TEAM_SCHEDULE, type GameLogConfig, type TeamScheduleConfig } from './config.ts';
import { round } from './stats.ts';
import type { Game, PlayerWeek, ScheduleGame, TeamGame, TeamSchedule } from './types.ts';

/** Each column's sources as [kind, column index]. A title not in the game log is a config error. */
export function columnIndexes(cfg: TeamScheduleConfig = TEAM_SCHEDULE, log: GameLogConfig = GAME_LOG): [string, number][][] {
  return cfg.stats.map((st) => st.from.map(([kind, title]) => {
    const i = log.columns[kind].findIndex((c) => c.title === title);
    if (i < 0) throw new Error(`TEAM_SCHEDULE ${st.label}: no ${kind} game log column titled "${title}"`);
    return [kind, i];
  }));
}

const epa = (rows: TeamGame[]): number | null => {
  const n = rows.reduce((s, r) => s + r.passN + r.rushN, 0);
  return n ? rows.reduce((s, r) => s + r.passEpa + r.rushEpa, 0) / n : null;
};

export function teamSchedules(games: Game[], teamGames: TeamGame[], playerWeeks: PlayerWeek[], teams: string[], cfg: TeamScheduleConfig = TEAM_SCHEDULE, log: GameLogConfig = GAME_LOG): TeamSchedule[] {
  const idx = columnIndexes(cfg, log);
  // game|team -> kind -> column sums
  const sums = new Map<string, Map<string, number[]>>();
  for (const w of playerWeeks) {
    const k = `${w.g}|${w.t}`;
    const byKind = sums.get(k) ?? new Map<string, number[]>();
    const acc = byKind.get(w.kind) ?? Array(log.columns[w.kind].length).fill(0);
    w.v.forEach((x, i) => { acc[i] = (acc[i] ?? 0) + x; });
    byKind.set(w.kind, acc);
    sums.set(k, byKind);
  }
  const byOff = new Map<string, TeamGame>();
  for (const g of teamGames) byOff.set(`${g.game}|${g.off}`, g);
  const ordered = [...games].sort((a, b) => a.week - b.week || a.gameday.localeCompare(b.gameday) || a.id.localeCompare(b.id));

  return teams.map((team) => {
    const out: ScheduleGame[] = [];
    for (const g of ordered) {
      if (g.home !== team && g.away !== team) continue;
      const home = g.home === team;
      const opp = home ? g.away : g.home;
      const played = g.homeScore !== null && g.awayScore !== null;
      let result = '';
      if (played) {
        const [us, them] = home ? [g.homeScore as number, g.awayScore as number] : [g.awayScore as number, g.homeScore as number];
        result = `${us > them ? 'W' : us < them ? 'L' : 'T'} ${us}-${them}`;
      }
      const mine = sums.get(`${g.id}|${team}`);
      const theirs = sums.get(`${g.id}|${opp}`);
      const v = played && mine && theirs
        ? cfg.stats.map((st, c) => round((idx[c] ?? []).reduce((s, [kind, i]) => s + ((st.rows === 'team' ? mine : theirs).get(kind)?.[i] ?? 0), 0), st.decimals))
        : null;
      const off = byOff.get(`${g.id}|${team}`);
      const def = byOff.get(`${g.id}|${opp}`);
      out.push({
        wk: g.week, opp, home, gameday: g.gameday, result,
        offEpa: played && off ? round(epa([off]) ?? 0, cfg.epaDecimals) : null,
        defEpa: played && def ? round(epa([def]) ?? 0, cfg.epaDecimals) : null,
        v,
      });
    }
    const withStats = out.filter((x) => x.v);
    const offAll = teamGames.filter((r) => r.off === team);
    const defAll = teamGames.filter((r) => r.def === team);
    const e = (rows: TeamGame[]): number | null => { const x = epa(rows); return x === null ? null : round(x, cfg.epaDecimals); };
    return {
      team,
      games: out,
      season: {
        offEpa: e(offAll),
        defEpa: e(defAll),
        v: cfg.stats.map((st, c) => (withStats.length ? round(withStats.reduce((s, x) => s + (x.v?.[c] ?? 0), 0) / withStats.length, st.decimals + 1) : null)),
      },
    };
  });
}
