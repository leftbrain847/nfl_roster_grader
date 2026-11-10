import { describe, expect, it } from 'vitest';
import { BIG_PLAYS, POSITIONS } from '../src/model/config.ts';
import { parseCsv } from '../pipeline/csv.ts';
import { extractPbp } from '../pipeline/extract.ts';

const COLS = ['season', 'season_type', 'game_id', 'week', 'pass', 'rush', 'epa', 'qb_epa', 'wp', 'success', 'sack', 'qb_hit', 'pass_attempt', 'cpoe',
  'posteam', 'defteam', 'posteam_type', 'location', 'passer_player_id', 'receiver_player_id', 'rusher_player_id',
  'solo_tackle_1_player_id', 'tackle_for_loss_1_player_id', 'sack_player_id', 'half_sack_1_player_id', 'half_sack_2_player_id',
  'qb_hit_1_player_id', 'pass_defense_1_player_id', 'interception_player_id', 'forced_fumble_player_1_player_id'];

/** One play: the columns named in `set` take those values, the rest are empty. */
const play = (set: Record<string, string>): string => COLS.map((c) => set[c] ?? {
  season: '2026', season_type: 'REG', game_id: 'g1', week: '1', epa: '0', qb_epa: '0', wp: '0.5', success: '0',
  posteam: 'AAA', defteam: 'BBB', posteam_type: 'home', location: 'Home', pass: '1', rush: '0', pass_attempt: '1', sack: '0', qb_hit: '0',
}[c] ?? '').join(',');

const bigOf = (rows: string[]) => {
  const ex = extractPbp(parseCsv([COLS.join(','), ...rows].join('\n')), 2026);
  return Object.fromEntries(ex.data.playerGames.filter((x) => x.big).map((x) => [x.p, x.big]));
};

describe('big plays', () => {
  it('a sack that is also a QB hit and a tackle for loss counts once; so does an interception that is also a pass defensed', () => {
    expect(bigOf([
      play({ sack: '1', sack_player_id: 'edge', qb_hit_1_player_id: 'edge', tackle_for_loss_1_player_id: 'edge' }),
      play({ interception_player_id: 'cb', pass_defense_1_player_id: 'cb' }),
    ])).toEqual({ edge: BIG_PLAYS.values.sack, cb: BIG_PLAYS.values.interception });
  });

  it('a defensive back gets the same credit for a tackle for loss or a sack as a lineman', () => {
    expect(bigOf([
      play({ pass: '0', rush: '1', pass_attempt: '0', tackle_for_loss_1_player_id: 'safety' }),
      play({ sack: '1', sack_player_id: 'corner' }),
      play({ sack: '1', sack_player_id: 'edge' }),
    ])).toEqual({ safety: BIG_PLAYS.values.tackleForLoss, corner: BIG_PLAYS.values.sack, edge: BIG_PLAYS.values.sack });
  });

  it('half sacks, forced fumbles, and the smaller plays (pass defensed, QB hit) add up across plays', () => {
    expect(bigOf([
      play({ sack: '1', half_sack_1_player_id: 'a', half_sack_2_player_id: 'b' }),
      play({ forced_fumble_player_1_player_id: 'a' }),
      play({ pass_defense_1_player_id: 'b' }),
      play({ qb_hit_1_player_id: 'b' }),
    ])).toEqual({ a: BIG_PLAYS.values.sack / 2 + BIG_PLAYS.values.forcedFumble, b: BIG_PLAYS.values.sack / 2 + BIG_PLAYS.values.passDefensed + BIG_PLAYS.values.qbHit });
  });

  it('every defensive group weighs big plays the same, and every group\'s weights add up to 1', () => {
    for (const g of ['EDGE', 'IDL', 'LB', 'CB', 'S'] as const) {
      expect(POSITIONS[g].weights.bigPlaysPer100).toBe(BIG_PLAYS.weight);
      expect(Object.values(POSITIONS[g].weights).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 9);
    }
  });
});

describe('big play values', () => {
  it('takeaways (interceptions, forced fumbles) are worth more than sacks and tackles for loss, which are worth more than breakups and hits', () => {
    const V = BIG_PLAYS.values;
    expect(Math.min(V.interception, V.forcedFumble)).toBeGreaterThan(Math.max(V.sack, V.tackleForLoss));
    expect(Math.min(V.sack, V.tackleForLoss)).toBeGreaterThan(Math.max(V.passDefensed, V.qbHit));
  });

  it('a strip sack counts as the forced fumble', () => {
    expect(bigOf([play({ sack: '1', sack_player_id: 'edge', forced_fumble_player_1_player_id: 'edge' })])).toEqual({ edge: BIG_PLAYS.values.forcedFumble });
  });
});
