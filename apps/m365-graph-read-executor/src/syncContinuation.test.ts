import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSyncContinuationCodec, SyncContinuationError } from './syncContinuation';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NEXT_LINK = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc123';
const ACTION = 'm365.sync.signin_activity' as const;
const KEY = Buffer.alloc(32, 3);

function codec(over: Partial<Parameters<typeof createSyncContinuationCodec>[0]> = {}) {
  return createSyncContinuationCodec({ key: KEY, now: () => 1_700_000_000_000, ...over });
}

describe('sync continuation codec', () => {
  it('round-trips a next link under the same tenant and action', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, URL/JSON safe
    expect(sealed.length).toBeLessThanOrEqual(4096);
    expect(codec().open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
  });

  it('never emits the same blob twice for the same input', () => {
    const one = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const two = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(one).not.toBe(two);
    expect(one).not.toContain('skiptoken'); // the token is not readable by the API
  });

  it('refuses a continuation replayed against another tenant', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_B, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it('refuses a continuation replayed against another action', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_A, action: 'm365.sync.users', continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it('expires after an hour', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const later = codec({ now: () => 1_700_000_000_000 + 3_600_001 });
    expect(() => later.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
    const justInside = codec({ now: () => 1_700_000_000_000 + 3_599_000 });
    expect(justInside.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
  });

  it('refuses a blob minted under a different key', () => {
    const sealed = createSyncContinuationCodec({ key: Buffer.alloc(32, 9), now: () => 1_700_000_000_000 })
      .seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });

  it.each([
    '', 'not-base64url!!', Buffer.alloc(4, 1).toString('base64url'), 'A'.repeat(5000),
  ])('refuses malformed input %#', (continuation) => {
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation }))
      .toThrow(SyncContinuationError);
  });

  it('refuses a flipped ciphertext bit (the GCM tag is the integrity check)', () => {
    const sealed = codec().seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[20] = bytes[20]! ^ 0x01;
    expect(() => codec().open({ tenantId: TENANT_A, action: ACTION, continuation: bytes.toString('base64url') }))
      .toThrow(SyncContinuationError);
  });

  it('mints an ephemeral key when none is configured, and two instances cannot read each other', () => {
    const first = createSyncContinuationCodec({ key: null, randomBytes });
    const second = createSyncContinuationCodec({ key: null, randomBytes });
    const sealed = first.seal({ tenantId: TENANT_A, action: ACTION, nextLink: NEXT_LINK });
    expect(first.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed })).toBe(NEXT_LINK);
    expect(() => second.open({ tenantId: TENANT_A, action: ACTION, continuation: sealed }))
      .toThrow(SyncContinuationError);
  });
});
