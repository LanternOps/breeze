import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneHttpError } from './client';

// actions.ts pulls in ../../db (and transitively ../../jobs/s1Sync) at import
// time. We only exercise the pure helpers (truncateError /
// logActionDispatchFailureServerSide), so stub the heavy deps to keep this a
// fast unit test rather than wiring a full DB/queue mock.
vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../jobs/s1Sync', () => ({
  dispatchS1Isolation: vi.fn(),
  dispatchS1ThreatAction: vi.fn(),
  scheduleS1ActionPoll: vi.fn(),
}));

import { truncateError, logActionDispatchFailureServerSide } from './actions';

const UPSTREAM_BODY_MARKER = 'UPSTREAM_BODY_MARKER_should_never_reach_tenant';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('truncateError', () => {
  it('keeps a SentinelOneHttpError body-free (upstream body never reaches the tenant)', () => {
    const err = new SentinelOneHttpError(
      'POST',
      '/web/api/v2.1/agents/actions/disconnect',
      500,
      `{"errors":[{"detail":"${UPSTREAM_BODY_MARKER}"}]}`
    );

    const text = truncateError(err);

    // `.message` is the status line only; the upstream `.responseBody` is excluded.
    expect(text).not.toContain(UPSTREAM_BODY_MARKER);
    expect(text).toContain('failed (500)');
  });

  it('redacts a secret-shaped Authorization header in a non-S1HttpError message', () => {
    const err = new Error('connect failed sending Authorization: Bearer s3cr3t-token-value to host');

    const text = truncateError(err);

    expect(text).not.toContain('s3cr3t-token-value');
    expect(text).toContain('[REDACTED]');
  });

  it('truncates very long messages to 2000 chars', () => {
    const err = new Error('x'.repeat(5_000));
    expect(truncateError(err).length).toBe(2_000);
  });
});

describe('logActionDispatchFailureServerSide', () => {
  it('logs the (redacted) upstream responseBody server-side for a SentinelOneHttpError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new SentinelOneHttpError(
      'POST',
      '/web/api/v2.1/threats/mitigate/kill',
      502,
      `body Authorization: Bearer leaked-token ${UPSTREAM_BODY_MARKER}`
    );

    logActionDispatchFailureServerSide({ orgId: 'org-1', integrationId: 'int-1' }, err);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    // The diagnostic body IS captured server-side (it was being dropped before).
    expect(payload).toContain(UPSTREAM_BODY_MARKER);
    expect(payload).toContain('org-1');
    expect(payload).toContain('"status":502');
    // But any header secret echoed inside the body is redacted.
    expect(payload).not.toContain('leaked-token');
    expect(payload).toContain('[REDACTED]');
  });

  it('logs a redacted message for a non-S1HttpError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('transport error Authorization: Bearer another-secret');

    logActionDispatchFailureServerSide({ orgId: 'org-2', integrationId: 'int-2' }, err);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    expect(payload).toContain('org-2');
    expect(payload).not.toContain('another-secret');
    expect(payload).toContain('[REDACTED]');
  });
});
