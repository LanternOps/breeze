import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetchWithAuth so we can control API responses
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/stores/auth';
import { sendDeviceCommand } from './deviceActions';

const fetchMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendDeviceCommand error extraction', () => {
  it('produces a readable message (not [object Object]) when the API returns a zod-style error body', async () => {
    // API returns a 400 with a zod-style error: { error: { issues: [...] } }
    fetchMock.mockResolvedValue(
      makeJsonResponse(
        { error: { issues: [{ message: 'bad', path: ['x'] }] } },
        false,
        400
      )
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // Must NOT be the bare fallback, must NOT be "[object Object]"
    expect(thrownMessage).not.toBe('[object Object]');
    expect(thrownMessage).not.toBe('Failed to send device command');
    // Must contain the human-readable issue message
    expect(thrownMessage).toContain('bad');
  });

  it('returns the plain error string from the API when error is a string', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ error: 'Device not found' }, false, 404)
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toBe('Device not found');
  });

  it('falls back to the fallback message when no readable error is available', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({}, false, 500)
    );

    let thrownMessage: string | undefined;
    try {
      await sendDeviceCommand('dev-1', 'restart');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toBe('Failed to send device command');
  });
});
