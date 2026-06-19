import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerSettingsPage, { runPartnerSave } from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { getJwtClaims } from '../../lib/authScope';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn()
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

// Stub the embedded ticketing sub-tab group — we only assert that the Partner
// hub mounts it on the Ticketing tab, not the (separately tested) sub-tab
// behaviour. The stub records the `syncHash` prop so we can assert the hub
// disables hash-sync to avoid colliding with its own top-level tab hash.
const ticketingTabsProps: Array<{ syncHash?: boolean }> = [];
vi.mock('./TicketingSettingsTabs', () => ({
  default: (props: { syncHash?: boolean }) => {
    ticketingTabsProps.push(props);
    return <div data-testid="stub-ticketing-settings-tabs">TicketingTabsStub</div>;
  },
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);
const showToastMock = vi.mocked(showToast);
const getJwtClaimsMock = vi.mocked(getJwtClaims);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('runPartnerSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PAYLOAD = { name: 'Acme MSP', settings: { timezone: 'UTC' } };

  it('shows a success toast and returns the updated partner on 200', async () => {
    const updated = { id: 'p-1', name: 'Acme MSP', settings: {} };
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(updated));

    const result = await runPartnerSave(PAYLOAD, { onUnauthorized: vi.fn() });

    expect(result).toMatchObject({ id: 'p-1' });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Partner settings saved' })
    );
  });

  it('shows an error toast and throws ActionError on non-401 failure', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'validation failed' }, false, 422));

    await expect(runPartnerSave(PAYLOAD, { onUnauthorized: vi.fn() })).rejects.toThrow();

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('calls onUnauthorized and does not show a toast on 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    const onUnauthorized = vi.fn();

    await expect(runPartnerSave(PAYLOAD, { onUnauthorized })).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('sends PATCH to /orgs/partners/me with the provided payload', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'p-1', name: 'Acme', settings: {} }));

    await runPartnerSave(PAYLOAD, { onUnauthorized: vi.fn() });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/orgs/partners/me',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(PAYLOAD),
      })
    );
  });
});

describe('PartnerSettingsPage language control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
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
    window.location.hash = '';
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

describe('PartnerSettingsPage Ticketing tab', () => {
  const partnerResponse = {
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    ticketingTabsProps.length = 0;
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  });

  it('exposes a Ticketing tab in the tab bar', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    expect(screen.getByRole('button', { name: /^ticketing$/i })).not.toBeNull();
    // Not the active tab by default, so the embedded tabs are not mounted yet.
    expect(screen.queryByTestId('stub-ticketing-settings-tabs')).toBeNull();
  });

  it('mounts the ticketing sub-tabs (hash-sync disabled) when the tab is clicked', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^ticketing$/i }));

    expect(screen.getByTestId('stub-ticketing-settings-tabs')).not.toBeNull();
    // The hub owns the top-level tab hash, so the embedded group must NOT sync it.
    expect(ticketingTabsProps.at(-1)).toMatchObject({ syncHash: false });
    // Clicking the tab keeps the URL deep-linkable.
    expect(window.location.hash).toBe('#ticketing');
    // The inheritance banner is partner-config-only and must be hidden here.
    expect(screen.queryByText(/enforced across all organizations/i)).toBeNull();
  });

  it('deep-links #ticketing straight to the Ticketing tab on mount', async () => {
    window.location.hash = '#ticketing';
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    expect(await screen.findByTestId('stub-ticketing-settings-tabs')).not.toBeNull();
  });
});

describe('PartnerSettingsPage access gate (no flash-of-access-denied)', () => {
  const partnerResponse = {
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    // Default: token claims do NOT confirm partner scope. Individual tests
    // override this as needed.
    getJwtClaimsMock.mockReturnValue({ scope: null, orgId: null, partnerId: null });
  });

  it('shows the loading state (not access-denied) while the partner context is still resolving', () => {
    // Store is still fetching: currentPartnerId not yet set, isLoading true.
    useOrgStoreMock.mockReturnValue({
      currentPartnerId: null,
      isLoading: true,
      setPartner: vi.fn(),
    } as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<PartnerSettingsPage />);

    // Must NOT show the access-denied state during resolution...
    expect(screen.queryByText('Partner Access Required')).toBeNull();
    expect(
      screen.queryByText('Partner settings are only available to partner-level users.')
    ).toBeNull();
    // ...it shows the loading affordance instead.
    expect(screen.getByText('Loading partner settings...')).not.toBeNull();
  });

  it('renders the settings once a partner user resolves', async () => {
    useOrgStoreMock.mockReturnValue({
      currentPartnerId: 'partner-1',
      isLoading: false,
      setPartner: vi.fn(),
    } as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    expect(await screen.findByText('Partner Settings')).not.toBeNull();
    expect(screen.queryByText('Partner Access Required')).toBeNull();
  });

  it('shows access-denied once resolution confirms a genuine non-partner user', async () => {
    // Context finished resolving (isLoading false) with no partner, and the JWT
    // confirms a non-partner scope — the genuine denied case.
    useOrgStoreMock.mockReturnValue({
      currentPartnerId: null,
      isLoading: false,
      setPartner: vi.fn(),
    } as never);
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });

    render(<PartnerSettingsPage />);

    // The mount effect runs setLoading(false) for the confirmed non-partner
    // scope, after which the access-denied state must appear.
    expect(await screen.findByText('Partner Access Required')).not.toBeNull();
    expect(
      screen.getByText('Partner settings are only available to partner-level users.')
    ).not.toBeNull();
    expect(screen.queryByText('Loading partner settings...')).toBeNull();
  });
});
