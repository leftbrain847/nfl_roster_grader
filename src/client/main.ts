/**
 * Roster Grader page. Reads the model output baked in at build time (no network). Tabs: This week (fantasy points
 * allowed by position, red zone usage, personnel, practice status, and every game's matchup), Value (production and fantasy points per cap dollar), Production (position rankings, a page per player) and Front office (cap value by
 * team, and the team grade board with its buy / sell calls and team sheets). Text goes in as text, never HTML.
 */
import data from '@roster-data';
import {
  ADJUST, GAME_LOG, MOVES, LINE, LINE_KEYS, LINE_TARGETS, PLAYOFF_SIM, TRADE_COST, POSITION_GROUPS, POSITIONS, STATS, UNIT_KEYS, UNITS, VALUE, VERDICT,
  type LineKey, type MoveKind, type PositionGroup, type RankingMode, type UnitKey, type Verdict,
  PICK_VALUE, TEAM_SCHEDULE, FANTASY_ALLOWED, RED_ZONE, THIS_WEEK, UNIT_METRICS, DEPTH, PERSONNEL, INJURY, MATCHUP, COMPARE, type FantasyPos,
} from '../model/config.ts';
import { buildComparison, comparable } from '../model/compare.ts';
import { ordinal } from '../model/stats.ts';
import { logTotals } from '../model/profiles.ts';
import { share } from '../model/redZone.ts';
import type { MatchupPlayer, TeamSchedule, PlayerStatus, MatchupSide, UnitClash, PracticeRow, PersonnelExact, DepthChartView, DepthEntry, UnitResult, ContractDetail, FrontOffice, LineTarget, Lineup, MoveGrade, TradeCard, TradeSide, PlayerContract, PlayerProfile, PlayerResult, PlayerValue, TeamResult } from '../model/types.ts';
import { el, render } from './ui';

/** Moves listed at first; "Show more" adds this many again. */
const MOVES_PAGE = 60;

type SortKey = 'team' | 'verdict' | 'odds' | UnitKey;
type View = 'week' | 'value' | 'players' | 'office' | 'moves';

const state = {
  /** Opens on This week (the current week's matchups) when the data has it. */
  view: (data.thisWeek ? 'week' : 'value') as View,
  sort: 'odds' as SortKey,
  desc: true,
  filter: 'all' as Verdict | 'all',
  group: 'QB' as PositionGroup | 'OL',
  /** Production tab: one team's players, or every team's. */
  prodTeam: 'all',
  mode: 'production' as RankingMode,
  team: null as string | null,
  /** The open player page, on top of the team sheet if both are open. */
  player: null as string | null,
  query: '',
  valueView: 'production' as 'production' | 'fantasy',
  valuePos: 'All',
  valueOrder: 'best' as 'best' | 'worst',
  rosterBudget: VALUE.roster.budgetsMillions[0] ?? 0,
  officeView: 'cap' as 'cap' | 'board',
  moveTeam: 'all',
  moveGroup: 'all',
  moveKind: 'all',
  moveGraded: 'all',
  moveShown: MOVES_PAGE,
  fantasyPos: 'All',
  budget: VALUE.fantasy.budgetsMillions[0] ?? 0,
  lineupScope: 'season' as Lineup['scope'],
  office: null as string | null,
  open: new Set<string>(),
  faPos: 'WR' as FantasyPos,
  faWindow: 'season' as 'season' | 'recent',
  faAdjusted: true,
  weekView: 'matchups' as 'matchups' | 'fantasy' | 'redzone' | 'personnel' | 'practice',
  /** Matchups: game cards, or players against the unit they face (filtered by position and game, sorted). */
  mView: 'games' as 'games' | 'players',
  mGroup: 'QB' as PositionGroup,
  mGame: 'all',
  mSort: 'score' as 'score' | 'edge',
  prTeam: 'all',
  pTeam: '',
  rzTeam: '',
  rzWeek: 'season',
  metric: 'epa' as keyof typeof UNIT_METRICS,
  /** Players picked to compare (ids), and whether the side-by-side sheet is open. */
  compare: [] as string[],
  comparing: false,
  compareQuery: '',
};

const players = new Map(data.players.map((p) => [p.id, p]));
const teams = new Map(data.teams.map((t) => [t.team, t]));
const moves = data.moves ?? [];
const profiles = new Map((data.profiles ?? []).map((p) => [p.id, p]));
const depth = new Map((data.depthCharts ?? []).map((d) => [d.team, d]));
const schedules = new Map((data.schedules ?? []).map((x) => [x.team, x]));
// a data file from before line grades existed still opens its team sheets
for (const t of data.teams) {
  t.line ??= { passPro: null, runBlock: null };
  t.lineTargets ??= [];
}
// a data file from before the Value tab (or before part of it) still loads
data.value = Object.assign({ players: [], rosters: [], fantasy: [], lineups: [], frontOffices: [] }, data.value as Partial<typeof data.value> | undefined);
const VERDICT_ORDER: Record<Verdict, number> = { buy: 0, 'stand pat': 1, sell: 2 };
const pct = (x: number): string => {
  const p = Math.round(100 * x);
  return p === 0 && x > 0 ? '<1%' : p === 100 && x < 1 ? '>99%' : `${p}%`;
};
const band = (g: number): string => (g >= 75 ? 'g5' : g >= 58 ? 'g4' : g >= 42 ? 'g3' : g >= 25 ? 'g2' : 'g1');
const signed = (x: number, d = 2): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const fmtDate = (iso: string | null): string => {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const score = (p: PlayerResult): number => p.scores[state.mode] ?? p.scores.production;

function verdictPill(v: Verdict): HTMLElement {
  return el('span', { className: `pill v-${v.replace(' ', '-')}`, text: VERDICT.labels[v] });
}

function setHash(h: string): void {
  try {
    history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  } catch {
    /* sandboxed frames may refuse; the page works without it */
  }
}

// ------------------------------------------------------------------ league table

const hasSeries = data.teams.some((t) => UNIT_KEYS.some((k) => t.units[k].series));
/** A unit on the chosen measure (EPA/play, or series success when the data has it). */
const unitOf = (t: TeamResult, k: UnitKey): Omit<UnitResult, 'series'> => (state.metric === 'series' && t.units[k].series) || t.units[k];
const metricValue = (x: number, signedEpa = true): string => {
  const m = UNIT_METRICS[state.metric];
  return m.percent ? `${(100 * x).toFixed(m.decimals)}%` : signedEpa ? signed(x, m.decimals) : x.toFixed(m.decimals);
};

function metricChips(): HTMLElement | null {
  if (!hasSeries) return null;
  return el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Grade units on' } }, (Object.keys(UNIT_METRICS) as (keyof typeof UNIT_METRICS)[]).map((m) =>
    chip(UNIT_METRICS[m].label, state.metric === m, () => { state.metric = m; draw(); }, `metric-${m}`)));
}

function sortedTeams(): TeamResult[] {
  const list = data.teams.filter((t) => state.filter === 'all' || t.verdict === state.filter);
  const val = (t: TeamResult): number | string => {
    switch (state.sort) {
      case 'team': return t.team;
      case 'verdict': return VERDICT_ORDER[t.verdict] * 10 - t.playoffOdds;
      case 'odds': return t.playoffOdds;
      default: return unitOf(t, state.sort).grade;
    }
  };
  return list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return (state.desc ? -c : c) || a.team.localeCompare(b.team);
  });
}

function header(key: SortKey, label: string, cls = ''): HTMLElement {
  const active = state.sort === key;
  return el('th', { className: `${cls}${active ? ' sorted' : ''}`, attrs: { scope: 'col', 'aria-sort': active ? (state.desc ? 'descending' : 'ascending') : 'none' } }, [
    el('button', {
      className: 'th-btn',
      text: `${label}${active ? (state.desc ? ' ↓' : ' ↑') : ''}`,
      onClick: () => {
        if (state.sort === key) state.desc = !state.desc;
        else {
          state.sort = key;
          state.desc = key !== 'team' && key !== 'verdict';
        }
        draw();
      },
    }),
  ]);
}

