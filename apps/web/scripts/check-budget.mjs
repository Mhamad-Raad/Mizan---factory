/**
 * Bundle budget (NFR-03): the app shell must stay under 250 kB gzipped, because the reference
 * device is a 2 GB Android phone on a throttled connection. CI fails if it grows past that.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_KB = 250;
const dist = new URL('../dist/assets', import.meta.url).pathname;

let total = 0;
const rows = [];
for (const file of readdirSync(dist)) {
  if (!file.endsWith('.js')) continue;
  const path = join(dist, file);
  const gzipped = gzipSync(readFileSync(path)).length;
  total += gzipped;
  rows.push(`  ${file.padEnd(40)} ${(gzipped / 1024).toFixed(1)} kB gzipped (${(statSync(path).size / 1024).toFixed(1)} kB raw)`);
}

console.log(rows.sort().join('\n'));
const totalKb = total / 1024;
console.log(`\n  total JavaScript: ${totalKb.toFixed(1)} kB gzipped (budget ${BUDGET_KB} kB)`);

if (totalKb > BUDGET_KB) {
  console.error(`\nbundle budget exceeded by ${(totalKb - BUDGET_KB).toFixed(1)} kB`);
  process.exit(1);
}
