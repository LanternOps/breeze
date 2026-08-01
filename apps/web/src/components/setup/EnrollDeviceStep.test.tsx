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
 * GET /enrollment-keys/:id/installer/:platform?count=N. The modern Windows /
 * macOS-app-bundle download paths create no child enrollment key, so that
 * parent is the row the Enrollment Keys page shows — and a parent minted
 * without maxUsage gets the API's `?? 1` default, rendering "0 / 1" for an
 * installer built for N devices. Guided setup is typically a partner's first
 * visit to that page, so the defect is most visible here.
 */
describe('EnrollDeviceStep — installer parent key carries the device count (#2992)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the device count as the parent key maxUsage', async () => {
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
    expect(createBody.maxUsage).toBe(12);

    // The key's cap and the installer's own cap must not drift apart.
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=12');
  });

  it('defaults maxUsage to 1 when the operator leaves the count alone', async () => {
    mockHappyPath();

    render(<EnrollDeviceStep orgId="org-1" siteId="site-1" onFinish={vi.fn()} />);

    fireEvent.click(screen.getByTestId('setup-download-installer'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createBody = JSON.parse(
      (fetchWithAuthMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.maxUsage).toBe(1);
  });

  // The field has no `step` and isn't inside a <form>, so "4.5" is reachable.
  // Both mint routes bound this to an int; sending a fraction 400s with a wire
  // field name ("maxUsage") the operator has never seen.
  it('rounds a fractional device count before either mint route sees it', async () => {
    mockHappyPath();

    render(<EnrollDeviceStep orgId="org-1" siteId="site-1" onFinish={vi.fn()} />);

    fireEvent.change(screen.getByTestId('setup-device-count'), { target: { value: '4.5' } });
    fireEvent.click(screen.getByTestId('setup-download-installer'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createBody = JSON.parse(
      (fetchWithAuthMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.maxUsage).toBe(5);
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=5');
  });
});