function leagueView(): HTMLElement {
  const filters = (['all', 'buy', 'stand pat', 'sell'] as const).map((f) => {
    const n = f === 'all' ? data.teams.length : data.teams.filter((t) => t.verdict === f).length;
    return el('button', {
      className: `chip${state.filter === f ? ' on' : ''}`,
      text: `${f === 'all' ? 'All' : VERDICT.labels[f]} ${n}`,
      attrs: { 'aria-pressed': String(state.filter === f) },
      onClick: () => {
        state.filter = f;
        draw();
      },
    });
  });
  const rows = sortedTeams().map((t) =>
    el('tr', { className: 'team-row', attrs: { 'data-verdict': t.verdict, 'data-team': t.team, tabindex: '0' }, onClick: () => openTeam(t.team) }, [
      el('th', { className: 'c-team', attrs: { scope: 'row' } }, [el('span', { className: 'abbr', text: t.team }), el('span', { className: 'rec', text: t.record })]),
      el('td', { className: 'c-verdict' }, [verdictPill(t.verdict)]),
      el('td', { className: 'c-odds num', text: pct(t.playoffOdds) }),
      ...UNIT_KEYS.map((k) => el('td', { className: 'c-grade num' }, [el('span', { className: `grade ${band(unitOf(t, k).grade)}`, text: String(unitOf(t, k).grade) })])),
    ]),
  );
  for (const r of rows) r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTeam(r.dataset.team ?? ''); });
  return el('section', { className: 'league' }, [
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by verdict' } }, filters),
    metricChips(),
    el('div', { className: 'table-wrap' }, [
      el('table', { className: 'board' }, [
        el('thead', {}, [el('tr', {}, [
          header('team', 'Team', 'c-team'), header('verdict', 'Call', 'c-verdict'), header('odds', 'Odds', 'c-odds'),
          ...UNIT_KEYS.map((k) => header(k, UNITS[k].short, 'c-grade')),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
    el('p', { className: 'fine', text: `Grades are 0-100 (50 = league average) from opponent-adjusted ${state.metric === 'series' ? 'series success (share of plays in series that earned a first down or touchdown); the calls still come from EPA' : 'EPA per play'}. Call = buy, sell or stand pat at the trade deadline. Odds: ${PLAYOFF_SIM.label.toLowerCase()}. Tap a team for its sheet and trade targets.` }),
  ]);
}

// ------------------------------------------------------------------ team sheet

function unitBar(t: TeamResult, k: UnitKey): HTMLElement {
  const u = unitOf(t, k);
  const m = UNIT_METRICS[state.metric];
  const side = UNITS[k].side === 'offense' ? m.offense : m.defense;
  const avg = data.teams.reduce((sum, x) => sum + unitOf(x, k).adjusted, 0) / Math.max(1, data.teams.length);
  return el('div', { className: `unit${k === t.weakest ? ' weakest' : ''}` }, [
    el('div', { className: 'unit-head' }, [
      el('span', { className: 'unit-name', text: UNITS[k].long }),
      el('span', { className: 'unit-rank num', text: `${ordinal(u.rank)} · ${u.grade}` }),
    ]),
    el('div', { className: 'bar', attrs: { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(u.grade), 'aria-label': `${UNITS[k].long} grade` } }, [
      el('span', { className: `fill ${band(u.grade)}`, vars: { '--w': `${Math.max(2, u.grade)}%` } }),
      el('span', { className: 'mid' }),
    ]),
    el('div', { className: 'unit-sub num', text: `${metricValue(u.adjusted)} ${side} adjusted (avg ${metricValue(avg)}) · ${metricValue(u.raw)} raw · ${u.plays} plays` }),
  ]);
}

function statLine(p: PlayerResult): HTMLElement {
  return el('ul', { className: 'stats' }, p.stats.map((s) => {
    const d = STATS[s.key];
    return el('li', {}, [
      el('span', { className: 'st-label', text: d.label }),
      el('span', { className: 'st-val num', text: `${s.value.toFixed(d.decimals)}${d.suffix ?? ''}` }),
      el('span', { className: 'st-pct num', text: `${Math.round(s.pct)}` }),
      el('span', { className: 'st-bar' }, [el('span', { className: `fill ${band(s.pct)}`, vars: { '--w': `${Math.max(2, s.pct)}%` } })]),
    ]);
  }));
}

function contractText(c: PlayerContract | null): string {
  if (!c) return 'No contract on file';
  const terms = `$${c.apyMillions.toFixed(1)}M/yr · ${(100 * c.capPct).toFixed(1)}% of cap at signing · thru ${c.lastYear}`;
  return c.baseSalaryLeftMillions == null ? terms : `${terms} · base salary left ≈ $${c.baseSalaryLeftMillions.toFixed(2)}M`;
}

function playerCard(p: PlayerResult, opts: { showTeam: boolean; rank?: number }): HTMLElement {
  const open = state.open.has(p.id);
  const contract = contractText(p.contract);
  const s = score(p);
  return el('li', { className: `player${open ? ' open' : ''}` }, [
    el('button', {
      className: 'player-head target',
      attrs: { 'aria-expanded': String(open) },
      onClick: () => {
        if (open) state.open.delete(p.id);
        else state.open.add(p.id);
        draw();
      },
    }, [
      opts.rank !== undefined ? el('span', { className: 'p-rank num', text: String(opts.rank) }) : null,
      el('span', { className: 'p-main' }, [
        el('span', { className: 'p-name', text: p.name }),
        el('span', { className: 'p-meta', text: `${opts.showTeam ? `${p.team} · ` : ''}${p.group} · ${p.volume} · #${p.rank} of ${p.qualifiedAtPosition}` }),
      ]),
      el('span', { className: `p-score num ${band(s)}`, text: String(Math.round(s)) }),
    ]),
    open ? el('div', { className: 'player-body' }, [
      statLine(p),
      el('p', { className: 'p-contract', text: contract }),
      profiles.has(p.id) ? el('button', { className: 'more', text: 'Game log and contract', attrs: { 'data-player': p.id }, onClick: () => openPlayer(p.id, `.more[data-player="${p.id}"]`) }) : null,
      el('p', { className: 'fine', text: 'Each stat: value, then percentile among qualified players at the position. Score = percentile of the weighted stat percentiles.' }),
    ]) : null,
  ]);
}

function lineBar(t: TeamResult, k: LineKey): HTMLElement {
  const r = t.line[k];
  const d = LINE[k];
  return el('div', { className: 'unit' }, [
    el('div', { className: 'unit-head' }, [
      el('span', { className: 'unit-name', text: d.label }),
      el('span', { className: 'unit-rank num', text: r ? `${ordinal(r.rank)} · ${r.grade}` : 'no data' }),
    ]),
    el('div', { className: 'bar', attrs: { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(r?.grade ?? 0), 'aria-label': `${d.label} grade` } }, [
      el('span', { className: `fill ${band(r?.grade ?? 0)}`, vars: { '--w': `${Math.max(2, r?.grade ?? 0)}%` } }),
      el('span', { className: 'mid' }),
    ]),
    el('div', { className: 'unit-sub num', text: r ? `${r.value.toFixed(d.decimals)}${d.suffix ?? ''} ${d.stat}` : 'PFR data missing' }),
  ]);
}

function lineCard(x: LineTarget): HTMLElement {
  return el('li', { className: 'player' }, [
    el('div', { className: 'player-head' }, [
      el('span', { className: 'p-main' }, [
        el('span', { className: 'p-name', text: x.name }),
        el('span', { className: 'p-meta', text: `${x.team} · ${x.depth} · ${Math.round(100 * x.snapShare)}% of snaps · ${contractText(x.contract)}` }),
      ]),
      el('span', { className: `p-score num ${band(x.lineGrade)}`, text: String(Math.round(x.lineGrade)) }),
    ]),
  ]);
}

function depthEntry(e: DepthEntry, key: string): HTMLElement {
  const bits = [
    el('span', { className: 'd-name', text: e.name }),
    e.score !== null ? el('span', { className: `d-score num ${band(e.score)}`, text: String(e.score), attrs: { title: `Production score (${e.group})` } }) : null,
    e.designation ? el('span', { className: 'd-tag d-inj', text: e.designation }) : null,
    e.change ? el('span', { className: `d-tag d-${e.change}`, text: e.change === 'new' ? DEPTH.labels.new : `${e.change === 'up' ? DEPTH.labels.up : DEPTH.labels.down} from ${e.prevRank}` }) : null,
  ];
  return el('li', { className: 'd-entry' }, [
    profiles.has(e.id) ? el('button', { className: 'd-link', attrs: { 'data-depth': key }, onClick: () => openPlayer(e.id, `[data-depth="${key}"]`) }, bits) : el('span', { className: 'd-link' }, bits),
  ]);
}

function depthSection(d: DepthChartView | undefined): HTMLElement {
  if (!d) return el('section', { className: 'shop' }, [el('h3', { text: 'Depth chart' }), el('p', { className: 'fine', text: 'No depth chart on file.' })]);
  const open = state.open.has(`depth-${d.team}`);
  return el('section', { className: 'shop depth' }, [
    el('h3', { text: 'Depth chart' }),
    el('p', { className: 'fine', text: `As of ${fmtDate(d.asOf)} (ESPN via nflverse)${d.comparedWith ? ` · ${d.changes} ${d.changes === 1 ? 'change' : 'changes'} since ${fmtDate(d.comparedWith)}` : ' · no earlier snapshot to compare'}. Number = production score (ranked players). Tags: this week's injury designation, and moves since the earlier chart.` }),
    ...d.groups.map((g) => el('div', { className: 'd-group' }, [
      el('h4', { text: `${g.side === 'offense' ? 'Offense' : 'Defense'} (${g.name})` }),
      el('ul', { className: 'd-slots' }, g.slots.map((sl, i) => el('li', { className: 'd-slot' }, [
        el('span', { className: 'd-pos', text: sl.pos }),
        el('ol', { className: 'd-list' }, [
          ...(open ? sl.players : sl.players.slice(0, DEPTH.shownPerSlot)).map((e, k) => depthEntry(e, `${d.team}-${g.name}-${i}-${k}`)),
          ...sl.gone.map((x) => el('li', { className: 'd-entry d-gone', text: `${x.name} · ${DEPTH.labels.gone} (was ${x.prevRank})` })),
        ]),
      ]))),
    ])),
    d.groups.some((g) => g.slots.some((sl) => sl.players.length > DEPTH.shownPerSlot))
      ? el('button', { className: 'more', text: open ? 'Show fewer' : 'Show every player', attrs: { 'aria-expanded': String(open) }, onClick: () => { if (open) state.open.delete(`depth-${d.team}`); else state.open.add(`depth-${d.team}`); draw(); } })
      : null,
  ]);
}

/** Every game on the team's schedule with its core stats; games not played yet show the date. */
function scheduleSection(sc: TeamSchedule | undefined): HTMLElement | null {
  if (!sc?.games.length) return null;
  const S = TEAM_SCHEDULE.stats;
  const epaText = (x: number | null): string => (x === null ? '-' : signed(x, TEAM_SCHEDULE.epaDecimals));
  const head: [string, string][] = [
    ['Wk', 'Week'], ['Opp', 'Opponent (@ = away)'], ['Result', 'Result, or game day'],
    ['EPA O', 'Offense EPA per play (garbage time removed)'], ['EPA D', 'EPA per play allowed by the defense (lower is better)'],
    ...S.map((c): [string, string] => [c.label, c.title]),
  ];
  const statCells = (v: (number | null)[] | null, extra = 0): HTMLElement[] => S.map((c, i) => {
    const x = v?.[i];
    return el('td', { className: 'num', text: x === null || x === undefined ? '-' : x.toFixed(c.decimals + extra) });
  });
  const played = sc.games.filter((g) => g.result).length;
  return el('section', { className: 'shop' }, [
    el('h3', { text: 'Schedule' }),
    el('div', { className: 'table-wrap' }, [
      el('table', { className: 'log' }, [
        el('thead', {}, [el('tr', {}, head.map(([h, title], i) => el('th', { text: h, className: i < 2 ? 'left' : '', attrs: { scope: 'col', title } })))]),
        el('tbody', {}, sc.games.map((g) => el('tr', { className: g.result ? '' : 'upcoming' }, [
          el('th', { className: 'num left', attrs: { scope: 'row' }, text: String(g.wk) }),
          el('td', { className: 'left' }, [
            teams.has(g.opp) ? el('button', { className: 'link', text: `${g.home ? '' : '@'}${g.opp}`, attrs: { 'data-sched': `${sc.team}-${g.wk}` }, onClick: () => openTeam(g.opp) }) : el('span', { text: `${g.home ? '' : '@'}${g.opp}` }),
          ]),
          el('td', { className: 'num', text: g.result || fmtDate(g.gameday) }),
          el('td', { className: 'num', text: epaText(g.offEpa) }),
          el('td', { className: 'num', text: epaText(g.defEpa) }),
          ...statCells(g.v),
        ]))),
        played ? el('tfoot', {}, [el('tr', {}, [
          el('th', { className: 'left', attrs: { scope: 'row' }, text: 'Avg' }),
          el('td', { className: 'left', attrs: { colspan: '2' }, text: `${played} played` }),
          el('td', { className: 'num', text: epaText(sc.season.offEpa) }),
          el('td', { className: 'num', text: epaText(sc.season.defEpa) }),
          ...statCells(sc.season.v, 1),
        ])]) : null,
      ]),
    ]),
    el('p', { className: 'fine', text: `EPA O / EPA D = expected points added per play on offense, and allowed on defense, with garbage time removed (the plays behind the unit grades; not opponent-adjusted). Avg = per game; EPA over all plays. ${S.map((c) => `${c.label} = ${c.title}`).join(' · ')}. Yards and sacks from the nflverse weekly player stats, summed by team. Tap an opponent for its sheet.` }),
  ]);
}

function teamSheet(t: TeamResult): HTMLElement {
  const list = (ids: string[]) => el('ol', { className: 'players' }, ids.map((id) => players.get(id)).filter((p): p is PlayerResult => !!p).map((p) => playerCard(p, { showTeam: true })));
  let shop: HTMLElement;
  if (t.verdict === 'buy' && t.need?.line) {
    const d = LINE[t.need.line];
    shop = el('section', { className: 'shop' }, [
      el('h3', { text: `Where to buy: ${t.need.label}` }),
      el('p', { className: 'fine', text: `Starting linemen from the selling teams with the best ${d.label.toLowerCase()} (${d.stat}), up to ${LINE_TARGETS.perSeller} per team. The score is their line's grade, not an individual one: open data has no per-lineman stat.` }),
      t.lineTargets.length ? el('ol', { className: 'players' }, t.lineTargets.map(lineCard)) : el('p', { className: 'fine', text: 'No starters found on selling teams.' }),
    ]);
  } else if (t.verdict === 'buy' && t.need) {
    shop = el('section', { className: 'shop' }, [
      el('h3', { text: `Where to buy: ${t.need.label}` }),
      el('p', { className: 'fine', text: `Top producers at ${t.need.positions.join(' / ')} on teams that should sell.` }),
      t.buyTargets.length ? list(t.buyTargets) : el('p', { className: 'fine', text: 'No qualified seller players at these positions yet.' }),
    ]);
  } else if (t.verdict === 'sell') {
    shop = el('section', { className: 'shop' }, [
      el('h3', { text: 'Trade chips' }),
      el('p', { className: 'fine', text: 'Their best producers on the active roster.' }),
      t.chips.length ? list(t.chips) : el('p', { className: 'fine', text: 'No qualified players.' }),
    ]);
  } else {
    shop = el('section', { className: 'shop' }, [el('p', { className: 'fine', text: 'Standing pat: no shopping list.' })]);
  }
  return el('div', { className: 'sheet-backdrop', onClick: (e) => { if (e.target === e.currentTarget) closeTeam(); } }, [
    el('article', { className: 'sheet', attrs: { role: 'dialog', 'aria-modal': String(!state.player), ...(state.player ? { 'aria-hidden': 'true' } : {}), 'aria-label': `${t.name} roster grade` } }, [
      el('header', { className: 'sheet-head' }, [
        el('div', {}, [
          el('p', { className: 'eyebrow', text: `${t.division} · ${t.record}` }),
          el('h2', { text: `${t.team} ${t.name}` }),
        ]),
        el('button', { className: 'close', text: 'Close', onClick: closeTeam }),
      ]),
      el('div', { className: 'verdict-box' }, [
        verdictPill(t.verdict),
        el('p', { className: 'reason', text: t.reason }),
        el('dl', { className: 'facts' }, [
          el('div', {}, [el('dt', { text: PLAYOFF_SIM.label }), el('dd', { className: 'num', text: pct(t.playoffOdds) })]),
          el('div', {}, [el('dt', { text: 'Schedule left' }), el('dd', { className: 'num', text: `${ordinal(t.scheduleLeftRank)} hardest · ${t.gamesLeft} games` })]),
          el('div', {}, [el('dt', { text: 'Strength' }), el('dd', { className: 'num', text: `${signed(t.strength, 1)} pts/game` })]),
        ]),
      ]),
      scheduleSection(schedules.get(t.team)),
      el('section', { className: 'units' }, [metricChips(), ...UNIT_KEYS.map((k) => unitBar(t, k))]),
      el('section', { className: 'units' }, [
        el('h3', { text: 'Offensive line' }),
        el('p', { className: 'fine', text: 'Team level, not opponent-adjusted. Also reflects the QB, backs and scheme.' }),
        ...LINE_KEYS.map((k) => lineBar(t, k)),
      ]),
      shop,
      depthSection(depth.get(t.team)),
    ]),
  ]);
}

function openTeam(team: string): void {
  if (!teams.has(team)) return;
  state.team = team;
  setHash(`team-${team.toLowerCase()}`);
  draw();
  document.querySelector<HTMLElement>('.sheet .close')?.focus();
}

function closeTeam(): void {
  const last = state.team;
  state.team = null;
  setHash('');
  draw();
  if (last) document.querySelector<HTMLElement>(`tr[data-team="${last}"]`)?.focus();
}

// ------------------------------------------------------------------ player page

const money = (m: number | null, d = 1): string => (m === null ? '-' : `$${m.toFixed(d)}M`);

function gameLog(p: PlayerProfile): HTMLElement {
  const cols = GAME_LOG.columns[p.kind];
  const head = ['Wk', 'Opp', 'Result', 'Snap%', ...cols.map((c) => c.label)];
  const titles = ['Week', 'Opponent (@ = away)', 'Result', 'Share of the team\'s snaps on his side of the ball', ...cols.map((c) => c.title)];
  const cells = (v: number[]): HTMLElement[] => cols.map((c, i) => el('td', { className: 'num', text: (v[i] ?? 0).toFixed(c.decimals) }));
  const traded = new Set(p.log.map((r) => r.team)).size > 1;
  const rows = p.log.map((r) => el('tr', {}, [
    el('th', { className: 'num left', attrs: { scope: 'row' }, text: String(r.wk) }),
    el('td', { className: 'left', text: `${traded ? `${r.team} ` : ''}${r.home ? '' : '@'}${r.opp}` }),
    el('td', { className: 'num', text: r.result || '-' }),
    el('td', { className: 'num', text: r.snapPct === null ? '-' : String(r.snapPct) }),
    ...cells(r.v),
  ]));
  return el('div', { className: 'table-wrap' }, [
    el('table', { className: 'log' }, [
      el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { text: h, className: i < 2 ? 'left' : '', attrs: { scope: 'col', title: titles[i] ?? h } })))]),
      el('tbody', {}, rows),
      el('tfoot', {}, [el('tr', {}, [
        // only the first column is pinned (sticky): a pinned cell spanning several columns would cover the totals
        el('th', { className: 'left', attrs: { scope: 'row' }, text: 'Total' }),
        el('td', { className: 'left', attrs: { colspan: '3' }, text: `${p.log.length} games` }),
        ...cells(logTotals(p.log, cols.map((c) => c.decimals))),
      ])]),
    ]),
  ]);
}

function contractBox(c: ContractDetail | null): HTMLElement {
  if (!c) return el('p', { className: 'fine', text: 'No contract on file.' });
  const terms = [
    c.years !== null && c.valueMillions !== null ? `${c.years} ${c.years === 1 ? 'year' : 'years'}, ${money(c.valueMillions)}` : null,
    `${money(c.apyMillions)} per year`,
    c.guaranteedMillions !== null ? `${money(c.guaranteedMillions)} guaranteed` : null,
    c.yearSigned !== null ? `signed ${c.yearSigned}` : null,
    `through ${c.lastYear}`,
  ].filter((x): x is string => !!x).join(' · ');
  return el('div', { className: 'contract' }, [
    el('p', { className: 'terms', text: terms }),
    c.seasons.length ? el('div', { className: 'table-wrap' }, [
      el('table', { className: 'log' }, [
        el('thead', {}, [el('tr', {}, ['Year', 'Base salary', 'Cap hit', 'Cash paid'].map((h, i) => el('th', { text: h, className: i ? '' : 'left', attrs: { scope: 'col' } })))]),
        el('tbody', {}, c.seasons.map((s) => el('tr', {}, [
          el('th', { className: 'num left', attrs: { scope: 'row' }, text: String(s.year) }),
          el('td', { className: 'num', text: money(s.base, 2) }),
          el('td', { className: 'num', text: money(s.cap, 2) }),
          el('td', { className: 'num', text: money(s.cash, 2) }),
        ]))),
      ]),
    ]) : null,
    c.baseSalaryLeftMillions !== null ? el('p', { className: 'fine', text: `Base salary left this season ≈ ${money(c.baseSalaryLeftMillions, 2)}: what a team trading for him now takes on.` }) : null,
    el('p', { className: 'fine', text: 'Cap hit = what he counts against his team\'s cap that year. Contract figures from OverTheCap via nflverse.' }),
  ]);
}

/** His latest practice status and game designation (and a reserve list), at the top of his page. */
function statusBox(st: PlayerStatus | undefined): HTMLElement {
  const r = st?.report ?? null;
  const current = !!r && r.wk === st?.reportWeek;
  const tags = [
    st?.reserve ? el('span', { className: 'd-tag d-inj', text: st.reserve }) : null,
    current && r.practice ? el('span', { className: `d-tag ${tagClass(r.practice)}`, text: `${r.practice} practice` }) : null,
    current && r.game ? el('span', { className: `d-tag ${tagClass(r.game)}`, text: r.game }) : null,
  ].filter((x): x is HTMLElement => !!x);
  const lineOf = (x: NonNullable<PlayerStatus['report']>): string => [x.practice ? `${x.practice} practice` : null, x.game, x.injury || null].filter(Boolean).join(' · ');
  const fileWeek = st?.reportWeek ?? data.thisWeek?.practice?.latestWeek ?? 0;
  const text = !fileWeek
    ? 'No injury reports on file yet.'
    : !r
      ? `Not on any injury report this season (the file has through week ${fileWeek}).`
      : current
        ? `Week ${r.wk} report: ${lineOf(r) || 'listed, no detail'}.`
        : `Not on the week ${fileWeek} injury report (last listed week ${r.wk}: ${lineOf(r) || 'no detail'}).`;
  return el('section', { className: 'shop' }, [
    el('h3', { text: 'Practice status' }),
    tags.length ? el('p', { className: 'pr-tags' }, tags) : null,
    el('p', { className: 'p-contract', text }),
    el('p', { className: 'fine', text: `${INJURY.practiceNote} From the NFL's injury reports via nflverse.` }),
  ]);
}

function playerSheet(p: PlayerProfile): HTMLElement {
  const ranked = players.get(p.id);
  return el('div', { className: 'sheet-backdrop', onClick: (e) => { if (e.target === e.currentTarget) closePlayer(); } }, [
    el('article', { className: 'sheet player-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${p.name} game log and contract` } }, [
      el('header', { className: 'sheet-head' }, [
        el('div', {}, [
          el('p', { className: 'eyebrow', text: `${p.team} ${teams.get(p.team)?.name ?? ''} · ${p.pos}` }),
          el('h2', { text: p.name }),
        ]),
        el('button', { className: 'close', text: 'Close', onClick: closePlayer }),
      ]),
      compareButton(p.id),
      statusBox(p.status),
      ranked ? el('section', { className: 'shop' }, [
        el('h3', { text: `#${ranked.rank} of ${ranked.qualifiedAtPosition} ${POSITIONS[ranked.group].label}s` }),
        statLine(ranked),
        el('p', { className: 'fine', text: 'Each stat: value, then percentile among qualified players at the position.' }),
      ]) : null,
      el('section', { className: 'shop' }, [
        el('h3', { text: 'Game log' }),
        gameLog(p),
        el('p', { className: 'fine', text: `Snap% = share of the team's ${GAME_LOG.snapSide[p.kind] === 'off' ? 'offense' : 'defense'} snaps. ${GAME_LOG.columns[p.kind].map((c) => `${c.label} = ${c.title}`).join(' · ')}.` }),
      ]),
      el('section', { className: 'shop' }, [el('h3', { text: 'Contract' }), contractBox(p.contract)]),
    ]),
  ]);
}

// ------------------------------------------------------------------ compare players

const compareHash = (): string => (state.compare.length ? `compare-${state.compare.join(',')}` : '');

function toggleCompare(id: string): void {
  if (state.compare.includes(id)) state.compare = state.compare.filter((x) => x !== id);
  else if (state.compare.length < COMPARE.max && comparable(data, id)) state.compare = [...state.compare, id];
  if (!state.compare.length) state.comparing = false;
  if (state.comparing) setHash(compareHash());
  draw();
}

/** On a player page: add him to (or take him out of) the comparison. */
function compareButton(id: string): HTMLElement {
  const inIt = state.compare.includes(id);
  const full = !inIt && state.compare.length >= COMPARE.max;
  const b = el('button', {
    className: 'more',
    text: inIt ? `In compare (${state.compare.length}/${COMPARE.max}): remove` : full ? `Compare is full (${COMPARE.max})` : `Add to compare (${state.compare.length}/${COMPARE.max})`,
    attrs: { 'data-compare': id, 'aria-pressed': String(inIt) },
    onClick: () => { toggleCompare(id); document.querySelector<HTMLElement>(`[data-compare="${id}"]`)?.focus(); },
  });
  if (full) b.disabled = true;
  return b;
}

function openCompare(): void {
  if (!state.compare.length) return;
  state.comparing = true;
  setHash(compareHash());
  draw();
  document.querySelector<HTMLElement>('.compare-sheet .close')?.focus();
}

function closeCompare(): void {
  state.comparing = false;
  setHash(state.player ? `player-${state.player}` : state.team ? `team-${state.team.toLowerCase()}` : '');
  draw();
  document.querySelector<HTMLElement>('.compare-bar .more, .player-sheet .close')?.focus();
}

/** Fixed at the bottom while players are picked and the comparison isn't open. */
function compareBar(): HTMLElement | null {
  if (!state.compare.length || state.comparing) return null;
  const names = state.compare.map((id) => profiles.get(id)?.name ?? players.get(id)?.name ?? id).join(', ');
  return el('div', { className: 'compare-bar', attrs: { role: 'region', 'aria-label': 'Compare players' } }, [
    el('span', { className: 'compare-names', text: `Compare ${state.compare.length}/${COMPARE.max}: ${names}` }),
    el('button', { className: 'more', text: 'Open', onClick: openCompare }),
    el('button', { className: 'close', text: 'Clear', onClick: () => { state.compare = []; draw(); } }),
  ]);
}

/** Add a player from inside the comparison: any player with a page or a score (no linemen). */
function compareSearch(): HTMLElement | null {
  if (state.compare.length >= COMPARE.max) return null;
  const results = el('ul', { className: 'players', attrs: { 'aria-live': 'polite' } });
  const fill = (): void => {
    const q = fold(state.compareQuery);
    const hits = q.length < GAME_LOG.searchMinChars ? [] : (data.profiles ?? []).filter((p) => !state.compare.includes(p.id) && folded.get(p.id)?.includes(q)).slice(0, GAME_LOG.searchResults);
    results.replaceChildren(...hits.map((p) => el('li', { className: 'player' }, [
      el('button', { className: 'player-head', onClick: () => { state.compareQuery = ''; toggleCompare(p.id); document.querySelector<HTMLElement>('.compare-sheet .search')?.focus(); } }, [
        el('span', { className: 'p-main' }, [el('span', { className: 'p-name', text: p.name }), el('span', { className: 'p-meta', text: `${p.team} · ${p.pos}` })]),
      ]),
    ])));
  };
  const input = el('input', { className: 'search', attrs: { type: 'search', placeholder: `Add a player (${state.compare.length}/${COMPARE.max})`, 'aria-label': 'Add a player to compare', autocomplete: 'off', enterkeyhint: 'search' } });
  input.value = state.compareQuery;
  input.addEventListener('input', () => { state.compareQuery = input.value; fill(); });
  fill();
  return el('div', { className: 'finder' }, [input, results]);
}

function compareSheet(): HTMLElement {
  const c = buildComparison(state.compare, data);
  const n = c.players.length;
  let section = '';
  const body: HTMLElement[] = [];
  for (const r of c.rows) {
    if (r.section !== section) {
      section = r.section;
      // a plain cell, not the pinned first column: a pinned cell spanning every column would cover the others
      body.push(el('tr', { className: 'cmp-sec' }, [el('td', { attrs: { colspan: String(n + 1) }, text: section })]));
    }
    body.push(el('tr', {}, [
      el('th', { className: 'left', attrs: { scope: 'row', ...(r.title ? { title: r.title } : {}) }, text: r.label }),
      ...r.cells.map((cell) => el('td', { className: `num${cell.best ? ' cmp-best' : ''}` }, [
        el('span', { className: 'cmp-val', text: cell.text }),
        cell.sub ? el('span', { className: 'cmp-sub', text: cell.sub }) : null,
      ])),
    ]));
  }
  return el('div', { className: 'sheet-backdrop', onClick: (e) => { if (e.target === e.currentTarget) closeCompare(); } }, [
    el('article', { className: 'sheet compare-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare players' } }, [
      el('header', { className: 'sheet-head' }, [
        el('div', {}, [el('p', { className: 'eyebrow', text: `${n} of ${COMPARE.max} players` }), el('h2', { text: 'Compare' })]),
        el('button', { className: 'close', text: 'Close', onClick: closeCompare }),
      ]),
      el('div', { className: 'table-wrap' }, [
        el('table', { className: 'log cmp' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { className: 'left', attrs: { scope: 'col' }, text: '' }),
            ...c.players.map((p) => el('th', { attrs: { scope: 'col' } }, [
              el('span', { className: 'cmp-name', text: p.name }),
              el('span', { className: 'cmp-sub', text: `${p.team} · ${p.pos}` }),
              el('button', { className: 'cmp-remove', text: 'Remove', attrs: { 'aria-label': `Remove ${p.name}` }, onClick: () => toggleCompare(p.id) }),
            ])),
          ])]),
          el('tbody', {}, body),
        ]),
      ]),
      compareSearch(),
      el('p', { className: 'fine', text: 'Box score from the game log, with per-game figures underneath; only the sections that apply to the players picked. Advanced stats show the real value, with the percentile among qualified players at his position underneath. Green = best in the row, where it means the same for each (ranks only within one position; contract costs and games played never). Surplus = what his production is worth (the cap hit paid at that production percentile at his position) minus his cap hit. Linemen and specialists can\'t be compared: open data has no individual score for them. Share this view with the page\'s link.' }),
    ]),
  ]);
}

