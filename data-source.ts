/**
 * Which data file the page is built with: data/roster_grader.json (written by the nightly refresh) when it exists,
 * else the committed sample made from the test fixtures (the page then shows a "sample data" banner). Shared by
 * vite.config.ts and demo/vite.config.ts.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const real = fileURLToPath(new URL('./data/roster_grader.json', import.meta.url));
const sample = fileURLToPath(new URL('./test/fixtures/sample-output.json', import.meta.url));

export const rosterDataAlias = { '@roster-data': existsSync(real) ? real : sample };
