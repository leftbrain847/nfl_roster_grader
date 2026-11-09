/**
 * npm run sample: rebuild test/fixtures/sample-output.json, the stand-in data the page is built with when
 * data/roster_grader.json doesn't exist yet (CI, a fresh clone). Made from the fixture files, marked sample: true
 * so the page shows a "sample data" banner. A test checks it stays in step with the fixtures.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OUTPUT_FILE, refresh, type Fetcher } from './refresh.ts';
import { NFLVERSE_BASE } from './sources.ts';

export const SAMPLE_TODAY = '2026-09-24';
const RAW = resolve('test/fixtures/raw');

const fixtures: Fetcher = async (url) => {
  const p = join(RAW, url.slice(NFLVERSE_BASE.length + 1).replace(/\//g, '__'));
  if (!existsSync(p)) return { ok: false, status: 404 };
  return { ok: true, status: 200, bytes: readFileSync(p), lastModified: readFileSync(`${p}.last-modified`, 'utf8').trim() };
};

const root = mkdtempSync(join(tmpdir(), 'roster-sample-'));
await refresh({ root, today: SAMPLE_TODAY, fetcher: fixtures });
const out = JSON.parse(readFileSync(join(root, OUTPUT_FILE), 'utf8'));
writeFileSync('test/fixtures/sample-output.json', `${JSON.stringify({ ...out, sample: true })}\n`);
console.log('wrote test/fixtures/sample-output.json');
