/** This week's injury report: each listed player's practice status and game designation (nflverse injuries). */
import { INJURY, type InjuryConfig } from './config.ts';
import type { InjuryRow, PlayerStatus, PracticeReport, PracticeRow, RosterPlayer } from './types.ts';

const order = (list: string[], x: string | null): number => {
  const i = x === null ? -1 : list.indexOf(x);
  return i < 0 ? list.length : i;
};

export function practiceReport(injuries: InjuryRow[], week: number, cfg: InjuryConfig = INJURY): PracticeReport {
  const latestWeek = injuries.reduce((m, i) => Math.max(m, i.wk), 0);
  const teams: Record<string, PracticeRow[]> = {};
  for (const i of injuries) {
    if (i.wk !== week) continue;
    (teams[i.t] ??= []).push({
      id: i.p,
      name: i.name,
      pos: i.pos,
      practice: i.practice ? cfg.practice[i.practice] ?? i.practice : null,
      game: i.report ? cfg.gameStatus[i.report] ?? i.report : null,
      injury: i.injury,
    });
  }
  for (const rows of Object.values(teams)) {
    rows.sort((a, b) => order(cfg.gameOrder, a.game) - order(cfg.gameOrder, b.game) || order(cfg.practiceOrder, a.practice) - order(cfg.practiceOrder, b.practice) || a.name.localeCompare(b.name));
  }
  return { week, published: Object.keys(teams).length > 0, latestWeek, note: cfg.practiceNote, teams: Object.fromEntries(Object.entries(teams).sort((a, b) => a[0].localeCompare(b[0]))) };
}

/**
 * A status for every player: his most recent injury report line (any week this season), the newest week his team has
 * filed a report (teams file on different days, and not on a bye), and a reserve roster status (e.g. IR) from his
 * latest weekly roster row. Every player gets one, so a page without it means a data file from before it.
 */
export function playerStatuses(injuries: InjuryRow[], roster: RosterPlayer[], cfg: InjuryConfig = INJURY): (id: string, team: string) => PlayerStatus {
  const teamWeek = new Map<string, number>();
  const latest = new Map<string, InjuryRow>();
  for (const i of injuries) {
    teamWeek.set(i.t, Math.max(teamWeek.get(i.t) ?? 0, i.wk));
    const prev = latest.get(i.p);
    if (!prev || i.wk > prev.wk) latest.set(i.p, i);
  }
  const reserve = new Map<string, string>();
  for (const r of roster) {
    const label = cfg.rosterStatus[r.status];
    if (label) reserve.set(r.gsis, label);
  }
  return (id, team) => {
    const i = latest.get(id);
    return {
      reportWeek: teamWeek.get(team) ?? 0,
      report: i ? {
        wk: i.wk,
        practice: i.practice ? cfg.practice[i.practice] ?? i.practice : null,
        game: i.report ? cfg.gameStatus[i.report] ?? i.report : null,
        injury: i.injury,
      } : null,
      reserve: reserve.get(id) ?? null,
    };
  };
}
