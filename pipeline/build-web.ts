/**
 * npm run build:web -> web/roster_grader.html: the public page (homepage showcase), one self-contained HTML document
 * with the data baked in. Same build as the sprint demo, wrapped as a full document with a plain title.
 * Fails if the page has network code or needs any file beside it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_FILE = 'web/roster_grader.html';
const TITLE = 'Roster Grader';
const DESCRIPTION = 'Every NFL team graded on four units with a buy, sell or stand pat call at the trade deadline, from nflverse data.';
const NETWORK = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'WebSocket', '/api/'];

const dir = 'dist/demo';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const css = /<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/.exec(html)?.[1];
const js = /<script type="module"[^>]*src="\.\/([^"]+)"/.exec(html)?.[1];
if (!css || !js) throw new Error('build-web: the demo build is missing its script or stylesheet');
const extra = readdirSync(join(dir, 'assets')).filter((f) => `assets/${f}` !== css && `assets/${f}` !== js);
if (extra.length) throw new Error(`build-web: the page must stand alone, but the build also wrote ${extra.join(', ')}`);
const style = readFileSync(join(dir, css), 'utf8');
const script = readFileSync(join(dir, js), 'utf8');
if (/<\/style/i.test(style)) throw new Error('build-web: stylesheet contains "</style"');
const found = NETWORK.filter((n) => script.includes(n));
if (found.length) throw new Error(`build-web: the page script has network code (${found.join(', ')})`);

const page = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  `<title>${TITLE}</title>`,
  `<meta name="description" content="${DESCRIPTION}">`,
  `<style>\n${style}</style>`,
  '</head>',
  '<body>',
  '<div id="app"></div>',
  `<script type="module">\n${script.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')}</script>`,
  '</body>',
  '</html>',
  '',
].join('\n');
mkdirSync('web', { recursive: true });
writeFileSync(WEB_FILE, page);
console.log(`wrote ${WEB_FILE} (${page.length} bytes)`);
