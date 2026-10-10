import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SLAConfigDialog from './SLAConfigDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('SLAConfigDialog device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.startsWith('/devices/options?')
      ? ok({ data: [{ id: 'd-99', hostname: 'zzz-sla-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }], page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' } })
      : ok({ data: [] })));
  });

  it('loads interactive choices from the authorized options endpoint', async () => {
    render(<SLAConfigDialog config={null} onClose={vi.fn()} />);
    expect(await screen.findByText('zzz-sla-device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });
});

describe('SLAConfigDialog API contract', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') return Promise.resolve(ok({ data: {} }));
      return Promise.resolve(url.startsWith('/devices/options?')
        ? ok({ data: [{ id: '11111111-1111-4111-8111-111111111111', hostname: 'h1', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }], page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' } })
        : ok({ data: [] }));
    });
  });

  const lastWrite = () => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST' || init?.method === 'PATCH');
    return call ? { url: call[0], method: call[1]?.method, body: JSON.parse(String(call[1]?.body)) } : undefined;
  };

  it('creates with the API field names', async () => {
    render(<SLAConfigDialog config={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Gold' } });
    const create = screen.getByRole('button', { name: /^create$/i });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    await waitFor(() => expect(lastWrite()).toBeDefined());
    const w = lastWrite()!;
    expect(w.method).toBe('POST');
    expect(w.body).toMatchObject({ name: 'Gold', rpoTargetMinutes: 60, rtoTargetMinutes: 120, isActive: true, alertOnBreach: true });
    expect(w.body).not.toHaveProperty('rpoMinutes');
    expect(w.body).not.toHaveProperty('rtoMinutes');
    expect(w.body).not.toHaveProperty('active');
    expect(w.body).not.toHaveProperty('targetDeviceIds');
  });

  it('pre-fills from the API shape and patches with API field names', async () => {
    const config = {
      id: 'c-1', name: 'Silver', rpoTargetMinutes: 30, rtoTargetMinutes: 90,
      isActive: false, alertOnBreach: false,
      targetDevices: ['11111111-1111-4111-8111-111111111111'], targetGroups: [],
    };
    render(<SLAConfigDialog config={config} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    const update = screen.getByRole('button', { name: /^update$/i });
    await waitFor(() => expect(update).toBeEnabled());
    fireEvent.click(update);
    await waitFor(() => expect(lastWrite()).toBeDefined());
    const w = lastWrite()!;
    expect(w.method).toBe('PATCH');
    expect(w.url).toBe('/backup/sla/configs/c-1');
    expect(w.body).toMatchObject({
      rpoTargetMinutes: 30, rtoTargetMinutes: 90, isActive: false, alertOnBreach: false,
      targetDevices: ['11111111-1111-4111-8111-111111111111'], targetGroups: [],
    });
  });
});
