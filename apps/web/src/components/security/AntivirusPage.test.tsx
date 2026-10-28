import '@/lib/i18n';
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

// #10378: `/security/dashboard`'s protectedDevices / atRiskDevices /
// unprotectedDevices / totalDevices are fleet posture-risk counts (a device is
// "protected" there only at posture risk 'low'), not antivirus coverage. The
// tiles read those, so a fleet whose posture scores sat below 85 showed
// "Protected 0 · Coverage 0%" above a table of Defender devices with real-time
// protection on. The tiles must use the real-time-protection buckets in
// `antivirus` — the same numbers as the /security overview card.
describe('AntivirusPage summary tiles (#10378)', () => {
  const dashboardWith = (antivirus: unknown) => ({
    data: {
      // Posture-risk counts that disagree with AV coverage, as on prod.
      totalDevices: 39,
      protectedDevices: 0,
      atRiskDevices: 39,
      unprotectedDevices: 0,
      offlineDevices: 4,
      providers: [{ providerId: 'windows_defender', providerName: 'Microsoft Defender', deviceCount: 35, coverage: 100 }],
      ...(antivirus === undefined ? {} : { antivirus }),
    },
  });
  const routeDashboard = (payload: unknown) => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/security/status')) {
        return response({ data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
      }
      if (url === '/security/dashboard') return response(payload);
      return response({}, false, 404);
    });
  };
  // The tile's value line (the label sits in a sibling <p>).
  const tile = async (id: string) =>
    (await screen.findByTestId(`antivirus-stat-${id}`)).querySelector('p.text-xl')?.textContent;

  it('counts real-time protection, not posture risk', async () => {
    routeDashboard(dashboardWith({ protected: 35, unprotected: 0, unknown: 0 }));
    render(<AntivirusPage />);

    expect(await tile('total')).toBe('35');
    expect(await tile('protected')).toBe('35');
    expect(await tile('unprotected')).toBe('0');
    expect(await tile('coverage')).toBe('100%');
  });

  it('keeps unknown readings in the total but not in coverage', async () => {
    routeDashboard(dashboardWith({ protected: 96, unprotected: 6, unknown: 5 }));
    render(<AntivirusPage />);

    expect(await tile('total')).toBe('107');
    expect(await tile('protected')).toBe('96');
    expect(await tile('unprotected')).toBe('6');
    // 96 / 107 = 89.7% -> 90%
    expect(await tile('coverage')).toBe('90%');
  });

  it('shows an em dash, not posture counts, when the antivirus block is missing', async () => {
    routeDashboard(dashboardWith(undefined));
    render(<AntivirusPage />);

    for (const id of ['total', 'protected', 'unprotected', 'coverage']) {
      expect(await tile(id)).toBe('—');
    }
  });
});

describe('AntivirusPage filter selects accessible name (#7156)', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(response({ data: [] }));
  });

  it('gives the status and OS filter selects a real accessible name', async () => {
    render(<AntivirusPage />);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Operating system' })).toBeInTheDocument();
  });
});
