import { createHash } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { devices } from '../db/schema';
import {
  CLEARED_AGENT_CREDENTIALS,
  collectAgentCredentialHashes,
  SHA256_HEX_DIGEST,
  sha256Hex,
} from './agentCredentialHashes';

/** Every credential column of `devices`: a token hash, or a token's issued/expiry stamp. */
const credentialColumns = Object.keys(getTableColumns(devices)).filter((key) => /token(Hash|IssuedAt|ExpiresAt)$/i.test(key));

describe('CLEARED_AGENT_CREDENTIALS (#8318 review finding 14)', () => {
  it('finds the credential columns (guards the guard)', () => {
    expect(credentialColumns).toContain('agentTokenHash');
    expect(credentialColumns).toContain('pendingHelperTokenHash');
    expect(credentialColumns).toContain('previousWatchdogTokenExpiresAt');
    expect(credentialColumns.length).toBeGreaterThanOrEqual(16);
  });

  it('clears EVERY credential column of devices: a new one fails here until it joins the set', () => {
    expect(Object.keys(CLEARED_AGENT_CREDENTIALS).sort()).toEqual([...credentialColumns].sort());
    expect(Object.values(CLEARED_AGENT_CREDENTIALS).every((value) => value === null)).toBe(true);
  });

  it('collectAgentCredentialHashes reads every token hash column', () => {
    const hashColumns = credentialColumns.filter((key) => /TokenHash$/.test(key));
    const row = Object.fromEntries(hashColumns.map((key, i) => [key, String(i).padStart(64, 'a')]));
    expect(collectAgentCredentialHashes(row).length).toBe(hashColumns.length);
  });
});

describe('sha256Hex / SHA256_HEX_DIGEST (#8318 review finding 14)', () => {
  it('is the lowercase hex SHA-256 of the whole string', () => {
    expect(sha256Hex('brz_rbc_x')).toBe(createHash('sha256').update('brz_rbc_x').digest('hex'));
    expect(SHA256_HEX_DIGEST.test(sha256Hex('anything'))).toBe(true);
    expect(SHA256_HEX_DIGEST.test(sha256Hex('anything').toUpperCase())).toBe(false);
  });
});
