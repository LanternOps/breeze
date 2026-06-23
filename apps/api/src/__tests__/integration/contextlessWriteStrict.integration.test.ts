/**
 * #1379 A1 — DB_CONTEXTLESS_WRITE_STRICT env gate.
 *
 * Verifies that reportContextlessWrite:
 *   1. warns (no throw) by default — prod-safe behaviour unchanged.
 *   2. throws under DB_CONTEXTLESS_WRITE_STRICT=true — CI gate.
 *   3. is completely silent when the write is properly wrapped in a context.
 *
 * Uses a real contextless db.update() against a non-existent UUID row so no
 * real data is touched but the guard is triggered at query-execution time.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, __resetContextlessWriteGuardForTests } from '../../db';
import { users } from '../../db/schema';

// A UUID that must not exist in the test DB.
const PHANTOM_ID = '00000000-dead-beef-0000-000000000000';

const CONTEXTLESS_MSG = 'ran with no RLS access context';

describe('#1379 A1 — DB_CONTEXTLESS_WRITE_STRICT', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalStrict: string | undefined;

  beforeEach(() => {
    originalStrict = process.env.DB_CONTEXTLESS_WRITE_STRICT;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset dedup set so captureMessage path is eligible each test (console.warn
    // fires regardless, but clearing ensures consistent state).
    __resetContextlessWriteGuardForTests();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalStrict === undefined) {
      delete process.env.DB_CONTEXTLESS_WRITE_STRICT;
    } else {
      process.env.DB_CONTEXTLESS_WRITE_STRICT = originalStrict;
    }
  });

  it('warn-only by default: contextless write warns, does not throw', async () => {
    // Explicitly clear so this test is hermetic regardless of ambient CI env.
    delete process.env.DB_CONTEXTLESS_WRITE_STRICT;
    await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, PHANTOM_ID));

    const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes(CONTEXTLESS_MSG));
    expect(hit).toBeTruthy();
    expect(String(hit![0])).toContain('#1375');
  });

  it('throws under DB_CONTEXTLESS_WRITE_STRICT=true', async () => {
    process.env.DB_CONTEXTLESS_WRITE_STRICT = 'true';

    // The guard throws synchronously at db.update() call time (before the chain
    // is awaited), so wrap in an async fn so rejects.toThrow can catch it.
    await expect(async () => {
      await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, PHANTOM_ID));
    }).rejects.toThrow(CONTEXTLESS_MSG);
  });

  it('no throw or warn when write is properly wrapped in withSystemDbAccessContext', async () => {
    process.env.DB_CONTEXTLESS_WRITE_STRICT = 'true';

    await withSystemDbAccessContext(async () => {
      await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, PHANTOM_ID));
    });

    const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes(CONTEXTLESS_MSG));
    expect(hit).toBeUndefined();
  });
});
