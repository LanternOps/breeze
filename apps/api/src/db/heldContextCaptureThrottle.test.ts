import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing ./index pulls the DB module; stub the Sentry surface it uses so the
// unit test never loads the real SDK (mirrors dbWriteExpectingRows.test.ts).
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import {
  shouldCaptureHeldContext,
  shouldReportHeldContextSite,
  parseOpenerFrame,
  formatHeldContextWarning,
  __resetHeldContextCaptureThrottleForTests,
  __resetHeldContextAssertDedupeForTests,
} from './index';

// Guards the #1105 quota fix: the held-context warning must NOT emit one Sentry
// event per occurrence (8.6k events in a week exhausted the org budget and
// blinded all error reporting). It captures at most once per scope per window.
describe('shouldCaptureHeldContext (held-context Sentry-capture throttle)', () => {
  const W = 300_000; // 5-minute window

  beforeEach(() => {
    __resetHeldContextCaptureThrottleForTests();
  });

  it('throttleMs=0 disables throttling — always captures', () => {
    expect(shouldCaptureHeldContext('system', 1000, 0)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1001, 0)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1002, 0)).toBe(true);
  });

  it('captures the first hit for a scope, then throttles within the window', () => {
    expect(shouldCaptureHeldContext('system', 1_000, W)).toBe(true);     // first → capture
    expect(shouldCaptureHeldContext('system', 2_000, W)).toBe(false);    // +1s → throttled
    expect(shouldCaptureHeldContext('system', 300_999, W)).toBe(false);  // just under window
    expect(shouldCaptureHeldContext('system', 301_000, W)).toBe(true);   // window elapsed → capture
    expect(shouldCaptureHeldContext('system', 302_000, W)).toBe(false);  // throttled again
  });

  it('throttles each scope independently', () => {
    expect(shouldCaptureHeldContext('system', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('organization', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('partner', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1, W)).toBe(false);
    expect(shouldCaptureHeldContext('organization', 1, W)).toBe(false);
    expect(shouldCaptureHeldContext('partner', 1, W)).toBe(false);
  });

  it('quantifies the quota win: a constant-hold scope yields ~13/hr, not 720/hr', () => {
    let captures = 0;
    // One hold every 5s for an hour (721 holds) — the flood that drained quota.
    for (let t = 0; t <= 3_600_000; t += 5_000) {
      if (shouldCaptureHeldContext('system', t, W)) captures++;
    }
    expect(captures).toBe(13); // t=0,300k,600k,…,3.6M — a >98% reduction from 721
  });

  it('reset clears throttle state', () => {
    expect(shouldCaptureHeldContext('system', 1, W)).toBe(true);
    expect(shouldCaptureHeldContext('system', 2, W)).toBe(false);
    __resetHeldContextCaptureThrottleForTests();
    expect(shouldCaptureHeldContext('system', 2, W)).toBe(true);
  });
});

// Guards the second flavor of the same quota failure: the enqueue tripwire
// (assertOutsideHeldDbContext) marks a wrong CALL SITE, not N distinct errors.
// Unthrottled it produced ~2.2k Sentry events in a day from seven call sites
// (BREEZE-H) and helped exhaust the org quota. One capture per site per process
// is the whole signal; console.warn stays per-occurrence.
describe('shouldReportHeldContextSite (enqueue-tripwire Sentry-capture dedupe)', () => {
  beforeEach(() => {
    __resetHeldContextAssertDedupeForTests();
  });

  it('reports a given call site once, then suppresses it', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
  });

  it('tracks distinct call sites independently', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    expect(shouldReportHeldContextSite('stack-b')).toBe(true);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
    expect(shouldReportHeldContextSite('stack-b')).toBe(false);
  });

  it('reset clears the seen-set', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    __resetHeldContextAssertDedupeForTests();
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
  });
});

