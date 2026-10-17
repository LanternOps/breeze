import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

const TEST_KEY = vi.hoisted(() => new TextEncoder().encode('test-secret-test-secret-test-secret-32'));
vi.mock('../jwt', async (orig) => ({
  ...(await orig<typeof import('../jwt')>()),
  getSignKey: () => ({ key: TEST_KEY }),
  getVerifyKey: () => TEST_KEY,
  buildHeader: () => ({ alg: 'HS256' as const }),
}));
import { createTrustPreviewToken, verifyTrustPreviewToken } from './previewToken';

describe('trust preview token', () => {
  it('round-trips pageId/orgId and is bound to purpose + audience', async () => {
    const t = await createTrustPreviewToken({ pageId: 'page-1', orgId: 'org-1' });
    expect(await verifyTrustPreviewToken(t)).toEqual({ pageId: 'page-1', orgId: 'org-1' });
  });

  it('rejects garbage and expired tokens', async () => {
    expect(await verifyTrustPreviewToken('nope')).toBeNull();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
      const t = await createTrustPreviewToken({ pageId: 'p', orgId: 'o' });
      vi.setSystemTime(new Date('2026-10-13T12:16:00Z'));
      expect(await verifyTrustPreviewToken(t)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a same-key token minted for another audience or purpose', async () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>, aud: string) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(now).setExpirationTime(now + 600)
      .setIssuer('breeze').setAudience(aud).sign(TEST_KEY);
    expect(await verifyTrustPreviewToken(await sign({ pageId: 'p', orgId: 'o', purpose: 'trust-preview' }, 'breeze-api'))).toBeNull();
    expect(await verifyTrustPreviewToken(await sign({ pageId: 'p', orgId: 'o', purpose: 'other' }, 'breeze-trust-preview'))).toBeNull();
    expect(await verifyTrustPreviewToken(await sign({ pageId: 'p', purpose: 'trust-preview' }, 'breeze-trust-preview'))).toBeNull();
  });
});