/** What to focus when the player page closes: a selector for the control that opened it. */
let playerOpener = '';

function openPlayer(id: string, opener: string): void {
  if (!profiles.has(id)) return;
  playerOpener = opener;
  state.player = id;
  setHash(`player-${id}`);
  draw();
  document.querySelector<HTMLElement>('.player-sheet .close')?.focus();
}

function closePlayer(): void {
  state.player = null;
  setHash(state.team ? `team-${state.team.toLowerCase()}` : '');
  draw();
  const back = playerOpener ? document.querySelector<HTMLElement>(playerOpener) : null;
  (back ?? document.querySelector<HTMLElement>(state.team ? '.sheet .close' : '.search'))?.focus();
}

/** For matching names as typed: no accents, no apostrophes or periods, lowercase ("D’Andre" == "dandre"). */
const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’‘`.]/g, '').toLowerCase().trim();
const folded = new Map((data.profiles ?? []).map((p) => [p.id, fold(p.name)]));

/** Find any player with a page, ranked or not. Typing redraws only the result list, so the box keeps focus. */
function playerSearch(): HTMLElement {
  const results = el('ul', { className: 'players', attrs: { 'aria-live': 'polite' } });
  const fill = (): void => {
    const q = fold(state.query);
    const all = q.length < GAME_LOG.searchMinChars ? [] : (data.profiles ?? []).filter((p) => folded.get(p.id)?.includes(q));
    const hits = all.slice(0, GAME_LOG.searchResults);
    results.replaceChildren(...hits.map((p) => el('li', { className: 'player' }, [
      el('button', { className: 'player-head', onClick: () => openPlayer(p.id, '.search') }, [
        el('span', { className: 'p-main' }, [
          el('span', { className: 'p-name', text: p.name }),
          el('span', { className: 'p-meta', text: `${p.team} · ${p.pos} · ${p.log.length} games` }),
        ]),
      ]),
    ])));
    if (all.length > hits.length) results.appendChild(el('li', { className: 'fine', text: `${all.length - hits.length} more: keep typing to narrow it down.` }));
    if (q.length >= GAME_LOG.searchMinChars && !hits.length) results.replaceChildren(el('li', { className: 'fine', text: 'No player found.' }));
  };
  const input = el('input', { className: 'search', attrs: { type: 'search', placeholder: 'Find a player: game log and contract', 'aria-label': 'Find a player', autocomplete: 'off', enterkeyhint: 'search' } });
  input.value = state.query;
  input.addEventListener('input', () => { state.query = input.value; fill(); });
  fill();
  return el('div', { className: 'finder' }, [input, results]);
}

// ------------------------------------------------------------------ player rankings

function lineAvg(t: TeamResult): number {
  const gs = LINE_KEYS.map((k) => t.line[k]?.grade).filter((g): g is number => g !== undefined);
  return gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
}

function playersView(): HTMLElement {
  const groups = [...POSITION_GROUPS, 'OL' as const].map((g) => el('button', {
    className: `chip${state.group === g ? ' on' : ''}`,
    text: g,
    attrs: { 'aria-pressed': String(state.group === g) },
    onClick: () => { state.group = g; draw(); },
  }));
  const modes = data.rankingModes.length > 1
    ? el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Ranking' } }, data.rankingModes.map((m) => el('button', {
      className: `chip${state.mode === m ? ' on' : ''}`, text: m[0]!.toUpperCase() + m.slice(1), onClick: () => { state.mode = m; draw(); },
    })))
    : null;
  if (state.group === 'OL') return el('section', { className: 'rankings' }, [
    profiles.size ? playerSearch() : null,
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, groups),
    el('h2', { className: 'pos-title', text: 'Offensive lines' }),
    el('p', { className: 'fine', text: `Graded by team: ${LINE.passPro.label.toLowerCase()} from ${LINE.passPro.stat}, ${LINE.runBlock.label.toLowerCase()} from ${LINE.runBlock.stat}. Sorted by the average of the two grades. Tap a team.` }),
    el('ol', { className: 'players' }, [...data.teams]
      .sort((a, b) => lineAvg(b) - lineAvg(a) || a.team.localeCompare(b.team))
      .map((t, i) => el('li', { className: 'player' }, [
        el('button', { className: 'player-head', onClick: () => openTeam(t.team) }, [
          el('span', { className: 'p-rank num', text: String(i + 1) }),
          el('span', { className: 'p-main' }, [
            el('span', { className: 'p-name', text: `${t.team} ${t.name}` }),
            el('span', { className: 'p-meta', text: LINE_KEYS.map((k) => {
              const r = t.line[k];
              return `${LINE[k].label} ${r ? `${ordinal(r.rank)} (${r.value.toFixed(LINE[k].decimals)}${LINE[k].suffix ?? ''})` : '-'}`;
            }).join(' · ') }),
          ]),
          el('span', { className: `p-score num ${band(lineAvg(t))}`, text: String(Math.round(lineAvg(t))) }),
        ]),
      ]))),
  ]);
  const group = state.group;
  const atPosition = data.players.filter((p) => p.group === group);
  const list = atPosition.filter((p) => state.prodTeam === 'all' || p.team === state.prodTeam).sort((a, b) => score(b) - score(a));
  const teamCodes = [...teams.keys()].sort();
  const pos = POSITIONS[group];
  const weights = Object.entries(pos.weights).map(([k, w]) => `${STATS[k as keyof typeof STATS].label} ${Math.round(100 * (w ?? 0))}%`).join(' · ');
  const minWord = { dropbacks: 'dropbacks', carries: 'carries', targets: 'targets', defenseSnaps: 'defense snaps' }[pos.minimum.per];
  return el('section', { className: 'rankings' }, [
    profiles.size ? playerSearch() : null,
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, groups),
    modes,
    el('div', { className: 'picks' }, [
      selectBox('Team', state.prodTeam, [['all', 'All teams'], ...teamCodes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()])], (v) => { state.prodTeam = v; draw(); }),
      state.prodTeam !== 'all' ? el('button', { className: 'more', text: `${state.prodTeam} schedule and grades`, onClick: () => openTeam(state.prodTeam) }) : null,
    ]),
    el('h2', { className: 'pos-title', text: `${state.prodTeam === 'all' ? '' : `${state.prodTeam} `}${pos.label}s` }),
    el('p', { className: 'fine', text: `${weights}. Minimum ${pos.minimum.perTeamGame} ${minWord} per team game. ${atPosition.length} qualified${state.prodTeam === 'all' ? '' : `, ${list.length} on ${state.prodTeam}; the score and #rank are still league-wide`}.` }),
    list.length
      ? el('ol', { className: 'players' }, list.map((p, i) => playerCard(p, { showTeam: true, rank: i + 1 })))
      : el('p', { className: 'fine', text: `No qualified ${pos.label.toLowerCase()}s on ${state.prodTeam} yet.` }),
  ]);
}

// ------------------------------------------------------------------ value

const chip = (text: string, on: boolean, onClick: () => void, key?: string): HTMLElement =>
  el('button', { className: `chip${on ? ' on' : ''}`, text, attrs: { 'aria-pressed': String(on), ...(key ? { 'data-sub': key } : {}) }, onClick });
// without cap hits (sample data, or contracts missing) the value views are empty: open on the board instead
if (!data.thisWeek && !data.value.players.length) {
  state.view = 'office';
  state.officeView = 'board';
}
const dollars = (m: number): string => `${m >= 0 ? '+' : '-'}$${Math.abs(m).toFixed(1)}M`;
const valueMeta = (p: PlayerValue, team: boolean): string =>
  `${team ? `${p.team} · ` : ''}${p.group} · ${ordinal(Math.min(99, Math.round(p.production)))} percentile · worth ${money(p.worthMillions)}, cap hit ${money(p.capMillions)}`;

function productionView(): HTMLElement {
  const value = data.value;
  const pool = value.players.filter((p) => state.valuePos === 'All' || p.group === state.valuePos);
  const list = (state.valueOrder === 'best' ? pool : [...pool].reverse()).slice(0, VALUE.listSize);
  const roster = value.rosters.find((l) => l.budgetMillions === state.rosterBudget);
  const R = VALUE.roster;
  const spots = Object.entries(R.lineup.slots).map(([p, n]) => `${n} ${p}`).join(', ');
  return el('div', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: 'Production per cap dollar' }),
    el('p', { className: 'fine', text: 'Every ranked player with a known cap hit, by what his production is worth minus what he costs. Production is the 0-100 score from the Production tab. It is worth the cap hit found at the same percentile of pay at his position: the 90th-percentile producer is worth what the 90th-percentile-paid player costs. Tap a player.' }),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, ['All', ...POSITION_GROUPS].map((g) => chip(g, state.valuePos === g, () => { state.valuePos = g; draw(); }))),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Order' } }, [
      chip('Best value', state.valueOrder === 'best', () => { state.valueOrder = 'best'; draw(); }),
      chip('Worst value', state.valueOrder === 'worst', () => { state.valueOrder = 'worst'; draw(); }),
    ]),
    list.length
      ? el('ol', { className: 'players' }, list.map((p, i) => valueRow(p.id, `v-${p.id}`, p.name, valueMeta(p, true), dollars(p.surplus), String(i + 1))))
      : el('p', { className: 'fine', text: 'No players yet: this needs contracts with this season\'s cap hits.' }),
    el('h2', { className: 'pos-title', text: 'Best roster under a budget' }),
    el('p', { className: 'fine', text: `The ${Object.values(R.lineup.slots).reduce((a, b) => a + b, 0)} starters (${spots}) with the highest total production score whose cap hits fit the budget. The budgets are this page's game, not an NFL rule; linemen and specialists aren't ranked, so they have no spot.` }),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Budget' } }, R.budgetsMillions.map((b) => chip(`$${b}M`, state.rosterBudget === b, () => { state.rosterBudget = b; draw(); }))),
    roster ? el('ol', { className: 'players' }, [
      ...roster.players.map((p, i) => valueRow(p.id, `r-${i}`, p.name, `${p.team} · cap hit ${money(p.capMillions, 2)}`, String(Math.round(p.points)), p.slot)),
      el('li', { className: 'total' }, [
        el('span', { text: `Total: cap ${money(roster.capMillions, 2)} of $${roster.budgetMillions}M` }),
        el('span', { className: 'num', text: `avg ${(roster.points / Math.max(1, roster.players.length)).toFixed(0)}` }),
      ]),
    ]) : el('p', { className: 'fine', text: 'No roster fits yet.' }),
  ]);
}

/** A row that opens the player's page when he has one. */
function valueRow(id: string, key: string, name: string, meta: string, figure: string, lead?: string): HTMLElement {
  const inner = [
    lead !== undefined ? el('span', { className: 'p-rank num', text: lead }) : null,
    el('span', { className: 'p-main' }, [el('span', { className: 'p-name', text: name }), el('span', { className: 'p-meta', text: meta })]),
    el('span', { className: 'v-figure num', text: figure }),
  ];
  return el('li', { className: 'player' }, [
    profiles.has(id)
      ? el('button', { className: 'player-head', attrs: { 'data-open': key }, onClick: () => openPlayer(id, `[data-open="${key}"]`) }, inner)
      : el('div', { className: 'player-head' }, inner),
  ]);
}

function fantasyView(): HTMLElement {
  const F = VALUE.fantasy;
  const value = data.value;
  const positions = ['All', ...Object.keys(F.minPerGame)];
  const list = value.fantasy.filter((f) => state.fantasyPos === 'All' || f.pos === state.fantasyPos).slice(0, VALUE.listSize);
  const lineup = value.lineups.find((l) => l.scope === state.lineupScope && l.budgetMillions === state.budget);
  const week = value.lineups.find((l) => l.scope === 'week')?.week;
  const slots = `${Object.entries(F.lineup.slots).map(([p, n]) => `${n} ${p}`).join(', ')}, 1 ${F.lineup.flexLabel}`;
  return el('div', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: 'Fantasy points per cap dollar' }),
    el('p', { className: 'fine', text: `PPR points for each $1M of this season's cap hit. Listed: ${Object.entries(F.minPerGame).map(([p, n]) => `${p} ${n}+`).join(', ')} points a game, in at least ${Math.round(100 * F.minGameShare)}% of the team's games. Tap a player.` }),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, positions.map((p) => chip(p, state.fantasyPos === p, () => { state.fantasyPos = p; draw(); }))),
    list.length
      ? el('ol', { className: 'players' }, list.map((f, i) => valueRow(f.id, `f-${f.id}`, f.name, `${f.team} · ${f.pos} · ${f.perGame.toFixed(1)} a game · cap hit ${money(f.capMillions, 2)}`, f.perMillion.toFixed(1), String(i + 1))))
      : el('p', { className: 'fine', text: 'No players yet: this needs the weekly stats and contracts.' }),
    el('h2', { className: 'pos-title', text: 'Best lineup under a budget' }),
    el('p', { className: 'fine', text: `The highest-scoring lineup (${slots}) whose cap hits add up to no more than the budget. The budgets are this page's game, not an NFL rule.` }),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Budget' } }, F.budgetsMillions.map((b) => chip(`$${b}M`, state.budget === b, () => { state.budget = b; draw(); }))),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Period' } }, [
      chip('Season', state.lineupScope === 'season', () => { state.lineupScope = 'season'; draw(); }),
      chip(week ? `Week ${week}` : 'Latest week', state.lineupScope === 'week', () => { state.lineupScope = 'week'; draw(); }),
    ]),
    lineup ? el('ol', { className: 'players' }, [
      ...lineup.players.map((p, i) => valueRow(p.id, `l-${i}`, p.name, `${p.team} · ${p.pos} · cap hit ${money(p.capMillions, 2)}`, p.points.toFixed(1), p.slot)),
      el('li', { className: 'total' }, [
        el('span', { text: `Total: cap ${money(lineup.capMillions, 2)} of $${lineup.budgetMillions}M` }),
        el('span', { className: 'num', text: `${lineup.points.toFixed(1)} pts` }),
      ]),
    ]) : el('p', { className: 'fine', text: 'No lineup fits yet.' }),
  ]);
}

