import { describe, expect, it } from 'vitest';
import { BIG_PLAYS, POSITIONS } from '../src/model/config.ts';
import { parseCsv } from '../pipeline/csv.ts';
import { extractPbp } from '../pipeline/extract.ts';

const COLS = ['season', 'season_type', 'game_id', 'week', 'pass', 'rush', 'epa', 'qb_epa', 'wp', 'success', 'sack', 'qb_hit', 'pass_attempt', 'cpoe',
  'posteam', 'defteam', 'posteam_type', 'location', 'passer_player_id', 'receiver_player_id', 'rusher_player_id',
  'solo_tackle_1_player_id', 'tackle_for_loss_1_player_id', 'sack_player_id', 'half_sack_1_player_id', 'half_sack_2_player_id',
  'qb_hit_1_player_id', 'pass_defense_1_player_id', 'interception_player_id', 'forced_fumble_player_1_player_id', 'yardline_100'];

/** One play: the columns named in `set` take those values, the rest are empty. */
const play = (set: Record<string, string>): string => COLS.map((c) => set[c] ?? {
  season: '2026', season_type: 'REG', game_id: 'g1', week: '1', epa: '0', qb_epa: '0', wp: '0.5', success: '0',
  posteam: 'AAA', defteam: 'BBB', posteam_type: 'home', location: 'Home', pass: '1', rush: '0', pass_attempt: '1', sack: '0', qb_hit: '0',
}[c] ?? '').join(',');

const bigOf = (rows: string[]) => {
  const ex = extractPbp(parseCsv([COLS.join(','), ...rows].join('\n')), 2026);
  return Object.fromEntries(ex.data.playerGames.filter((x) => x.big).map((x) => [x.p, Math.round((x.big ?? 0) * 100) / 100]));
};

describe('big plays (EPA)', () => {
  it('a big play is worth the EPA it took from the offense: a pick more than a sack', () => {
    expect(bigOf([
      play({ epa: '-4.4', interception_player_id: 'cb', pass_defense_1_player_id: 'cb' }),
      play({ epa: '-1.5', sack: '1', sack_player_id: 'edge', qb_hit_1_player_id: 'edge', tackle_for_loss_1_player_id: 'edge' }),
    ])).toEqual({ cb: 4.4, edge: 1.5 });   // credited once each, though the data marks several things
  });

  it('a defensive back gets the same credit for a tackle for loss as a lineman', () => {
    expect(bigOf([
      play({ epa: '-1.2', pass: '0', rush: '1', pass_attempt: '0', tackle_for_loss_1_player_id: 'safety' }),
      play({ epa: '-1.2', pass: '0', rush: '1', pass_attempt: '0', tackle_for_loss_1_player_id: 'tackle' }),
    ])).toEqual({ safety: 1.2, tackle: 1.2 });
  });

  it('defenders who make a big play on the same play split it; a play that helped the offense credits nothing', () => {
    expect(bigOf([
      play({ epa: '-2', sack: '1', half_sack_1_player_id: 'a', half_sack_2_player_id: 'b' }),
      play({ epa: '-3', sack: '1', sack_player_id: 'a', forced_fumble_player_1_player_id: 'c' }),
      play({ epa: '0.8', qb_hit_1_player_id: 'b' }),   // hit him, but the pass was completed for a gain
    ])).toEqual({ a: 2.5, b: 1, c: 1.5 });
  });

  it('every defensive group weighs big plays the same, and every group\'s weights add up to 1', () => {
    for (const g of ['EDGE', 'IDL', 'LB', 'CB', 'S'] as const) {
      expect(POSITIONS[g].weights.bigPlaysPer100).toBe(BIG_PLAYS.weight);
      expect(Object.values(POSITIONS[g].weights).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 9);
    }
  });
});
