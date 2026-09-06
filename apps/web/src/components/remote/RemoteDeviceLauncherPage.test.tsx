import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteDeviceLauncherPage from './RemoteDeviceLauncherPage';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);

function optionPage(hostname = 'zzz-beyond-old-prefix'): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      data: [{
        id: '00000000-0000-4000-8000-000000000099',
        hostname,
        displayName: null,
        osType: 'linux',
        status: 'online',
        siteId: null,
        siteName: null,
      }],
      page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
    }),
  } as unknown as Response;
}

describe('RemoteDeviceLauncherPage device options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(optionPage());
  });

  it('uses the online server option search and launches a beyond-prefix device', async () => {
    render(<RemoteDeviceLauncherPage mode="terminal" />);

    expect((await screen.findAllByText('zzz-beyond-old-prefix')).length).toBeGreaterThan(0);
    const optionUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(optionUrl).toContain('/devices/options?');
    expect(optionUrl).toContain('status=online');

    fireEvent.click(screen.getByRole('button', { name: /open terminal/i }));
    expect(navigateMock).toHaveBeenCalledWith('/remote/terminal/00000000-0000-4000-8000-000000000099');
  });

  it('retries an option error without exposing stale launch actions', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({ error: 'option service unavailable' }),
      } as unknown as Response)
      .mockResolvedValueOnce(optionPage('recovered-device'));

    render(<RemoteDeviceLauncherPage mode="files" />);

    expect(await screen.findByText('option service unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open files/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getAllByText('recovered-device').length).toBeGreaterThan(0));
  });
});
