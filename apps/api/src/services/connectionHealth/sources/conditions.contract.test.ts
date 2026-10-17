import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIGEST_CONDITION_LABELS } from '../digestEmail';

// Every fixed condition code a source can emit must have a label in the web
// panel (KNOWN_CONDITIONS), or the panel silently shows the generic fallback.
// Free-form codes (an m365 degraded last_error_code outside the consent set)
// are allowed to fall back.

const API_SRC = path.resolve(__dirname, '../..');
const WEB_PANEL = path.resolve(__dirname, '../../../../../web/src/components/integrations/ConnectionHealthPanel.tsx');

function emittedConditions(): string[] {
  const states = readFileSync(path.join(API_SRC, 'integrationStates.ts'), 'utf8');
  const out = new Set<string>();
  for (const m of states.matchAll(/\b(?:permanent|transient)\('([a-z_]+)'\)/g)) out.add(m[1]!);
  const consent = /M365_CONSENT_CODES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(states);
  for (const m of consent?.[1]?.matchAll(/'([a-z_]+)'/g) ?? []) out.add(m[1]!);
  // Free-form fallback in m365ConnectionHealth: transient(row.lastErrorCode ?? 'degraded').
  out.add('degraded');
  const oauth = readFileSync(path.join(API_SRC, 'connectionHealth/sources/oauthGrant.ts'), 'utf8');
  for (const m of oauth.matchAll(/'(grant_[a-z_]+)'/g)) out.add(m[1]!);
  return [...out].sort();
}

function knownConditions(): string[] {
  const panel = readFileSync(WEB_PANEL, 'utf8');
  const block = /KNOWN_CONDITIONS = \[([\s\S]*?)\] as const/.exec(panel)?.[1] ?? '';
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe('connection health condition labels', () => {
  it('the extraction finds the conditions (guards against a silent empty scan)', () => {
    expect(emittedConditions()).toEqual(expect.arrayContaining(['sync_failed', 'reauth_required', 'grant_missing', 'grant_revoked_reuse']));
    expect(knownConditions().length).toBeGreaterThan(10);
  });

  it('every fixed condition a source emits has a panel label', () => {
    const known = new Set(knownConditions());
    const missing = emittedConditions().filter((c) => !known.has(c));
    expect(missing, `add to KNOWN_CONDITIONS and the locales: ${missing.join(', ')}`).toEqual([]);
  });

  it('every fixed condition a source emits has a digest email label (W3)', () => {
    const missing = emittedConditions().filter((c) => !(c in DIGEST_CONDITION_LABELS));
    expect(missing, `add to DIGEST_CONDITION_LABELS in digestEmail.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('the digest labels and the panel labels name the same conditions', () => {
    expect(Object.keys(DIGEST_CONDITION_LABELS).sort()).toEqual([...knownConditions()].sort());
  });
});
