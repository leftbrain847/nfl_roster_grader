import { describe, expect, it } from 'vitest';
import { parseCsv } from '../pipeline/csv.ts';
import { extractPbp } from '../pipeline/extract.ts';
import { RED_ZONE } from '../src/model/config.ts';
import { opportunities, redZoneUsage, share } from '../src/model/redZone.ts';
import type { Game } from '../src/model/types.ts';

const COLS = ['season', 'season_type', 'game_id', 'play_id', 'pass', 'rush', 'epa', 'qb_epa', 'wp', 'success', 'sack', 'qb_hit', 'pass_attempt', 'cpoe',
  'posteam', 'defteam', 'posteam_type', 'location', 'passer_player_id', 'receiver_player_id', 'rusher_player_id',
  'solo_tackle_1_player_id', 'tackle_for_loss_1_player_id', 'sack_player_id', 'qb_hit_1_player_id', 'pass_defense_1_player_id', 'interception_player_id',
  'yardline_100', 'series_success', 'two_point_attempt', 'qb_kneel'];

type Play = Partial<Record<(typeof COLS)[number], string | number>>;
const csv = (plays: Play[]): string => [COLS.join(','), ...plays.map((p) => COLS.map((c) => p[c] ?? '').join(','))].join('\n');
const base: Play = { season: 2026, season_type: 'REG', game_id: 'g1', epa: 0.1, wp: 0.5, success: 1, sack: 0, qb_hit: 0, posteam: 'AAA', defteam: 'BBB', posteam_type: 'home', location: 'Home', passer_player_id: 'qb' };
const target = (yard: number | string, rec = 'wr', extra: Play = {}): Play => ({ ...base, pass: 1, rush: 0, pass_attempt: 1, receiver_player_id: rec, yardline_100: yard, ...extra });
const carry = (yard: number, rb = 'rb', extra: Play = {}): Play => ({ ...base, pass: 0, rush: 1, pass_attempt: 0, rusher_player_id: rb, yardline_100: yard, ...extra });

describe('red zone usage', () => {
  it('counts targets and carries at or inside each cutoff (the 20 and the 10), not outside', () => {
    expect(RED_ZONE.zones.map((z) => z.maxYardline)).toEqual([20, 10]);
    const plays = [
      target(21), target(20), target(11), target(10), target(1), // 20 counts, 21 doesn't; 10 counts, 11 doesn't
      target(5, 'wr', { sack: 1, pass_attempt: 0 }), // a sack is not a target
      target(5, 'wr', { two_point_attempt: 1 }), // two-point tries don't count
      target('NA'),
      carry(25), carry(20), carry(9), carry(3, 'rb', { qb_kneel: 1 }),
      target(15, 'te'), carry(8, 'rb2'),
    ];
    const pbp = extractPbp(parseCsv(csv(plays)), 2026).data;
    const by = Object.fromEntries(pbp.playerGames.map((p) => [p.p, p]));
    expect(by.wr!.tgt).toBe(6);
    expect(by.wr!.rz).toEqual([4, 0, 2, 0]); // [in20 tgt, in20 car, in10 tgt, in10 car]
    expect(by.rb!.rz).toEqual([0, 2, 0, 1]);
    expect(by.te!.rz).toEqual([1, 0, 0, 0]);
    expect(by.qb!.rz).toBeUndefined();

    const games: Game[] = [{ id: 'g1', week: 3, gameday: '2026-09-27', home: 'AAA', away: 'BBB', homeScore: 1, awayScore: 0, neutral: false }];
    const rz = redZoneUsage({ playerGames: pbp.playerGames, games, roster: [], playerWeeks: [] });
    const team = rz.teams.AAA!;
    expect(team.season).toEqual([5, 3, 2, 2]);
    expect(team.weeks).toEqual([[3, 5, 3, 2, 2]]);
    expect(team.players.map((p) => p.id)).toEqual(['wr', 'rb', 'rb2', 'te']);
    const wr = team.players[0]!;
    expect(share(wr.season[0]!, team.season[0]!)).toBe(0.8); // 4 of the team's 5 targets inside the 20
    expect(share(wr.season[2]!, team.season[2]!)).toBe(1);
    expect(opportunities(team.season, 1)).toBe(4);
    expect(wr.weeks).toEqual([[3, 4, 0, 2, 0]]);
  });
});