function officePlayers(title: string, note: string, list: PlayerValue[], key: string): HTMLElement | null {
  if (!list.length) return null;
  return el('div', { className: 'shop' }, [
    el('h4', { text: title }),
    el('p', { className: 'fine', text: note }),
    el('ul', { className: 'players' }, list.map((p, i) => valueRow(p.id, `${key}-${i}`, p.name, valueMeta(p, false), dollars(p.surplus)))),
  ]);
}

function officeCard(f: FrontOffice): HTMLElement {
  const open = state.office === f.team;
  return el('li', { className: `player${open ? ' open' : ''}` }, [
    el('button', { className: 'player-head', attrs: { 'aria-expanded': String(open), 'data-office': f.team }, onClick: () => { state.office = open ? null : f.team; draw(); document.querySelector<HTMLElement>(`[data-office="${f.team}"]`)?.focus(); } }, [
      el('span', { className: 'p-rank num', text: f.rank === null ? '-' : String(f.rank) }),
      el('span', { className: 'p-main' }, [
        el('span', { className: 'p-name', text: `${f.team} ${teams.get(f.team)?.name ?? ''}` }),
        el('span', { className: 'p-meta', text: `${dollars(f.surplus)} surplus · ${f.players} ranked players costing ${money(f.capMillions)}` }),
      ]),
      el('span', { className: `p-score num ${band(f.grade ?? 50)}`, text: f.grade === null ? '-' : String(f.grade) }),
    ]),
    open ? el('div', { className: 'player-body' }, [
      officePlayers('Bargains', 'Production worth the most over their cap hit.', f.bargains, `b-${f.team}`),
      officePlayers('Overpays', 'Cap hit the most over what their production is worth.', f.overpays, `o-${f.team}`),
      f.idle.length ? el('div', { className: 'shop' }, [
        el('h4', { text: 'Paid, not ranked' }),
        el('p', { className: 'fine', text: `Cap hits of ${money(VALUE.frontOffice.idleCapMillions, 0)} or more on players without enough play to be ranked (hurt, benched or new). Listed, not graded.` }),
        el('ul', { className: 'players' }, f.idle.map((p, k) => valueRow(p.id, `i-${f.team}-${k}`, p.name, p.pos, money(p.capMillions, 2)))),
      ]) : null,
      !f.bargains.length && !f.overpays.length && !f.idle.length ? el('p', { className: 'fine', text: 'Nothing stands out either way.' }) : null,
    ]) : null,
  ]);
}

