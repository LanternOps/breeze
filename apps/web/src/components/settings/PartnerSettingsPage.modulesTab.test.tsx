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

describe('PartnerSettingsPage Modules tab (M7)', () => {
  it('Modules is its own tab, not embedded in Company', async () => {
    // PartnerSettingsPage destructures useOrgStore() directly; PartnerModulesCard
    // calls it with a selector (`useOrgStore((s) => s.setServiceManagementMode)`)
    // — the mock must serve both call shapes off one shared state object.
    useOrgStoreMock.mockImplementation(((selector?: (state: Record<string, unknown>) => unknown) => {
      const state = { currentPartnerId: 'partner-1', isLoading: false, setServiceManagementMode: vi.fn(), adoptPartnerId: vi.fn() };
      return selector ? selector(state) : state;
    }) as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
        createdAt: '2026-02-09T00:00:00.000Z', serviceManagementMode: 'native',
        settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {}, address: {} },
      })
    );

    render(<PartnerSettingsPage />);
    await userEvent.click(await screen.findByTestId('partner-settings-tab-company'));
    expect(screen.queryByTestId('partner-modules-card')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('partner-settings-tab-modules'));
    expect(await screen.findByTestId('partner-modules-card')).toBeInTheDocument();
  });
});
