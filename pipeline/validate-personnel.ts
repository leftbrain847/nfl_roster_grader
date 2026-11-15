/**
 * Validate the snap-count personnel estimate against FTN participation (exact per-play personnel) for a completed
 * season, and refit its two scales. No network: point it at files already downloaded (named as nflverse names them).
 *
 *   node pipeline/validate-personnel.ts <season> <snap_counts.csv> <pbp_participation.csv> <play_by_play.csv.gz> <games.csv>
 *
 * Prints, for 11 personnel, 12 personnel and heavy sets (2+ TE or 2+ RB): mean absolute error (rate points),
 * bias, and Spearman rank correlation, by team over the season and by team-game. "LOO" refits the scales leaving
 * each team out in turn, so its error is the honest out-of-sample one.
 */
import { readFileSync } from 'node:fs';
import { parseCsv } from './csv.ts';
import { decode, extractParticipation, extractPbpPlays, extractSchedules, extractSnaps } from './extract.ts';
import { PERSONNEL, type PersonnelConfig } from '../src/model/config.ts';
import { exactPersonnel, personnelEstimate } from '../src/model/personnel.ts';
import type { Participation, PlayEpa } from '../src/model/types.ts';

const [seasonArg, snapsFile, partFile, pbpFile, gamesFile] = process.argv.slice(2);
if (!seasonArg || !snapsFile || !partFile || !pbpFile || !gamesFile) throw new Error('usage: validate-personnel.ts <season> <snaps> <participation> <pbp> <games>');
const season = Number(seasonArg);
const read = (f: string) => parseCsv(decode(readFileSync(f), f));

const games = extractSchedules(read(gamesFile), season).data;
const snaps = extractSnaps(read(snapsFile), season).data;
const part = extractParticipation(read(partFile), season).data;
const plays = extractPbpPlays(read(pbpFile), season).data;

type Rates = { p11: number; p12: number; heavy: number };
const KEYS = ['p11', 'p12', 'heavy'] as const;

/** Exact rates per team (season) and per team-game. */
const exactSeason = exactPersonnel(season, part, plays, '')!;
const perGame = new Map<string, Rates>();
for (const [g, rows] of Object.entries(part)) {
  const one: Participation = { [g]: rows };
  const ex = exactPersonnel(season, one, { [g]: plays[g] ?? [] } as PlayEpa, '');
  for (const [t, x] of Object.entries(ex?.teams ?? {})) perGame.set(`${t}|${g}`, x);
}

function estimates(cfg: PersonnelConfig) {
  return personnelEstimate(snaps, games, cfg);
}

function rank(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (ra[i]! - ma) * (rb[i]! - mb); va += (ra[i]! - ma) ** 2; vb += (rb[i]! - mb) ** 2; }
  return c / Math.sqrt(va * vb);
}
function report(label: string, pairs: { est: Rates; act: Rates }[]): void {
  const parts = KEYS.map((k) => {
    const e = pairs.map((p) => p.est[k]), a = pairs.map((p) => p.act[k]);
    const mae = e.reduce((s, x, i) => s + Math.abs(x - a[i]!), 0) / e.length;
    const bias = e.reduce((s, x, i) => s + x - a[i]!, 0) / e.length;
    return `${k === 'p11' ? '11' : k === 'p12' ? '12' : 'heavy'} MAE ${(100 * mae).toFixed(1)} bias ${(100 * bias >= 0 ? '+' : '')}${(100 * bias).toFixed(1)} rho ${spearman(e, a).toFixed(2)}`;
  });
  console.log(`${label.padEnd(34)} ${parts.join(' | ')}  (n=${pairs.length})`);
}

/** Least-squares scale through the origin for one rate, over teams' season numbers. */
function fitScales(teams: string[]): PersonnelConfig {
  const est = estimates({ ...PERSONNEL, heavyScale: 1, twoTeScale: 1 });
  let hx = 0, hy = 0, tx = 0, ty = 0;
  for (const t of teams) {
    const e = est[t]?.season, a = exactSeason.teams[t];
    if (!e || !a) continue;
    const base = Math.min(1, Math.max(0, e.te - 1)) + Math.min(1, Math.max(0, e.rb - 1));
    const two = Math.min(1, Math.max(0, e.te - 1));
    hx += base * base; hy += base * a.heavy; tx += two * two; ty += two * a.p12;
  }
  return { ...PERSONNEL, heavyScale: hx ? hy / hx : 1, twoTeScale: tx ? ty / tx : 1 };
}

const teams = Object.keys(exactSeason.teams).sort();
const fitted = fitScales(teams);
console.log(`season ${season}: ${teams.length} teams, ${[...perGame.keys()].length} team-games`);
console.log(`scales in config: heavy ${PERSONNEL.heavyScale}, 12 ${PERSONNEL.twoTeScale}; refit on all teams: heavy ${fitted.heavyScale.toFixed(3)}, 12 ${fitted.twoTeScale.toFixed(3)}`);

const pairsFor = (cfg: PersonnelConfig, level: 'season' | 'game', only?: string[]): { est: Rates; act: Rates }[] => {
  const est = estimates(cfg);
  const out: { est: Rates; act: Rates }[] = [];
  for (const t of only ?? teams) {
    const e = est[t];
    if (!e) continue;
    if (level === 'season') { const a = exactSeason.teams[t]; if (a) out.push({ est: e.season, act: a }); continue; }
    for (const w of e.weeks) {
      const g = games.find((x) => x.week === w.wk && (x.home === t || x.away === t));
      const a = g ? perGame.get(`${t}|${g.id}`) : undefined;
      if (a) out.push({ est: w, act: a });
    }
  }
  return out;
};

report('config scales, by team (season)', pairsFor(PERSONNEL, 'season'));
report('config scales, by team-game', pairsFor(PERSONNEL, 'game'));
const unscaled = { ...PERSONNEL, heavyScale: 1, twoTeScale: 1 };
report('no scaling (min-spread), by team', pairsFor(unscaled, 'season'));
// leave one team out: fit on 31, predict the 32nd
const loo = teams.flatMap((t) => pairsFor(fitScales(teams.filter((x) => x !== t)), 'season', [t]));
report('LOO refit, by team (season)', loo);
const looGames = teams.flatMap((t) => pairsFor(fitScales(teams.filter((x) => x !== t)), 'game', [t]));
report('LOO refit, by team-game', looGames);
