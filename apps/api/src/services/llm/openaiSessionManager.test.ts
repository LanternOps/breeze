import { describe, it, expect, afterEach } from 'vitest';
import { OpenAISessionManager } from './openaiSessionManager';
import type { RequestLike } from '../auditEvents';
import type { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import type { AuthContext } from '../../middleware/auth';

// Mirrors the canonical shim in services/clientIp.test.ts.
function makeContext(headers: Record<string, string | undefined>, remoteAddress?: string): RequestLike {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) normalized[k.toLowerCase()] = v;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    ...(remoteAddress
      ? { env: { incoming: { socket: { remoteAddress } } } }
      : {}),
  } as RequestLike;
}

describe('OpenAISessionManager.getOrCreate — auditSnapshot.ip via trusted resolver (SR2-16)', () => {
  const origTrust = process.env.TRUST_PROXY_HEADERS;
  const origCidrs = process.env.TRUSTED_PROXY_CIDRS;
  let manager: OpenAISessionManager | undefined;

  afterEach(() => {
    manager?.shutdown();
    manager = undefined;
    if (origTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = origTrust;
    if (origCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = origCidrs;
    delete process.env.TRUST_CF_CONNECTING_IP;
  });

  it('records undefined, not a spoofed x-forwarded-for, when the peer is untrusted (SR2-16)', () => {
    process.env.TRUST_PROXY_HEADERS = 'false';
    delete process.env.TRUSTED_PROXY_CIDRS;

    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const ctx = makeContext({ 'x-forwarded-for': '203.0.113.5' }, '198.51.100.77');
    const session = manager.getOrCreate('sess-untrusted-1', 'org-1', {} as AuthContext, ctx);

    // GUARD-BITE: RED today — the raw header read persists the spoof
    // '203.0.113.5' instead of the resolver's undefined fallback.
    expect(session.auditSnapshot.ip).not.toBe('203.0.113.5');
    expect(session.auditSnapshot.ip).toBeUndefined();
  });

  it('records the real trusted client IP when the peer is a trusted proxy (SR2-16)', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_CIDRS = '198.51.100.77/32';
    process.env.TRUST_CF_CONNECTING_IP = 'true';

    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const ctx = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, '198.51.100.77');
    const session = manager.getOrCreate('sess-trusted-1', 'org-1', {} as AuthContext, ctx);

    expect(session.auditSnapshot.ip).toBe('203.0.113.5');
  });

  it('records undefined ip when no requestContext is provided', () => {
    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
    const session = manager.getOrCreate('sess-no-ctx', 'org-1', {} as AuthContext, undefined);
    expect(session.auditSnapshot.ip).toBeUndefined();
  });
});
