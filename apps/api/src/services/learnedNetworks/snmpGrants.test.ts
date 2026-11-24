import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));
// Fresh plaintext encrypts to a recognisable value, so the merge oracle below can tell a retained stored
// ciphertext ('enc:...') from a value that arrived in this request ('fresh:...').
vi.mock('../secretCrypto', () => ({
  encryptSecret: (value: string) => `fresh:${value}`,
  decryptSecret: (value: string | null | undefined) => value ?? null,
  decryptForColumn: (_t: string, _c: string, value: string | null | undefined) => value ?? null,
}));

import type { discoveryProfiles } from '../../db/schema';
import {
  MASKED_SNMP_SECRET as M,
  SNMP_SECRET_FIELD_NAMES,
  mergeEncryptSnmpCommunities,
  mergeEncryptSnmpCredentials,
} from '../snmpSecrets';
import { gateProfileFromRow } from './gate';
import {
  EMPTY_SNMP_SECRET_STATE,
  isFullSnmpReentry,
  profileWillHoldSnmpSecrets,
  snmpPatchSuppliesSecret,
  type SnmpSecretPatch,
  type SnmpSecretState,
} from './snmpGrants';

const V3_STORED = { version: 'v3', username: 'poller', authPassphrase: 'enc:a1', privacyPassphrase: 'enc:p1' };
const V3_FRESH = { version: 'v3', username: 'poller', authPassphrase: 'auth-b', privacyPassphrase: 'priv-b' };
const STORED: SnmpSecretState = { communities: ['enc:c1'], credentials: V3_STORED };

type Row = [string, SnmpSecretState, SnmpSecretPatch, boolean];

const T3_ROWS: Row[] = [
  ['all fresh', STORED, { communities: ['public-b'], credentials: V3_FRESH }, true],
  ['one masked', STORED, { communities: ['public-b'], credentials: { ...V3_FRESH, privacyPassphrase: M } }, false],
  ['one masked community beside a fresh one', { ...STORED, communities: ['enc:c1', 'enc:c2'] },
    { communities: ['public-b', M], credentials: V3_FRESH }, false],
  ['a field omitted while a stored value is retained', STORED, { communities: ['public-b'] }, false],
  ['secrets cleared', STORED, { communities: [], credentials: null }, false],
  ['v3 only', { communities: [], credentials: V3_STORED }, { credentials: V3_FRESH }, true],
  ['community only', { communities: ['enc:c1'], credentials: null }, { communities: ['public-b'] }, true],
  ['create', EMPTY_SNMP_SECRET_STATE, { communities: ['public-a'], credentials: V3_FRESH }, true],
  ['create without secrets', EMPTY_SNMP_SECRET_STATE, {}, false],
  ['masked entry with nothing stored at its index', { communities: [], credentials: null },
    { communities: ['public-b', M] }, true],
  ['v3 leaf omitted inside the supplied object (it clears)', { communities: [], credentials: V3_STORED },
    { credentials: { version: 'v3', username: 'poller', authPassphrase: 'auth-b' } }, true],
];

// Shapes the merge helpers accept that the T3 table does not exercise.
const SHAPE_ROWS: Row[] = [
  ['secret key holding an array: masked index with a stored value', { communities: [], credentials: { community: ['enc:x', 'enc:y'] } },
    { credentials: { community: ['fresh-1', M] } }, false],
  ['secret key holding an array: all fresh', { communities: [], credentials: { community: ['enc:x', 'enc:y'] } },
    { credentials: { community: ['fresh-1', 'fresh-2'] } }, true],
  ['secret key holding an array: masked index past the stored array', { communities: [], credentials: { community: ['enc:x'] } },
    { credentials: { community: ['fresh-1', M] } }, true],
  ['top-level credentials array, one masked entry retained', { communities: [], credentials: [{ authPassphrase: 'enc:a1' }, { authPassphrase: 'enc:a2' }] },
    { credentials: [{ authPassphrase: 'auth-1' }, { authPassphrase: M }] }, false],
  ['top-level credentials array, all fresh', { communities: [], credentials: [{ authPassphrase: 'enc:a1' }] },
    { credentials: [{ authPassphrase: 'auth-1' }, { authPassphrase: 'auth-2' }] }, true],
  ['stored object, incoming array: the stored side reads as empty', { communities: [], credentials: V3_STORED },
    { credentials: [{ authPassphrase: M }, { privacyPassphrase: 'priv-1' }] }, true],
  ['stored array, incoming object: masked leaf has nothing to retain', { communities: [], credentials: [{ authPassphrase: 'enc:a1' }] },
    { credentials: { authPassphrase: M, privacyPassphrase: 'priv-1' } }, true],
  ['masked scalar over a stored array retains the whole array', { communities: [], credentials: { community: ['enc:x'] } },
    { credentials: { community: M, authPassphrase: 'auth-1' } }, false],
  ['non-string leaf is stored raw and not held', { communities: [], credentials: null },
    { credentials: { authPassphrase: 42, privacyPassphrase: 'priv-1' } }, true],
  ['only a non-string leaf: nothing held, nothing re-entered', { communities: [], credentials: null },
    { credentials: { authPassphrase: 42 } }, false],
  ['nested secret leaf under a non-secret key, masked and retained', { communities: [], credentials: { v3: { authPassphrase: 'enc:a1' } } },
    { credentials: { v3: { authPassphrase: M }, community: 'public-1' } }, false],
  ['empty string clears a stored leaf', { communities: [], credentials: V3_STORED },
    { credentials: { version: 'v3', authPassphrase: 'auth-1', privacyPassphrase: '' } }, true],
  ['omitted credentials with only non-string stored leaves', { communities: [], credentials: { authPassphrase: 7 } },
    { communities: ['public-1'] }, true],
];

