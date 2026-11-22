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
 * Each listed player's most recent injury report line (any week this season) and the latest week in the file, plus a
 * reserve roster status (e.g. IR) from his latest weekly roster row. Players on neither are left out.
 */
export function playerStatuses(injuries: InjuryRow[], roster: RosterPlayer[], cfg: InjuryConfig = INJURY): Map<string, PlayerStatus> {
  const reportWeek = injuries.reduce((m, i) => Math.max(m, i.wk), 0);
  const latest = new Map<string, InjuryRow>();
  for (const i of injuries) {
    const prev = latest.get(i.p);
    if (!prev || i.wk > prev.wk) latest.set(i.p, i);
  }
  const out = new Map<string, PlayerStatus>();
  for (const [id, i] of latest) {
    out.set(id, {
      reportWeek,
      report: {
        wk: i.wk,
        practice: i.practice ? cfg.practice[i.practice] ?? i.practice : null,
        game: i.report ? cfg.gameStatus[i.report] ?? i.report : null,
        injury: i.injury,
      },
      reserve: null,
    });
  }
  for (const r of roster) {
    const label = cfg.rosterStatus[r.status];
    if (!label) continue;
    const s = out.get(r.gsis);
    if (s) s.reserve = label;
    else out.set(r.gsis, { reportWeek, report: null, reserve: label });
  }
  return out;
}
