import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateScanModal from './CreateScanModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const pickerState = vi.hoisted(() => ({ canSubmit: true, state: 'ready' as string }));

vi.mock('../../hooks/useDeviceOptions', () => ({
  useDeviceOptions: () => ({
    options: [
      {
        id: 'dev-1',
        hostname: 'alpha-pc',
        displayName: 'Alpha PC',
        status: 'online',
        osType: 'windows',
        siteId: null,
        siteName: null,
      },
    ],
    page: { hasMore: false },
    state: pickerState.state,
    error: null,
    canSubmit: pickerState.canSubmit,
    loadMore: async () => {},
    retry: () => {},
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as unknown as Response;

describe('CreateScanModal device targets (#9683)', () => {
  beforeEach(() => {
    pickerState.canSubmit = true;
    pickerState.state = 'ready';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return res({ data: { scans: [{ id: 's1', deviceId: 'dev-1', orgId: 'o' }] } });
      return res({ data: [] });
    });
  });

  it('uses the device picker, not a raw UUID textarea, and submits the picked ids', async () => {
    const onCreated = vi.fn();
    render(<CreateScanModal onClose={() => {}} onCreated={onCreated} />);

    expect(screen.queryByPlaceholderText(/device-uuid/i)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Alpha PC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Scan' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]?.body)).deviceIds).toEqual(['dev-1']);
  });

  it.each([
    ['loading', 'still loading or incomplete'],
    ['error', 'could not be loaded'],
  ])('blocks submit while the picker cannot submit (%s)', async (state, message) => {
    pickerState.canSubmit = false;
    pickerState.state = state;
    render(<CreateScanModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Alpha PC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Scan' }));

    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('blocks submit with no device selected', async () => {
    render(<CreateScanModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Scan' }));
    expect(await screen.findByText('Select at least one device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
