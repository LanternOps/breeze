import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1105: safeFetch is the shared outbound-HTTP chokepoint, so it calls the
// held-DB-context tripwire before doing any network work. Verify that wiring
// here in isolation by spying on the guard. (urlSafety.test.ts exercises the
// real guard, which is a no-op outside any context.)
const { assertSpy } = vi.hoisted(() => ({ assertSpy: vi.fn() }));
vi.mock('../db', () => ({
  assertOutsideHeldDbContext: assertSpy,
}));

import { safeFetch, SsrfBlockedError } from './urlSafety';

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
