import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerSettingsPage, { runPartnerSave } from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { getJwtClaims } from '../../lib/authScope';
import { i18n, loadLocale } from '../../lib/i18n';

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

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
});

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

  // Regression for #1976: a partner-settings save that fails server-side Zod
  // validation must surface the specific field message — not collapse into the
  // generic "Failed to save settings" fallback. The save flows through runAction,
  // which (via extractApiError) recovers issues from the legacy pre-#2201
  // @hono/zod-validator default 400 body (kept for older deployed APIs). Under
  // zod v4 the ZodError's `issues` are non-enumerable, so they are
  // JSON-stringified into `error.message`; this mirrors that legacy wire shape.
  it('surfaces the specific Zod validation message (not the generic fallback) on a 400', async () => {
    const zodValidatorBody = {
      success: false,
      error: {
        name: 'ZodError',
        message: JSON.stringify([
          {
            code: 'custom',
            path: ['settings', 'remoteAccessProviders', 0, 'urlTemplate'],
            message: 'Template must include the {id} placeholder for the per-device value',
          },
        ]),
      },
    };
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(zodValidatorBody, false, 400));

    await expect(runPartnerSave(PAYLOAD, { onUnauthorized: vi.fn() })).rejects.toThrow(
      'Template must include the {id} placeholder for the per-device value'
    );

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Template must include the {id} placeholder for the per-device value',
      })
    );
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to save settings' })
    );
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
  const renderPartner = async (language = 'en') => {
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
          language,
          businessHours: { preset: 'business' },
          contact: {}
        }
      })
    );

    render(<PartnerSettingsPage />);
    await screen.findByRole('heading', { name: /Partner Settings|Configurações do parceiro/i });
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^regional$/i }));
    return user;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    window.location.hash = '';
    await act(async () => { await i18n.changeLanguage('en'); });
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  });

  it('renders an active selector with exactly the supported locales', async () => {
    await renderPartner();

    const languageSelect = screen.getByLabelText('Language') as HTMLSelectElement;
    expect(languageSelect.value).toBe('en');
    expect(Array.from(languageSelect.options).map(option => option.value)).toEqual([
'en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT',
    ]);
    expect(screen.getByText('Default language for partner settings.')).not.toBeNull();
  });

  it('loads pt-BR and includes a language edit in dirty tracking and the save payload', async () => {
    const user = await renderPartner('pt-BR');
    const languageSelect = screen.getByLabelText('Language') as HTMLSelectElement;
    expect(languageSelect.value).toBe('pt-BR');

    const saveButton = screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    await user.selectOptions(languageSelect, 'en');
    expect(saveButton.disabled).toBe(false);

    await user.click(saveButton);
    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.settings.language).toBe('en');
  });

it.each(['es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT'] as const)(
    'hydrates %s and preserves it when an unrelated partner setting is saved',
    async (persistedLocale) => {
      const user = await renderPartner(persistedLocale);
      const languageSelect = screen.getByLabelText('Language') as HTMLSelectElement;
      expect(languageSelect.value).toBe(persistedLocale);

      await user.selectOptions(screen.getByLabelText('Timezone'), 'Europe/London');
      await user.click(screen.getByRole('button', { name: /save settings/i }));

      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.settings.language).toBe(persistedLocale);
    }
  );

  it('falls back to English when the persisted locale is unsupported', async () => {
    await renderPartner('unsupported-locale');

    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('en');
  });

  it('renders the Regional Settings surface in pt-BR', async () => {
    await act(async () => {
      await loadLocale('pt-BR');
      await i18n.changeLanguage('pt-BR');
    });
    await renderPartner('pt-BR');

    expect(screen.getByText('Configurações regionais')).not.toBeNull();
    expect(screen.getByLabelText('Fuso horário')).not.toBeNull();
    expect(screen.getAllByText('Horário comercial')).toHaveLength(2);
    expect(screen.getByText('Idioma padrão das configurações do parceiro.')).not.toBeNull();
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

  const partnerWithSignature = (emailSignature: string | null) => ({
    id: 'partner-1',
    name: 'Acme MSP',
    slug: 'acme',
    type: 'partner',
    plan: 'pro',
    emailSignature,
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
  });

  it('shows the saved email signature and sends an edited value at the payload top level', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse(partnerWithSignature('Best regards,\nAcme MSP'))
    );
    // Response to the PATCH — shape doesn't matter for the assertion.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ id: 'partner-1', name: 'Acme MSP', settings: {} })
    );

    render(<PartnerSettingsPage />);

    const textarea = await screen.findByTestId('partner-email-signature') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Best regards,\nAcme MSP');

    const saveBtn = screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const user = userEvent.setup();
    await user.clear(textarea);
    await user.type(textarea, 'Cheers, The Acme Team');
    expect(saveBtn.disabled).toBe(false);
    await user.click(saveBtn);

    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.emailSignature).toBe('Cheers, The Acme Team');
  });

  it('sends emailSignature: null when the field is cleared', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse(partnerWithSignature('Old signature'))
    );
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ id: 'partner-1', name: 'Acme MSP', settings: {} })
    );

    render(<PartnerSettingsPage />);

    const textarea = await screen.findByTestId('partner-email-signature') as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.clear(textarea);
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.emailSignature).toBeNull();
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

  it('exposes a Ticketing tab in the settings nav', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    expect(screen.getByRole('link', { name: /^ticketing$/i })).not.toBeNull();
    // Not the active tab by default, so the embedded tabs are not mounted yet.
    expect(screen.queryByTestId('stub-ticketing-settings-tabs')).toBeNull();
  });

  it('mounts the ticketing sub-tabs (hash-sync disabled) when the tab is clicked', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^ticketing$/i }));

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

