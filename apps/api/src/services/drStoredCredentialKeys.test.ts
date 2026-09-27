import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DR_CREDENTIAL_KEY_PATTERN_SOURCE,
  findCredentialShapedKeyPath,
  isCredentialShapedKey,
  withoutCredentialShapedKeys,
} from './drStoredCredentialKeys';

describe('DR stored credential keys', () => {
  it.each([
    'providerConfig', 'providerConfigRef', 'providerConfigEnvelope', 'password', 'dbPassword', 'pwd',
    'secret', 'secretKey', 'secretAccessKey', 'clientSecret', 'token', 'recoveryToken', 'sessionToken',
    'apiKey', 'api_key', 'accessKey', 'accessKeyId', 'privateKey', 'credentials', 'connectionString',
    'accountKey', 'sharedKey', 'passphrase',
  ])('treats %s as credential material', (key) => {
    expect(isCredentialShapedKey(key)).toBe(true);
  });

  it.each([
    'snapshotId', 'sourceSnapshotId', 'vmName', 'generateNewId', 'noRecovery', 'targetDatabase',
    'backupFileName', 'provider', 'recoveryTokenId', 'tokenExpiresAt', 'serverUrl', 'instance',
  ])('keeps %s', (key) => {
    expect(isCredentialShapedKey(key)).toBe(false);
  });

  it('finds and removes keys at any depth without touching the rest', () => {
    const doc = { commandType: 'x', payload: { snapshotId: 's', nested: [{ ok: 1, password: 'p' }] } };
    expect(findCredentialShapedKeyPath(doc)).toEqual(['payload', 'nested', 0, 'password']);
    expect(withoutCredentialShapedKeys(doc)).toEqual({
      commandType: 'x',
      payload: { snapshotId: 's', nested: [{ ok: 1 }] },
    });
  });

  it('matches the pattern the cleanup migration applies in SQL', () => {
    const sql = readFileSync(
      path.resolve(__dirname, '../../migrations/2026-11-05-100500-backup-command-stored-destination-cleanup.sql'),
      'utf8',
    );
    expect(sql).toContain(`'${DR_CREDENTIAL_KEY_PATTERN_SOURCE}'`);
  });
});