function officesView(): HTMLElement {
  const list = data.value.frontOffices;
  return el('div', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: 'Cap value by team' }),
    el('p', { className: 'fine', text: 'Which teams get the most production for their cap dollars: each ranked player\'s surplus (what his production is worth minus his cap hit, as on the Value tab) added up by team. Grade 50 = league average. Tap a team.' }),
    list.length ? el('ol', { className: 'players' }, list.map((f) => officeCard(f))) : el('p', { className: 'fine', text: 'No grades yet: this needs contracts with this season\'s cap hits.' }),
    el('p', { className: 'fine', text: 'Left out: offensive linemen and specialists (not ranked individually), players without enough play to rank, and dead money (cap charges for players no longer on the team), which the open data doesn\'t have. A traded player counts for his current team.' }),
  ]);
}

function valueView(): HTMLElement {
  return el('section', { className: 'rankings' }, [
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Value view' } }, [
      chip('Production per $', state.valueView === 'production', () => { state.valueView = 'production'; draw(); }),
      chip('Fantasy per $', state.valueView === 'fantasy', () => { state.valueView = 'fantasy'; draw(); }),
    ]),
    state.valueView === 'production' ? productionView() : fantasyView(),
  ]);
}

function officeView(): HTMLElement {
  return el('section', { className: 'rankings' }, [
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Front office view' } }, [
      chip('Cap value', state.officeView === 'cap', () => { state.officeView = 'cap'; draw(); }, 'cap'),
      chip('Team grades and trades', state.officeView === 'board', () => { state.officeView = 'board'; draw(); }, 'board'),
    ]),
    state.officeView === 'cap' ? officesView() : leagueView(),
  ]);
}

// ------------------------------------------------------------------ moves

function selectBox(label: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLElement {
  const s = el('select', { className: 'pick', attrs: { 'aria-label': label } }, options.map(([v, t]) => {
    const o = el('option', { text: t, attrs: { value: v } });
    if (v === value) o.selected = true;
    return o;
  }));
  s.addEventListener('change', () => onChange(s.value));
  return el('label', { className: 'pick-wrap' }, [el('span', { className: 'pick-label', text: label }), s]);
}

const tradeMoney = (m: number): string => `${m < 0 ? '-' : ''}$${Math.abs(m)}M`;

/** One trade: each team's grade from value in minus value out, then what it received and how each value was reached. */
function tradeCard(t: TradeCard, i: number): HTMLElement {
  const side = (s: TradeSide, j: number): HTMLElement => el('div', { className: 'trade-side' }, [
    el('div', { className: 'trade-head' }, [
      el('span', { className: 'trade-team', text: `${s.team} receives` }),
      el('span', { className: `grade-word ${s.word ? `w-${s.word.toLowerCase()}` : 'w-none'}`, text: s.word ? `${s.word} ${s.score}` : 'Not graded' }),
    ]),
    el('p', { className: 'trade-sum num', text: `Value in ${tradeMoney(s.valueIn)} · out ${tradeMoney(s.valueOut)} · net ${s.net >= 0 ? '+' : ''}${tradeMoney(s.net)}` }),
    el('ul', { className: 'trade-assets' }, s.received.map((a, k) => el('li', {}, [
      el('div', { className: 'asset-line' }, [
        a.id && profiles.has(a.id)
          ? el('button', { className: 'asset-name link', text: a.name, attrs: { 'data-asset': `${i}-${j}-${k}` }, onClick: () => openPlayer(a.id as string, `[data-asset="${i}-${j}-${k}"]`) })
          : el('span', { className: 'asset-name', text: a.name }),
        el('span', { className: 'asset-value num', text: a.millions === null ? 'no value' : tradeMoney(a.millions) }),
      ]),
      el('p', { className: 'p-meta', text: a.how }),
    ]))),
  ]);
  return el('li', { className: 'player trade-card' }, [
    el('div', { className: 'trade-title' }, [
      el('span', { className: 'move-kind k-trade', text: MOVES.labels.trade }),
      el('span', { className: 'p-name', text: t.sides.map((s) => s.team).join(' ⇄ ') }),
    ]),
    tradeVerdict(t),
    ...t.sides.map(side),
  ]);
}

/** The headline: who came out ahead, by how much (or why there's no grade). */
function tradeVerdict(t: TradeCard): HTMLElement {
  if (t.note) return el('p', { className: 'trade-verdict w-none', text: t.note });
  // each team's net, best first: two teams read "JAX +$2.8M · ATL -$2.8M"; ties and three-team trades stay accurate
  const sides = [...t.sides].sort((a, b) => b.net - a.net || a.team.localeCompare(b.team));
  if (sides.every((s) => s.net === 0)) return el('p', { className: 'trade-verdict', text: 'Even trade: net value $0 for each team' });
  return el('p', { className: 'trade-verdict', text: `Net value: ${sides.map((s) => `${s.team} ${s.net >= 0 ? '+' : ''}${tradeMoney(s.net)}`).join(' · ')}` });
}

function movesView(): HTMLElement {
  const teamCodes = [...new Set(moves.flatMap((m) => [m.team, m.from ?? '']).filter(Boolean))].sort();
  const groups = [...MOVES.positionGroups, ...(moves.some((m) => m.group === MOVES.other) ? [MOVES.other] : [])];
  const list = moves.filter((m) => (state.moveTeam === 'all' || m.team === state.moveTeam || m.from === state.moveTeam)
    && (state.moveGroup === 'all' || m.group === state.moveGroup)
    && (state.moveKind === 'all' || m.kind === state.moveKind)
    && (state.moveGraded === 'all' || (m.grades ?? []).some((g) => g.score !== null) || (m.trade?.sides ?? []).some((t) => t.score !== null)))
    // a trades-file trade is one card: keep its first row only
    .filter((m, i, all) => !m.tradeId || all.findIndex((o) => o.tradeId === m.tradeId) === i);
  const shown = list.slice(0, state.moveShown);
  let lastWhen = '';
  const items: HTMLElement[] = [];
  const gradeLine = (g: MoveGrade): HTMLElement => el('p', { className: 'move-grade' }, [
    el('span', { className: `grade-word ${g.word ? `w-${g.word.toLowerCase()}` : 'w-none'}`, text: g.word ? `${g.team} ${g.word} ${g.score}` : g.team }),
    el('span', { className: 'p-meta', text: g.reason }),
  ]);
  shown.forEach((m, i) => {
    if (m.when !== lastWhen) {
      lastWhen = m.when;
      items.push(el('li', { className: 'move-when', text: m.when }));
    }
    if (m.trade) {
      items.push(tradeCard(m.trade, i));
      return;
    }
    const main = [
      el('span', { className: `move-kind k-${m.kind}`, text: MOVES.labels[m.kind] }),
      el('span', { className: 'p-main' }, [
        el('span', { className: 'p-name', text: m.name }),
        el('span', { className: 'p-meta', text: `${[m.pos, m.team].filter(Boolean).join(' · ')} · ${m.detail}` }),
      ]),
    ];
    items.push(el('li', { className: 'player' }, [
      m.id && profiles.has(m.id)
        ? el('button', { className: 'player-head', attrs: { 'data-move': String(i) }, onClick: () => openPlayer(m.id as string, `[data-move="${i}"]`) }, main)
        : el('div', { className: 'player-head' }, main),
      // ungraded lines only where a grade is expected (trades); elsewhere they'd be noise on every depth move
      m.grades?.some((g) => g.score !== null || m.kind === 'trade' || m.kind === 'moved') ? el('div', { className: 'move-grades' }, m.grades.map(gradeLine)) : null,
    ]));
  });
  return el('section', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: 'Moves' }),
    el('p', { className: 'fine', text: 'Every trade, draft pick and roster move this season, newest first. Tap a player for his game log and contract (players with stats this season).' }),
    el('div', { className: 'picks' }, [
      selectBox('Team', state.moveTeam, [['all', 'All teams'], ...teamCodes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()])], (v) => { state.moveTeam = v; state.moveShown = MOVES_PAGE; draw(); }),
      selectBox('Type', state.moveKind, [['all', 'All types'], ...(Object.keys(MOVES.labels) as MoveKind[]).filter((k) => moves.some((m) => m.kind === k)).map((k): [string, string] => [k, MOVES.labels[k]])], (v) => { state.moveKind = v; state.moveShown = MOVES_PAGE; draw(); }),
      selectBox('Position', state.moveGroup, [['all', 'All positions'], ...groups.map((g): [string, string] => [g, g])], (v) => { state.moveGroup = v; state.moveShown = MOVES_PAGE; draw(); }),
      selectBox('Grades', state.moveGraded, [['all', 'All moves'], ['graded', 'Graded only']], (v) => { state.moveGraded = v; state.moveShown = MOVES_PAGE; draw(); }),
    ]),
    el('p', { className: 'fine', text: `${list.length} moves` }),
    list.length ? el('ol', { className: 'players moves' }, items) : el('p', { className: 'fine', text: 'No moves match.' }),
    list.length > shown.length ? el('button', { className: 'more', text: `Show more (${list.length - shown.length} left)`, onClick: () => { state.moveShown += MOVES_PAGE; draw(); } }) : null,
    el('p', { className: 'fine', text: 'Grades (0-100) judge each move for the team: how much it needed the position before the move (its unit grades from the games before; offseason and week 1–2 moves use the season so far and say so), its playoff odds before the move (contenders should add talent; teams out of the race should sell it), the player’s production this season to date, and his cap hit in each season left on his deal against what that production is worth. For the team that lets a player go, each part counts the other way. A trade from the trades file is graded as a whole, for each team, from the value it received minus the value it gave, in dollars of surplus: a player is worth what players at his position with his production percentile are paid, minus his cap hits over the seasons left (up to 4); a pick is its surplus on Ben Baldwin’s draft value chart (Open Source Football, CC BY-NC 4.0; see Credits) × today’s cap × 4 rookie seasons, a pick with no slot yet at the middle of its round, a future pick one round later per draft away. A trade with an asset that has no value (a lineman, a backup without enough snaps) isn’t graded. Not counted: cap space and dead money. Linemen, specialists and players without enough snaps to be ranked aren’t graded.' }),
    el('p', { className: 'fine', text: 'In-season moves are read from week-to-week changes in the weekly rosters, so they are dated by week, and a player who went straight from one roster to another is listed as a trade or waiver claim (the rosters don’t say which), unless players went both ways between the two teams that week or the trades file has it. The trades file is updated a few times a year; its date is in Sources below.' }),
  ]);
}

