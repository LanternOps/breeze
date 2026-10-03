// Regression test for #2649: the #2340 i18n extraction replaced real English
// copy with machine-humanized renderings of the key name itself in an unknown
// number of places (e.g. `viewerDescription` -> "Viewer Description" instead
// of the original sentence). This fails when a *new* `en/*.json` value is
// exactly the humanized form of its own key leaf — the signature of that bug
// — so the same regression can't silently reappear on new copy.
//
// Detection logic (`isHumanizedKeyPlaceholder`, checking both "Sentence case"
// and "Title Case" renderings — #2649's own example, `viewerDescription` ->
// "Viewer Description", is Title Case) lives in
// ../../../../scripts/i18n-humanized-key-lib.mjs, shared with the scanner and
// recovery scripts so the heuristic can't drift between the test and the
// tools that feed it. It is deliberately broad and NOT high-precision on its
// own — the #2649 investigation found this exact class of heuristic produces
// thousands of false positives, because plenty of legitimate short labels are
// indistinguishable from a humanized key by pattern alone (e.g. `acceptRisk`
// -> "Accept risk" is correct copy).
//
// So this test does NOT require the codebase to be free of heuristic hits.
// Instead it works like the frozen-baseline pattern used elsewhere in this
// repo (see migrationRlsScope.test.ts): BASELINE below is every hit that
// exists as of this test — a snapshot of already-shipped keys, most of which
// are legitimate copy, a minority of which are still-broken extraction
// damage from #2340 that #2649 didn't get to. 45 confirmed regressions were
// recovered from git history and fixed in the same PR that added this test
// (see scripts/i18n-recover-original-copy.mjs) and removed from the
// baseline; the remainder is tracked as follow-up work (#7376), not silently
// accepted as correct.
//
// NEVER add a new key to the baseline to make this test pass — that means
// new copy was written as (or degenerated into) a humanized key placeholder,
// which is the bug this test exists to catch. Fix the copy instead.
// Removing an entry (because it was investigated and fixed, or because a
// human confirmed it's legitimate copy) is always fine — and the second test
// below requires every remaining baseline entry to still be a live hit, so a
// key that gets fixed without being removed from the baseline fails loudly
// instead of quietly losing its guard.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHumanizedKeyPlaceholder, leafWordCount } from '../../../../scripts/i18n-humanized-key-lib.mjs';

const LOCALES_DIR = dirname(fileURLToPath(import.meta.url));
const EN_DIR = join(LOCALES_DIR, 'en');
const BASELINE: string[] = JSON.parse(
  readFileSync(join(LOCALES_DIR, 'humanizedKeyBaseline.json'), 'utf8'),
);
// New-hit threshold. Short labels routinely and legitimately read like their
// own key ("Created by" / createdBy, "Try again" / tryAgain, "Sent to agent" /
// sentToAgent), so flagging every 2–3 word match made this test red on
// ordinary new copy and dequeued unrelated PRs. The #2340 damage this guards
// against is sentence-length keys ("thisMacIsBelowTheMacos"), so NEW hits are
// only reported for leaves of MIN_WORDS_FOR_NEW_HIT+ words. The scanner
// (scripts/i18n-humanized-key-scan.mjs) still reports every length, and the
// baseline below is still checked for staleness with the full heuristic.
const MIN_WORDS_FOR_NEW_HIT = 4;
const ALLOWLIST_KEYS = new Set<string>(BASELINE);

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
    if (leafWordCount(leaf) < MIN_WORDS_FOR_NEW_HIT) continue;
    if (isHumanizedKeyPlaceholder(leaf, value)) {
      hits.push(`${dottedKey}: "${value}" looks like a humanized key, not real copy`);
    }
  }
  return hits;
}

const enFiles = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));

describe('en/*.json values are not humanized key placeholders (#2649)', () => {
  it('found en/*.json namespace files to check', () => {
    // Guards against `it.each([])` silently reporting 0 assertions as a pass
    // if the locales directory were ever emptied by a bad merge/build step.
    expect(enFiles.length).toBeGreaterThan(0);
  });

  it.each(enFiles)('%s has no new humanized-key-shaped values', (file) => {
    const namespace = file.replace(/\.json$/, '');
    const json = JSON.parse(readFileSync(join(EN_DIR, file), 'utf8'));
    const hits = findHumanizedKeyHits(namespace, json);
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('baseline has no stale entries (every entry is still a live hit)', () => {
    // A baseline entry that no longer matches the heuristic means the key
    // was fixed (or edited) without being removed from the baseline — which
    // would otherwise let it silently regress back to a placeholder with no
    // test ever noticing (the baseline only skips known hits, it doesn't
    // reassert them). Every entry must currently: exist, be a string, and
    // still match the heuristic against the live en/*.json value.
    const enByNamespace = new Map<string, Record<string, unknown>>();
    for (const file of enFiles) {
      enByNamespace.set(file.replace(/\.json$/, ''), JSON.parse(readFileSync(join(EN_DIR, file), 'utf8')));
    }
    const flattenedByNamespace = new Map<string, Map<string, string>>();
    for (const [namespace, json] of enByNamespace) {
      flattenedByNamespace.set(namespace, new Map(flattenJson(json)));
    }
    const stale: string[] = [];
    for (const dottedKey of BASELINE) {
      const [namespace, ...rest] = dottedKey.split('.');
      const json = enByNamespace.get(namespace);
      if (!json) {
        stale.push(`${dottedKey}: namespace file no longer exists`);
        continue;
      }
      const leafPath = rest.join('.');
      const flat = flattenedByNamespace.get(namespace)!;
      const value = flat.get(leafPath);
      if (value === undefined) {
        stale.push(`${dottedKey}: key no longer exists in en/${namespace}.json`);
        continue;
      }
      const leaf = rest[rest.length - 1];
      if (!isHumanizedKeyPlaceholder(leaf, value)) {
        stale.push(`${dottedKey}: current value "${value}" no longer matches the heuristic — remove from humanizedKeyBaseline.json`);
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });
});