describe('PartnerSettingsPage sidebar nav & save contract', () => {
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
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));
  });

  it('disables Save while clean and enables it (with a nav dirty dot) after an edit', async () => {
    render(<PartnerSettingsPage />);

    const nameInput = await screen.findByLabelText(/company name/i);
    const saveBtn = screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    const user = userEvent.setup();
    await user.type(nameInput, ' Inc.');

    expect(saveBtn.disabled).toBe(false);
    // The Company nav item flags its unsaved changes for AT via the link name.
    expect(screen.getByRole('link', { name: /^company \(unsaved changes\)$/i })).not.toBeNull();
  });

  it('replaces the global Save button with a note on self-saving tabs', async () => {
    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^ticketing$/i }));

    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
    expect(screen.getByText('This section saves its own changes.')).not.toBeNull();
  });

  it('marks the active tab with aria-current and pushes the canonical kebab hash on click', async () => {
    render(<PartnerSettingsPage />);

    await screen.findByText('Partner Settings');
    const user = userEvent.setup();
    const eventLogsLink = screen.getByRole('link', { name: /^event logs$/i });
    await user.click(eventLogsLink);

    expect(window.location.hash).toBe('#event-logs');
    expect(eventLogsLink.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /^company$/i }).getAttribute('aria-current')).toBeNull();
  });

  it('deep-links the legacy camelCase hash to the right tab', async () => {
    window.location.hash = '#remoteAccess';

    render(<PartnerSettingsPage />);

    const link = await screen.findByRole('link', { name: /^remote access$/i });
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('deep-links the canonical kebab-case hash to the right tab', async () => {
    window.location.hash = '#event-logs';

    render(<PartnerSettingsPage />);

    const link = await screen.findByRole('link', { name: /^event logs$/i });
    expect(link.getAttribute('aria-current')).toBe('page');
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
      adoptPartnerId: vi.fn(),
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
      adoptPartnerId: vi.fn(),
    } as never);
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(partnerResponse));

    render(<PartnerSettingsPage />);

    expect(await screen.findByText('Partner Settings')).not.toBeNull();
    expect(screen.queryByText('Partner Access Required')).toBeNull();
  });

  it('seeds a missing partner id from the JWT via adoptPartnerId — never the context-resetting setPartner', async () => {
    // Regression: visiting /settings/partner with currentPartnerId unset used
    // to call setPartner, whose reset + auto-select silently snapped the org
    // scope to the first org (context hijack).
    const setPartner = vi.fn();
    const adoptPartnerId = vi.fn();
    useOrgStoreMock.mockReturnValue({
      currentPartnerId: null,
      isLoading: false,
      setPartner,
      adoptPartnerId,
    } as never);
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'partner-1' });
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<PartnerSettingsPage />);

    await waitFor(() => expect(adoptPartnerId).toHaveBeenCalledWith('partner-1'));
    expect(setPartner).not.toHaveBeenCalled();
  });

  it('shows access-denied once resolution confirms a genuine non-partner user', async () => {
    // Context finished resolving (isLoading false) with no partner, and the JWT
    // confirms a non-partner scope — the genuine denied case.
    useOrgStoreMock.mockReturnValue({
      currentPartnerId: null,
      isLoading: false,
      setPartner: vi.fn(),
      adoptPartnerId: vi.fn(),
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
