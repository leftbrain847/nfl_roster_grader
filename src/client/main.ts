/**
 * Roster Grader page. Reads the model output baked in at build time (no network). Three tabs: Value (production and
 * fantasy points per cap dollar), Production (position rankings, a page per player) and Front office (cap value by
 * team, and the team grade board with its buy / sell calls and team sheets). Text goes in as text, never HTML.
 */
import data from '@roster-data';
import {
  ADJUST, GAME_LOG, MOVES, LINE, LINE_KEYS, LINE_TARGETS, PLAYOFF_SIM, TRADE_COST, POSITION_GROUPS, POSITIONS, STATS, UNIT_KEYS, UNITS, VALUE, VERDICT,
  type LineKey, type PositionGroup, type RankingMode, type UnitKey, type Verdict,
} from '../model/config.ts';
import { ordinal } from '../model/stats.ts';
import { logTotals } from '../model/profiles.ts';
import type { ContractDetail, FrontOffice, LineTarget, Lineup, PlayerContract, PlayerProfile, PlayerResult, PlayerValue, TeamResult } from '../model/types.ts';
import { el, render } from './ui';

/** Moves listed at first; "Show more" adds this many again. */
const MOVES_PAGE = 60;

type SortKey = 'team' | 'verdict' | 'odds' | UnitKey;
type View = 'value' | 'players' | 'office' | 'moves';

const state = {
  view: 'value' as View,
  sort: 'odds' as SortKey,
  desc: true,
  filter: 'all' as Verdict | 'all',
  group: 'QB' as PositionGroup | 'OL',
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
  moveShown: MOVES_PAGE,
  fantasyPos: 'All',
  budget: VALUE.fantasy.budgetsMillions[0] ?? 0,
  lineupScope: 'season' as Lineup['scope'],
  office: null as string | null,
  open: new Set<string>(),
};

const players = new Map(data.players.map((p) => [p.id, p]));
const teams = new Map(data.teams.map((t) => [t.team, t]));
const moves = data.moves ?? [];
const profiles = new Map((data.profiles ?? []).map((p) => [p.id, p]));
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

