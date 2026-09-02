import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1105: safeFetch is the shared outbound-HTTP chokepoint, so it calls the
// held-DB-context tripwire before doing any network work. Verify that wiring
// here in isolation by spying on the guard. (urlSafety.test.ts exercises the
// real guard, which is a no-op outside any context.)
const { assertSpy } = vi.hoisted(() => ({ assertSpy: vi.fn() }));
vi.mock('../db', () => ({
  assertOutsideHeldDbContext: assertSpy,
}));

import { assertSafeUrl, safeFetch, SsrfBlockedError } from './urlSafety';

describe('safeFetch #1105 tripwire', () => {
  beforeEach(() => {
    assertSpy.mockClear();
  });

  it('calls assertOutsideHeldDbContext("safeFetch") before any network work', async () => {
    // A literal private IP is rejected synchronously, before DNS/TCP — so if the
    // guard is reached at all, it must have fired ahead of the SSRF rejection.
    await expect(safeFetch('http://127.0.0.1/secret')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(assertSpy).toHaveBeenCalledTimes(1);
    expect(assertSpy).toHaveBeenCalledWith('safeFetch');
  });

  it('propagates a strict-mode throw from the guard (a new violation fails the call)', async () => {
    assertSpy.mockImplementationOnce(() => {
      throw new Error('safeFetch ran inside a held withDbAccessContext transaction (#1105)');
    });
    await expect(safeFetch('https://example.com/')).rejects.toThrow(/#1105/);
  });
});

// `assertSafeUrl` sends nothing, but it still does a real `dns.lookup` against
// an operator/tenant-supplied hostname — an unbounded network wait on a
// resolver the caller does not control. Inside a held request transaction that
// pins a pooled connection idle-in-transaction exactly as an outbound fetch
// does (#1105), and every caller of it so far reached it from a validation
// helper deep inside a route handler, where the held context is invisible.
// Guarding the primitive itself is what makes that class visible rather than
// relying on each new caller remembering to register its route.
describe('assertSafeUrl #1105 tripwire', () => {
  beforeEach(() => {
    assertSpy.mockClear();
  });

  it('calls assertOutsideHeldDbContext("assertSafeUrl") before resolving anything', async () => {
    // A literal private IP is rejected without any DNS work, so reaching the
    // guard at all proves it fired ahead of the resolve-and-filter step.
    await expect(assertSafeUrl('https://127.0.0.1/secret')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(assertSpy).toHaveBeenCalledTimes(1);
    expect(assertSpy).toHaveBeenCalledWith('assertSafeUrl');
  });

  it('fires even for an unsupported scheme, which is rejected before any lookup', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(assertSpy).toHaveBeenCalledWith('assertSafeUrl');
  });

  it('propagates a strict-mode throw from the guard', async () => {
    assertSpy.mockImplementationOnce(() => {
      throw new Error('assertSafeUrl ran inside a held withDbAccessContext transaction (#1105)');
    });
    // A blocked literal, so the only way this rejects with the guard's message
    // rather than SsrfBlockedError is if the guard ran first — and no DNS.
    await expect(assertSafeUrl('https://127.0.0.1/')).rejects.toThrow(/#1105/);
  });
});
