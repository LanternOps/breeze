/**
 * Concurrency isolation test for withSentryRequestScope (#1379 B2 review).
 *
 * This file intentionally does NOT mock @sentry/node. It exercises the REAL
 * Sentry SDK (with a fake DSN so no network calls are made) to verify that
 * two concurrent requests cannot bleed tenant tags into each other's events.
 *
 * The mechanism under test: Sentry.init() installs an AsyncLocalStorage-based
 * async-context strategy. withIsolationScope() forks a new scope into that
 * ALS context, so every setUser/setTag call inside the callback is visible
 * only within that async subtree — not to sibling requests running concurrently.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/node';

// Recorded events intercepted before transport delivery.
const recorded: Sentry.Event[] = [];

let withSentryRequestScope: <T>(
  ctx: {
    userId: string;
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    partnerId: string | null;
  },
  run: () => T
) => T;

beforeAll(async () => {
  // Set a fake-but-valid-format DSN so Sentry.init() actually initialises.
  // No real network connection is made — we intercept events via an event
  // processor registered on the client BEFORE they reach the transport layer.
  process.env.SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/0';

  // Dynamically import so the module picks up the env var above.
  const sentryModule = await import('./sentry');
  sentryModule.initSentry();
  withSentryRequestScope = sentryModule.withSentryRequestScope;

  // Register an event processor that records events and drops them (returning
  // null) so they never reach the Sentry transport (no network). The processor
  // captures tags and user from the event as Sentry enriches them from the
  // active scope before calling processors.
  Sentry.addEventProcessor((event) => {
    // Deep-copy so scope mutations after capture don't affect what we recorded.
    recorded.push(JSON.parse(JSON.stringify(event)) as Sentry.Event);
    // Return null to drop the event — prevents any transport delivery.
    return null;
  });
});

afterAll(async () => {
  // Flush any remaining buffered events, then close the transport.
  await Sentry.close(500);
  delete process.env.SENTRY_DSN;
});

describe('withSentryRequestScope — concurrent tenant isolation', () => {
  it('keeps tenant tags request-local even when two requests interleave', async () => {
    // Run two withSentryRequestScope calls concurrently. Each introduces an
    // async yield inside the callback (Promise.resolve()) to force interleaving
    // of microtasks, proving that the ALS boundary actually isolates them.
    await Promise.all([
      withSentryRequestScope(
        { userId: 'uA', scope: 'organization', orgId: 'oA', partnerId: null },
        async () => {
          // Yield to allow the other request's callback to interleave.
          await Promise.resolve();
          Sentry.captureException(new Error('event-A'));
        }
      ),
      withSentryRequestScope(
        { userId: 'uB', scope: 'partner', orgId: null, partnerId: 'pB' },
        async () => {
          await Promise.resolve();
          Sentry.captureException(new Error('event-B'));
        }
      ),
    ]);

    // Flush Sentry's internal processing pipeline so event processors fire
    // and populate `recorded` before we assert. Without this, captureException
    // enqueues events asynchronously and the assertions would race.
    await Sentry.flush(1000);

    // Both events should have been recorded by the processor above.
    const eventA = recorded.find(
      (e) => e.exception?.values?.[0]?.value?.includes('event-A')
    );
    const eventB = recorded.find(
      (e) => e.exception?.values?.[0]?.value?.includes('event-B')
    );

    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();

    // Event A must carry oA's tags and uA's user — NOT oB/uB.
    expect(eventA?.tags?.['orgId']).toBe('oA');
    expect(eventA?.tags?.['partnerId']).toBe('none');
    expect(eventA?.user?.id).toBe('uA');

    // Event B must carry pB's tags and uB's user — NOT oA/uA.
    expect(eventB?.tags?.['orgId']).toBe('none');
    expect(eventB?.tags?.['partnerId']).toBe('pB');
    expect(eventB?.user?.id).toBe('uB');

    // Cross-check: no bleed between scopes.
    expect(eventA?.tags?.['orgId']).not.toBe('none');  // A has a real orgId
    expect(eventB?.user?.id).not.toBe('uA');           // B didn't pick up A's user
  });
});
