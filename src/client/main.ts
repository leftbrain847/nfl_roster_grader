/**
 * Roster Grader page. Reads the model output baked in at build time (no network), renders the league table, a team
 * sheet (unit bars, verdict, reason, buy targets) and position rankings. Text goes in as text, never HTML.
 */
import data from '@roster-data';
import {
  ADJUST, LINE, LINE_KEYS, LINE_TARGETS, PLAYOFF_SIM, TRADE_COST, POSITION_GROUPS, POSITIONS, STATS, UNIT_KEYS, UNITS, VERDICT,
  type LineKey, type PositionGroup, type RankingMode, type UnitKey, type Verdict,
} from '../model/config.ts';
import { ordinal } from '../model/stats.ts';
import type { LineTarget, PlayerContract, PlayerResult, TeamResult } from '../model/types.ts';
import { el, render } from './ui';

type SortKey = 'team' | 'verdict' | 'odds' | UnitKey;
type View = 'league' | 'players';

const state = {
  view: 'league' as View,
  sort: 'odds' as SortKey,
  desc: true,
  filter: 'all' as Verdict | 'all',
  group: 'QB' as PositionGroup | 'OL',
  mode: 'production' as RankingMode,
  team: null as string | null,
  open: new Set<string>(),
};

const players = new Map(data.players.map((p) => [p.id, p]));
const teams = new Map(data.teams.map((t) => [t.team, t]));
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
    el('p', { className: 'fine', text: `Grades are 0-100 (50 = league average) from opponent-adjusted EPA per play. Odds: ${PLAYOFF_SIM.label.toLowerCase()}. Tap a team.` }),
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
  return c.tradeCostMillions === null ? terms : `${terms} · trade cost ≈ $${c.tradeCostMillions.toFixed(2)}M`;
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
    el('article', { className: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${t.name} roster grade` } }, [
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
    el('div', { className: 'chips', attrs: { role: 'group', 'aria-label': 'Position' } }, groups),
    modes,
    el('h2', { className: 'pos-title', text: `${pos.label}s` }),
    el('p', { className: 'fine', text: `${weights}. Minimum ${pos.minimum.perTeamGame} ${minWord} per team game. ${list.length} qualified.` }),
    el('ol', { className: 'players' }, list.map((p, i) => playerCard(p, { showTeam: true, rank: i + 1 }))),
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
    el('p', { text: 'Player scores: percentile within the position of a weighted mix of stat percentiles, among players over a per-game volume minimum. Offensive linemen are graded by team instead (Players, then OL); specialists are not ranked. Open data has no good per-player stat for either.' }),
    el('p', { text: 'Offensive line: pass protection = QB pressures (PFR) per dropback; run blocking = rushing yards before contact per carry (PFR). When a buyer\'s weakest unit is pass O or rush O, it shops for the weaker half: the line, or the pass catchers (EPA per non-sack attempt) or backs (yards after contact per carry).' }),
    el('p', { text: `Trade cost: the rest of this season's base salary, paid in ${TRADE_COST.payWeeks} weekly checks (the signing bonus stays with the old team). Team cap room isn't shown: the open contracts data has no dead money, so it can't be computed reliably.` }),
    el('h3', { text: 'Credits' }),
    el('p', { text: 'Data from nflverse (nflverse-data releases): play-by-play and EPA from nflfastR, schedules, weekly rosters, NFL Next Gen Stats, Pro Football Reference advanced stats and snap counts, and contracts from OverTheCap. Thanks to the nflverse maintainers and their upstream sources. Not affiliated with the NFL or any team.' }),
    data.ratingsCredit ? el('p', { text: `Ratings: ${data.ratingsCredit}` }) : null,
  ]);
}

// ------------------------------------------------------------------ page

function draw(): void {
  const team = state.team ? teams.get(state.team) : undefined;
  const tabs = (['league', 'players'] as const).map((v) => el('button', {
    className: `tab${state.view === v ? ' on' : ''}`,
    text: v === 'league' ? 'League' : 'Players',
    attrs: { 'aria-pressed': String(state.view === v) },
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
    el('main', {}, [state.view === 'league' ? leagueView() : playersView(), footer()]),
    team ? teamSheet(team) : null,
  ]));
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.team) closeTeam(); });
const fromHash = /^#team-([a-z]{2,3})$/.exec(location.hash)?.[1]?.toUpperCase();
if (fromHash && teams.has(fromHash)) state.team = fromHash;
draw();
