import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue('tok'),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
const captureMessage = vi.fn();
vi.mock('@sentry/react-native', () => ({
  captureMessage: (...a: unknown[]) => captureMessage(...a),
  captureException: vi.fn(),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn().mockResolvedValue('https://example.test') }));
vi.mock('./installationId', () => ({ getOrCreateInstallationId: vi.fn().mockResolvedValue('i') }));

const fetchWithTimeout = vi.fn();
vi.mock('./fetchWithTimeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
}));

import { getDevices, getDevicesPaged, getAlertsPaged } from './api';
import { resetTruncationTracking } from './truncationReporting';

const row = (id: string) => ({ id, hostname: id, status: 'online', orgId: 'o1' });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`d${i}`));

/**
 * `nextCursor: null` here regardless of input is deliberate, not a claim
 * about what the real server returns today: the server now DOES mint a
 * `nextCursor` on a cold-start caller's first response (#3770). `fetchPage`
 * below never reads `nextCursor` at all — it fetches exactly one page and
 * reports honestly off `total` — so these fixtures are only proving that
 * behavior is nextCursor-agnostic, not asserting the token's value. An
 * earlier version of this file returned a cursor on page one and asserted the
 * client walked it, which certified a walk that in production stopped after a
 * single page (because the server-side bug made that cursor unobtainable) and
 * called it a whole fleet.
 */
function page(data: unknown[], total: number | null) {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data,
          pagination: total === null ? undefined : { page: 1, limit: 100, total, nextCursor: null },
        }),
        { status: 200 }
      )
    );
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
  captureMessage.mockReset();
  // Truncation reporting is throttled to a state CHANGE (#3783), and that state
  // is module scope so it survives between cases. Without this reset the second
  // case to fetch the same list sees "already reported" and stays silent, so an
  // assertion that the warning fires would fail for a reason that has nothing
  // to do with what it is testing.
  resetTruncationTracking();
});

describe('device list paging', () => {
  it('asks for a page size the server will actually honour', async () => {
    // `/mobile/devices` runs through `getPagination`, which does
    // `Math.min(100, ...)`: it CLAMPS silently, so asking for 200 returned 100
    // while the code read as 200.
    fetchWithTimeout.mockImplementationOnce(page([], 0));
    await getDevices();
    expect(String(fetchWithTimeout.mock.calls[0][0])).toContain('limit=100');
  });

  it('issues exactly one request', async () => {
    // Deliberately not a walk. Both server pagination modes skew on these
    // routes, so more requests would buy incorrect data plus rate-limit
    // pressure rather than completeness.
    fetchWithTimeout.mockImplementation(page(rows(100), 5000));
    await getDevicesPaged();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('scopes to an org server-side rather than filtering a partial page', async () => {
    fetchWithTimeout.mockImplementationOnce(page([row('a')], 1));
    await getDevices('org-9');
    expect(String(fetchWithTimeout.mock.calls[0][0])).toContain('orgId=org-9');
  });

  it('reports a partial fleet instead of presenting it as complete', async () => {
    fetchWithTimeout.mockImplementationOnce(page(rows(100), 216));

    const result = await getDevicesPaged();

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(216);
    expect(result.items).toHaveLength(100);
    expect(captureMessage).toHaveBeenCalledWith(
      'device list is showing a partial fleet',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('does not cry partial when the page IS the whole fleet', async () => {
    fetchWithTimeout.mockImplementationOnce(page(rows(12), 12));

    const result = await getDevicesPaged();

    expect(result.truncated).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('never claims complete when the server reported no total', async () => {
    // No `pagination` block at all. Only ONE direction of this flag is
    // dangerous, so an unknown total must not read as complete — and a short
    // page is not proof either, since an older server or an intermediary could
    // cap below the limit we asked for.
    fetchWithTimeout.mockImplementationOnce(page(rows(100), null));
    expect((await getDevicesPaged()).truncated).toBe(true);

    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockImplementationOnce(page(rows(3), null));
    expect((await getDevicesPaged()).truncated).toBe(true);
  });
});

describe('alert inbox paging', () => {
  it('asks for the server maximum instead of accepting the default 50', async () => {
    // The #3753 regression: this sent no `limit` at all, so it saw the first 50
    // by recency and Active Issues described that sample as the fleet.
    fetchWithTimeout.mockImplementationOnce(page([], 0));
    await getAlertsPaged('active');
    const url = String(fetchWithTimeout.mock.calls[0][0]);
    expect(url).toContain('limit=100');
    expect(url).toContain('status=active');
  });

  it('reports a partial set so issue counts are not read as totals', async () => {
    fetchWithTimeout.mockImplementationOnce(page(rows(100), 7023));

    const result = await getAlertsPaged('active');

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(7023);
    expect(captureMessage).toHaveBeenCalledWith(
      'alert inbox is showing a partial set',
      expect.objectContaining({ level: 'warning' })
    );
  });
});
