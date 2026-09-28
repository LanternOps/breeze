import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AntivirusPage from './AntivirusPage';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('AntivirusPage', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/security/status')) {
        return response({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
      }
      if (url === '/security/dashboard') {
        return response({
          data: {
            totalDevices: 10,
            protectedDevices: 8,
            atRiskDevices: 1,
            unprotectedDevices: 2,
            offlineDevices: 0,
            providers: [{ providerId: 'p1', providerName: 'Defender', deviceCount: 8, coverage: 0.8 }],
          },
        });
      }
      return response({}, false, 404);
    });
  });

  it('gives the Provider Distribution chart card min-w-0 so it does not spill past its grid track on mobile (#7155)', async () => {
    render(<AntivirusPage />);

    const heading = await screen.findByText('Provider Distribution');
    const card = heading.closest('div')!;
    expect(card.className).toContain('min-w-0');
  });
});
