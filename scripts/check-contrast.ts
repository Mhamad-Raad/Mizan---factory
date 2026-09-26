/**
 * Contrast of the token sheet (spec 3.2.4, NFR-10): WCAG 2.1 AA computed in CI from the token
 * values themselves, so a colour cannot be changed to something unreadable without the build
 * saying so. Targets: 4.5:1 for text, 3:1 for large text, icons and control boundaries.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TOKENS = join(ROOT, 'packages/ui/src/tokens.css');

if (!existsSync(TOKENS)) {
  console.log('contrast: no token sheet yet — nothing to check');
  process.exit(0);
}

const css = readFileSync(TOKENS, 'utf8');

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r as number) + 0.7152 * channel(g as number) + 0.0722 * channel(b as number);
}

function ratio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light as number) + 0.05) / ((dark as number) + 0.05);
}

/** Reads one theme block into a token map. */
function tokensOf(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`token sheet has no "${selector}" block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const map: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    map[match[1] as string] = match[2] as string;
  }
  return map;
}

interface Check {
  foreground: string;
  background: string;
  minimum: number;
  what: string;
}

const CHECKS: Check[] = [
  { foreground: '--color-text', background: '--color-surface', minimum: 4.5, what: 'body text on a card' },
  { foreground: '--color-text', background: '--color-bg', minimum: 4.5, what: 'body text on the page' },
  { foreground: '--color-text-muted', background: '--color-surface', minimum: 4.5, what: 'muted text on a card' },
  { foreground: '--color-text-muted', background: '--color-surface-2', minimum: 4.5, what: 'muted text on a fill' },
  { foreground: '--color-primary', background: '--color-surface', minimum: 3, what: 'primary on a card' },
  { foreground: '--color-on-primary', background: '--color-primary', minimum: 4.5, what: 'label on the primary button' },
  { foreground: '--color-on-primary-soft', background: '--color-primary-soft', minimum: 4.5, what: 'text on a soft chip' },
  { foreground: '--color-success', background: '--color-surface', minimum: 4.5, what: 'paid chip text' },
  { foreground: '--color-success', background: '--color-success-soft', minimum: 4.5, what: 'paid chip on its fill' },
  { foreground: '--color-warning', background: '--color-surface', minimum: 4.5, what: 'partially-paid chip text' },
  { foreground: '--color-warning', background: '--color-warning-soft', minimum: 4.5, what: 'warning chip on its fill' },
  { foreground: '--color-danger', background: '--color-surface', minimum: 4.5, what: 'unpaid chip text' },
  { foreground: '--color-danger', background: '--color-danger-soft', minimum: 4.5, what: 'danger chip on its fill' },
  { foreground: '--color-on-header', background: '--color-header', minimum: 4.5, what: 'header text' },
  /*
   * The two pairs the system-wide review had to add, because the components hard-coded white
   * instead of naming a token — so nothing checked them, and in the dark theme they were
   * 1.71:1 (the label on the button that voids an order) and 2.12:1 (the knob that says
   * whether a setting is on). A pair that is not in this list is a pair nobody measures.
   */
  { foreground: '--color-on-danger', background: '--color-danger', minimum: 4.5, what: 'label on the danger button' },
  { foreground: '--color-on-primary', background: '--color-primary', minimum: 3, what: 'toggle knob when it is on' },
  { foreground: '--color-surface', background: '--color-border-strong', minimum: 3, what: 'toggle knob when it is off' },
  { foreground: '--color-border-strong', background: '--color-surface', minimum: 3, what: 'input boundary' },
  { foreground: '--color-focus', background: '--color-surface', minimum: 3, what: 'focus ring' },
];

const themes: [string, Record<string, string>][] = [
  // The light semantic tokens live in the `:root, [data-theme='light']` block, not the first
  // `:root` (which now carries only primitives), so the light theme is read by its own selector.
  ['light', tokensOf('[data-theme=\'light\']')],
  ['dark', tokensOf('[data-theme=\'dark\']')],
];

const failures: string[] = [];
const report: string[] = [];

for (const [theme, tokens] of themes) {
  for (const check of CHECKS) {
    const foreground = tokens[check.foreground];
    const background = tokens[check.background];
    if (!foreground || !background) {
      failures.push(`${theme}: ${check.foreground} or ${check.background} is missing from the sheet`);
      continue;
    }
    const measured = ratio(foreground, background);
    const line = `  ${theme.padEnd(5)} ${check.what.padEnd(32)} ${measured.toFixed(2)}:1 (needs ${check.minimum}:1)`;
    report.push(line);
    if (measured < check.minimum) failures.push(`${theme}: ${check.what} is ${measured.toFixed(2)}:1, needs ${check.minimum}:1`);
  }
}

console.log(report.join('\n'));

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\ncontrast ok: ${CHECKS.length * themes.length} pairs meet WCAG 2.1 AA.`);
