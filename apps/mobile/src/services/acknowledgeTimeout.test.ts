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

  it('carries each failure out so the caller can report it', async () => {
    // Swallowed, a 403 / 500 / client abort are indistinguishable in the
    // outcome, and the caller's reportInternalError never fires because these
    // never throw — so a systematic failure (every id aborting at the same
    // deadline) leaves no telemetry and reads as ordinary partial failure.
    fetchWithTimeoutMock
      .mockResolvedValueOnce(ackResponse())
      .mockRejectedValueOnce(new Error('aborted'))
      .mockRejectedValueOnce(new Error('aborted'));

    const outcome = await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(outcome.acknowledged).toHaveLength(1);
    expect(outcome.failed).toHaveLength(2);
    expect(outcome.errors).toHaveLength(2);
    expect(String((outcome.errors[0] as Error).message)).toContain('aborted');
  });

  it('applies the same deadline to every write in a bulk acknowledge', async () => {
    // The bulk path fans out through acknowledgeAlert, so a regression that
    // dropped the override on one path would silently halve the protection.
    await acknowledgeAlerts(['a1', 'a2', 'a3']);

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    for (const call of fetchWithTimeoutMock.mock.calls) {
      expect(call[2]).toBe(ACKNOWLEDGE_TIMEOUT_MS);
    }
  });
});
