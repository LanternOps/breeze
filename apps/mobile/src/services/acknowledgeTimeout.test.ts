import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACKNOWLEDGE_TIMEOUT_MS, acknowledgeAlert, acknowledgeAlerts } from './api';
import { DEFAULT_FETCH_TIMEOUT_MS } from './fetchWithTimeout';

// Asserting the timeout ARGUMENT rather than observing a real abort: the whole
// failure mode is that a slow-but-successful write gets cancelled client-side,
// which is invisible in a passing test suite because the request "fails" exactly
// like a genuine error. Pinning the value is what stops it regressing.
const fetchWithTimeoutMock = vi.fn();
vi.mock('./fetchWithTimeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fetchWithTimeout')>();
  return {
    ...actual,
    fetchWithTimeout: (...a: unknown[]) => fetchWithTimeoutMock(...a),
  };
});

vi.mock('./serverConfig', () => ({
  getServerUrl: vi.fn().mockResolvedValue('https://api.test'),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('test-token'),
}));

// api.ts reaches react-native through @sentry/react-native, and this suite runs
// with the repo's .ts-only vitest config (no RN runtime), so the real module is
// an unparseable Flow file. Same reason auth.test.ts stubs it.
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('./installationId', () => ({
  getOrCreateInstallationId: vi.fn().mockResolvedValue('install-test'),
}));

function ackResponse() {
  const body = { id: 'a1', title: 't', severity: 'high', status: 'acknowledged' };
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Arbitrary JSON body, for the bulk route's counts-and-ids response. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  fetchWithTimeoutMock.mockReset().mockResolvedValue(ackResponse());
});

describe('acknowledge write deadline', () => {
  it('sends the acknowledge with a deadline above the shared default', async () => {
    // Measured on a real deployment: 13,361ms and 15,163ms, both HTTP 200. At
    // the 15s default the second aborts a request the server completed, the row
    // rolls back, and the operator is told it was not acknowledged when it was.
    expect(ACKNOWLEDGE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS);
    // Above the 15,163ms sample with real headroom, not merely above 15s.
    expect(ACKNOWLEDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);

    await acknowledgeAlert('a1');

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [url, , timeoutMs] = fetchWithTimeoutMock.mock.calls[0];
    expect(String(url)).toContain('/alerts/a1/acknowledge');
    expect(timeoutMs).toBe(ACKNOWLEDGE_TIMEOUT_MS);
  });

  it('reports UNKNOWN, not failed, when the request itself throws', async () => {
    // A transport error proves only that WE got no usable response. A 45s
    // abort, a dropped connection or a truncated body can all sit on top of a
    // server that already committed. Calling those `failed` would restore the
    // rows and invite a second acknowledge of an IRREVERSIBLE action.
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error('aborted'));

    const outcome = await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(outcome.acknowledged).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.unknown).toEqual(['a1', 'a2', 'a3']);
    expect(String((outcome.errors[0] as Error).message)).toContain('aborted');
  });

  it('splits the outcome by the ids the server reports when they account for the batch', async () => {
    // `skipped` is NOT a failure — the alert was already out of `active` state
    // (someone else acknowledged it, or it resolved), so the row must follow
    // server truth on the next fetch rather than be restored as active.
    //
    // An id the server mentions in NO array is treated as failed on purpose: an
    // older server that returns counts only must restore those rows rather than
    // leave them silently hidden.
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ updated: 1, skipped: 1, failed: 1, updatedIds: ['a1'], skippedIds: ['a2'], failedIds: ['a3'] }),
    );

    const outcome = await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(outcome.acknowledged.sort()).toEqual(['a1', 'a2']);
    expect(outcome.failed).toEqual(['a3']);
    expect(outcome.unknown).toHaveLength(0);
    expect(outcome.errors).toHaveLength(1);
  });

  it('treats a response that does NOT account for the whole batch as unknown', async () => {
    // Covers an older counts-only server and any malformed/partial array. It
    // may have acknowledged everything, so restoring would be wrong and
    // claiming success would be a lie — the batch is unknown until refetched.
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ updated: 3, skipped: 0, failed: 0 }));

    const outcome = await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(outcome.acknowledged).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.unknown).toEqual(['a1', 'a2', 'a3']);
  });

  it('rejects arrays that name an id which was never requested', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ updatedIds: ['a1', 'SOMEONE-ELSES-ID'], skippedIds: [], failedIds: [] }),
    );

    const outcome = await acknowledgeAlerts(['a1', 'a2']);

    expect(outcome.unknown).toEqual(['a1', 'a2']);
    expect(outcome.acknowledged).toHaveLength(0);
  });

  it('sends the bulk acknowledge under the acknowledge deadline', async () => {
    // One request now, but it must still carry the longer deadline the single
    // path uses — the default would be shorter than the server needs.
    await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [url, , timeoutMs] = fetchWithTimeoutMock.mock.calls[0];
    expect(String(url)).toContain('/alerts/bulk');
    expect(timeoutMs).toBe(ACKNOWLEDGE_TIMEOUT_MS);
  });
});