// #3218: the console warning has to name the caller by itself. The `openedAt`
// stack was already captured but only reached Sentry — which is exactly the
// channel that drops these warnings during the incident that produces them
// (the concurrent hot error saturates the DSN rate limit). These guard the
// frame picker that turns that stack into one log-line attribution.
describe('parseOpenerFrame (#1105 hold-warning attribution)', () => {
  const frames = (...lines: string[]) =>
    ['Error: withDbAccessContext opened here', ...lines].join('\n');

  // The emitter allocates the Error inside withDbAccessContext, so the top
  // frame is ALWAYS this module. Returning it would reproduce the exact BREEZE-9
  // failure: 12k events all naming the emitter instead of the caller.
  it('skips this module and the context wrappers to reach the caller', () => {
    const result = parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/src/db/index.ts:304:34)',
      '    at withSystemDbAccessContext (/app/apps/api/src/db/index.ts:353:10)',
      '    at pollDevices (/app/apps/api/src/workers/devicePoller.ts:88:12)',
    ));
    expect(result).toEqual({
      location: 'apps/api/src/workers/devicePoller.ts:88:12',
      label: 'devicePoller.pollDevices',
    });
  });

  it('skips node_modules and node-internal frames', () => {
    const result = parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/src/db/index.ts:304:34)',
      '    at Object.begin (/app/node_modules/postgres/cjs/src/index.js:512:9)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at handleHeartbeat (/app/apps/api/src/routes/agent/heartbeat.ts:120:3)',
    ));
    expect(result?.location).toBe('apps/api/src/routes/agent/heartbeat.ts:120:3');
    expect(result?.label).toBe('heartbeat.handleHeartbeat');
  });

  it('handles async frames, receiver prefixes and [as alias] suffixes', () => {
    const result = parseOpenerFrame(frames(
      '    at async Object.getDevice [as handler] (/app/apps/api/src/routes/devices.ts:42:10)',
    ));
    expect(result).toEqual({
      location: 'apps/api/src/routes/devices.ts:42:10',
      label: 'devices.getDevice',
    });
  });

  it('handles a bare location frame with no function name', () => {
    const result = parseOpenerFrame(frames(
      '    at /app/apps/api/src/services/alertEngine.ts:17:5',
    ));
    expect(result).toEqual({
      location: 'apps/api/src/services/alertEngine.ts:17:5',
      label: 'alertEngine',
    });
  });

  it('strips the file:// scheme ESM stacks carry', () => {
    const result = parseOpenerFrame(frames(
      '    at run (file:///app/apps/api/src/workers/patchWorker.ts:9:1)',
    ));
    expect(result?.location).toBe('apps/api/src/workers/patchWorker.ts:9:1');
  });

  // The label feeds a Sentry tag and the grouped message; line numbers move on
  // every unrelated edit above the call site, so they must NOT reach it or one
  // issue forks into a new one per release.
  it('keeps line/column out of the grouping label', () => {
    const a = parseOpenerFrame(frames('    at run (/app/apps/api/src/workers/w.ts:9:1)'));
    const b = parseOpenerFrame(frames('    at run (/app/apps/api/src/workers/w.ts:412:7)'));
    expect(a?.label).toBe(b?.label);
    expect(a?.location).not.toBe(b?.location);
  });

  it('returns null when there is no application frame, rather than naming the runtime', () => {
    expect(parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/src/db/index.ts:304:34)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ))).toBeNull();
  });

  it('returns null for an absent or frameless stack', () => {
    expect(parseOpenerFrame(undefined)).toBeNull();
    expect(parseOpenerFrame('')).toBeNull();
    expect(parseOpenerFrame('Error: no frames here')).toBeNull();
  });

  // Openers are not all in apps/ — a context can be opened from shared code.
  it('attributes a frame in packages/ too', () => {
    const result = parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/src/db/index.ts:304:34)',
      '    at dispatch (/app/packages/shared/src/queue/dispatch.ts:12:4)',
    ));
    expect(result).toEqual({
      location: 'packages/shared/src/queue/dispatch.ts:12:4',
      label: 'dispatch.dispatch',
    });
  });

  // The path-based self-exclusion hardcodes today's filename. If this module is
  // ever split or renamed, the emitter frame must STILL be skipped by name, or
  // the BREEZE-9 bug (every event naming the emitter) silently returns.
  it('still skips the emitter by function name if db/index.ts is renamed', () => {
    const result = parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/src/db/accessContext.ts:304:34)',
      '    at withSystemDbAccessContext (/app/apps/api/src/db/accessContext.ts:353:10)',
      '    at reconcile (/app/apps/api/src/workers/reconciler.ts:31:2)',
    ));
    expect(result?.label).toBe('reconciler.reconcile');
  });

  it('skips node_modules nested inside an app directory', () => {
    const result = parseOpenerFrame(frames(
      '    at q (/app/apps/api/node_modules/drizzle-orm/session.js:88:1)',
      '    at tick (/app/apps/api/src/workers/tick.ts:4:4)',
    ));
    expect(result?.location).toBe('apps/api/src/workers/tick.ts:4:4');
  });

  it('normalizes a constructor frame instead of leaking "new " into the label', () => {
    const result = parseOpenerFrame(frames(
      '    at new PatchClient (/app/apps/api/src/workers/patchWorker.ts:5:1)',
    ));
    expect(result?.label).toBe('patchWorker.PatchClient');
  });

  // Attribution must survive a compiled deploy — that is where it is needed.
  it('attributes a built .js frame the same way', () => {
    const result = parseOpenerFrame(frames(
      '    at withDbAccessContext (/app/apps/api/dist/db/index.js:1204:34)',
      '    at sweep (/app/apps/api/dist/workers/sweeper.js:77:9)',
    ));
    expect(result?.label).toBe('sweeper.sweep');
  });
});