describe('T3 full re-entry table', () => {
  it.each<Row>(T3_ROWS)('%s', (_name, existing, incoming, expected) => {
    expect(isFullSnmpReentry({ existing, incoming })).toBe(expected);
  });
});

describe('full re-entry over the merge helpers\' other shapes', () => {
  it.each<Row>(SHAPE_ROWS)('%s', (_name, existing, incoming, expected) => {
    expect(isFullSnmpReentry({ existing, incoming })).toBe(expected);
  });
});

/** The secret leaves the stored state will hold, with the same walk the stored-secret checks use. */
function heldLeaves(state: SnmpSecretState): string[] {
  const leaves: unknown[] = [...state.communities];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (SNMP_SECRET_FIELD_NAMES.has(key)) {
        if (Array.isArray(entry)) leaves.push(...entry); else leaves.push(entry);
      } else walk(entry);
    }
  };
  walk(state.credentials);
  return leaves.filter((leaf): leaf is string => typeof leaf === 'string' && leaf.length > 0);
}

/** What the update handler stores for this save, through the real merge helpers. */
function mergedState(existing: SnmpSecretState, incoming: SnmpSecretPatch): SnmpSecretState {
  return {
    communities: incoming.communities === undefined
      ? existing.communities
      : mergeEncryptSnmpCommunities([...incoming.communities], [...existing.communities]) ?? [],
    credentials: incoming.credentials === undefined
      ? existing.credentials
      : mergeEncryptSnmpCredentials(incoming.credentials, existing.credentials),
  };
}

describe('isFullSnmpReentry agrees with the merge helpers', () => {
  it.each<Row>([...T3_ROWS, ...SHAPE_ROWS])('%s', (_name, existing, incoming) => {
    const held = heldLeaves(mergedState(existing, incoming));
    const oracle = held.length > 0 && held.every((leaf) => leaf.startsWith('fresh:'));
    expect(isFullSnmpReentry({ existing, incoming })).toBe(oracle);
    expect(profileWillHoldSnmpSecrets(mergedState(existing, incoming))).toBe(held.length > 0);
  });
});

const HOLD_ROWS: Array<[string, SnmpSecretState, boolean]> = [
  ['nothing', EMPTY_SNMP_SECRET_STATE, false],
  ['empty strings only', { communities: [''], credentials: { version: 'v3', authPassphrase: '' } }, false],
  ['community', { communities: ['enc:c1'], credentials: null }, true],
  ['v3 only, nested in an array', { communities: [], credentials: [{ authPassphrase: 'enc:a1' }] }, true],
  ['non-secret keys only', { communities: [], credentials: { version: 'v3', username: 'poller' } }, false],
];

describe('profileWillHoldSnmpSecrets', () => {
  it.each(HOLD_ROWS)('%s', (_n, state, expected) => expect(profileWillHoldSnmpSecrets(state)).toBe(expected));
});

describe('one definition of "holds secrets": the gate agrees with profileWillHoldSnmpSecrets', () => {
  const ROW = {
    id: '55555555-5555-4555-8555-555555555555',
    orgId: '11111111-1111-4111-8111-111111111111',
    siteId: '33333333-3333-4333-8333-333333333333',
    networkId: null,
    snmpGrantMode: 'bound',
  } as unknown as typeof discoveryProfiles.$inferSelect;

  it.each(HOLD_ROWS)('%s', (_n, state, expected) => {
    const gate = gateProfileFromRow({ ...ROW, snmpCommunities: [...state.communities], snmpCredentials: state.credentials });
    expect(gate.hasSavedSnmpSecrets).toBe(expected);
    expect(profileWillHoldSnmpSecrets(state)).toBe(gate.hasSavedSnmpSecrets);
  });
});

describe('snmpPatchSuppliesSecret', () => {
  it('is true for one fresh leaf among masks and false for masks only', () => {
    expect(snmpPatchSuppliesSecret({ communities: [M], credentials: { ...V3_FRESH, authPassphrase: M } })).toBe(true);
    expect(snmpPatchSuppliesSecret({ communities: [M], credentials: { authPassphrase: M } })).toBe(false);
    expect(snmpPatchSuppliesSecret({})).toBe(false);
  });

  it('counts a fresh community, ignores empty strings and non-string leaves', () => {
    expect(snmpPatchSuppliesSecret({ communities: ['public-a'] })).toBe(true);
    expect(snmpPatchSuppliesSecret({ communities: [''], credentials: { authPassphrase: '', privacyPassphrase: 9 } })).toBe(false);
    expect(snmpPatchSuppliesSecret({ credentials: null })).toBe(false);
  });

  it('is implied by every full re-entry in the tables', () => {
    for (const [, existing, incoming] of [...T3_ROWS, ...SHAPE_ROWS]) {
      if (isFullSnmpReentry({ existing, incoming })) expect(snmpPatchSuppliesSecret(incoming)).toBe(true);
    }
  });
});
