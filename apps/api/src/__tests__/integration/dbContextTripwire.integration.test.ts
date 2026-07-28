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

// db/index.ts imports `captureMessage` as a bound ESM named import, so
// vi.spyOn on the module object does not intercept it. Mock the module so the
// held-context capture is observable. Only the attribution test asserts on it;
// every other test here observes console.warn, which is untouched.
const capturedMessages: Array<{
  message: string;
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}> = [];
vi.mock('../../services/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sentry')>();
  return {
    ...actual,
    captureMessage: (
      message: string,
      _level?: unknown,
      extra?: Record<string, unknown>,
      tags?: Record<string, string>,
    ) => {
      capturedMessages.push({ message, extra, tags });
    },
  };
});

import {
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  assertOutsideHeldDbContext,
  __resetHeldContextCaptureThrottleForTests,
} from '../../db';

const HELD = 'held a pooled connection';

describe('#1105 DB-context tripwires', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function heldWarns(): unknown[][] {
    return warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(HELD));
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    capturedMessages.length = 0;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.DB_CONTEXT_TRIPWIRE_STRICT;
    delete process.env.DB_CONTEXT_HELD_WARN_MS;
    delete process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS;
    __resetHeldContextCaptureThrottleForTests();
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

    it('attributes the hold to the OPENER, not to the emitter (BREEZE-9 triage fix)', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';

      // Named so the frame is identifiable in the captured trace. The whole
      // point: ~12k BREEZE-9 events were unactionable because the stack was
      // built in the `finally` — after `await`, when the opener's frames are
      // already gone — so every event pointed at db/index.ts instead of at the
      // code actually holding the connection.
      async function theCulpritThatHoldsTheConnection(): Promise<void> {
        await withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      }

      // Defeat the per-scope capture throttle so this asserts on a real event
      // rather than conditionally skipping and passing vacuously.
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      await theCulpritThatHoldsTheConnection();

      expect(heldWarns()).toHaveLength(1);
      expect(capturedMessages).toHaveLength(1);

      const extra = capturedMessages[0]!.extra;
      expect(typeof extra?.openedAt).toBe('string');
      // The opener's own frame must be present. Before the fix this field did
      // not exist and `stack` contained only the await trampoline.
      expect(String(extra?.openedAt)).toContain('theCulpritThatHoldsTheConnection');
    });

    it('emits the context label as a Sentry TAG and in the message (BREEZE-A triage fix)', async () => {
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      await withDbAccessContext(
        {
          scope: 'organization',
          orgId: null,
          accessibleOrgIds: [],
          accessiblePartnerIds: [],
          currentPartnerId: null,
          label: 'agentWs.heartbeat',
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        },
      );

      expect(capturedMessages).toHaveLength(1);
      // The TAG is the load-bearing part: extras are only visible inside a
      // single event, so an unfilterable bucket (BREEZE-A, ~7k events) stays
      // unfilterable if the label only lands in `extra`.
      expect(capturedMessages[0]!.tags).toEqual({ dbContextLabel: 'agentWs.heartbeat' });
      // Also in the message, because Sentry groups by message — that is what
      // splits one bucket into per-handler issues.
      expect(capturedMessages[0]!.message).toContain('[agentWs.heartbeat]');
    });

    it('omits the tag entirely for an unlabelled context, leaving the message text unchanged', async () => {
      // Grouping stability: every existing caller is unlabelled, so their
      // message must be byte-identical to before this change or their Sentry
      // history splits into a new issue for no reason.
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      await withSystemDbAccessContext(async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
      });

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]!.tags).toBeUndefined();
      expect(capturedMessages[0]!.message).toContain('withDbAccessContext (scope=system) held');
      expect(capturedMessages[0]!.message).not.toContain('[');
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
