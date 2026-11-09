/**
 * The refresh pipeline on fixture files (a week-1-2 slice of real nflverse data), with no network: the fetcher
 * reads test/fixtures/raw, and global fetch is stubbed to fail the test if anything tries the network.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATINGS_SOURCE } from '../src/model/config.ts';
import type { ModelOutput } from '../src/model/types.ts';
import { OUTPUT_FILE, refresh, snapshotPath, type Fetcher } from '../pipeline/refresh.ts';
import { NFLVERSE_BASE } from '../pipeline/sources.ts';

const RAW = join(__dirname, 'fixtures', 'raw');
const TODAY = '2026-09-24';

const fixtureFetcher = (override: Record<string, 'fail' | 'garbage' | Uint8Array> = {}): Fetcher => async (url) => {
  expect(url.startsWith(`${NFLVERSE_BASE}/`)).toBe(true);
  const name = url.slice(NFLVERSE_BASE.length + 1).replace(/\//g, '__');
  const o = Object.entries(override).find(([k]) => name.startsWith(k))?.[1];
  if (o === 'fail') return { ok: false, status: 503 };
  if (o === 'garbage') return { ok: true, status: 200, bytes: new TextEncoder().encode('not,a\n"broken'), lastModified: 'Tue, 22 Sep 2026 12:00:00 GMT' };
  if (o instanceof Uint8Array) return { ok: true, status: 200, bytes: o, lastModified: 'Tue, 22 Sep 2026 12:00:00 GMT' };
  const p = join(RAW, name);
  if (!existsSync(p)) return { ok: false, status: 404 };
  return { ok: true, status: 200, bytes: readFileSync(p), lastModified: readFileSync(`${p}.last-modified`, 'utf8').trim() };
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roster-grader-'));
  vi.stubGlobal('fetch', () => {
    throw new Error('network call in a test');
  });
});
afterEach(() => vi.unstubAllGlobals());

const out = (): ModelOutput => JSON.parse(readFileSync(join(root, OUTPUT_FILE), 'utf8')) as ModelOutput;

describe('refresh pipeline (fixtures, no network)', () => {
  it('builds the data file: 32 graded teams, verdicts, ranked players, every source fresh', async () => {
    const res = await refresh({ root, today: TODAY, fetcher: fixtureFetcher() });
    const o = out();
    expect(o.season).toBe(2026);
    expect(o.throughWeek).toBe(2);
    expect(o.teams).toHaveLength(32);
    expect(o.sample).toBe(false);
    for (const t of o.teams) {
      expect(t.wins + t.losses + t.ties).toBe(2);
      for (const u of Object.values(t.units)) {
        expect(u.grade).toBeGreaterThanOrEqual(0);
        expect(u.grade).toBeLessThanOrEqual(100);
      }
      expect(t.reason.length).toBeGreaterThan(0);
      if (t.verdict === 'buy') expect(t.need).not.toBeNull();
    }
    expect(new Set(o.teams.flatMap((t) => Object.values(t.units).map((u) => u.rank)))).toContain(1);
    expect(o.players.length).toBeGreaterThan(100);
    expect(o.players.some((p) => p.contract)).toBe(true);
    expect(o.rankingModes).toEqual(['production']);
    expect(o.sources.map((s) => s.state)).toEqual(Array(12).fill('fresh'));
    expect(o.dataAsOf).toBe('2026-09-21');
    expect(res.written).toContain(snapshotPath('pfr_def'));
  });

  it('keeps the last good copy when a download fails, a file is unreadable, or it has less data', async () => {
    await refresh({ root, today: TODAY, fetcher: fixtureFetcher() });
    const before = readFileSync(join(root, snapshotPath('pfr_def')), 'utf8');
    // pfr_def: download fails; snaps: unreadable; ngs_rushing: a valid file with fewer weeks than our copy
    const ngsLess = new TextEncoder().encode('season,season_type,week,player_gsis_id,rush_attempts,rush_yards_over_expected_per_att\n2026,REG,1,00-0000001,5,0.1\n2026,REG,0,00-0000001,5,0.1\n');
    const { gzipSync } = await import('node:zlib');
    const res = await refresh({
      root, today: TODAY,
      fetcher: fixtureFetcher({ 'pfr_advstats__advstats_week_def': 'fail', snap_counts__: 'garbage', nextgen_stats__ngs_rushing: gzipSync(ngsLess) }),
    });
    const s = Object.fromEntries(res.statuses.map((x) => [x.id, x]));
    expect(s.pfr_def?.state).toBe('kept');
    expect(s.pfr_def?.note).toMatch(/download failed \(HTTP 503\); using our last good copy/);
    expect(s.snaps?.state).toBe('kept');
    expect(s.ngs_rushing?.state).toBe('kept');
    expect(s.ngs_rushing?.note).toMatch(/less data/);
    expect(s.pfr_def?.asOf).toBe('2026-09-21');
    expect(readFileSync(join(root, snapshotPath('pfr_def')), 'utf8')).toBe(before);
    expect(out().players.some((p) => p.stats.some((x) => x.key === 'pressuresPer100'))).toBe(true);
  });

  it('a file with a renamed column is rejected, not read as zeros', async () => {
    await refresh({ root, today: TODAY, fetcher: fixtureFetcher() });
    const raw = readFileSync(join(RAW, 'pfr_advstats__advstats_week_def_2026.csv'), 'utf8').replace('def_pressures', 'def_pressures_total');
    const res = await refresh({ root, today: TODAY, fetcher: fixtureFetcher({ 'pfr_advstats__advstats_week_def': new TextEncoder().encode(raw) }) });
    const s = res.statuses.find((x) => x.id === 'pfr_def');
    expect(s?.state).toBe('kept');
    expect(s?.note).toMatch(/could not read the file; using our last good copy/);
  });

  it('a missing optional source never fails the page; it is listed as missing', async () => {
    const res = await refresh({ root, today: TODAY, fetcher: fixtureFetcher({ contracts__: 'fail', 'pfr_advstats__advstats_week_def': 'fail' }) });
    const s = Object.fromEntries(res.statuses.map((x) => [x.id, x]));
    expect(s.contracts?.state).toBe('missing');
    expect(s.pfr_def?.state).toBe('missing');
    expect(out().teams).toHaveLength(32);
    expect(out().players.every((p) => p.contract === null)).toBe(true);
  });

  it('a required source with no copy at all fails the refresh (the workflow then commits nothing)', async () => {
    await expect(refresh({ root, today: TODAY, fetcher: fixtureFetcher({ pbp__: 'fail' }) })).rejects.toThrow(/Play-by-play/);
    expect(existsSync(join(root, OUTPUT_FILE))).toBe(false);
  });

  it('flags a source as lagging when games that should be in it are not', async () => {
    // a week later, week 3 has been played by the schedule (scores filled in) but no other file has it
    const sched = readFileSync(join(RAW, 'schedules__games.csv'), 'utf8').split('\n');
    const header = sched[0]!.split(',');
    const [wk, hs, as] = ['week', 'home_score', 'away_score'].map((c) => header.indexOf(c));
    const later = sched.map((line, i) => {
      const f = line.split(',');
      if (i === 0 || f[wk!] !== '3') return line;
      f[hs!] = '24';
      f[as!] = '17';
      return f.join(',');
    }).join('\n');
    const res = await refresh({ root, today: '2026-10-02', fetcher: fixtureFetcher({ schedules__: new TextEncoder().encode(later) }) });
    const pbp = res.statuses.find((x) => x.id === 'pbp');
    expect(pbp?.state).toBe('lagging');
    expect(pbp?.coverage).toBe('through week 2');
    expect(pbp?.note).toMatch(/wk 3/);
  });

  it('the ratings slot is off by default and refuses data we may not republish', async () => {
    expect(RATINGS_SOURCE.enabled).toBe(false);
    writeFileSync(join(root, 'ratings.json'), '{}');
    const cfg = { ...RATINGS_SOURCE, enabled: true, label: 'X', license: 'test', file: 'ratings.json', republishAllowed: false };
    await expect(refresh({ root, today: TODAY, fetcher: fixtureFetcher(), ratingsCfg: cfg })).rejects.toThrow(/republish/);
    const ok = await refresh({ root, today: TODAY, fetcher: fixtureFetcher(), ratingsCfg: { ...cfg, republishAllowed: true } });
    expect(ok.output.rankingModes).toEqual(['production', 'ratings', 'composite']);
  });

  it('the committed sample page data matches what the fixtures produce', async () => {
    const res = await refresh({ root, today: TODAY, fetcher: fixtureFetcher() });
    const sample = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sample-output.json'), 'utf8')) as ModelOutput;
    expect(sample.sample).toBe(true);
    expect({ ...sample, sample: false }).toEqual(JSON.parse(JSON.stringify(res.output)));
  });
});

