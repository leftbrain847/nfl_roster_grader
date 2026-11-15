/** This week's games, each offense against the other's defense: unit grades, what the defense allows to each
 * position, the offense's red zone shares, its personnel and its injury designations. Built from the other This
 * week parts, so it adds no data of its own. */
import { FANTASY_ALLOWED, MATCHUP, type MatchupConfig } from './config.ts';
import { opportunities, share } from './redZone.ts';
import type { FantasyAllowed, Game, Matchup, MatchupSide, Personnel, PracticeReport, RedZoneUsage, TeamResult, UnitClash, UnitResult } from './types.ts';

export function edgeWord(edge: number, cfg: MatchupConfig = MATCHUP): string {
  for (const [min, word] of cfg.edgeWords) if (edge >= min) return word;
  return cfg.fallbackWord;
}

export function clash(off: Pick<UnitResult, 'grade' | 'rank'>, def: Pick<UnitResult, 'grade' | 'rank'>, cfg: MatchupConfig = MATCHUP): UnitClash {
  const edge = off.grade - def.grade;
  return { offGrade: off.grade, offRank: off.rank, defGrade: def.grade, defRank: def.rank, edge, word: edgeWord(edge, cfg) };
}

interface Parts {
  teams: TeamResult[];
  fantasyAllowed?: FantasyAllowed;
  redZone?: RedZoneUsage;
  personnel?: Personnel;
  practice?: PracticeReport;
}

function side(team: string, opp: string, p: Parts, byTeam: Map<string, TeamResult>, cfg: MatchupConfig): MatchupSide | null {
  const o = byTeam.get(team);
  const d = byTeam.get(opp);
  if (!o || !d) return null;
  const fa: MatchupSide['fantasyAllowed'] = {};
  for (const pos of FANTASY_ALLOWED.positions) {
    const w = p.fantasyAllowed?.teams[opp]?.[pos]?.season;
    if (w) fa[pos] = { adjusted: w.adjusted, rank: w.adjustedRank };
  }
  const rz = p.redZone?.teams[team];
  const zones = p.redZone?.zones.length ?? 0;
  const redZone = rz
    ? rz.players.slice(0, cfg.redZonePlayers).map((x) => ({
      id: x.id, name: x.name, pos: x.pos,
      shares: Array.from({ length: zones }, (_, z) => Math.round(1000 * share(opportunities(x.season, z), opportunities(rz.season, z))) / 1000),
    }))
    : [];
  const slot = p.personnel?.slot?.teams[team];
  const est = p.personnel?.estimate[team]?.season;
  const personnel = slot
    ? { p11: slot.p11, p12: slot.p12, heavy: slot.heavy, estimated: false }
    : est ? { p11: est.p11, p12: est.p12, heavy: est.heavy, estimated: true } : null;
  const status = (p.practice?.teams[team] ?? []).filter((r) => r.game !== null && cfg.statuses.includes(r.game));
  return {
    team, opp,
    pass: clash(o.units.passOffense, d.units.passDefense, cfg),
    rush: clash(o.units.rushOffense, d.units.rushDefense, cfg),
    fantasyAllowed: fa, redZone, personnel, status,
  };
}

export function buildMatchups(games: Game[], week: number, parts: Parts, cfg: MatchupConfig = MATCHUP): Matchup[] {
  const byTeam = new Map(parts.teams.map((t) => [t.team, t]));
  const out: Matchup[] = [];
  for (const g of games.filter((x) => x.week === week).sort((a, b) => a.gameday.localeCompare(b.gameday) || a.id.localeCompare(b.id))) {
    const away = side(g.away, g.home, parts, byTeam, cfg);
    const home = side(g.home, g.away, parts, byTeam, cfg);
    if (!away || !home) continue;
    out.push({ id: g.id, week: g.week, gameday: g.gameday, home: g.home, away: g.away, homeScore: g.homeScore, awayScore: g.awayScore, sides: [away, home] });
  }
  return out;
}

