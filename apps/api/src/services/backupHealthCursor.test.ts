// apps/api/src/services/backupHealthCursor.test.ts
import { describe, expect, it } from 'vitest';

import {
  BACKUP_HEALTH_DEFAULT_LIMIT,
  BACKUP_HEALTH_MAX_LIMIT,
  compareRowKeys,
  cursorFromRow,
  decodeBackupHealthCursor,
  encodeBackupHealthCursor,
} from './backupHealthCursor';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';

describe('encode/decode round trip', () => {
  it('round-trips a cursor through a base64url token', () => {
    const cursor = { v: 1 as const, n: 'acme-srv01', k: `breeze:${DEVICE}` };
    const token = encodeBackupHealthCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no '+', '/' or '='
    expect(decodeBackupHealthCursor(token)).toEqual(cursor);
  });

  it('lower-cases the name it stores so the SQL predicate needs no function on the bound side', () => {
    expect(cursorFromRow({ key: `breeze:${DEVICE}`, name: 'ACME-SRV01' })).toEqual({
      v: 1,
      n: 'acme-srv01',
      k: `breeze:${DEVICE}`,
    });
  });
});

describe('decodeBackupHealthCursor rejects', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['non-base64url', 'not a token!!'],
    ['valid base64url that is not JSON', Buffer.from('nope', 'utf8').toString('base64url')],
  ])('%s', (_label, token) => {
    expect(decodeBackupHealthCursor(token as string | undefined | null)).toBeNull();
  });

  it('a future version, rather than mis-walking it', () => {
    const token = Buffer.from(JSON.stringify({ v: 2, n: 'a', k: 'breeze:x' }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });

  it('a wrong-shaped key prefix', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, n: 'a', k: 'huntress:x' }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });

  it('a non-string name', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, n: 7, k: `breeze:${DEVICE}` }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });
});

describe('compareRowKeys', () => {
  it('orders by lower-cased name first', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'alpha' };
    const b = { key: `breeze:${PROVIDER}`, name: 'Beta' };
    expect(compareRowKeys(a, b)).toBeLessThan(0);
    expect(compareRowKeys(b, a)).toBeGreaterThan(0);
  });

  it('breaks a name tie on the key, so two identically-named devices never flap', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'SRV01' };
    const b = { key: `provider:${PROVIDER}`, name: 'srv01' };
    // 'breeze:…' < 'provider:…' in code-point order.
    expect(compareRowKeys(a, b)).toBeLessThan(0);
    expect(compareRowKeys(b, a)).toBeGreaterThan(0);
  });

  it('is 0 only for the same row', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'SRV01' };
    expect(compareRowKeys(a, { ...a, name: 'srv01' })).toBe(0);
  });
});

describe('limits', () => {
  it('are the documented page sizes', () => {
    expect(BACKUP_HEALTH_DEFAULT_LIMIT).toBe(50);
    expect(BACKUP_HEALTH_MAX_LIMIT).toBe(200);
  });
});
