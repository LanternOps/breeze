import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import FileManager from './FileManager';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('FileManager disk-cleanup consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({ data: [] }));
  });

  it('navigates to the device\u2019s Disk Cleanup tab instead of running cleanup itself', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);

    await userEvent.click(await screen.findByTestId('file-manager-disk-cleanup'));

    expect(navigateToMock).toHaveBeenCalledWith('/devices/dev-1#filesystem');
  });

  it('no longer offers analyze, preview or execute here', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);
    await screen.findByTestId('file-manager-disk-cleanup');

    expect(screen.queryByText('Analyze')).not.toBeInTheDocument();
    expect(screen.queryByText('Preview Cleanup')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Execute/)).not.toBeInTheDocument();
  });

  it('never calls a filesystem scan, preview or execute endpoint', async () => {
    render(<FileManager deviceId="dev-1" deviceHostname="host-1" initialPath="C:\\" />);
    await screen.findByTestId('file-manager-disk-cleanup');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    // The race the API's pinning exists to prevent came from THIS component
    // deriving its own candidates; it must not reach these routes at all now.
    expect(urls.some((u) => u.includes('/filesystem'))).toBe(false);
  });
});
