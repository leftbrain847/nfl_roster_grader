/**
 * The move tracker: this season's trades and draft (from their nflverse files) and every in-season roster move,
 * read from week-to-week changes in the weekly rosters: signings, releases, reserve and practice-squad moves,
 * promotions, retirements, and players who changed teams. Newest first.
 */
import { MOVES, type MoveKind, type MovesConfig } from './config.ts';
import type { Game, ModelInputs, Move, RosterHistory } from './types.ts';

const shortDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export const positionGroup = (pos: string, cfg: MovesConfig = MOVES): string => cfg.positionGroup[pos.toUpperCase()] ?? cfg.other;

/** The date of each week's first game. */
function weekDates(games: Game[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const g of games) if (!out.has(g.week) || g.gameday < (out.get(g.week) as string)) out.set(g.week, g.gameday);
  return out;
}

/** Pure: the move (if any) between two consecutive roster entries of one player. */
export function rosterMove(
  prev: [number, string, string] | null,
  next: [number, string, string],
  cfg: MovesConfig = MOVES,
): { kind: MoveKind; from: string | null; detail: string } | null {
  const S = cfg.status;
  const [, team, status] = next;
  const onActive = S.active.includes(status);
  // "Signed by SEA" or "Signed to SEA's practice squad"
  const signedBy = (t: string): string => (status === S.practice ? `Signed to ${t}'s practice squad` : status === S.reserve ? `Signed by ${t} to reserve` : `Signed by ${t}`);
  if (!prev) {
    // first seen after week 1: he joined a roster mid-season
    if (status === S.released || status === S.retired) return null;
    return { kind: 'signed', from: null, detail: signedBy(team) };
  }
  const [, was, before] = prev;
  if (was !== team) {
    if (status === S.released) return { kind: 'released', from: was, detail: `Released by ${team}` };
    if (before === S.released) return { kind: 'signed', from: was, detail: `${signedBy(team)} (released by ${was})` };
    if (before === S.practice) return { kind: 'signed', from: was, detail: `${signedBy(team)}, off ${was}'s practice squad` };
    if (S.traded.includes(before)) return { kind: 'trade', from: was, detail: `Traded from ${was} to ${team}` };
    // a practice-squad spot is a signing; anything else straight from another roster is a trade or waiver claim
    if (status === S.practice) return { kind: 'signed', from: was, detail: `${signedBy(team)}, from ${was}` };
    return { kind: 'moved', from: was, detail: `Joined ${team} from ${was} (trade or waiver claim)` };
  }
  if (before === status || (S.active.includes(before) && onActive)) return null;   // game-day inactive and back: not a move
  if (status === S.released) return { kind: 'released', from: null, detail: before === S.practice ? `Released from ${team}'s practice squad` : `Released by ${team}` };
  if (status === S.retired) return { kind: 'retired', from: null, detail: 'Retired' };
  if (status === S.reserve) return { kind: 'reserve', from: null, detail: `Placed on reserve by ${team} (injured reserve or similar)` };
  if (before === S.released) return { kind: 'signed', from: null, detail: status === S.practice ? `Re-signed to ${team}'s practice squad` : `Re-signed by ${team}` };
  if (status === S.practice) return { kind: 'practice', from: null, detail: `Moved to ${team}'s practice squad` };
  if (onActive && before === S.reserve) return { kind: 'activated', from: null, detail: `Activated from reserve by ${team}` };
  if (onActive && before === S.practice) return { kind: 'promoted', from: null, detail: `Promoted from ${team}'s practice squad` };
  return null;
}

export function rosterMoves(history: RosterHistory[], games: Game[], cfg: MovesConfig = MOVES): Move[] {
  const dates = weekDates(games);
  const firstWeek = Math.min(...history.flatMap((x) => x.h.map((e) => e[0])), Infinity);
  const out: Move[] = [];
  for (const x of history) {
    x.h.forEach((e, i) => {
      const prev = i > 0 ? (x.h[i - 1] as [number, string, string]) : null;
      if (!prev && e[0] <= firstWeek) return;   // on a roster from the start
      const m = rosterMove(prev, e, cfg);
      if (!m) return;
      out.push({
        date: dates.get(e[0]) ?? '', when: `Week ${e[0]}`, kind: m.kind, id: x.p, name: x.n, pos: x.pos,
        group: positionGroup(x.pos, cfg), team: e[1], from: m.from, detail: m.detail,
      });
    });
  }
  return out;
}

export function buildMoves(inp: ModelInputs, cfg: MovesConfig = MOVES): Move[] {
  const history = inp.rosterHistory ?? [];
  const byPfr = new Map(history.filter((x) => x.f).map((x) => [x.f as string, x]));
  const out = rosterMoves(history, inp.games, cfg);

  // trades: one row per asset; a player row links to his page through the roster's PFR id
  const byTrade = new Map<string, NonNullable<ModelInputs['trades']>>();
  for (const t of inp.trades ?? []) byTrade.set(t.id, [...(byTrade.get(t.id) ?? []), t]);
  for (const rows of byTrade.values()) {
    for (const t of rows) {
      const p = t.pfr ? byPfr.get(t.pfr) : undefined;
      const back = rows.filter((o) => o.gave === t.received).map((o) => o.name || (o.pickRound ? `${o.pickSeason} round ${o.pickRound} pick` : 'a pick'));
      const name = t.name || (t.pickRound ? `${t.pickSeason} round ${t.pickRound} pick` : 'Draft pick');
      out.push({
        date: t.date, when: t.date ? shortDate(t.date) : 'Trade', kind: 'trade', id: p?.p ?? null, name,
        pos: p?.pos ?? '', group: t.name ? positionGroup(p?.pos ?? '', cfg) : cfg.other, team: t.received, from: t.gave,
        detail: `Traded from ${t.gave} to ${t.received}${back.length ? ` for ${back.join(', ')}` : ''}`,
        ...(t.name ? {} : { pick: true }),
      });
    }
  }

  for (const d of inp.draft ?? []) {
    const day = cfg.draftDay[d.season] ?? `${d.season}-04-30`;
    out.push({
      date: day, when: `${d.season} draft`, kind: 'draft', id: d.gsis, name: d.name, pos: d.pos, group: positionGroup(d.pos, cfg),
      team: d.team, from: null, detail: `Round ${d.round}, pick ${d.pick} overall`,
    });
  }
  // newest first; same day: trades, then the draft by pick, then names
  const order: Record<MoveKind, number> = { trade: 0, draft: 1, signed: 2, moved: 3, released: 4, reserve: 5, activated: 6, promoted: 7, practice: 8, retired: 9 };
  return out.sort((a, b) => b.date.localeCompare(a.date) || order[a.kind] - order[b.kind]
    || (a.kind === 'draft' ? Number(a.detail.match(/pick (\d+)/)?.[1]) - Number(b.detail.match(/pick (\d+)/)?.[1]) : 0)
    || a.name.localeCompare(b.name));
}