// ------------------------------------------------------------------ this week

/** Rank 1 of n -> a 0-100 band value (1st = 100). */
const rankBand = (rank: number, n: number): number => (n > 1 ? (100 * (n - rank)) / (n - 1) : 50);

function fantasyAllowedView(): HTMLElement {
  const fa = data.thisWeek?.fantasyAllowed;
  const head = [
    el('h2', { className: 'pos-title', text: 'Fantasy points allowed' }),
    el('p', { className: 'fine', text: `PPR points each defense gave up per game to each position. Adjusted = after allowing for the offenses it faced (the same ridge regression as the unit grades, each defense shrunk toward average as if it had ${FANTASY_ALLOWED.lambdaGames} extra average games). Rank ${FANTASY_ALLOWED.rankLabel}. Tap a team.` }),
  ];
  if (!fa || !Object.keys(fa.teams).length) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: 'No data yet: this needs the weekly player stats.' })]);
  const recentLabel = fa.fromWeek === fa.throughWeek ? `Week ${fa.throughWeek}` : `Weeks ${fa.fromWeek}-${fa.throughWeek}`;
  const rows = Object.entries(fa.teams)
    .map(([team, byPos]) => ({ team, w: byPos[state.faPos]?.[state.faWindow] ?? null }))
    .filter((x): x is { team: string; w: NonNullable<typeof x.w> } => !!x.w);
  const rk = (w: (typeof rows)[number]['w']): number => (state.faAdjusted ? w.adjustedRank : w.rawRank);
  rows.sort((a, b) => rk(a.w) - rk(b.w) || a.team.localeCompare(b.team));
  return el('div', { className: 'rankings' }, [
    ...head,
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, FANTASY_ALLOWED.positions.map((p) => chip(p, state.faPos === p, () => { state.faPos = p; draw(); }))),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Period' } }, [
      chip('Season', state.faWindow === 'season', () => { state.faWindow = 'season'; draw(); }),
      chip(`Last ${fa.recentWeeks} weeks (${recentLabel})`, state.faWindow === 'recent', () => { state.faWindow = 'recent'; draw(); }),
    ]),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Measure' } }, [
      chip('Adjusted', state.faAdjusted, () => { state.faAdjusted = true; draw(); }),
      chip('Raw', !state.faAdjusted, () => { state.faAdjusted = false; draw(); }),
    ]),
    el('ol', { className: 'players' }, rows.map(({ team, w }) => el('li', { className: 'player' }, [
      el('button', { className: 'player-head', attrs: { 'data-fa': team }, onClick: () => openTeam(team) }, [
        el('span', { className: 'p-rank num', text: String(rk(w)) }),
        el('span', { className: 'p-main' }, [
          el('span', { className: 'p-name', text: `${team} ${teams.get(team)?.name ?? ''}`.trim() }),
          el('span', { className: 'p-meta', text: `Adjusted ${w.adjusted.toFixed(1)} (${ordinal(w.adjustedRank)}) · raw ${w.raw.toFixed(1)} (${ordinal(w.rawRank)}) · ${w.games} ${w.games === 1 ? 'game' : 'games'}` }),
        ]),
        el('span', { className: `p-score num ${band(rankBand(rk(w), rows.length))}`, text: (state.faAdjusted ? w.adjusted : w.raw).toFixed(1) }),
      ]),
    ]))),
  ]);
}

function redZoneView(): HTMLElement {
  const rz = data.thisWeek?.redZone;
  const head = [
    el('h2', { className: 'pos-title', text: 'Red zone usage' }),
    el('p', { className: 'fine', text: `Targets and carries with the ball snapped ${RED_ZONE.zones.map((z) => `at or inside the ${z.maxYardline}`).join(' and ')}, and each player's share of his team's. From play-by-play; every play counts except kneels, spikes and two-point tries.` }),
  ];
  const codes = rz ? Object.keys(rz.teams).sort() : [];
  if (!rz || !codes.length) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: 'No data yet: this needs play-by-play.' })]);
  if (!codes.includes(state.rzTeam)) state.rzTeam = codes[0] as string;
  const team = rz.teams[state.rzTeam] as NonNullable<typeof rz>['teams'][string];
  const wk = state.rzWeek === 'season' ? null : Number(state.rzWeek);
  const countsOf = (season: number[], weeks: number[][]): number[] | null => {
    if (wk === null) return season;
    const row = weeks.find((w) => w[0] === wk);
    return row ? row.slice(1) : null;
  };
  const totals = countsOf(team.season, team.weeks) ?? Array(2 * rz.zones.length).fill(0);
  const rows = team.players.map((p) => ({ p, c: countsOf(p.season, p.weeks) })).filter((x): x is { p: typeof x.p; c: number[] } => !!x.c);
  const cell = (n: number, total: number): HTMLElement => el('td', { className: 'num', text: n ? `${n} · ${Math.round(100 * share(n, total))}%` : '-' });
  const kinds = ['Tgt', 'Car'];
  return el('div', { className: 'rankings' }, [
    ...head,
    el('div', { className: 'picks' }, [
      selectBox('Team', state.rzTeam, codes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()]), (v) => { state.rzTeam = v; draw(); }),
      selectBox('Period', state.rzWeek, [['season', 'Season'], ...rz.weeks.slice().reverse().map((w): [string, string] => [String(w), `Week ${w}`])], (v) => { state.rzWeek = v; draw(); }),
    ]),
    rows.length ? el('div', { className: 'table-wrap' }, [
      el('table', { className: 'log' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { className: 'left', text: 'Player', attrs: { scope: 'col' } }),
          ...rz.zones.flatMap((z) => kinds.map((k) => el('th', { text: `${k} ${z.maxYardline}`, attrs: { scope: 'col', title: `${k === 'Tgt' ? 'Targets' : 'Carries'} ${z.label.toLowerCase()}, and share of the team's` } }))),
        ])]),
        el('tbody', {}, rows.map(({ p, c }) => el('tr', {}, [
          el('th', { className: 'left', attrs: { scope: 'row' }, text: `${p.name}${p.pos ? ` ${p.pos}` : ''}` }),
          ...c.map((n, i) => cell(n, totals[i] ?? 0)),
        ]))),
        el('tfoot', {}, [el('tr', {}, [
          el('th', { className: 'left', attrs: { scope: 'row' }, text: 'Team' }),
          ...totals.map((n) => el('td', { className: 'num', text: String(n) })),
        ])]),
      ]),
    ]) : el('p', { className: 'fine', text: 'No red zone targets or carries in this period.' }),
    el('p', { className: 'fine', text: `Each cell: count · share of the team's. ${rz.zones.map((z) => `${z.maxYardline} = ${z.label.toLowerCase()}`).join(', ')}.` }),
  ]);
}

const pctText = (x: number): string => `${Math.round(100 * x)}%`;

function exactTable(ex: PersonnelExact, team: string): HTMLElement | null {
  const t = ex.teams[team];
  if (!t) return null;
  const league = new Map(ex.league.map((g) => [g.code, g]));
  return el('div', { className: 'shop' }, [
    el('h4', { text: `${ex.season} exact: ${team}` }),
    el('p', { className: 'fine', text: `11 ${pctText(t.p11)} · 12 ${pctText(t.p12)} · heavy ${pctText(t.heavy)} of ${t.plays} plays. ${ex.credit}.` }),
    el('div', { className: 'table-wrap' }, [el('table', { className: 'log' }, [
      el('thead', {}, [el('tr', {}, ['Group', 'Plays', 'Share', 'EPA/play', 'League share', 'League EPA'].map((h, i) => el('th', { className: i ? '' : 'left', text: h, attrs: { scope: 'col' } })))]),
      el('tbody', {}, t.groupings.map((g) => el('tr', {}, [
        el('th', { className: 'left', attrs: { scope: 'row' }, text: g.code }),
        el('td', { className: 'num', text: String(g.plays) }),
        el('td', { className: 'num', text: pctText(g.rate) }),
        el('td', { className: 'num', text: g.epa === null ? '-' : signed(g.epa, 2) }),
        el('td', { className: 'num', text: league.get(g.code) ? pctText(league.get(g.code)!.rate) : '-' }),
        el('td', { className: 'num', text: league.get(g.code)?.epa != null ? signed(league.get(g.code)!.epa as number, 2) : '-' }),
      ]))),
    ])]),
  ]);
}

function personnelView(): HTMLElement {
  const pe = data.thisWeek?.personnel;
  const link = el('span', { className: 'ext', text: `${PERSONNEL.exactLink.label} (${PERSONNEL.exactLink.url})` });
  const head = [
    el('h2', { className: 'pos-title', text: 'Personnel' }),
    el('p', { className: 'fine' }, [
      el('span', { text: `${pe?.slot ? `Exact: ${pe.slot.credit}.` : `${PERSONNEL.label}: average backs, tight ends and receivers on the field per offensive snap, and the share of snaps in 11, 12 and heavy sets (2+ TE or 2+ RB) those averages imply. Typical error against FTN's exact ${PERSONNEL.fittedOn} numbers: a few points over a season, more for one game (see Method).`} Exact current numbers: ` }),
      link,
      el('span', { text: '.' }),
    ]),
  ];
  const codes = pe ? Object.keys(pe.slot?.teams ?? pe.estimate).sort() : [];
  if (!pe || !codes.length) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: 'No data yet: this needs snap counts.' })]);
  if (!codes.includes(state.pTeam)) state.pTeam = codes[0] as string;
  const team = state.pTeam;
  const est = pe.estimate[team];
  const slot = pe.slot?.teams[team];
  const exact = pe.exactCurrent ?? pe.exactPrev;
  const rateCells = (x: { p11: number; p12: number; heavy: number }): HTMLElement[] => [x.p11, x.p12, x.heavy].map((v) => el('td', { className: 'num', text: pctText(v) }));
  const table = slot
    ? el('table', { className: 'log' }, [
      el('thead', {}, [el('tr', {}, ['Wk', 'Plays', '11', '12', 'Heavy'].map((h, i) => el('th', { className: i ? '' : 'left', text: h, attrs: { scope: 'col' } })))]),
      el('tbody', {}, (slot.weeks ?? []).map((w) => el('tr', {}, [el('th', { className: 'num left', attrs: { scope: 'row' }, text: String(w.wk) }), el('td', { className: 'num', text: String(w.plays) }), ...rateCells(w)]))),
      el('tfoot', {}, [el('tr', {}, [el('th', { className: 'left', attrs: { scope: 'row' }, text: 'Season' }), el('td', { className: 'num', text: String(slot.plays) }), ...rateCells(slot)])]),
    ])
    : est ? el('table', { className: 'log' }, [
      el('thead', {}, [el('tr', {}, ['Wk', 'Opp', 'RB', 'TE', 'WR', '11', '12', 'Heavy'].map((h, i) => el('th', { className: i < 2 ? 'left' : '', text: h, attrs: { scope: 'col', title: ['Week', 'Opponent', 'Backs on the field per snap (avg)', 'Tight ends per snap (avg)', 'Receivers per snap (avg)', 'Share of snaps in 11 (est.)', 'Share in 12 (est.)', 'Share with 2+ TE or 2+ RB (est.)'][i] ?? h } })))]),
      el('tbody', {}, est.weeks.map((w) => el('tr', {}, [
        el('th', { className: 'num left', attrs: { scope: 'row' }, text: String(w.wk) }),
        el('td', { className: 'left', text: w.opp }),
        ...[w.rb, w.te, w.wr].map((v) => el('td', { className: 'num', text: v.toFixed(2) })),
        ...rateCells(w),
      ]))),
      el('tfoot', {}, [el('tr', {}, [
        el('th', { className: 'left', attrs: { scope: 'row' }, text: 'Season' }),
        el('td', {}),
        ...[est.season.rb, est.season.te, est.season.wr].map((v) => el('td', { className: 'num', text: v.toFixed(2) })),
        ...rateCells(est.season),
      ])]),
    ]) : null;
  return el('div', { className: 'rankings' }, [
    ...head,
    el('div', { className: 'picks' }, [selectBox('Team', team, codes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()]), (v) => { state.pTeam = v; draw(); })]),
    table ? el('div', { className: 'table-wrap' }, [table]) : el('p', { className: 'fine', text: 'No snap counts for this team yet.' }),
    exact ? exactTable(exact, team) : null,
  ]);
}

