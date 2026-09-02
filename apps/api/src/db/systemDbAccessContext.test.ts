import { describe, expect, it, vi } from 'vitest';

// Importing ./index pulls the DB module; stub the Sentry surface it uses so the
// unit test never loads the real SDK (mirrors heldContextCaptureThrottle.test.ts).
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { SYSTEM_DB_ACCESS_CONTEXT, systemDbAccessContext } from './index';

// Pins the blank-label rule promised in systemDbAccessContext's doc comment
// (#4276): a missing OR whitespace-only label must fall through to the shared
// constant. `formatHeldContextWarning` treats a blank explicit label as
// "unlabelled", so storing one would suppress both the tag and the derived
// opener fallback; and returning the shared constant keeps the common no-label
// case allocation-free. A refactor like `label ?? undefined` (dropping the
// trim) breaks both properties with no other failing test.
describe('systemDbAccessContext (#4276 label plumbing)', () => {
  it('returns the shared constant — same reference, no allocation — when no label is given', () => {
    expect(systemDbAccessContext()).toBe(SYSTEM_DB_ACCESS_CONTEXT);
    expect(systemDbAccessContext(undefined)).toBe(SYSTEM_DB_ACCESS_CONTEXT);
  });

  it('treats a whitespace-only label as no label at all', () => {
    expect(systemDbAccessContext('   ')).toBe(SYSTEM_DB_ACCESS_CONTEXT);
    expect(systemDbAccessContext('\t\n')).toBe(SYSTEM_DB_ACCESS_CONTEXT);
    expect(systemDbAccessContext('')).toBe(SYSTEM_DB_ACCESS_CONTEXT);
  });

  it('stores a real label trimmed, on a copy that leaves the shared constant untouched', () => {
    const ctx = systemDbAccessContext('  metricRollups.scanOrgs  ');
    expect(ctx.label).toBe('metricRollups.scanOrgs');
    expect(ctx).not.toBe(SYSTEM_DB_ACCESS_CONTEXT);
    expect(SYSTEM_DB_ACCESS_CONTEXT.label).toBeUndefined();
    // Everything except the label is the system context verbatim.
    expect({ ...ctx, label: undefined }).toEqual({ ...SYSTEM_DB_ACCESS_CONTEXT, label: undefined });
  });
});