function sortedTeams(): TeamResult[] {
  const list = data.teams.filter((t) => state.filter === 'all' || t.verdict === state.filter);
  const val = (t: TeamResult): number | string => {
    switch (state.sort) {
      case 'team': return t.team;
      case 'verdict': return VERDICT_ORDER[t.verdict] * 10 - t.playoffOdds;
      case 'odds': return t.playoffOdds;
      default: return t.units[state.sort].grade;
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
      ...UNIT_KEYS.map((k) => el('td', { className: 'c-grade num' }, [el('span', { className: `grade ${band(t.units[k].grade)}`, text: String(t.units[k].grade) })])),
    ]),
  );
  for (const r of rows) r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTeam(r.dataset.team ?? ''); });
  return el('section', { className: 'league' }, [
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by verdict' } }, filters),
    el('div', { className: 'table-wrap' }, [
      el('table', { className: 'board' }, [
        el('thead', {}, [el('tr', {}, [
          header('team', 'Team', 'c-team'), header('verdict', 'Call', 'c-verdict'), header('odds', 'Odds', 'c-odds'),
          ...UNIT_KEYS.map((k) => header(k, UNITS[k].short, 'c-grade')),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
    el('p', { className: 'fine', text: `Grades are 0-100 (50 = league average) from opponent-adjusted EPA per play. Call = buy, sell or stand pat at the trade deadline. Odds: ${PLAYOFF_SIM.label.toLowerCase()}. Tap a team for its sheet and trade targets.` }),
  ]);
}

// ------------------------------------------------------------------ team sheet

function unitBar(t: TeamResult, k: UnitKey): HTMLElement {
  const u = t.units[k];
  const side = UNITS[k].side === 'offense' ? 'EPA/play' : 'EPA/play allowed';
  const avg = data.teams.reduce((sum, x) => sum + x.units[k].adjusted, 0) / Math.max(1, data.teams.length);
  return el('div', { className: `unit${k === t.weakest ? ' weakest' : ''}` }, [
    el('div', { className: 'unit-head' }, [
      el('span', { className: 'unit-name', text: UNITS[k].long }),
      el('span', { className: 'unit-rank num', text: `${ordinal(u.rank)} · ${u.grade}` }),
    ]),
    el('div', { className: 'bar', attrs: { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(u.grade), 'aria-label': `${UNITS[k].long} grade` } }, [
      el('span', { className: `fill ${band(u.grade)}`, vars: { '--w': `${Math.max(2, u.grade)}%` } }),
      el('span', { className: 'mid' }),
    ]),
    el('div', { className: 'unit-sub num', text: `${signed(u.adjusted, 3)} ${side} adjusted (avg ${signed(avg, 3)}) · ${signed(u.raw, 3)} raw · ${u.plays} plays` }),
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
      el('section', { className: 'units' }, UNIT_KEYS.map((k) => unitBar(t, k))),
      el('section', { className: 'units' }, [
        el('h3', { text: 'Offensive line' }),
        el('p', { className: 'fine', text: 'Team level, not opponent-adjusted. Also reflects the QB, backs and scheme.' }),
        ...LINE_KEYS.map((k) => lineBar(t, k)),
      ]),
      shop,
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
        el('th', { className: 'left', attrs: { scope: 'row', colspan: '4' }, text: `Total · ${p.log.length} games` }),
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
  const list = data.players.filter((p) => p.group === group).sort((a, b) => score(b) - score(a));
  const pos = POSITIONS[group];
  const weights = Object.entries(pos.weights).map(([k, w]) => `${STATS[k as keyof typeof STATS].label} ${Math.round(100 * (w ?? 0))}%`).join(' · ');
  const minWord = { dropbacks: 'dropbacks', carries: 'carries', targets: 'targets', defenseSnaps: 'defense snaps' }[pos.minimum.per];
  return el('section', { className: 'rankings' }, [
    profiles.size ? playerSearch() : null,
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, groups),
    modes,
    el('h2', { className: 'pos-title', text: `${pos.label}s` }),
    el('p', { className: 'fine', text: `${weights}. Minimum ${pos.minimum.perTeamGame} ${minWord} per team game. ${list.length} qualified.` }),
    el('ol', { className: 'players' }, list.map((p, i) => playerCard(p, { showTeam: true, rank: i + 1 }))),
  ]);
}

// ------------------------------------------------------------------ value

const chip = (text: string, on: boolean, onClick: () => void, key?: string): HTMLElement =>
  el('button', { className: `chip${on ? ' on' : ''}`, text, attrs: { 'aria-pressed': String(on), ...(key ? { 'data-sub': key } : {}) }, onClick });
// without cap hits (sample data, or contracts missing) the value views are empty: open on the board instead
if (!data.value.players.length) {
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

function movesView(): HTMLElement {
  const teamCodes = [...new Set(moves.flatMap((m) => [m.team, m.from ?? '']).filter(Boolean))].sort();
  const groups = [...MOVES.positionGroups, ...(moves.some((m) => m.group === MOVES.other) ? [MOVES.other] : [])];
  const list = moves.filter((m) => (state.moveTeam === 'all' || m.team === state.moveTeam || m.from === state.moveTeam)
    && (state.moveGroup === 'all' || m.group === state.moveGroup));
  const shown = list.slice(0, state.moveShown);
  let lastWhen = '';
  const items: HTMLElement[] = [];
  shown.forEach((m, i) => {
    if (m.when !== lastWhen) {
      lastWhen = m.when;
      items.push(el('li', { className: 'move-when', text: m.when }));
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
    ]));
  });
  return el('section', { className: 'rankings' }, [
    el('h2', { className: 'pos-title', text: 'Moves' }),
    el('p', { className: 'fine', text: 'Every trade, draft pick and roster move this season, newest first. Tap a player for his game log and contract (players with stats this season).' }),
    el('div', { className: 'picks' }, [
      selectBox('Team', state.moveTeam, [['all', 'All teams'], ...teamCodes.map((t): [string, string] => [t, `${t} ${teams.get(t)?.name ?? ''}`.trim()])], (v) => { state.moveTeam = v; state.moveShown = MOVES_PAGE; draw(); }),
      selectBox('Position', state.moveGroup, [['all', 'All positions'], ...groups.map((g): [string, string] => [g, g])], (v) => { state.moveGroup = v; state.moveShown = MOVES_PAGE; draw(); }),
    ]),
    el('p', { className: 'fine', text: `${list.length} moves` }),
    list.length ? el('ol', { className: 'players moves' }, items) : el('p', { className: 'fine', text: 'No moves match.' }),
    list.length > shown.length ? el('button', { className: 'more', text: `Show more (${list.length - shown.length} left)`, onClick: () => { state.moveShown += MOVES_PAGE; draw(); } }) : null,
    el('p', { className: 'fine', text: 'In-season moves are read from week-to-week changes in the weekly rosters, so they are dated by week, and a player who changed teams without a matching trade is shown as a trade or waiver claim. The trades file is updated a few times a year; its date is in Sources below.' }),
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
    el('p', { text: `Verdict: playoff odds from ${PLAYOFF_SIM.simulations.toLocaleString('en-US')} simulated finishes (team strength blends adjusted EPA with point differential; standings ties broken at random, not by NFL tiebreakers). Odds ${pct(VERDICT.contenderOdds)}+ buy for a unit graded under ${VERDICT.holeGrade}; ${pct(VERDICT.sellerOdds)} or less sell; in between, the schedule left decides.` }),
    el('p', { text: 'Player scores: percentile within the position of a weighted mix of stat percentiles, among players over a per-game volume minimum. Offensive linemen are graded by team instead (Production, then OL); specialists are not ranked. Open data has no good per-player stat for either.' }),
    el('p', { text: 'Offensive line: pass protection = QB pressures (PFR) per dropback; run blocking = rushing yards before contact per carry (PFR). When a buyer\'s weakest unit is pass O or rush O, it shops for the weaker half: the line, or the pass catchers (EPA per non-sack attempt) or backs (yards after contact per carry).' }),
    el('p', { text: 'Player pages (Production, then search, or "Game log and contract" on a ranked player): one line per game from the nflverse weekly stats, for every quarterback, back, receiver, tight end and defender with a stat this season. Snap% is his share of the team\'s offense or defense snaps. PPR = fantasy points with a point per catch. Contract years show base salary, cap hit and cash paid.' }),
    el('p', { text: `Value: cap hit is what a player counts against his team's cap this season (from the contract's yearly rows). Production per $: a ranked player's production score is worth the cap hit at the same percentile of pay at his position; surplus is that worth minus his own cap hit. Cheap producers (often rookie deals) come out best and expensive players who aren't producing worst. Pay is steep at the top of a position, so its highest-paid players only break even by being its very best producers, and a few percentile points there can move worth by many millions. Cap value by team (Front office) adds the surplus up by team; it ignores dead money, linemen, specialists and players without enough play to rank, teams that spend more on ranked players tend to score lower, and a quarterback's surplus can swing a team's total. Fantasy per $ = PPR points per $1M of cap hit. Best rosters and lineups are found exactly, with cap hits rounded up to the nearest $${Math.max(VALUE.fantasy.budgetStepMillions, VALUE.roster.budgetStepMillions)}M; the weekly lineup uses the latest week with every game played.` }),
    el('p', { text: `Base salary left: the part of this season's base salary still to be paid (${TRADE_COST.payWeeks} weekly checks), which a team trading for the player takes on. It leaves out bonuses and incentives; the signing bonus stays with the old team. Team cap room isn't shown: the open contracts data has no dead money, so it can't be computed reliably.` }),
    el('h3', { text: 'Credits' }),
    el('p', { text: 'Data from nflverse (nflverse-data releases): play-by-play and EPA from nflfastR, schedules, weekly rosters and player stats, trades and draft picks, NFL Next Gen Stats, Pro Football Reference advanced stats and snap counts, and contracts from OverTheCap. Thanks to the nflverse maintainers and their upstream sources. Not affiliated with the NFL or any team.' }),
    data.ratingsCredit ? el('p', { text: `Ratings: ${data.ratingsCredit}` }) : null,
  ]);
}

// ------------------------------------------------------------------ page

function draw(): void {
  const team = state.team ? teams.get(state.team) : undefined;
  const profile = state.player ? profiles.get(state.player) : undefined;
  const tabs = (['value', 'players', 'office', 'moves'] as const).map((v) => el('button', {
    className: `tab${state.view === v ? ' on' : ''}`,
    text: v === 'value' ? 'Value' : v === 'players' ? 'Production' : v === 'office' ? 'Front office' : 'Moves',
    attrs: { 'aria-pressed': String(state.view === v), 'data-view': v },
    onClick: () => { state.view = v; draw(); },
  }));
  render(el('div', { className: 'shell' }, [
    el('header', { className: 'top' }, [
      el('div', { className: 'brand' }, [
        el('h1', { text: 'Roster Grader' }),
        el('p', { className: 'asof', text: `${data.season} season · through week ${data.throughWeek} · data as of ${fmtDate(data.dataAsOf)}` }),
      ]),
      el('nav', { className: 'tabs' }, tabs),
    ]),
    data.sample ? el('p', { className: 'banner', text: 'Sample data (weeks 1-2 of 2026): the nightly refresh has not run yet.' }) : null,
    el('main', {}, [state.view === 'value' ? valueView() : state.view === 'players' ? playersView() : state.view === 'office' ? officeView() : movesView(), footer()]),
    team ? teamSheet(team) : null,
    profile ? playerSheet(profile) : null,
  ]));
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.player) closePlayer();
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
draw();
