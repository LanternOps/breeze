import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    // Default response for child component fetches (e.g., KnownGuestsSettings)
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
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
    // Company is the default tab now; switch to Regional to check the language copy.
    const regionalTab = screen.getByRole('button', { name: /^regional$/i });
    const user = userEvent.setup();
    await user.click(regionalTab);

    expect(screen.queryByText('More languages coming soon')).toBeNull();
    expect(screen.getByText('Default language for partner settings.')).not.toBeNull();
  });
});

describe('PartnerSettingsPage Company tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  });

  it('renders the Company tab as the default tab with the current company name', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
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
          contact: { name: 'Jane' },
          address: { city: 'Denver', country: 'US' },
        },
      })
    );

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    // Company tab is the default, so its content should be visible.
    const nameInput = await screen.findByLabelText(/company name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Acme MSP');
    const cityInput = screen.getByLabelText(/city/i) as HTMLInputElement;
    expect(cityInput.value).toBe('Denver');
  });

  it('saves company name at the top level and address inside settings', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
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
          contact: {},
          address: {},
        },
      })
    );
    // Response to the PATCH — shape doesn't matter for the assertion.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ id: 'partner-1', name: 'Acme MSP Inc.', settings: {} })
    );

    render(<PartnerSettingsPage />);

    const nameInput = await screen.findByLabelText(/company name/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme MSP Inc.');

    const cityInput = screen.getByLabelText(/city/i) as HTMLInputElement;
    await user.type(cityInput, 'Denver');

    const saveBtn = screen.getByRole('button', { name: /save settings/i });
    await user.click(saveBtn);

    // Find the PATCH call (skip any GETs)
    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.name).toBe('Acme MSP Inc.');
    expect(body.settings.address.city).toBe('Denver');
  });
});
