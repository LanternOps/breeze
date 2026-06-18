/**
 * #1105 Phase 1 — DB-context tripwires.
 *
 * Exercises the two detection mechanisms added to surface the
 * txn-around-slow-work foot-gun (a withDbAccessContext transaction held across
 * slow non-DB work, which poisons the pool under a mass agent reconnect):
 *   1. `assertOutsideHeldDbContext(op)` — fires when a slow primitive runs
 *      inside a held context; warn-only by default, throws under strict mode.
 *   2. the held-context duration warning baked into withDbAccessContext.
 *
 * Real-DB integration test because the duration warning depends on a genuinely
 * held transaction (withSystemDbAccessContext opens one on the breeze_app pool).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withSystemDbAccessContext,
  runOutsideDbContext,
  assertOutsideHeldDbContext,
} from '../../db';

const HELD = 'held a pooled connection';

describe('#1105 DB-context tripwires', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function heldWarns(): unknown[][] {
    return warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(HELD));
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.DB_CONTEXT_TRIPWIRE_STRICT;
    delete process.env.DB_CONTEXT_HELD_WARN_MS;
  });

  describe('assertOutsideHeldDbContext', () => {
    it('is a no-op outside any DB context', () => {
      expect(() => assertOutsideHeldDbContext('redis.enqueue')).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns (warn-only default) when called inside a held context', async () => {
      await withSystemDbAccessContext(async () => {
        assertOutsideHeldDbContext('redis.enqueue');
      });
      const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('redis.enqueue'));
      expect(hit).toBeTruthy();
      expect(String(hit![0])).toContain('#1105');
    });

    it('does NOT fire when the slow work is wrapped in runOutsideDbContext (escape hatch)', async () => {
      await withSystemDbAccessContext(async () => {
        await runOutsideDbContext(async () => {
          assertOutsideHeldDbContext('redis.enqueue');
        });
      });
      const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('redis.enqueue'));
      expect(hit).toBeUndefined();
    });

    it('throws inside a held context under strict mode (=1)', async () => {
      process.env.DB_CONTEXT_TRIPWIRE_STRICT = '1';
      await expect(
        withSystemDbAccessContext(async () => {
          assertOutsideHeldDbContext('redis.enqueue');
        }),
      ).rejects.toThrow(/#1105/);
    });

    it('accepts truthy spellings for strict mode (e.g. "true")', async () => {
      process.env.DB_CONTEXT_TRIPWIRE_STRICT = 'true';
      await expect(
        withSystemDbAccessContext(async () => {
          assertOutsideHeldDbContext('redis.enqueue');
        }),
      ).rejects.toThrow(/#1105/);
    });
  });

  describe('held-context duration warning', () => {
    it('warns (with scope) when a context is held longer than DB_CONTEXT_HELD_WARN_MS', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      await withSystemDbAccessContext(async () => {
        // Stand in for slow non-DB work (Redis/HTTP) inside the context.
        await new Promise((resolve) => setTimeout(resolve, 90));
      });
      const hits = heldWarns();
      expect(hits).toHaveLength(1);
      expect(String(hits[0]![0])).toContain('#1105');
      expect(String(hits[0]![0])).toContain('scope=system');
    });

    it('still warns when fn THROWS after holding the context too long (the finally path)', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      await expect(
        withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // The original error must still propagate AND the warn must have fired.
      expect(heldWarns()).toHaveLength(1);
    });

    it('does not double-warn for a nested context (only the outermost holds the txn)', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      await withSystemDbAccessContext(async () => {
        // Nested call short-circuits (reuses the parent context, no new txn).
        await withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      });
      expect(heldWarns()).toHaveLength(1);
    });

    it('disables the duration warn when DB_CONTEXT_HELD_WARN_MS=0', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '0';
      await withSystemDbAccessContext(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(heldWarns()).toHaveLength(0);
    });

    it('does not warn for a fast DB-only context (no slow work)', async () => {
      // Generous threshold so the real set_config round-trips on a slow CI DB
      // can't spuriously trip it.
      process.env.DB_CONTEXT_HELD_WARN_MS = '5000';
      await withSystemDbAccessContext(async () => {
        // trivial; well under threshold
      });
      expect(heldWarns()).toHaveLength(0);
    });
  });
});
