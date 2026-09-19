/**
 * Translation completeness (FR-1201, rule 6): every user-visible string exists in
 * `ckb-IQ`, `ar-IQ` and `en`. This runs in CI before the build; a missing key is an error,
 * not a warning, because an untranslated key must never reach production.
 *
 * It checks four things:
 *   1. every namespace file exists for every locale;
 *   2. the three locales have exactly the same key set;
 *   3. no value is empty or left as the English source in another language by accident
 *      (identical values are allowed only for the app name and symbols);
 *   4. every `t('namespace:key')` the UI references actually exists.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES = ['ckb-IQ', 'ar-IQ', 'en'] as const;
const SOURCE_LOCALE = 'en';
const CATALOG_DIR = join(ROOT, 'packages/i18n/locales');
const SCAN_DIRS = [join(ROOT, 'apps/web/src'), join(ROOT, 'packages/ui/src')];
/** Keys that legitimately read the same in every language. */
const SAME_IN_EVERY_LANGUAGE = new Set(['common:app_name']);

const problems: string[] = [];

function readCatalog(locale: string, namespace: string): Record<string, string> {
  const file = join(CATALOG_DIR, locale, `${namespace}.json`);
  if (!existsSync(file)) {
    problems.push(`missing catalog file: ${locale}/${namespace}.json`);
    return {};
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

const namespaces = readdirSync(join(CATALOG_DIR, SOURCE_LOCALE))
  .filter((file) => extname(file) === '.json')
  .map((file) => file.replace(/\.json$/, ''))
  .sort();

if (namespaces.length === 0) problems.push('no catalogs found at all');

const known = new Set<string>();
let keyCount = 0;

for (const namespace of namespaces) {
  const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, readCatalog(locale, namespace)]));
  const source = catalogs[SOURCE_LOCALE] as Record<string, string>;

  for (const key of Object.keys(source)) {
    known.add(`${namespace}:${key}`);
    keyCount += 1;
  }

  for (const locale of LOCALES) {
    const catalog = catalogs[locale] as Record<string, string>;
    for (const key of Object.keys(source)) {
      const value = catalog[key];
      if (value === undefined) {
        problems.push(`${locale}/${namespace}.json is missing the key "${key}"`);
        continue;
      }
      if (value.trim() === '') problems.push(`${locale}/${namespace}.json has an empty value for "${key}"`);

      // ICU placeholders must survive translation, or the message renders a literal {{count}}.
      const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      const inSource = placeholders(source[key] as string).join(',');
      const inTarget = placeholders(value).join(',');
      if (inSource !== inTarget) {
        problems.push(
          `${locale}/${namespace}.json "${key}" has placeholders [${inTarget}], the source has [${inSource}]`,
        );
      }

      if (
        locale !== SOURCE_LOCALE &&
        value === source[key] &&
        !SAME_IN_EVERY_LANGUAGE.has(`${namespace}:${key}`) &&
        /[A-Za-z]/.test(value)
      ) {
        problems.push(`${locale}/${namespace}.json "${key}" is still the English source text`);
      }
    }
    for (const key of Object.keys(catalog)) {
      if (!(key in source)) problems.push(`${locale}/${namespace}.json has an extra key "${key}"`);
    }
  }
}

/** Every key the interface asks for must exist in the catalogs. */
function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx')) yield path;
  }
}

const usedKeyPattern = /\bt\(\s*'([a-z_]+:[A-Za-z0-9_.]+)'/g;
let usedCount = 0;
for (const directory of SCAN_DIRS) {
  for (const file of walk(directory)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(usedKeyPattern)) {
      const key = match[1] as string;
      usedCount += 1;
      if (!known.has(key)) {
        problems.push(`${file.replace(ROOT, '')} uses "${key}", which no catalog defines`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} translation problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nEvery user-visible string must exist in all three languages (FR-1201).\n');
  process.exit(1);
}

console.log(
  `i18n ok: ${keyCount} keys x ${LOCALES.length} languages across ${namespaces.length} namespaces; ` +
    `${usedCount} key references in the interface all resolve.`,
);
