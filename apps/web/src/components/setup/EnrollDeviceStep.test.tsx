import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic UA so detectPlatform() resolves to 'windows' and the installer
// tab is the active one — on Linux CI the component would open on the CLI tab
// and the download button would not be mounted at all.
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 jsdom/test',
});

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

import EnrollDeviceStep from './EnrollDeviceStep';
import { fetchWithAuth } from '../../stores/auth';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(payload),
    blob: vi.fn().mockResolvedValue(new Blob(['binary'])),
  }) as unknown as Response;

global.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/fake');
global.URL.revokeObjectURL = vi.fn();

function mockHappyPath() {
  fetchWithAuthMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/enrollment-keys') {
      return makeJsonResponse({ id: 'key-abc', key: 'raw-key' }, true, 201);
    }
    if (url.startsWith('/enrollment-keys/key-abc/installer/')) {
      return makeJsonResponse(null, true);
    }
    return makeJsonResponse({}, false, 404);
  });
}

/**
 * #2992 — guided setup mints its installer through the same two-step flow as
 * the Add Device modal: POST /enrollment-keys for a parent, then
 * GET /enrollment-keys/:id/installer/:platform?count=N.
 *
 * The device count belongs on the bootstrap token that the second call mints,
 * NOT on the parent key: `max_usage` is an enforced enrollment budget
 * (/agents/enroll matches on usage_count < max_usage), so writing a device
 * count there to fix the Enrollment Keys display would widen a live
 * credential. The list route reads the token instead.
 */
describe('EnrollDeviceStep — installer device count (#2992)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the device count to the installer route, not the key budget', async () => {
    mockHappyPath();

    render(<EnrollDeviceStep orgId="org-1" siteId="site-1" onFinish={vi.fn()} />);

    fireEvent.change(screen.getByTestId('setup-device-count'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('setup-download-installer'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createCall = fetchWithAuthMock.mock.calls[0];
    expect(String(createCall[0])).toBe('/enrollment-keys');
    const createBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createBody.siteId).toBe('site-1');
    expect(createBody.orgId).toBe('org-1');
    // Never the parent key's budget — that column gates real enrollments.
    expect(createBody.maxUsage).toBeUndefined();

    // The count drives the installer (bootstrap token) cap, and only that.
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=12');
  });

  // The field has no `step` and isn't inside a <form>, so "4.5" is reachable.
  // The download route bounds `count` to an int; sending a fraction 400s with
  // a wire field name the operator has never seen.
  it('rounds a fractional device count before either mint route sees it', async () => {
    mockHappyPath();

    render(<EnrollDeviceStep orgId="org-1" siteId="site-1" onFinish={vi.fn()} />);

    fireEvent.change(screen.getByTestId('setup-device-count'), { target: { value: '4.5' } });
    fireEvent.click(screen.getByTestId('setup-download-installer'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=5');
  });
});