// The synthetic stacks above pin the parsing rules, but the feature rests on an
// assumption they cannot test: the emitter allocates its Error INSIDE the
// transaction callback, after ~6 `await tx.execute(...)` calls, so the opener's
// synchronous frames are long gone by then. It only works because V8 keeps
// async frames across awaits (rendered `at async fn (...)`). If that ever stops
// holding, every warning silently degrades to naming nothing — so assert it
// against a real, runtime-generated stack rather than a hand-written string.
describe('parseOpenerFrame against a REAL V8 async stack', () => {
  async function theCulpritThatHoldsTheConnection(): Promise<string | undefined> {
    // `return await`, not a bare `return` — V8 only links an async frame into
    // the trace at a real await point, so a tail `return f()` drops the caller
    // from the stack entirely. Real openers all `await withDbAccessContext(...)`,
    // which is the shape reproduced here.
    return await emulateTransactionCallback();
  }

  async function emulateTransactionCallback(): Promise<string | undefined> {
    // Mirror the awaits that precede the Error allocation in withDbAccessContext.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    return new Error('withDbAccessContext opened here').stack;
  }

  it('still carries the caller frames after 6 awaits — the assumption the feature rests on', async () => {
    const stack = await theCulpritThatHoldsTheConnection();
    // The outer caller is several awaits and one frame above the allocation. If
    // V8 ever drops async frames this goes empty and every warning degrades to
    // naming nothing — which is the exact BREEZE-9 failure being fixed.
    expect(stack).toContain('theCulpritThatHoldsTheConnection');
  });

  it('resolves a real runtime stack to the nearest application frame', async () => {
    const stack = await theCulpritThatHoldsTheConnection();
    const frame = parseOpenerFrame(stack);

    expect(frame).not.toBeNull();
    // The NEAREST app frame is the right answer: in production the equivalent
    // intermediate (the transaction callback) lives in db/index.ts and is
    // skipped, so the nearest remaining frame IS the true opener. Here that
    // helper sits in this test file, so it is legitimately the nearest one.
    expect(frame!.label).toContain('emulateTransactionCallback');
    // A jumpable location, parsed out of genuine V8 output.
    expect(frame!.location).toMatch(/heldContextCaptureThrottle\.test\.ts:\d+:\d+$/);
    // Never the runtime or the emitter's own module.
    expect(frame!.location).not.toContain('node_modules');
    expect(frame!.location).not.toMatch(/^node:/);
  });
});

