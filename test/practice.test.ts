import { describe, expect, it } from 'vitest';
import { parseCsv } from '../pipeline/csv.ts';
import { extractInjuries } from '../pipeline/extract.ts';
import { playerStatuses, practiceReport } from '../src/model/practice.ts';
import type { RosterPlayer } from '../src/model/types.ts';

const HEAD = 'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status';
const row = (team: string, week: number, id: string, name: string, report: string, practice: string, injury = 'Knee', season = 2026, type = 'REG'): string =>
  [season, type, type, team, week, id, 'WR', name, '', '', report ? injury : '', '', report, injury, '', practice].join(',');

describe('practice report', () => {
  it('this week\'s practice status and game designation per player, most serious first', () => {
    const csv = [HEAD,
      row('AAA', 5, 'a', 'Al', '', 'Full Participation in Practice'),
      row('AAA', 5, 'b', 'Bo', 'Out', 'Did Not Participate In Practice'),
      row('AAA', 5, 'c', 'Cy', 'Questionable', 'Limited Participation in Practice'),
      row('AAA', 5, 'd', 'Di', '', 'Did Not Participate In Practice', 'Not injury related - resting player'),
      row('AAA', 4, 'e', 'Ed', 'Out', 'Did Not Participate In Practice'), // last week
      row('BBB', 5, 'f', 'Fy', 'Doubtful', ''),
      row('AAA', 5, 'g', 'Gu', 'Out', 'Did Not Participate In Practice', 'Knee', 2025), // another season
      row('AAA', 19, 'h', 'Hu', 'Out', 'Did Not Participate In Practice', 'Knee', 2026, 'POST'), // playoffs
    ].join('\n');
    const inj = extractInjuries(parseCsv(csv), 2026);
    expect(inj.maxWeek).toBe(5);
    const r = practiceReport(inj.data, 5);
    expect(r.published).toBe(true);
    expect(r.teams.AAA!.map((x) => [x.name, x.game, x.practice])).toEqual([
      ['Bo', 'Out', 'DNP'], ['Cy', 'Questionable', 'Limited'], ['Di', null, 'DNP'], ['Al', null, 'Full'],
    ]);
    expect(r.teams.AAA![2]!.injury).toBe('Not injury related - resting player');
    expect(r.teams.BBB).toEqual([{ id: 'f', name: 'Fy', pos: 'WR', practice: null, game: 'Doubtful', injury: 'Knee' }]);
    expect(r.note).toMatch(/one per player per week/);
  });

  it('before this week\'s first report: nothing listed, and it says which week the file reaches', () => {
    const inj = extractInjuries(parseCsv([HEAD, row('AAA', 4, 'e', 'Ed', 'Out', 'Did Not Participate In Practice')].join('\n')), 2026);
    const r = practiceReport(inj.data, 5);
    expect(r).toMatchObject({ week: 5, published: false, latestWeek: 4, teams: {} });
  });

  it('player page status: his most recent report line, the newest week in the file, and a reserve list', () => {
    const csv = [HEAD,
      row('AAA', 3, 'a', 'Al', 'Out', 'Did Not Participate In Practice', 'Ankle'),
      row('AAA', 5, 'a', 'Al', 'Questionable', 'Limited Participation in Practice', 'Ankle'),
      row('AAA', 4, 'b', 'Bo', '', 'Full Participation in Practice', 'Hand'),
      row('BBB', 6, 'c', 'Cy', '', 'Did Not Participate In Practice'),
    ].join('\n');
    const roster = (gsis: string, status: string): RosterPlayer => ({ gsis, pfr: null, name: gsis, team: 'AAA', depth: 'WR', week: 6, status });
    const s = playerStatuses(extractInjuries(parseCsv(csv), 2026).data, [roster('a', 'ACT'), roster('b', 'RES'), roster('z', 'RES')]);
    expect(s.get('a')).toEqual({ reportWeek: 6, report: { wk: 5, practice: 'Limited', game: 'Questionable', injury: 'Ankle' }, reserve: null });
    expect(s.get('b')).toEqual({ reportWeek: 6, report: { wk: 4, practice: 'Full', game: null, injury: 'Hand' }, reserve: 'Reserve/IR' });
    expect(s.get('c')?.report?.wk).toBe(6);
    expect(s.get('z')).toEqual({ reportWeek: 6, report: null, reserve: 'Reserve/IR' });
    expect(s.has('nobody')).toBe(false);
  });
});
