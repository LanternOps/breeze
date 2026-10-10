import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SLADashboard from './SLADashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('SLADashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/sla/dashboard') {
        return makeJsonResponse({ data: {} });
      }
      if (url === '/backup/sla/configs' || url === '/backup/sla/events') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({});
    });
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<SLADashboard />);

    expect(screen.getByText('Loading SLA data...')).toBeTruthy();
  });

  it('renders empty state when no configs exist', async () => {
    render(<SLADashboard />);

    await screen.findByText('No SLA configurations defined.');
    expect(screen.getByText('No breach events recorded.')).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<SLADashboard />);

    await screen.findByText('SLA Configurations');
    expect(screen.getByText(/Backup SLA monitoring is in early access/i)).toBeTruthy();
  });

  it('renders targets and toggles active using the API field names', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') return makeJsonResponse({ data: {} });
      if (url === '/backup/sla/configs') {
        return makeJsonResponse({ data: [{ id: 'c-1', name: 'Gold', rpoTargetMinutes: 45, rtoTargetMinutes: 99, isActive: true, targetDevices: ['a', 'b'], targetGroups: [] }] });
      }
      return makeJsonResponse({ data: url.endsWith('dashboard') ? {} : [] });
    });
    render(<SLADashboard />);
    await screen.findByText('Gold');
    expect(screen.getByText(/45\s+min/)).toBeTruthy();
    expect(screen.getByText(/99\s+min/)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    const toggle = screen.getByText('Gold').closest('tr')!.querySelector('button')!;
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ isActive: false });
  });
});