// The payoff of #3218: what actually lands in the droplet log. The console line
// must be self-sufficient for attribution while the Sentry-facing `message`
// stays stable enough to group.
describe('formatHeldContextWarning (#3218 console attribution)', () => {
  const frame = { location: 'apps/api/src/workers/sweeper.ts:77:9', label: 'sweeper.sweep' };
  const base = { scope: 'system' as const, openerFrame: frame, heldMs: 40_000, warnMs: 2_000 };

  it('names the caller in the console line — the whole point of the issue', () => {
    const { consoleLine } = formatHeldContextWarning(base);
    expect(consoleLine).toContain('apps/api/src/workers/sweeper.ts:77:9');
    expect(consoleLine).toContain('[sweeper.sweep]');
    expect(consoleLine).toContain('40000ms');
  });

  it('keeps file:line OUT of the Sentry message so grouping survives edits', () => {
    const early = formatHeldContextWarning(base);
    const later = formatHeldContextWarning({
      ...base,
      openerFrame: { location: 'apps/api/src/workers/sweeper.ts:412:9', label: 'sweeper.sweep' },
    });
    expect(early.message).not.toContain(':77:9');
    expect(early.message).toBe(later.message);
    expect(early.consoleLine).not.toBe(later.consoleLine);
  });

  it('prefers an explicit label over the derived one, and tags them separately', () => {
    const { message, tags } = formatHeldContextWarning({ ...base, label: 'agentWs.heartbeat' });
    expect(message).toContain('[agentWs.heartbeat]');
    expect(message).not.toContain('[sweeper.sweep]');
    // Existing Sentry queries on dbContextLabel keep meaning explicit-only.
    expect(tags).toEqual({ dbContextLabel: 'agentWs.heartbeat', dbContextOpener: 'sweeper.sweep' });
  });

  // A blank label must not win the `??` race and then render as nothing: that
  // would both defeat the REQUIRED-label safeguard on shared closures (agentWs,
  // BREEZE-A) and suppress the derived fallback — strictly worse than passing
  // no label at all.
  it.each([['', 'empty'], ['   ', 'whitespace-only']])(
    'treats a %s label as absent and falls back to the derived one',
    (blank) => {
      const { message, tags } = formatHeldContextWarning({ ...base, label: blank });
      expect(message).toContain('[sweeper.sweep]');
      expect(tags).toEqual({ dbContextOpener: 'sweeper.sweep' });
    },
  );

  it('trims a padded explicit label rather than emitting the padding', () => {
    const { message, tags } = formatHeldContextWarning({ ...base, label: '  agentWs.heartbeat  ' });
    expect(message).toContain('[agentWs.heartbeat]');
    expect(tags.dbContextLabel).toBe('agentWs.heartbeat');
  });

  it('derives the label when no explicit one was passed', () => {
    const { message, tags } = formatHeldContextWarning(base);
    expect(message).toContain('[sweeper.sweep]');
    expect(tags).toEqual({ dbContextOpener: 'sweeper.sweep' });
  });

  it('degrades to the previous message shape when no frame is resolvable', () => {
    const { message, consoleLine, tags } = formatHeldContextWarning({ ...base, openerFrame: null });
    expect(message).toContain('withDbAccessContext (scope=system) held a pooled connection');
    expect(consoleLine).toBe(message);
    expect(tags).toEqual({});
  });

  it('omits the "Opened at" suffix when a label is given but no frame resolved', () => {
    const { consoleLine, tags } = formatHeldContextWarning({
      ...base,
      openerFrame: null,
      label: 'agentWs.heartbeat',
    });
    expect(consoleLine).toContain('[agentWs.heartbeat]');
    expect(consoleLine).not.toContain('Opened at');
    expect(tags).toEqual({ dbContextLabel: 'agentWs.heartbeat' });
  });

  it('still reports scope, threshold and the #1105 remediation pointer', () => {
    const { consoleLine } = formatHeldContextWarning({ ...base, scope: 'organization' });
    expect(consoleLine).toContain('scope=organization');
    expect(consoleLine).toContain('>= 2000ms');
    expect(consoleLine).toContain('runOutsideDbContext (#1105)');
  });
});
