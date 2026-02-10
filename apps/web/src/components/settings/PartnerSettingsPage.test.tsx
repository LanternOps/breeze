import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('PartnerSettingsPage language control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  });

  it('removes coming-soon language selector and shows default language copy', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1',
        name: 'Acme MSP',
        slug: 'acme',
        type: 'partner',
        plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z',
        settings: {
          timezone: 'UTC',
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          language: 'en',
          businessHours: { preset: 'business' },
          contact: {}
        }
      })
    );

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    expect(screen.queryByText('More languages coming soon')).toBeNull();
    expect(screen.getByText('Default language for partner settings.')).not.toBeNull();
  });
});