const tagClass = (x: string | null): string => (x === 'Out' || x === 'DNP' ? 'd-inj' : x === 'Doubtful' || x === 'Questionable' || x === 'Limited' ? 'd-down' : 'd-up');

function practiceRows(rows: PracticeRow[], key: string): HTMLElement {
  return el('ul', { className: 'players' }, rows.map((r, i) => {
    const inner = [
      el('span', { className: 'p-main' }, [
        el('span', { className: 'p-name', text: `${r.name} ${r.pos}` }),
        el('span', { className: 'p-meta', text: r.injury || 'No injury listed' }),
      ]),
      el('span', { className: 'pr-tags' }, [
        r.practice ? el('span', { className: `d-tag ${tagClass(r.practice)}`, text: r.practice }) : null,
        r.game ? el('span', { className: `d-tag ${tagClass(r.game)}`, text: r.game }) : null,
      ]),
    ];
    return el('li', { className: 'player' }, [
      profiles.has(r.id)
        ? el('button', { className: 'player-head', attrs: { 'data-pr': `${key}-${i}` }, onClick: () => openPlayer(r.id, `[data-pr="${key}-${i}"]`) }, inner)
        : el('div', { className: 'player-head' }, inner),
    ]);
  }));
}

function practiceView(): HTMLElement {
  const pr = data.thisWeek?.practice;
  const head = [
    el('h2', { className: 'pos-title', text: 'Practice and game status' }),
    el('p', { className: 'fine', text: `${pr?.note ?? INJURY.practiceNote} Game status = the designation for this week's game (Out, Doubtful, Questionable). From the NFL's injury reports via nflverse.` }),
  ];
  if (!pr) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: 'No injury reports on file.' })]);
  if (!pr.published) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: `Week ${pr.week}'s first report isn't in yet (reports come out Wednesday to Friday; the file has through week ${pr.latestWeek}).` })]);
  const codes = Object.keys(pr.teams);
  if (state.prTeam !== 'all' && !codes.includes(state.prTeam)) state.prTeam = 'all';
  const shown = state.prTeam === 'all' ? codes : [state.prTeam];
  return el('div', { className: 'rankings' }, [
    ...head,
    el('div', { className: 'picks' }, [selectBox('Team', state.prTeam, [['all', 'All teams'], ...codes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()])], (v) => { state.prTeam = v; draw(); })]),
    ...shown.map((t) => el('div', { className: 'shop' }, [el('h4', { text: `${t} ${teams.get(t)?.name ?? ''}`.trim() }), practiceRows(pr.teams[t] ?? [], t)])),
  ]);
}

/** Green when the offense has an edge, red when the defense does, plain when even (MATCHUP.edgeWords[1] and [2]). */
const edgeClass = (edge: number): string => (edge >= (MATCHUP.edgeWords[1]?.[0] ?? 0) ? 'd-up' : edge < (MATCHUP.edgeWords[2]?.[0] ?? 0) ? 'd-inj' : 'd-even');

function clashRow(label: string, c: UnitClash): HTMLElement {
  return el('div', { className: 'm-clash' }, [
    el('span', { className: 'm-label', text: label }),
    el('span', { className: 'num', text: `O ${c.offGrade} (${ordinal(c.offRank)}) vs D ${c.defGrade} (${ordinal(c.defRank)})` }),
    el('span', { className: `d-tag ${edgeClass(c.edge)}`, text: c.word }),
  ]);
}

function matchupSide(sd: MatchupSide): HTMLElement {
  const fa = FANTASY_ALLOWED.positions.filter((p) => sd.fantasyAllowed[p]).map((p) => `${p} ${sd.fantasyAllowed[p]!.adjusted.toFixed(1)} (${ordinal(sd.fantasyAllowed[p]!.rank)})`).join(' · ');
  const zones = data.thisWeek?.redZone?.zones ?? [];
  return el('div', { className: 'm-side' }, [
    el('h4', { text: `${sd.team} offense vs ${sd.opp} defense` }),
    clashRow('Pass', sd.pass),
    clashRow('Rush', sd.rush),
    fa ? el('p', { className: 'm-line' }, [el('span', { className: 'm-label', text: `${sd.opp} allows` }), el('span', { className: 'num', text: fa })]) : null,
    sd.redZone.length ? el('p', { className: 'm-line' }, [
      el('span', { className: 'm-label', text: 'Red zone' }),
      el('span', { text: sd.redZone.map((r) => `${r.name} ${r.shares.map((x, z) => `${Math.round(100 * x)}%${zones.length > 1 ? `/${zones[z]?.maxYardline}` : ''}`).join(' ')}`).join(' · ') }),
    ]) : null,
    sd.personnel ? el('p', { className: 'm-line' }, [
      el('span', { className: 'm-label', text: 'Personnel' }),
      el('span', { className: 'num', text: `11 ${Math.round(100 * sd.personnel.p11)}% · 12 ${Math.round(100 * sd.personnel.p12)}% · heavy ${Math.round(100 * sd.personnel.heavy)}%${sd.personnel.estimated ? ' (est. from snap counts)' : ''}` }),
    ]) : null,
    el('p', { className: 'm-line' }, [
      el('span', { className: 'm-label', text: 'Status' }),
      sd.status.length
        ? el('span', {}, sd.status.map((r, i) => el('span', { className: 'm-status', text: `${i ? ' · ' : ''}${r.name} ${r.pos} ${r.game}${r.practice ? ` (${r.practice})` : ''}` })))
        : el('span', { className: 'fine', text: data.thisWeek?.practice?.published ? 'No one listed Out, Doubtful or Questionable' : 'Report not out yet' }),
    ]),
  ]);
}

function matchupPlayerRow(p: MatchupPlayer, i: number): HTMLElement {
  const inner = [
    el('span', { className: 'p-rank num', text: String(i + 1) }),
    el('span', { className: 'p-main' }, [
      el('span', { className: 'p-name', text: p.name }),
      el('span', { className: 'p-meta', text: `${p.team} ${p.group} · #${p.rank} of ${p.qualified} · vs ${p.opp} ${p.vs ? `${p.vs.label} ${ordinal(p.vs.rank)}` : '(no grade)'}` }),
      el('span', { className: 'mp-tags' }, [
        p.word !== null && p.edge !== null ? el('span', { className: `d-tag ${edgeClass(p.edge)}`, text: `${p.word} ${p.edge >= 0 ? '+' : ''}${p.edge}` }) : null,
        p.status ? el('span', { className: `d-tag ${tagClass(p.status)}`, text: p.status }) : null,
      ]),
    ]),
    el('span', { className: 'mp-scores' }, [
      el('span', { className: 'mp-score' }, [el('span', { className: `p-score num ${band(p.score)}`, text: String(Math.round(p.score)) }), el('span', { className: 'mp-cap', text: p.group })]),
      el('span', { className: 'mp-score' }, [
        el('span', { className: `p-score num ${p.vs ? band(p.vs.grade) : ''}`, text: p.vs ? String(p.vs.grade) : '-' }),
        el('span', { className: 'mp-cap', text: p.vs ? `${p.opp} ${p.vs.label}` : p.opp }),
      ]),
    ]),
  ];
  return el('li', { className: 'player' }, [
    profiles.has(p.id)
      ? el('button', { className: 'player-head', attrs: { 'data-mp': p.id }, onClick: () => openPlayer(p.id, `[data-mp="${p.id}"]`) }, inner)
      : el('div', { className: 'player-head' }, inner),
  ]);
}

function matchupPlayersView(): HTMLElement {
  const ms = data.thisWeek?.matchups ?? [];
  const all = data.thisWeek?.matchupPlayers ?? [];
  if (state.mGame !== 'all' && !ms.some((m) => m.id === state.mGame)) state.mGame = 'all';
  const list = all.filter((p) => p.group === state.mGroup && (state.mGame === 'all' || p.game === state.mGame));
  if (state.mSort === 'edge') list.sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity) || b.score - a.score);
  const vs = MATCHUP.versus[state.mGroup];
  const against = 'unit' in vs ? `the opponent's ${UNITS[vs.unit].long.toLowerCase()} grade` : `the opponent's ${LINE[vs.line].label.toLowerCase()} grade (${LINE[vs.line].stat})`;
  return el('div', {}, [
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, POSITION_GROUPS.map((g) => chip(g, state.mGroup === g, () => { state.mGroup = g; draw(); }))),
    el('div', { className: 'picks' }, [
      selectBox('Game', state.mGame, [['all', 'All games'], ...ms.map((m): [string, string] => [m.id, `${m.away} @ ${m.home}`])], (v) => { state.mGame = v; draw(); }),
      selectBox('Sort', state.mSort, [['score', 'Player score'], ['edge', 'Matchup edge']], (v) => { state.mSort = v as 'score' | 'edge'; draw(); }),
    ]),
    el('p', { className: 'fine', text: `${POSITIONS[state.mGroup].label}s: production score (0-100, as on the Production tab) against ${against}, 0-100 with 50 = average, rank 1st = best. Edge = his score minus that grade (${MATCHUP.playerEdgeWords.map(([n, w]) => `${w} ${n >= 0 ? '+' : ''}${n} or more`).join(', ')}, else ${MATCHUP.playerFallbackWord.toLowerCase()}). Tags: this week's game designation. Tap a player.` }),
    list.length
      ? el('ol', { className: 'players' }, list.map(matchupPlayerRow))
      : el('p', { className: 'fine', text: 'No ranked players at this position in this game.' }),
  ]);
}

function matchupsView(): HTMLElement {
  const ms = data.thisWeek?.matchups ?? [];
  const toggle = data.thisWeek?.matchupPlayers ? el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Matchups view' } }, [
    chip('Games', state.mView === 'games', () => { state.mView = 'games'; draw(); }, 'm-games'),
    chip('Players', state.mView === 'players', () => { state.mView = 'players'; draw(); }, 'm-players'),
  ]) : null;
  if (toggle && state.mView === 'players' && ms.length) return el('div', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: `Week ${data.thisWeek?.week ?? ''} matchups: players` }),
    toggle,
    matchupPlayersView(),
  ]);
  const head = [
    el('h2', { className: 'pos-title', text: `Week ${data.thisWeek?.week ?? ''} matchups` }),
    el('p', { className: 'fine', text: `Each offense against the other defense: unit grades (0-100 from opponent-adjusted EPA/play, rank in brackets) and the gap between them; what the defense allows per game by position (adjusted, rank 1 = allows the most); the offense's top red zone players (share of the team's targets + carries ${RED_ZONE.zones.map((z) => `inside the ${z.maxYardline}`).join(' / ')}, season); personnel share of snaps; and players listed Out, Doubtful or Questionable. Tap a game.` }),
  ];
  if (!ms.length) return el('div', { className: 'rankings' }, [...head, el('p', { className: 'fine', text: 'No games this week.' })]);
  return el('div', { className: 'rankings' }, [
    ...head,
    toggle,
    el('ul', { className: 'players' }, ms.map((m) => {
      const open = state.open.has(`m-${m.id}`);
      const result = m.homeScore !== null && m.awayScore !== null ? `Final ${m.away} ${m.awayScore}, ${m.home} ${m.homeScore}` : fmtDate(m.gameday);
      const edges = m.sides.map((sd) => `${sd.team} pass ${sd.pass.edge >= 0 ? '+' : ''}${sd.pass.edge}, rush ${sd.rush.edge >= 0 ? '+' : ''}${sd.rush.edge}`).join(' · ');
      return el('li', { className: `player${open ? ' open' : ''}` }, [
        el('button', { className: 'player-head', attrs: { 'aria-expanded': String(open), 'data-game': m.id }, onClick: () => { if (open) state.open.delete(`m-${m.id}`); else state.open.add(`m-${m.id}`); draw(); document.querySelector<HTMLElement>(`[data-game="${m.id}"]`)?.focus(); } }, [
          el('span', { className: 'p-main' }, [
            el('span', { className: 'p-name', text: `${m.away} @ ${m.home}` }),
            el('span', { className: 'p-meta', text: `${result} · ${edges}` }),
          ]),
        ]),
        open ? el('div', { className: 'player-body' }, [
          ...m.sides.map((sd) => matchupSide(sd)),
          toggle ? el('button', { className: 'more', text: 'Players in this game', onClick: () => { state.mView = 'players'; state.mGame = m.id; draw(); } }) : null,
        ]) : null,
      ]);
    })),
  ]);
}

