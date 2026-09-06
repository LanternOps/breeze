import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceCompare from './DeviceCompare';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown): Response => ({
  ok: true,
  status: 200,
  json: vi.fn().mockResolvedValue(payload),
}) as unknown as Response;

describe('DeviceCompare option source', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith('/devices/options?')) return response({
        data: [{ id: 'device-1', hostname: 'zzz-compare-device', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
      });
      return response({ data: [] });
    });
  });

  it('loads comparison choices from the server option contract', async () => {
    render(<DeviceCompare />);
    expect(await screen.findByText('zzz-compare-device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/devices/options?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => /^\/devices(?:\?|$)/.test(String(input)))).toBe(false);
  });
});
