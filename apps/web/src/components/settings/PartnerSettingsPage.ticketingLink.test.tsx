import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('PartnerSettingsPage Ticketing tab link-out (Task 3)', () => {
  it('the Ticketing tab is a link to /settings/ticketing, not an embedded tab group', async () => {
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z',
        settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {}, address: {} },
      })
    );

    render(<PartnerSettingsPage />);
    await userEvent.click(await screen.findByTestId('partner-settings-tab-ticketing'));
    const link = await screen.findByTestId('partner-settings-ticketing-link');
    expect(link).toHaveAttribute('href', '/settings/ticketing');
    expect(screen.queryByTestId('ticketing-settings-tabs')).not.toBeInTheDocument();
  });
});
