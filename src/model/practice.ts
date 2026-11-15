/** This week's injury report: each listed player's practice status and game designation (nflverse injuries). */
import { INJURY, type InjuryConfig } from './config.ts';
import type { InjuryRow, PracticeReport, PracticeRow } from './types.ts';

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
