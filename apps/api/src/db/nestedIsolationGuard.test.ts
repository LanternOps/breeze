import { describe, it, expect, vi } from 'vitest';

// Importing ./index pulls the DB module; stub the Sentry surface it uses so the
// unit test never loads the real SDK (mirrors heldContextCaptureThrottle.test.ts).
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { assertIsolationNotNested } from './index';

/**
 * Guards the #1105 / #2417 double-hold. `withDbAccessContext(ctx, fn, {
 * isolationLevel })` opens a NEW top-level transaction on a SECOND pooled
 * connection. Doing that while the request's own context is held deadlocks the
 * pool at concurrency >= pool size — a hang, not an error — so the misuse has
 * to fail loudly at the call instead. The fix for a route that needs it is
 * SELF_MANAGED_DB_CONTEXT_ROUTES, and the message says so.
 */
describe('withDbAccessContext nested-isolation guard', () => {
  it('throws, naming the remedy, when a context is already held', () => {
    expect(() => assertIsolationNotNested(true)).toThrow(/SELF_MANAGED_DB_CONTEXT_ROUTES/);
  });

  it('permits the isolated transaction when no context is held', () => {
    expect(() => assertIsolationNotNested(false)).not.toThrow();
  });
});
