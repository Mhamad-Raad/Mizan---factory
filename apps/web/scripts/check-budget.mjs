/**
 * Bundle budget (NFR-03): **initial** JavaScript ≤ 250 kB gzipped, with route-level code
 * splitting — because the reference device is a 2 GB Android phone on a 400 kbps connection,
 * where every kilobyte of the first load is two and a half milliseconds of somebody waiting.
 *
 * "Initial" is the part NFR-03 bounds, and since I6 it is no longer the whole build: the entry
 * chunk and everything `index.html` pulls in with it, and not the twenty-nine route chunks the
 * browser fetches only when somebody opens that screen. Summing every chunk — which this script
 * used to do — would punish the splitting that made the first paint fast (7.6 s → measured
 * again in REVIEW-I6), so both figures are printed and only the first one is a budget.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INITIAL_BUDGET_KB = 250;
const dist = new URL('../dist', import.meta.url).pathname;
const assets = join(dist, 'assets');

const html = readFileSync(join(dist, 'index.html'), 'utf8');

/**
 * Everything the document itself asks for, transitively.
 *
 * `index.html` carries the entry script and a `modulepreload` per chunk the entry statically
 * imports; a lazily-imported route is in neither, which is exactly the distinction NFR-03
 * draws. Following the entry's own imports as well keeps the figure honest if a future build
 * stops emitting the preloads.
 */
const referenced = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1]));

const follow = (file) => {
  const source = readFileSync(join(assets, file), 'utf8');
  for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) {
    if (!referenced.has(match[1])) {
      referenced.add(match[1]);
      follow(match[1]);
    }
  }
};
for (const file of [...referenced]) follow(file);

let initial = 0;
let total = 0;
const rows = [];

for (const file of readdirSync(assets)) {
  if (!file.endsWith('.js')) continue;
  const path = join(assets, file);
  const gzipped = gzipSync(readFileSync(path)).length;
  total += gzipped;
  const isInitial = referenced.has(file);
  if (isInitial) initial += gzipped;
  // Only the initial chunks are listed one by one; twenty-nine route chunks of half a
  // kilobyte each are noise on a build log.
  if (isInitial) {
    rows.push(
      `  ${file.padEnd(40)} ${(gzipped / 1024).toFixed(1)} kB gzipped (${(statSync(path).size / 1024).toFixed(1)} kB raw)`,
    );
  }
}

const routeChunks = readdirSync(assets).filter((file) => file.endsWith('.js') && !referenced.has(file)).length;

console.log(rows.sort().join('\n'));
const initialKb = initial / 1024;
console.log(
  `\n  initial JavaScript: ${initialKb.toFixed(1)} kB gzipped (budget ${INITIAL_BUDGET_KB} kB)` +
    `\n  the whole build:    ${(total / 1024).toFixed(1)} kB gzipped across ${routeChunks} lazy route chunks`,
);

if (initialKb > INITIAL_BUDGET_KB) {
  console.error(`\nbundle budget exceeded by ${(initialKb - INITIAL_BUDGET_KB).toFixed(1)} kB`);
  process.exit(1);
}
