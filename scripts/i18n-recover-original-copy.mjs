#!/usr/bin/env node
// Cross-references the #2340 extraction commit's diff against current
// en/*.json values to recover ORIGINAL English copy for keys whose value is
// currently just a humanized rendering of the key name (see #2649).
//
// Method: for every component file touched by 944bb8d18 (the extraction
// commit), diff 944bb8d18^ -> 944bb8d18. Within each diff hunk, pair up
// removed string literals with added `t('some.key')` calls that appear in
// the same hunk (the extraction script replaced a literal with a t() call
// in place, so they land adjacent in the diff). That gives a best-effort
// (key -> original literal) map, independent of what the extraction wrote
// into en/*.json.
//
// Then: for every key currently flagged by i18n-humanized-key-scan.mjs,
// look up its recovered original literal. If the recovered literal is
// non-empty and differs from the current en value, it's a confirmed
// regression with recoverable copy. If no literal was recovered, it's
// flagged as UNRECOVERABLE (needs a human to write new copy, per the issue's
// "do not invent new copy unless the original is unrecoverable" rule).
//
// Usage: node scripts/i18n-recover-original-copy.mjs [--json]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EN_DIR = join(ROOT, 'apps', 'web', 'src', 'locales', 'en');
const EXTRACTION_COMMIT = '944bb8d18';

function sh(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1024 * 1024 * 64 }).toString();
}

function humanizeKeyLeaf(leaf) {
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

function scanCandidates() {
  const files = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));
  const candidates = []; // { namespace, key, leaf, value }
  for (const file of files) {
    const namespace = file.replace(/\.json$/, '');
    const json = JSON.parse(readFileSync(join(EN_DIR, file), 'utf8'));
    for (const [key, value] of flattenJson(json)) {
      const leaf = key.split('.').pop();
      const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean);
      if (words.length < 2) continue;
      const humanized = humanizeKeyLeaf(leaf);
      const withoutFailedTo = value.startsWith('Failed to ') ? value.slice('Failed to '.length) : null;
      const directMatch = value === humanized;
      const failedToMatch = withoutFailedTo !== null && withoutFailedTo.toLowerCase() === humanized.toLowerCase();
      if (directMatch || failedToMatch) {
        candidates.push({ namespace, key, leaf, value, matchKind: directMatch ? 'direct' : 'failed-to-prefix' });
      }
    }
  }
  return candidates;
}

// Parse a t()/i18nKey call's key argument out of a line of JSX/TS source.
// Matches: t('foo.bar'), t("foo.bar"), t(`foo.bar`), i18nKey="foo.bar"
function extractTKeys(line) {
  const keys = [];
  const reCall = /\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let m;
  while ((m = reCall.exec(line))) keys.push(m[1]);
  const reAttr = /i18nKey=["']([a-zA-Z0-9_.]+)["']/g;
  while ((m = reAttr.exec(line))) keys.push(m[1]);
  return keys;
}

// Extract candidate human-readable string literals from a removed source line.
// Skip obvious non-copy: import paths, class names, single words that look
// like identifiers, template literals with interpolation only, and
// className/style attribute values (never real copy).
function extractStringLiterals(line) {
  if (/\b(className|class|style)\s*=\s*['"`{]/.test(line)) return [];
  const out = [];
  const re = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  let m;
  while ((m = re.exec(line))) {
    const s = m[2];
    if (s.length < 3) continue;
    if (!/[a-zA-Z]/.test(s)) continue;
    if (/^[a-z0-9_.\-/]+$/.test(s) && !s.includes(' ')) continue; // looks like an identifier/path/class
    if (/^(text|bg|border|hover|focus|w|h|p|m|px|py|mx|my|mt|mb|ml|mr|flex|grid|rounded|font|gap|space)[-:]/.test(s)) continue; // tailwind-ish
    out.push(s);
  }
  return out;
}

function getExtractionTouchedFiles() {
  const out = sh(['show', '--name-only', '--pretty=format:', EXTRACTION_COMMIT])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('apps/web/src/components/') && l.endsWith('.tsx'));
  return [...new Set(out)];
}

function buildKeyToOriginalMap() {
  const files = getExtractionTouchedFiles();
  const map = new Map(); // key -> { text, file }
  for (const file of files) {
    let diff;
    try {
      diff = sh(['diff', `${EXTRACTION_COMMIT}^`, EXTRACTION_COMMIT, '--', file]);
    } catch {
      continue;
    }
    const hunks = diff.split(/^@@/m).slice(1);
    for (const hunk of hunks) {
      const lines = hunk.split('\n');
      // Only pair within a single contiguous removed-block / added-block
      // (a "replace" edit), and only when the block is a 1:1 line
      // replacement — the case where an i18n extraction swapped a literal
      // for a t() call on the same logical line. Hunks with unequal block
      // sizes (multi-line JSX restructuring) are skipped rather than
      // guessed at — a wrong guess is worse than no guess here.
      let i = 0;
      while (i < lines.length) {
        if (lines[i].startsWith('-') && !lines[i].startsWith('---')) {
          const removedBlock = [];
          while (i < lines.length && lines[i].startsWith('-') && !lines[i].startsWith('---')) {
            removedBlock.push(lines[i].slice(1));
            i++;
          }
          const addedBlock = [];
          while (i < lines.length && lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
            addedBlock.push(lines[i].slice(1));
            i++;
          }
          if (removedBlock.length === addedBlock.length) {
            for (let j = 0; j < removedBlock.length; j++) {
              const literals = extractStringLiterals(removedBlock[j]);
              const keys = extractTKeys(addedBlock[j]);
              if (literals.length === 1 && keys.length === 1) {
                const key = keys[0];
                if (!map.has(key)) map.set(key, { text: literals[0], file });
              }
            }
          }
        } else {
          i++;
        }
      }
    }
  }
  return map;
}

function main() {
  const asJson = process.argv.includes('--json');
  const candidates = scanCandidates();
  const originalMap = buildKeyToOriginalMap();

  const confirmed = [];
  const unrecoverable = [];

  for (const c of candidates) {
    // The full t()-call key as it appears in source is just the leaf path
    // (namespace supplied by useTranslation(namespace)), i.e. everything
    // after the namespace segment of the JSON key.
    const withoutNamespace = c.key; // JSON key IS the leaf path already (namespace is the filename)
    const hit = originalMap.get(withoutNamespace);
    if (hit && hit.text && hit.text.trim() !== c.value.trim()) {
      confirmed.push({ ...c, original: hit.text, sourceFile: hit.file });
    } else if (!hit) {
      unrecoverable.push(c);
    }
    // if hit.text === c.value, heuristic false positive (already correct) — drop silently
  }

  if (asJson) {
    console.log(JSON.stringify({ confirmed, unrecoverable }, null, 2));
    return;
  }

  console.log(`Candidates scanned: ${candidates.length}`);
  console.log(`Confirmed recoverable regressions: ${confirmed.length}`);
  console.log(`Unrecoverable (candidate but no original found in diff): ${unrecoverable.length}`);
  console.log(`Dropped as false positives (matched original): ${candidates.length - confirmed.length - unrecoverable.length}`);
  console.log('\n--- CONFIRMED ---');
  for (const c of confirmed) {
    console.log(`${c.namespace}.${c.key}\n  current: "${c.value}"\n  original: "${c.original}"  (${c.sourceFile})`);
  }
}

main();
