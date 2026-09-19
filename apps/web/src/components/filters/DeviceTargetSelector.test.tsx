import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeviceOptionPage } from '@breeze/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { DeviceTargetSelector } from './DeviceTargetSelector';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) =>
      options?.defaultValue ?? (options?.count == null ? _key : String(options.count)),
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

function optionPage(
  ids: string[],
  page: Partial<DeviceOptionPage['page']> = {},
): DeviceOptionPage {
  return {
    data: ids.map((id) => ({
      id,
      hostname: id,
      displayName: null,
      osType: 'windows',
      status: 'online',
      siteId: null,
      siteName: null,
    })),
    page: {
      nextCursor: null,
      returned: ids.length,
      total: ids.length,
      hasMore: false,
      observedAt: '2026-08-24T12:00:00.000Z',
      ...page,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(optionPage(['device-a'])));
});

afterEach(() => vi.useRealTimers());

describe('DeviceTargetSelector device options', () => {
  it('uses only the server-backed options endpoint and searches server-side', async () => {
    vi.useFakeTimers();
    render(
      <DeviceTargetSelector
        value={{ type: 'devices', deviceIds: [] }}
        onChange={vi.fn()}
        modes={['manual']}
        groups={[]}
        sites={[]}
        showSavedFilters={false}
      />,
    );

    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('/devices/options?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).split('?')[0] === '/devices')).toBe(false);

    fireEvent.change(screen.getByRole('searchbox', { name: /search devices/i }), {
      target: { value: 'server-42' },
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('search=server-42'))).toBe(true);
  });

  it('reports unresolved selections as unsafe to submit', async () => {
    const onCanSubmitChange = vi.fn();
    render(
      <DeviceTargetSelector
        value={{ type: 'devices', deviceIds: ['missing-device'] }}
        onChange={vi.fn()}
        onCanSubmitChange={onCanSubmitChange}
        modes={['manual']}
        groups={[]}
        sites={[]}
        showSavedFilters={false}
      />,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/selected device.*could not be resolved/i));
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
  });

  it('exposes select-all only after explicitly exhaustive pagination completes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(optionPage(['one'], {
        total: 2,
        hasMore: true,
        nextCursor: 'next',
      })))
      .mockResolvedValueOnce(jsonResponse(optionPage(['two'], {
        total: 2,
      })));

    render(
      <DeviceTargetSelector
        value={{ type: 'devices', deviceIds: [] }}
        onChange={vi.fn()}
        modes={['manual']}
        groups={[]}
        sites={[]}
        showSavedFilters={false}
        requireCompleteSet
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /select all/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument());
  });
});
