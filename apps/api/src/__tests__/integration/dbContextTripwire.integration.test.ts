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
  eventCode?: string;
  tags?: Record<string, string>;
}> = [];
vi.mock('../../services/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sentry')>();
  return {
    ...actual,
    // BREEZE-18: captureMessage takes an options object, not four positionals.
    // `vi.mock`'s factory return is not checked against the real module's
    // types, so an adapter left on the old shape does NOT fail tsc — it fails
    // at assertion time, and only in the integration shard that owns this file.
    captureMessage: (
      message: string,
      options?: { eventCode?: string; tags?: Record<string, string> },
    ) => {
      capturedMessages.push({
        message,
        eventCode: options?.eventCode,
        tags: options?.tags,
      });
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

      // BREEZE-18: this used to read `extra.openedAt`, a field that never left
      // the process — captureMessage never attached it and scrubEvent deleted
      // it. The opener attribution now rides the allowlisted `dbContextOpener`
      // TAG, which actually reaches Sentry, and the precise file:line stays on
      // the console line. Both are asserted, so neither can rot silently.
      expect(capturedMessages[0]!.tags?.dbContextOpener)
        .toContain('theCulpritThatHoldsTheConnection');
      expect(String(heldWarns()[0]?.[0]))
        .toContain('theCulpritThatHoldsTheConnection');
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
      // BREEZE-18: every captureMessage carries a required, registered event
      // code, applied by captureMessage itself. Asserted against a real held
      // context (not a unit double) because this is the path that produced the
      // contentless events in the first place.
      expect(capturedMessages[0]!.eventCode).toBe('db_context_held_too_long');
      // The TAG is the load-bearing part: extras are only visible inside a
      // single event, so an unfilterable bucket (BREEZE-A, ~7k events) stays
      // unfilterable if the label only lands in `extra`.
      expect(capturedMessages[0]!.tags?.dbContextLabel).toBe('agentWs.heartbeat');
      // Also in the message, because Sentry groups by message — that is what
      // splits one bucket into per-handler issues.
      expect(capturedMessages[0]!.message).toContain('[agentWs.heartbeat]');
      // #3218 added a second, derived tag alongside it. `dbContextLabel` must
      // stay EXPLICIT-only so existing Sentry queries keep their meaning — the
      // derived opener goes in its own key, never widening this one.
      expect(capturedMessages[0]!.tags?.dbContextOpener).toEqual(expect.stringContaining('dbContextTripwire'));
    });

    it('withSystemDbAccessContext(fn, label) carries the label through to the tag and message (#4276)', async () => {
      // The two-argument form is the new surface #4276 adds — the metric
      // rollup workers pass e.g. 'metricRollups.raw.device_metrics' through it.
      // The unit tests only assert the label string is handed to a MOCK; this
      // proves the real plumbing (systemDbAccessContext -> withDbAccessContext
      // -> formatHeldContextWarning) lands it in the allowlisted tag against a
      // real held connection.
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      await withSystemDbAccessContext(async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
      }, 'metricRollups.raw.device_metrics');

      expect(capturedMessages).toHaveLength(1);
      expect(capturedMessages[0]!.tags?.dbContextLabel).toBe('metricRollups.raw.device_metrics');
      expect(capturedMessages[0]!.message).toContain('[metricRollups.raw.device_metrics]');
    });

    it('derives a grouping label from the opener when the context is unlabelled (#3218)', async () => {
      // Supersedes the previous contract ("unlabelled callers keep byte-identical
      // message text"). That stability was deliberately traded away in #3218:
      // most callers are unlabelled, so preserving their text meant they all
      // landed in ONE opaque bucket that could not be attributed. Regrouping
      // them per source is a one-time cost paid once, on purpose.
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      async function anUnlabelledCallerThatHolds(): Promise<void> {
        await withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      }
      await anUnlabelledCallerThatHolds();

      expect(capturedMessages).toHaveLength(1);
      const event = capturedMessages[0]!;
      expect(event.message).toContain('withDbAccessContext (scope=system)');
      expect(event.message).toContain(HELD);
      // No explicit label was passed, so only the derived tag is present.
      expect(event.tags?.dbContextLabel).toBeUndefined();
      expect(event.tags?.dbContextOpener).toContain('anUnlabelledCallerThatHolds');
      // The derived name reaches the grouped message too...
      expect(event.message).toContain('[');
      expect(event.message).toContain('anUnlabelledCallerThatHolds');
      // ...but the precise file:line must NOT, or every edit above the call site
      // forks the Sentry issue. It belongs to the console line alone.
      expect(event.message).not.toMatch(/\.ts:\d+/);
      expect(String(heldWarns()[0]?.[0])).toMatch(/dbContextTripwire.*:\d+:\d+/);
      // The TAG must stay free of the file:line for the same grouping reason.
      expect(event.tags?.dbContextOpener).not.toMatch(/:\d+/);
    });

    it('attributes a caller that uses a bare `return` instead of `await` (#3218)', async () => {
      // 66 call sites in this repo do `return withSystemDbAccessContext(...)`
      // with no await — most BullMQ job workers among them, which are a prime
      // suspect for real long holds. V8 links an async frame only at a genuine
      // await, so while the opener stack was allocated inside the transaction
      // callback (after six awaits) every one of those callers was dropped from
      // the trace: unattributed, or misattributed to the next function out.
      // The stack is now allocated at withDbAccessContext ENTRY, where the
      // caller's frame is live on the synchronous stack regardless of idiom.
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';
      process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS = '0';
      __resetHeldContextCaptureThrottleForTests();

      // Deliberately a bare return — no await anywhere in the chain.
      function aBareReturnWorkerCallsite(): Promise<void> {
        return withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      }
      await aBareReturnWorkerCallsite();

      const hits = heldWarns();
      expect(hits).toHaveLength(1);
      expect(String(hits[0]![0])).toContain('aBareReturnWorkerCallsite');
      expect(capturedMessages[0]!.tags?.dbContextOpener).toContain('aBareReturnWorkerCallsite');
    });

    it('names the opening caller in the CONSOLE line, not just in Sentry (#3218)', async () => {
      // The whole point of #3218: during the incident the DSN rate limit was
      // saturated by a concurrent hot error, so the throttled Sentry captures
      // were dropped exactly when needed. The console line must stand alone.
      process.env.DB_CONTEXT_HELD_WARN_MS = '50';

      async function theConsoleAttributionCulprit(): Promise<void> {
        await withSystemDbAccessContext(async () => {
          await new Promise((resolve) => setTimeout(resolve, 90));
        });
      }
      await theConsoleAttributionCulprit();

      const hits = heldWarns();
      expect(hits).toHaveLength(1);
      const line = String(hits[0]![0]);
      expect(line).toContain('theConsoleAttributionCulprit');
      // A real file:line an operator can jump to, straight from droplet logs.
      expect(line).toMatch(/Opened at .*dbContextTripwire.*:\d+:\d+\./);
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
