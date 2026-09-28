#!/usr/bin/env node
// Applies machine-draft translations (scripts/i18n-2649-translations.json) for
// the #2649 restored keys to the non-English locale files. fr-CA reuses the
// fr-FR strings, matching this repo's existing convention of near-identical
// fr-CA/fr-FR copy (see apps/web/src/locales/fr-CA/remote.json today).
//
// Usage: node scripts/i18n-apply-2649-translations.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, 'apps', 'web', 'src', 'locales');

const translations = JSON.parse(readFileSync(join(__dirname, 'i18n-2649-translations.json'), 'utf8'));
translations['fr-CA'] = translations['fr-FR'];

function setDeep(obj, pathParts, value) {
  let cur = obj;
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (!(pathParts[i] in cur)) throw new Error(`missing path segment ${pathParts.slice(0, i + 1).join('.')}`);
    cur = cur[pathParts[i]];
  }
  const leaf = pathParts[pathParts.length - 1];
  if (!(leaf in cur)) throw new Error(`missing leaf ${pathParts.join('.')}`);
  const before = cur[leaf];
  cur[leaf] = value;
  return before;
}

let totalApplied = 0;
for (const [locale, entries] of Object.entries(translations)) {
  const byNamespace = new Map();
  for (const [dottedKey, value] of Object.entries(entries)) {
    const [namespace, ...rest] = dottedKey.split('.');
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push({ path: rest, value, dottedKey });
  }
  let localeApplied = 0;
  for (const [namespace, keyEntries] of byNamespace) {
    const file = join(LOCALES_DIR, locale, `${namespace}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    for (const { path, value, dottedKey } of keyEntries) {
      setDeep(json, path, value);
      localeApplied++;
    }
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
  console.log(`${locale}: applied ${localeApplied}`);
  totalApplied += localeApplied;
}
console.log(`\nTotal applied: ${totalApplied}`);
