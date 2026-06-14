/**
 * SentinelOne action-dispatch catch-block wiring — SSRF read-oracle invariant
 * (#1035 item 2, follow-up to #1025).
 *
 * actions.test.ts proves the helpers (`truncateError`,
 * `logActionDispatchFailureServerSide`) in isolation, but nothing drove
 * `executeS1IsolationForOrg` / `executeS1ThreatActionForOrg` to prove the catch
 * block wires them together correctly. The catch site builds the tenant-visible
 * `s1_actions.error` text and the dispatch result `warning`; a regression that
 * fed `error.responseBody` into that text (instead of the body-free `.message`)
 * would have passed every existing test, leaking an upstream-body read oracle
 * for a tenant-supplied/look-alike S1 console.
 *
 * These tests mock the provider-dispatch functions to throw a
 * `SentinelOneHttpError` carrying a distinctive upstream-body marker, capture
 * the row written to `s1_actions` (and the returned `warning`), and assert:
 *   (a) the persisted `error` / `warning` carries the body-free status line and
 *       NEVER the upstream body marker;
 *   (b) the full (redacted) body IS captured in the server-side console.error.
 *
 * Pure unit test — runs in the standard `test-api` CI job (no live DB needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneHttpError } from './client';

const UPSTREAM_BODY_MARKER = 'UPSTREAM_S1_ACTION_BODY_MARKER_must_not_reach_tenant';
const UPSTREAM_BODY_SECRET = 'Authorization: Bearer s1_action_leaked_token';

// Capture every row array passed to `db.insert(...).values(<rows>)`.
const insertedRows: Array<Record<string, unknown>> = [];

const selectQueue: unknown[][] = [];

const mockDb = {
  select: vi.fn(() => {
    const rows = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'innerJoin', 'leftJoin']) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.limit = vi.fn().mockResolvedValue(rows);
    chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
    return chain;
  }),
  insert: vi.fn(() => ({
    values: vi.fn((rows: Array<Record<string, unknown>>) => {
      insertedRows.push(...rows);
      return {
        returning: vi.fn().mockResolvedValue(
          rows.map((_row, i) => ({ id: `action-${i}`, deviceId: (rows[i]!.deviceId as string | null) ?? null })),
        ),
      };
    }),
  })),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../db', () => ({
  db: mockDb,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withDbAccessContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
  withSystemDbAccessContext: <T>(fn: () => T): T => fn(),
}));

const dispatchS1IsolationMock = vi.fn();
const dispatchS1ThreatActionMock = vi.fn();
vi.mock('../../jobs/s1Sync', () => ({
  dispatchS1Isolation: dispatchS1IsolationMock,
  dispatchS1ThreatAction: dispatchS1ThreatActionMock,
  scheduleS1ActionPoll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

const { executeS1IsolationForOrg, executeS1ThreatActionForOrg } = await import('./actions');

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  selectQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function s1HttpError(method: 'POST' | 'GET', path: string, status: number) {
  return new SentinelOneHttpError(method, path, status, `${UPSTREAM_BODY_MARKER} ${UPSTREAM_BODY_SECRET}`);
}

describe('executeS1IsolationForOrg catch block — body-free error/warning (#1035)', () => {
  it('persists a body-free error to s1_actions and logs the redacted body server-side', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // (1) accessible devices, (2) agent mappings.
    selectQueue.push([{ id: 'dev-1' }]);
    selectQueue.push([{ deviceId: 'dev-1', s1AgentId: 's1-agent-1' }]);

    dispatchS1IsolationMock.mockRejectedValue(
      s1HttpError('POST', '/web/api/v2.1/agents/actions/disconnect', 502),
    );

    const result = await executeS1IsolationForOrg({
      orgId: 'org-1',
      integrationId: 'int-1',
      requestedBy: 'user-1',
      deviceIds: ['dev-1'],
      isolate: true,
    });

    // Dispatch failed → 502 but the records are still persisted (ok:true, 502).
    expect(result.ok).toBe(true);
    expect(result.status).toBe(502);

    // (a) the row written to s1_actions.error is body-free.
    const persistedError = String(insertedRows[0]!.error);
    expect(persistedError).toContain('SentinelOne action dispatch failed');
    expect(persistedError).toContain('failed (502)');
    expect(persistedError).not.toContain(UPSTREAM_BODY_MARKER);
    expect(persistedError).not.toContain('s1_action_leaked_token');

    // ...and the same goes for the tenant-facing warning in the result payload.
    const warning = String((result as { data: { warning?: string } }).data.warning);
    expect(warning).not.toContain(UPSTREAM_BODY_MARKER);

    // (b) the full (redacted) body is captured server-side only.
    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain(UPSTREAM_BODY_MARKER);
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain('s1_action_leaked_token');
  });
});

describe('executeS1ThreatActionForOrg catch block — body-free error/warning (#1035)', () => {
  it('persists a body-free error to s1_actions and logs the redacted body server-side', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // (1) matched threats.
    selectQueue.push([{ id: 'threat-uuid-1', s1ThreatId: 's1-threat-1', deviceId: 'dev-9' }]);

    dispatchS1ThreatActionMock.mockRejectedValue(
      s1HttpError('POST', '/web/api/v2.1/threats/mitigate/kill', 500),
    );

    const result = await executeS1ThreatActionForOrg({
      orgId: 'org-2',
      integrationId: 'int-2',
      requestedBy: 'user-2',
      action: 'kill',
      threatIds: ['s1-threat-1'],
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(502);

    const persistedError = String(insertedRows[0]!.error);
    expect(persistedError).toContain('SentinelOne action dispatch failed');
    expect(persistedError).toContain('failed (500)');
    expect(persistedError).not.toContain(UPSTREAM_BODY_MARKER);
    expect(persistedError).not.toContain('s1_action_leaked_token');

    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain(UPSTREAM_BODY_MARKER);
    expect(logged).toContain('[REDACTED]');
  });
});
