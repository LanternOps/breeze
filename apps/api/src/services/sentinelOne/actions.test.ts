import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneHttpError } from './client';

// actions.ts pulls in ../../db (and transitively ../../jobs/s1Sync) at import
// time. We only exercise the pure helpers (truncateError /
// logActionDispatchFailureServerSide), so stub the heavy deps to keep this a
// fast unit test rather than wiring a full DB/queue mock.

// Queued select results for getActiveS1IntegrationForOrg tests. Must be
// declared via vi.hoisted so it is available inside the hoisted vi.mock factory.
const { selectQueue } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  return { selectQueue };
});

vi.mock('../../db', () => {
  const mockSelect = vi.fn(() => {
    const rows = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'innerJoin', 'leftJoin']) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.limit = vi.fn().mockResolvedValue(rows);
    chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
    return chain;
  });
  return {
    db: { select: mockSelect, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../jobs/s1Sync', () => ({
  dispatchS1Isolation: vi.fn(),
  dispatchS1ThreatAction: vi.fn(),
  scheduleS1ActionPoll: vi.fn(),
}));

import { truncateError, logActionDispatchFailureServerSide, getActiveS1IntegrationForOrg } from './actions';

const UPSTREAM_BODY_MARKER = 'UPSTREAM_BODY_MARKER_should_never_reach_tenant';

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getActiveS1IntegrationForOrg — partner-axis resolution', () => {
  it('returns the partner active integration (with orgId = passed-in orgId) when org belongs to a partner with an active integration', async () => {
    // Step 1: org lookup returns partner_id
    selectQueue.push([{ id: 'org-1', partnerId: 'partner-1' }]);
    // Step 2: active integration for partner
    selectQueue.push([{
      id: 'int-1',
      partnerId: 'partner-1',
      name: 'My S1 Integration',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    }]);
    // Step 3: s1_org_mappings existence check
    selectQueue.push([{ id: 'mapping-1' }]);

    const result = await getActiveS1IntegrationForOrg('org-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('int-1');
    expect(result!.orgId).toBe('org-1'); // caller-provided orgId preserved in return
    expect(result!.name).toBe('My S1 Integration');
  });

  it('returns null when the org is not found in the DB', async () => {
    // org lookup returns empty
    selectQueue.push([]);

    const result = await getActiveS1IntegrationForOrg('org-missing');

    expect(result).toBeNull();
  });

  it('returns null when the partner has no active integration', async () => {
    // org lookup returns partner_id
    selectQueue.push([{ id: 'org-2', partnerId: 'partner-no-integration' }]);
    // no active integration found
    selectQueue.push([]);

    const result = await getActiveS1IntegrationForOrg('org-2');

    expect(result).toBeNull();
  });

  it('returns null when the org has no s1_org_mappings row under the integration (defense-in-depth)', async () => {
    // org lookup returns partner_id
    selectQueue.push([{ id: 'org-3', partnerId: 'partner-1' }]);
    // active integration exists
    selectQueue.push([{
      id: 'int-1',
      partnerId: 'partner-1',
      name: 'My S1 Integration',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    }]);
    // but no s1_org_mappings row for this org
    selectQueue.push([]);

    const result = await getActiveS1IntegrationForOrg('org-3');

    expect(result).toBeNull();
  });
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
