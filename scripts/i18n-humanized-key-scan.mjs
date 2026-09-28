#!/usr/bin/env node
// Scans apps/web/src/locales/en/*.json for values that are exactly the
// "humanized" form of their own key leaf — a signature of the #2340
// extraction bug (see #2649): the value was never real English copy, it's a
// mechanical rendering of the key name itself.
//
// Usage: node scripts/i18n-humanized-key-scan.mjs [--json]
//
// Detection logic lives in i18n-humanized-key-lib.mjs, shared with
// i18n-recover-original-copy.mjs and the regression test
// (apps/web/src/locales/humanizedKeyRegression.test.ts) so the heuristic
// can't drift between the scanner and the test that guards against it.
//
// This is a *candidate* list, not a verdict — see the regression test's
// frozen baseline (apps/web/src/locales/humanizedKeyBaseline.json).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHumanizedKeyPlaceholder } from './i18n-humanized-key-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EN_DIR = join(__dirname, '..', 'apps', 'web', 'src', 'locales', 'en');

function flattenJson(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenJson(v, key));
    } else if (typeof v === 'string') {
      out.push([key, v]);
    }
  }
  return out;
}

function scanFile(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const flat = flattenJson(json);
  const hits = [];
  for (const [key, value] of flat) {
    const leaf = key.split('.').pop();
    if (isHumanizedKeyPlaceholder(leaf, value)) {
      hits.push({ key, value });
    }
  }
  return hits;
}

function main() {
  const asJson = process.argv.includes('--json');
  const files = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));
  const results = {};
  let total = 0;
  for (const file of files) {
    const hits = scanFile(join(EN_DIR, file));
    if (hits.length > 0) {
      results[file] = hits;
      total += hits.length;
    }
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const [file, hits] of Object.entries(results)) {
    console.log(`\n## ${file} (${hits.length})`);
    for (const h of hits) {
      console.log(`  ${h.key}\n    en: "${h.value}"`);
    }
  }
  console.log(`\nTotal candidates: ${total} across ${Object.keys(results).length} files`);
}

main();
