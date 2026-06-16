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
 * Real-DB integration test because both mechanisms depend on a genuinely held
 * transaction (withSystemDbAccessContext opens one on the breeze_app pool).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withSystemDbAccessContext,
  runOutsideDbContext,
  assertOutsideHeldDbContext,
} from '../../db';

describe('#1105 DB-context tripwires', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.DB_CONTEXT_TRIPWIRE_STRICT;
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

    it('throws inside a held context under strict mode (CI)', async () => {
      process.env.DB_CONTEXT_TRIPWIRE_STRICT = '1';
      await expect(
        withSystemDbAccessContext(async () => {
          assertOutsideHeldDbContext('redis.enqueue');
        }),
      ).rejects.toThrow(/#1105/);
    });
  });

  describe('held-context duration warning', () => {
    it('warns when a context is held longer than DB_CONTEXT_HELD_WARN_MS', async () => {
      const prev = process.env.DB_CONTEXT_HELD_WARN_MS;
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      try {
        await withSystemDbAccessContext(async () => {
          // Stand in for slow non-DB work (Redis/HTTP) inside the context.
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      } finally {
        if (prev === undefined) delete process.env.DB_CONTEXT_HELD_WARN_MS;
        else process.env.DB_CONTEXT_HELD_WARN_MS = prev;
      }
      const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('held a pooled connection'));
      expect(hit).toBeTruthy();
      expect(String(hit![0])).toContain('#1105');
    });

    it('does not warn for a fast DB-only context (no slow work)', async () => {
      const prev = process.env.DB_CONTEXT_HELD_WARN_MS;
      process.env.DB_CONTEXT_HELD_WARN_MS = '500';
      try {
        await withSystemDbAccessContext(async () => {
          // trivial; well under threshold
        });
      } finally {
        if (prev === undefined) delete process.env.DB_CONTEXT_HELD_WARN_MS;
        else process.env.DB_CONTEXT_HELD_WARN_MS = prev;
      }
      const hit = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes('held a pooled connection'));
      expect(hit).toBeUndefined();
    });
  });
});
