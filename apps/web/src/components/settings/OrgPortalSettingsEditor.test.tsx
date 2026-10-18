import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PORTAL_SENSITIVE_FLAG_KEYS } from '@breeze/shared';
import OrgPortalSettingsEditor from './OrgPortalSettingsEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const SETTINGS = {
  orgId: ORG_ID,
  enableTickets: true,
  enableAssetCheckout: true,
  enableSelfService: false,
  enablePasswordReset: true,
  enableDevices: false,
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  enableService: false,
  enableDocuments: false,
  enableLifecycle: false,
  enableHardwareHealth: false,
  enableHardwareInventory: false,
  enablePerformanceMetrics: false,
  enableSoftwareInventory: false,
  enableNetworkVisibility: false,
  enableEdrVisibility: false,
  enableTrustPageEditing: false,
  enableHourBlock: false,
  enablePatchDetail: false,
  enableVulnerabilityDetail: false,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome!',
  footerText: null,
  chromeAccent: null as string | null
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi(settings: unknown = SETTINGS) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && !init?.method) {
      return makeJsonResponse({ data: settings });
    }
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && init?.method === 'PATCH') {
      return makeJsonResponse({ data: settings });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('OrgPortalSettingsEditor', () => {
  const onDirty = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders the fetched settings', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-settings')).toBeInTheDocument());
    expect((screen.getByTestId('org-portal-toggle-enableTickets') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('org-portal-toggle-enableSelfService') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('org-portal-support-email') as HTMLInputElement).value).toBe('help@msp.example');
    expect((screen.getByTestId('org-portal-support-phone') as HTMLInputElement).value).toBe('');
  });

  // #7510 (settings rules 3 + 4): the org "Footer text" is the org override of
  // the partner document footer. It says it prints on documents, and while it
  // is blank it shows the inherited partner value and where it comes from.
  describe('document footer (#7510)', () => {
    it('says the footer prints on quotes and invoices', async () => {
      mockApi({ ...SETTINGS, partnerInvoiceFooter: 'Thanks for your business' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      expect(await screen.findByTestId('org-portal-footer-help')).toHaveTextContent(/quotes and invoices/i);
    });

    it('shows the inherited partner footer and its source while the org footer is blank', async () => {
      mockApi({ ...SETTINGS, footerText: null, partnerInvoiceFooter: 'Thanks for your business' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      const input = (await screen.findByTestId('org-portal-footer')) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('Thanks for your business');
      expect(screen.getByText('Inherits from Partner document footer')).toBeInTheDocument();
    });

    it('says the org footer overrides the partner footer once set', async () => {
      mockApi({ ...SETTINGS, footerText: 'Org line', partnerInvoiceFooter: 'Thanks for your business' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      expect(((await screen.findByTestId('org-portal-footer')) as HTMLInputElement).value).toBe('Org line');
      expect(screen.getByText('Overrides Partner document footer (Thanks for your business)')).toBeInTheDocument();
    });

    it('says no partner footer is configured when neither level sets one', async () => {
      mockApi({ ...SETTINGS, footerText: null, partnerInvoiceFooter: null });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      await screen.findByTestId('org-portal-footer');
      expect(screen.getByText('No Partner document footer configured')).toBeInTheDocument();
    });

    // Blank = inherit: a cleared (or whitespace-only) org footer saves as NULL,
    // never '', so it cannot suppress the partner footer on documents.
    it.each(['', '   '])('saves a cleared org footer (%j) as null', async (blank) => {
      mockApi({ ...SETTINGS, footerText: 'Org line', partnerInvoiceFooter: 'Thanks for your business' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      fireEvent.change(await screen.findByTestId('org-portal-footer'), { target: { value: blank } });
      fireEvent.click(screen.getByTestId('org-portal-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(String(patchCall![1]!.body)).footerText).toBeNull();
    });

    it('never sends the inherited partner footer back on save', async () => {
      mockApi({ ...SETTINGS, footerText: null, partnerInvoiceFooter: 'Thanks for your business' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      fireEvent.change(await screen.findByTestId('org-portal-footer'), { target: { value: '  Org line  ' } });
      fireEvent.click(screen.getByTestId('org-portal-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      const body = JSON.parse(String(patchCall![1]!.body));
      expect(body.footerText).toBe('Org line');
      expect(body).not.toHaveProperty('partnerInvoiceFooter');
    });
  });

  it('marks dirty when a toggle changes', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-toggle-enableTickets')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    expect(onDirty).toHaveBeenCalled();
  });

  it('saves via PATCH with empty strings normalized to null, then calls onSave', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    fireEvent.change(screen.getByTestId('org-portal-support-email'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body.enableTickets).toBe(false);
    expect(body.supportEmail).toBeNull();
    expect(body.welcomeMessage).toBe('Welcome!');
  });

  it('enables available visibility flags in the local draft', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor
      orgId={ORG_ID}
      onDirty={onDirty}
      onSave={onSave}
    />);

    fireEvent.click(await screen.findByTestId(
      'org-portal-enable-all-visibility',
    ));

    for (const key of [
      'enableDevices',
      'enableDashboard',
      'enableSecurity',
      'enableBackups',
      'enableReports',
      'enableSupportUsage',
      'enableService',
      'enableDocuments',
      'enableLifecycle',
      'enableHardwareHealth',
      'enableHardwareInventory',
      'enablePerformanceMetrics',
      'enableNetworkVisibility',
    ]) {
      expect((screen.getByTestId(
        `org-portal-toggle-${key}`,
      ) as HTMLInputElement).checked).toBe(true);
    }

    expect(onDirty).toHaveBeenCalled();
  });

  it('shows the Support hours toggle from the fetched settings, unchecked by default', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    const toggle = await screen.findByTestId('org-portal-toggle-enableHourBlock');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('Enable all visibility does not turn on Support hours (billing-sensitive, enabled one at a time)', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));

    expect((screen.getByTestId('org-portal-toggle-enableHourBlock') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('org-portal-toggle-enableSupportUsage') as HTMLInputElement).checked).toBe(true);
  });

  it('is disabled while Support usage is off, enabled once it is on', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    const hours = await screen.findByTestId('org-portal-toggle-enableHourBlock') as HTMLInputElement;
    expect(hours.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('org-portal-toggle-enableSupportUsage'));
    expect((screen.getByTestId('org-portal-toggle-enableHourBlock') as HTMLInputElement).disabled).toBe(false);
  });

  it('saves the Support hours flag through the existing runAction PATCH once Support usage is on', async () => {
    mockApi({ ...SETTINGS, enableSupportUsage: true });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-toggle-enableHourBlock'));
    expect(onDirty).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({ enableSupportUsage: true, enableHourBlock: true });
  });

  it('turning Support usage off also turns Support hours off', async () => {
    mockApi({ ...SETTINGS, enableSupportUsage: true, enableHourBlock: true });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-toggle-enableSupportUsage'));

    expect((screen.getByTestId('org-portal-toggle-enableHourBlock') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({ enableSupportUsage: false, enableHourBlock: false });
  });

  it('never saves Support hours ON while Support usage is OFF, even from stale loaded settings', async () => {
    mockApi({ ...SETTINGS, enableSupportUsage: false, enableHourBlock: true });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({ enableHourBlock: false });
  });

  it.each(['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'])(
    'has a translated Support hours label and description in %s',
    async (locale) => {
      const catalog = (await import(`../../locales/${locale}/settings.json`)).default as {
        orgPortalSettingsEditor: { visibility: { toggles: Record<string, { label: string; description: string }> } };
      };
      const entry = catalog.orgPortalSettingsEditor.visibility.toggles.enableHourBlock;
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.description.length).toBeGreaterThan(0);
    },
  );

  it('preserves individual software opt-in when "Enable all" is clicked', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));
    const softwareToggle = screen.getByTestId('org-portal-toggle-enableSoftwareInventory') as HTMLInputElement;
    expect(softwareToggle.checked).toBe(false);
    fireEvent.click(softwareToggle);
    expect(softwareToggle.checked).toBe(true);
    fireEvent.click(screen.getByTestId('org-portal-enable-all-visibility'));
    expect(softwareToggle.checked).toBe(true);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body)).enableSoftwareInventory).toBe(true);
  });

  it('shows the EDR visibility toggle and saves it when toggled individually', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    const toggle = (await screen.findByTestId('org-portal-toggle-enableEdrVisibility')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body)).enableEdrVisibility).toBe(true);
  });

  it('shows the trust-page editing permission with its help text, keeps it out of "Enable all", and saves it (Trust Center W3d)', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    const toggle = (await screen.findByTestId('org-portal-toggle-enableTrustPageEditing')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const row = toggle.closest('label')!;
    expect(within(row).getByText('Customer trust page editing')).toBeTruthy();
    expect(within(row).getByText(/admin contact/i)).toBeTruthy();
    expect(within(row).getByText(/you still publish/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('org-portal-enable-all-visibility'));
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body)).enableTrustPageEditing).toBe(true);
  });

  it('"Enable all" turns EDR visibility on (not a sensitive flag)', async () => {
    expect(PORTAL_SENSITIVE_FLAG_KEYS).not.toContain('enableEdrVisibility');
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));
    expect((screen.getByTestId('org-portal-toggle-enableEdrVisibility') as HTMLInputElement).checked).toBe(true);
  });

  it('keeps patch detail (sensitive) off through "Enable all" and saves it when toggled individually', async () => {
    expect(PORTAL_SENSITIVE_FLAG_KEYS).toContain('enablePatchDetail');
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));
    const toggle = screen.getByTestId('org-portal-toggle-enablePatchDetail') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('org-portal-enable-all-visibility'));
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body)).enablePatchDetail).toBe(true);
  });

  it.each(['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'])(
    'has a translated patch detail label and description in %s',
    async (locale) => {
      const catalog = (await import(`../../locales/${locale}/settings.json`)).default as {
        orgPortalSettingsEditor: { visibility: { toggles: Record<string, { label: string; description: string }> } };
      };
      const entry = catalog.orgPortalSettingsEditor.visibility.toggles.enablePatchDetail;
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.description.length).toBeGreaterThan(0);
    },
  );

  it('keeps vulnerability detail (sensitive) off through "Enable all" and saves it when toggled individually', async () => {
    expect(PORTAL_SENSITIVE_FLAG_KEYS).toContain('enableVulnerabilityDetail');
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));
    const toggle = screen.getByTestId('org-portal-toggle-enableVulnerabilityDetail') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('org-portal-enable-all-visibility'));
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body)).enableVulnerabilityDetail).toBe(true);
  });

  it.each(['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'])(
    'has a translated vulnerability detail label and description in %s',
    async (locale) => {
      const catalog = (await import(`../../locales/${locale}/settings.json`)).default as {
        orgPortalSettingsEditor: { visibility: { toggles: Record<string, { label: string; description: string }> } };
      };
      const entry = catalog.orgPortalSettingsEditor.visibility.toggles.enableVulnerabilityDetail;
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.description.length).toBeGreaterThan(0);
    },
  );

  it('leaves every sensitive flag off when "Enable all" is clicked', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));

    expect(PORTAL_SENSITIVE_FLAG_KEYS.length).toBeGreaterThan(0);
    for (const key of PORTAL_SENSITIVE_FLAG_KEYS) {
      expect((screen.getByTestId(`org-portal-toggle-${key}`) as HTMLInputElement).checked).toBe(false);
    }
  });

  it('saves all visibility flags through the existing runAction path', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor
      orgId={ORG_ID}
      onDirty={onDirty}
      onSave={onSave}
    />);

    fireEvent.click(await screen.findByTestId(
      'org-portal-enable-all-visibility',
    ));
    fireEvent.click(screen.getByTestId(
      'org-portal-save',
    ));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({
      enableDevices: true,
      enableSelfService: false,
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
      enableService: true,
      enableDocuments: true,
      enableLifecycle: true,
      enableHardwareHealth: true,
      enableHardwareInventory: true,
      enablePerformanceMetrics: true,
      enableSoftwareInventory: false,
      enableNetworkVisibility: true,
      enableEdrVisibility: true,
    });
  });

  it('shows an error state with retry when the load fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-load-error')).toBeInTheDocument());
  });

  it('does not call onSave when the PATCH fails (runAction toasts the error)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: SETTINGS });
    });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onSave).not.toHaveBeenCalled();
  });

  describe('portal accent', () => {
    it('renders all 8 swatches with the fetched accent checked', async () => {
      mockApi({ ...SETTINGS, chromeAccent: 'navy' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      await waitFor(() => expect(screen.getByTestId('org-portal-settings')).toBeInTheDocument());

      const group = screen.getByRole('radiogroup', { name: /portal accent/i });
      const swatches = within(group).getAllByRole('radio');
      expect(swatches).toHaveLength(8);

      const navySwatch = screen.getByTestId('org-portal-accent-navy');
      expect(navySwatch).toHaveAttribute('aria-checked', 'true');
      for (const key of ['spruce', 'ink', 'oxblood', 'plum', 'bronze', 'teal', 'forest']) {
        expect(screen.getByTestId(`org-portal-accent-${key}`)).toHaveAttribute('aria-checked', 'false');
      }
    });

    it('defaults the checked swatch to spruce when chromeAccent is null', async () => {
      mockApi();
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      await waitFor(() => expect(screen.getByTestId('org-portal-settings')).toBeInTheDocument());
      expect(screen.getByTestId('org-portal-accent-spruce')).toHaveAttribute('aria-checked', 'true');
    });

    it('saves the picked non-default accent key', async () => {
      mockApi();
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('org-portal-accent-oxblood'));
      expect(onDirty).toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('org-portal-save'));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String(patchCall![1]!.body));
      expect(body.chromeAccent).toBe('oxblood');
    });

    it('saves null when spruce is picked', async () => {
      mockApi({ ...SETTINGS, chromeAccent: 'navy' });
      render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
      await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('org-portal-accent-spruce'));
      fireEvent.click(screen.getByTestId('org-portal-save'));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String(patchCall![1]!.body));
      expect(body.chromeAccent).toBeNull();
    });
  });
});
