// Regression test for #2649: the #2340 i18n extraction replaced real English
// copy with machine-humanized renderings of the key name itself in an unknown
// number of places (e.g. `viewerDescription` -> "Viewer Description" instead
// of the original sentence). This fails when a *new* `en/*.json` value is
// exactly the humanized form of its own key leaf — the signature of that bug
// — so the same regression can't silently reappear on new copy.
//
// The heuristic itself is deliberately broad (any 2+-word key leaf whose
// value equals its own humanized form, optionally behind "Failed to ") and
// is NOT high-precision on its own — the #2649 investigation found this
// exact heuristic produces thousands of false positives, because plenty of
// legitimate short labels are indistinguishable from a humanized key by
// pattern alone (e.g. `acceptRisk` -> "Accept risk" is correct copy).
//
// So this test does NOT require the codebase to be free of heuristic hits.
// Instead it works like the frozen-baseline pattern used elsewhere in this
// repo (see migrationRlsScope.test.ts): BASELINE below is every hit that
// existed when this test was added — a snapshot of already-shipped keys,
// most of which are legitimate copy, a minority of which are still-broken
// extraction damage from #2340 that #2649 didn't get to. 45 confirmed
// regressions were recovered from git history and fixed in the same PR that
// added this test (see scripts/i18n-recover-original-copy.mjs) and removed
// from the baseline; the remainder is tracked as follow-up work, not silently
// accepted as correct.
//
// NEVER add a new key to the baseline to make this test pass — that means
// new copy was written as (or degenerated into) a humanized key placeholder,
// which is the bug this test exists to catch. Fix the copy instead.
// Removing an entry (because it was investigated and fixed, or because a
// human confirmed it's legitimate copy) is always fine.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = dirname(fileURLToPath(import.meta.url));
const EN_DIR = join(LOCALES_DIR, 'en');
const BASELINE: string[] = JSON.parse(
  readFileSync(join(LOCALES_DIR, 'humanizedKeyBaseline.json'), 'utf8'),
);
const ALLOWLIST_KEYS = new Set<string>(BASELINE);

function humanizeKeyLeaf(leaf: string): string {
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

function flattenJson(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenJson(v as Record<string, unknown>, key));
    } else if (typeof v === 'string') {
      out.push([key, v]);
    }
  }
  return out;
}

function findHumanizedKeyHits(namespace: string, json: Record<string, unknown>): string[] {
  const hits: string[] = [];
  for (const [key, value] of flattenJson(json)) {
    const dottedKey = `${namespace}.${key}`;
    if (ALLOWLIST_KEYS.has(dottedKey)) continue;

    const leaf = key.split('.').pop()!;
    const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean);
    if (words.length < 2) continue; // single-word leaves excluded — too noisy to judge reliably

    const humanized = humanizeKeyLeaf(leaf);
    const withoutFailedTo = value.startsWith('Failed to ') ? value.slice('Failed to '.length) : null;
    const directMatch = value === humanized;
    const failedToMatch = withoutFailedTo !== null && withoutFailedTo.toLowerCase() === humanized.toLowerCase();

    if (directMatch || failedToMatch) {
      hits.push(`${dottedKey}: "${value}" looks like a humanized key, not real copy (expected something other than "${humanized}")`);
    }
  }
  return hits;
}

const enFiles = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));

describe('en/*.json values are not humanized key placeholders (#2649)', () => {
  it.each(enFiles)('%s has no humanized-key-shaped values', (file) => {
    const namespace = file.replace(/\.json$/, '');
    const json = JSON.parse(readFileSync(join(EN_DIR, file), 'utf8'));
    const hits = findHumanizedKeyHits(namespace, json);
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
