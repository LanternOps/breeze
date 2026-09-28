#!/usr/bin/env node
// Applies the confirmed original-copy restorations in scripts/i18n-2649-fixes.json
// to apps/web/src/locales/en/*.json (dotted key -> new value, where the first
// path segment is the namespace / filename).
//
// Usage: node scripts/i18n-apply-2649-fixes.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EN_DIR = join(ROOT, 'apps', 'web', 'src', 'locales', 'en');
const FIXES = JSON.parse(readFileSync(join(__dirname, 'i18n-2649-fixes.json'), 'utf8'));

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

function main() {
  const byNamespace = new Map();
  for (const [dottedKey, value] of Object.entries(FIXES)) {
    const [namespace, ...rest] = dottedKey.split('.');
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push({ path: rest, value, dottedKey });
  }

  let applied = 0;
  for (const [namespace, entries] of byNamespace) {
    const file = join(EN_DIR, `${namespace}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    for (const { path, value, dottedKey } of entries) {
      const before = setDeep(json, path, value);
      console.log(`${dottedKey}\n  "${before}" -> "${value}"`);
      applied++;
    }
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
  console.log(`\nApplied ${applied} fixes across ${byNamespace.size} namespace file(s).`);
}

main();
