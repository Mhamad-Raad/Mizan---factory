// Prints the Content-Security-Policy source list for every inline <script> of a built page:
// `'sha256-…' 'sha256-…'`, each hash over that script's exact text, byte for byte, as the
// browser computes it. The old shell version hashed both scripts as one with the whitespace
// stripped, which matched neither, so production would have blocked them (security review).
//
//   node ops/docker/csp-hashes.mjs apps/web/dist/index.html
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'apps/web/dist/index.html';
const html = readFileSync(file, 'utf8');
const hashes = [];
// An inline script: an opening tag with no src attribute, then everything up to </script>.
for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  const body = match[1] ?? '';
  if (body.trim() === '') continue;
  hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}
if (hashes.length === 0) {
  console.error(`no inline script found in ${file}`);
  process.exit(1);
}
process.stdout.write(`${hashes.join(' ')}\n`);
