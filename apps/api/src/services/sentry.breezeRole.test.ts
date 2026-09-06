/**
 * The `breeze_role` Sentry tag (#4143).
 *
 * Since the api/worker role split (#4086) a droplet in split mode runs two
 * containers off the same image, with the same DSN, release and environment.
 * Without this tag an event from the worker is indistinguishable from one
 * served on the request path — so "is this the scheduler or the API?", the
 * first question asked in both #3022 and #3214, could not be answered from
 * Sentry at all.
 *
 * Two halves, and BOTH are needed for the tag to actually arrive:
 *   1. `initSentry` sets it on the global scope.
 *   2. `ALLOWED_TAG_NAMES` lists it, so `scrubEvent` — which rebuilds `tags`
 *      from that allowlist on the way out — does not delete it.
 * Half 2 is the one this repo has silently lost before: the `worker` tag was
 * set correctly for two days and then voided by the allowlist landing without
 * it (see that entry's chronology in services/sentry.ts). Asserting the tag is
 * set is therefore NOT sufficient evidence that it ships; the scrubber
 * assertion below is what closes that gap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const moduleSetTagMock = vi.fn();

vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  withScope: (cb: (scope: unknown) => void) => cb({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn(), setExtras: vi.fn() }),
  setUser: vi.fn(),
  setTag: (...args: unknown[]) => moduleSetTagMock(...args),
}));

const ORIGINAL_ENV = { ...process.env };
const DSN = 'https://abc@o1.ingest.us.sentry.io/2';

beforeEach(() => {
  vi.resetModules();
  initMock.mockClear();
  moduleSetTagMock.mockClear();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('breeze_role Sentry tag (#4143)', () => {
  it.each([
    ['worker', 'worker'],
    ['api', 'api'],
    ['all', 'all'],
  ])('initSentry tags the scope with BREEZE_ROLE=%s -> %s', async (role, expected) => {
    process.env.SENTRY_DSN = DSN;
    process.env.BREEZE_ROLE = role;

    const { initSentry } = await import('./sentry');
    initSentry();

    expect(moduleSetTagMock).toHaveBeenCalledWith('breeze_role', expected);
  });

  it('defaults to `all` when BREEZE_ROLE is unset', async () => {
    process.env.SENTRY_DSN = DSN;
    delete process.env.BREEZE_ROLE;

    const { initSentry } = await import('./sentry');
    initSentry();

    expect(moduleSetTagMock).toHaveBeenCalledWith('breeze_role', 'all');
  });

  it('does not set the tag when Sentry is disabled (no DSN)', async () => {
    // `initSentry` returns early without a DSN; setting a tag on an
    // uninitialised client is pointless and would misreport isSentryEnabled().
    delete process.env.SENTRY_DSN;
    process.env.BREEZE_ROLE = 'worker';

    const { initSentry, isSentryEnabled } = await import('./sentry');
    initSentry();

    expect(isSentryEnabled()).toBe(false);
    expect(moduleSetTagMock).not.toHaveBeenCalledWith('breeze_role', expect.anything());
  });

  it('SURVIVES the scrubber — the tag is allowlisted, not silently voided', async () => {
    // The load-bearing half. `scrubEvent` rebuilds `event.tags` from
    // ALLOWED_TAG_NAMES, so a tag that is set but not listed arrives as
    // nothing at all — exactly how the `worker` tag regressed for two days.
    const { scrubEvent } = await import('./sentry');

    const scrubbed = scrubEvent({
      tags: { breeze_role: 'worker', some_unlisted_tag: 'dropped' },
    } as Record<string, unknown>);

    expect(scrubbed.tags).toEqual({ breeze_role: 'worker' });
  });

  it.each(['all', 'api', 'worker'])('survives the scrubber for role %s', async (role) => {
    const { scrubEvent } = await import('./sentry');
    const scrubbed = scrubEvent({ tags: { breeze_role: role } } as Record<string, unknown>);
    expect(scrubbed.tags).toEqual({ breeze_role: role });
  });
});

describe('sentryBreezeRoleTag agrees with config/env breezeRole (anti-drift)', () => {
  // services/sentry.ts deliberately does NOT import config/env — it is imported
  // by ~120 modules including db/index.ts, and config/env reads ~40 env values
  // into module-scope consts. The duplication that buys is only safe while the
  // two normalisations agree, which is what this pins.
  it.each([
    ['worker', 'worker'],
    ['api', 'api'],
    ['all', 'all'],
    ['', 'all'],
    ['  WORKER  ', 'worker'],
    ['API', 'api'],
    ['nonsense', 'all'],
    ['workerish', 'all'],
  ])('BREEZE_ROLE=%o -> %s in both implementations', async (raw, expected) => {
    process.env.BREEZE_ROLE = raw;

    const { sentryBreezeRoleTag } = await import('./sentry');
    const { breezeRole } = await import('../config/env');

    expect(sentryBreezeRoleTag()).toBe(expected);
    expect(breezeRole()).toBe(expected);
  });

  it('agrees when BREEZE_ROLE is unset entirely', async () => {
    delete process.env.BREEZE_ROLE;

    const { sentryBreezeRoleTag } = await import('./sentry');
    const { breezeRole } = await import('../config/env');

    expect(sentryBreezeRoleTag()).toBe('all');
    expect(breezeRole()).toBe('all');
  });
});
