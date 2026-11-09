/**
 * npm run refresh                       download from nflverse and rebuild data/
 * npm run refresh -- --offline <dir>    rebuild from files already in <dir> (named as in .cache/raw), no network
 *
 * REFRESH_DATE=YYYY-MM-DD overrides "today" (America/New_York), e.g. to rebuild an earlier day.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { refresh, type Fetcher } from './refresh.ts';
import { NFLVERSE_BASE } from './sources.ts';

const TIME_ZONE = 'America/New_York';
const DOWNLOAD_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const offlineAt = args.indexOf('--offline');
const offlineDir = offlineAt >= 0 ? args[offlineAt + 1] : undefined;
const today = process.env.REFRESH_DATE ?? new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`REFRESH_DATE must be YYYY-MM-DD, got ${today}`);

/** Network fetcher: nflverse release files only. */
const network: Fetcher = async (url) => {
  if (!url.startsWith(`${NFLVERSE_BASE}/`)) return { ok: false, status: 0, error: 'not an nflverse release URL' };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), lastModified: res.headers.get('last-modified') };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
};

/** Offline fetcher: the same file names in a local folder; the file's mtime stands in for Last-Modified. */
const offline = (dir: string): Fetcher => async (url) => {
  const rel = url.slice(NFLVERSE_BASE.length + 1).replace(/\//g, '__');
  const p = join(dir, rel);
  if (!existsSync(p)) return { ok: false, status: 404 };
  const hdr = `${p}.last-modified`;
  const lastModified = existsSync(hdr) ? readFileSync(hdr, 'utf8').trim() : statSync(p).mtime.toUTCString();
  return { ok: true, status: 200, bytes: readFileSync(p), lastModified };
};

const root = resolve('.');
const res = await refresh({
  root,
  today,
  fetcher: offlineDir ? offline(resolve(offlineDir)) : network,
  rawDir: offlineDir ? undefined : join(root, '.cache', 'raw'),
  log: (l) => console.log(l),
});
const counts = res.output.teams.reduce<Record<string, number>>((m, t) => ({ ...m, [t.verdict]: (m[t.verdict] ?? 0) + 1 }), {});
console.log(`season ${res.output.season}, through week ${res.output.throughWeek}, data as of ${res.output.dataAsOf}`);
console.log(`${res.output.teams.length} teams (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${res.output.players.length} ranked players`);
console.log(`wrote ${res.written.join(', ')}`);