function weekView(): HTMLElement {
  const wk = data.thisWeek?.week;
  return el('section', { className: 'rankings' }, [
    el('p', { className: 'eyebrow', text: wk ? `Week ${wk}` : '' }),
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'This week view' } }, [
      chip('Matchups', state.weekView === 'matchups', () => { state.weekView = 'matchups'; draw(); }, 'matchups'),
      chip('Fantasy allowed', state.weekView === 'fantasy', () => { state.weekView = 'fantasy'; draw(); }, 'fantasy'),
      chip('Red zone', state.weekView === 'redzone', () => { state.weekView = 'redzone'; draw(); }, 'redzone'),
      chip('Personnel', state.weekView === 'personnel', () => { state.weekView = 'personnel'; draw(); }, 'personnel'),
      chip('Practice', state.weekView === 'practice', () => { state.weekView = 'practice'; draw(); }, 'practice'),
    ]),
    state.weekView === 'redzone' ? redZoneView() : state.weekView === 'personnel' ? personnelView() : state.weekView === 'practice' ? practiceView() : state.weekView === 'fantasy' ? fantasyAllowedView() : matchupsView(),
  ]);
}

// ------------------------------------------------------------------ footer

function footer(): HTMLElement {
  const state = { fresh: 'Current', lagging: 'Behind', kept: 'Kept last copy', missing: 'Missing' } as const;
  return el('footer', { className: 'foot' }, [
    el('h3', { text: 'Sources' }),
    el('ul', { className: 'sources' }, data.sources.map((s) => el('li', { className: `src-${s.state}` }, [
      el('div', { className: 'src-head' }, [el('span', { className: 'src-name', text: s.label }), el('span', { className: `state s-${s.state}`, text: state[s.state] })]),
      el('span', { className: 'src-cov num', text: `As of ${fmtDate(s.asOf)} · ${s.coverage}` }),
      s.note ? el('span', { className: 'note', text: s.note }) : null,
    ]))),
    el('h3', { text: 'Method' }),
    el('p', { text: `Unit grades: EPA per play for pass and rush, offense and defense, adjusted for opponents with a ridge regression (each team's effect is shrunk toward average as if it had ${ADJUST.lambdaPlays.pass} extra average plays, so a half season of noise doesn't dominate), garbage time removed. Grade = normal percentile of the adjusted value among the 32 teams.` }),
    el('p', { text: 'Series success (toggle on the grade board and team sheets): nflfastR\'s series_success, 1 when the play\'s series (a set of downs) earned a first down or a touchdown. A unit\'s value is the share of its plays in such series, on the same plays as EPA and adjusted for opponents the same way. Calls, odds and needs still use EPA.' }),
    el('p', { text: `Verdict: playoff odds from ${PLAYOFF_SIM.simulations.toLocaleString('en-US')} simulated finishes (team strength blends adjusted EPA with point differential; standings ties broken at random, not by NFL tiebreakers). Odds ${pct(VERDICT.contenderOdds)}+ buy for a unit graded under ${VERDICT.holeGrade}; ${pct(VERDICT.sellerOdds)} or less sell; in between, the schedule left decides.` }),
    el('p', { text: 'Player scores: percentile within the position of a weighted mix of stat percentiles, among players over a per-game volume minimum. Offensive linemen are graded by team instead (Production, then OL); specialists are not ranked. Open data has no good per-player stat for either.' }),
    el('p', { text: 'Offensive line: pass protection = QB pressures (PFR) per dropback; run blocking = rushing yards before contact per carry (PFR). When a buyer\'s weakest unit is pass O or rush O, it shops for the weaker half: the line, or the pass catchers (EPA per non-sack attempt) or backs (yards after contact per carry).' }),
    el('p', { text: 'Player pages (Production, then search, or "Game log and contract" on a ranked player): one line per game from the nflverse weekly stats, for every quarterback, back, receiver, tight end and defender with a stat this season. Snap% is his share of the team\'s offense or defense snaps. PPR = fantasy points with a point per catch. Contract years show base salary, cap hit and cash paid.' }),
    el('p', { text: `Value: cap hit is what a player counts against his team's cap this season (from the contract's yearly rows). Production per $: a ranked player's production score is worth the cap hit at the same percentile of pay at his position; surplus is that worth minus his own cap hit. Cheap producers (often rookie deals) come out best and expensive players who aren't producing worst. Pay is steep at the top of a position, so its highest-paid players only break even by being its very best producers, and a few percentile points there can move worth by many millions. Cap value by team (Front office) adds the surplus up by team; it ignores dead money, linemen, specialists and players without enough play to rank, teams that spend more on ranked players tend to score lower, and a quarterback's surplus can swing a team's total. Fantasy per $ = PPR points per $1M of cap hit. Best rosters and lineups are found exactly, with cap hits rounded up to the nearest $${Math.max(VALUE.fantasy.budgetStepMillions, VALUE.roster.budgetStepMillions)}M; the weekly lineup uses the latest week with every game played.` }),
    el('p', { text: `Fantasy points allowed (This week): PPR points per game each defense gave up to quarterbacks, backs (fullbacks included), receivers and tight ends, from the nflverse weekly player stats, over the season and the last ${FANTASY_ALLOWED.recentWeeks} weeks played. Adjusted for the offenses faced with the unit grades' ridge regression on game totals (points = average + offense + defense + home), each team shrunk toward average as if it had ${FANTASY_ALLOWED.lambdaGames} extra average games. Rank 1 = allows the most.` }),
    el('p', { text: `Red zone usage (This week): targets and carries from play-by-play with the ball snapped ${RED_ZONE.zones.map((z) => `at or inside the ${z.maxYardline}`).join(' or ')}, by player and week, with each player's share of his team's. A sack or an aborted play is not a target; kneels, spikes and two-point tries are left out.` }),
    el('p', { text: `Depth charts (team sheets): ESPN's depth charts as nflverse snapshots them (about twice a day). The newest snapshot is compared with the newest one from at least ${DEPTH.minDaysBefore} ${DEPTH.minDaysBefore === 1 ? 'day' : 'days'} earlier: New = not on that slot before, Up / Down = moved on it, Off the chart = was on it. Designations are this week's injury report (nflverse injuries) or a reserve list on the weekly roster.` }),
    el('p', { text: `Personnel (This week), ${PERSONNEL.label.toLowerCase()}: average backs (fullbacks included), tight ends and receivers on the field per offensive snap = that position's offense snaps over the team's (PFR snap counts). If a team only used 1 or 2 tight ends, its 2-TE share would be the TE average minus 1; real teams spread wider, so that share is scaled down by factors fitted on ${PERSONNEL.fittedOn}: heavy (2+ TE or 2+ RB) = ${PERSONNEL.heavyScale} × ((TE − 1) + (RB − 1)), 12 = ${PERSONNEL.twoTeScale} × (TE − 1), 11 = 1 − heavy − (WR − 3), each part clamped to 0-1. Against FTN's exact ${PERSONNEL.fittedOn} participation (fitted leaving each team out): over a season, mean error about 4 points for 11, 5-6 for 12 and 4 for heavy, rank correlation 0.85 / 0.71 / 0.90; for one game about 6 / 8 / 5 points. Exact current numbers: ${PERSONNEL.exactLink.url}. When FTN participation for a season is on nflverse, the exact shares and EPA per play by grouping are shown for it (${PERSONNEL.ftnCredit}; tables derived from it are shared under the same license).` }),
    el('p', { text: `Matchups (This week): for each game this week, each offense's pass and rush grades against the other team's pass and rush defense grades (EPA-based, as on the board), the gap between them (${MATCHUP.edgeWords.map(([n, w]) => `${w} ${n >= 0 ? '+' : ''}${n} or more`).join(', ')}, else ${MATCHUP.fallbackWord.toLowerCase()}), and the other This week views for the two teams. Players view: every ranked player in a game this week, his production score against the grade of the opposing unit his position faces (${POSITION_GROUPS.map((g) => `${g} vs ${MATCHUP.versus[g].label}`).join(', ')}); pass pro is the line's team grade from pressure rate allowed, not a per-lineman stat.` }),
    el('p', { text: `Base salary left: the part of this season's base salary still to be paid (${TRADE_COST.payWeeks} weekly checks), which a team trading for the player takes on. It leaves out bonuses and incentives; the signing bonus stays with the old team. Team cap room isn't shown: the open contracts data has no dead money, so it can't be computed reliably.` }),
    el('h3', { text: 'Credits' }),
    el('p', { text: 'Data from nflverse (nflverse-data releases): play-by-play and EPA from nflfastR, schedules, weekly rosters and player stats, trades and draft picks, NFL Next Gen Stats, Pro Football Reference advanced stats and snap counts, and contracts from OverTheCap. Thanks to the nflverse maintainers and their upstream sources. Not affiliated with the NFL or any team.' }),
    el('p', { text: PICK_VALUE.credit }),
    data.thisWeek?.personnel?.exactCurrent || data.thisWeek?.personnel?.exactPrev ? el('p', { text: `Exact personnel: ${PERSONNEL.ftnCredit}, creativecommons.org/licenses/by-sa/4.0. Changed: summed by team and grouping and joined to nflfastR EPA; those tables are shared under CC BY-SA 4.0.` }) : null,
    data.thisWeek?.personnel?.slot ? el('p', { text: `Exact current personnel: ${data.thisWeek.personnel.slot.credit}` }) : null,
    data.ratingsCredit ? el('p', { text: `Ratings: ${data.ratingsCredit}` }) : null,
  ]);
}

// ------------------------------------------------------------------ page

function draw(): void {
  const team = state.team ? teams.get(state.team) : undefined;
  const profile = state.player ? profiles.get(state.player) : undefined;
  const tabs = (['week', 'value', 'players', 'office', 'moves'] as const).map((v) => el('button', {
    className: `tab${state.view === v ? ' on' : ''}`,
    text: v === 'week' ? THIS_WEEK.label : v === 'value' ? 'Value' : v === 'players' ? 'Production' : v === 'office' ? 'Front office' : 'Moves',
    attrs: { 'aria-pressed': String(state.view === v), 'data-view': v },
    onClick: () => { state.view = v; draw(); },
  }));
  render(el('div', { className: `shell${state.compare.length && !state.comparing ? ' with-bar' : ''}` }, [
    el('header', { className: 'top' }, [
      el('div', { className: 'brand' }, [
        el('h1', { text: 'Roster Grader' }),
        el('p', { className: 'asof', text: `${data.season} season · through week ${data.throughWeek} · data as of ${fmtDate(data.dataAsOf)}` }),
      ]),
      el('nav', { className: 'tabs' }, tabs),
    ]),
    data.sample ? el('p', { className: 'banner', text: 'Sample data (weeks 1-2 of 2026): the nightly refresh has not run yet.' }) : null,
    el('main', {}, [state.view === 'week' ? weekView() : state.view === 'value' ? valueView() : state.view === 'players' ? playersView() : state.view === 'office' ? officeView() : movesView(), footer()]),
    team ? teamSheet(team) : null,
    profile && !state.comparing ? playerSheet(profile) : null,
    state.comparing ? compareSheet() : null,
    compareBar(),
  ]));
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.comparing) closeCompare();
  else if (state.player) closePlayer();
  else if (state.team) closeTeam();
});
const fromHash = /^#team-([a-z]{2,3})$/.exec(location.hash)?.[1]?.toUpperCase();
if (fromHash && teams.has(fromHash)) {
  state.team = fromHash;
  state.view = 'office';
  state.officeView = 'board';
}
const playerHash = /^#player-([0-9-]{4,12})$/.exec(location.hash)?.[1];
if (playerHash && profiles.has(playerHash)) {
  state.player = playerHash;
  state.view = 'players';
}
// a shared comparison: #compare-<id>,<id>,<id>
const compareIds = /^#compare-([0-9,-]{4,60})$/.exec(location.hash)?.[1]?.split(',').filter((id) => comparable(data, id)).slice(0, COMPARE.max);
if (compareIds?.length) {
  state.compare = [...new Set(compareIds)];
  state.comparing = true;
}
draw();
