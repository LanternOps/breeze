#!/usr/bin/env node
// Scans apps/web/src/locales/en/*.json for values that are exactly the
// "humanized" form of their own key leaf — a signature of the #2340
// extraction bug (see #2649): the value was never real English copy, it's a
// mechanical rendering of the key name itself.
//
// Usage: node scripts/i18n-humanized-key-scan.mjs [--json]
//
// Heuristic (kept intentionally narrow, mirroring #2649's "floor" bucket):
//   1. Split the last path segment of the key on camelCase boundaries.
//   2. Title-case the first word, lowercase the rest (matches the observed
//      humanizer: "viewerDescription" -> "Viewer Description",
//      "handlerNotConfigured" -> "Handler Not Configured").
//   3. Flag when the EN value equals that humanized form exactly (or with a
//      "Failed to " prefix stripped, for the errors.* namespace pattern
//      "Failed to <humanized key>").
//   4. Skip single-word leaves and anything on the allowlist (legitimate
//      cases like `noReasonGiven` -> "No reason given" or a leaf that is
//      genuinely just its own label, e.g. column headers).
//
// This is a *candidate* list, not a verdict — see ALLOWLIST_KEYS below and
// the regression test apps/web/src/locales/humanizedKeyRegression.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EN_DIR = join(__dirname, '..', 'apps', 'web', 'src', 'locales', 'en');

function humanizeKeyLeaf(leaf) {
  // Split camelCase / acronym boundaries into words.
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

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
    const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean);
    if (words.length < 2) continue; // single-word leaves excluded — too noisy to judge

    const humanized = humanizeKeyLeaf(leaf);
    const withoutFailedTo = value.startsWith('Failed to ') ? value.slice('Failed to '.length) : null;
    const humanizedLower = humanized.toLowerCase();

    const directMatch = value === humanized;
    const failedToMatch = withoutFailedTo !== null && withoutFailedTo.toLowerCase() === humanizedLower;

    if (directMatch || failedToMatch) {
      hits.push({ key, value, humanized, matchKind: directMatch ? 'direct' : 'failed-to-prefix' });
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
      console.log(`  ${h.key}\n    en: "${h.value}"  [${h.matchKind}]`);
    }
  }
  console.log(`\nTotal candidates: ${total} across ${Object.keys(results).length} files`);
}

main();
