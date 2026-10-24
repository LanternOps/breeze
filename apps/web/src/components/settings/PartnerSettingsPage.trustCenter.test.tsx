import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // The header Save gates on partner-wide access (W2).
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketingSettingsTabs', () => ({ default: () => <div data-testid="stub-ticketing-settings-tabs" /> }));
const api = vi.hoisted(() => ({ getTrustPageTemplate: vi.fn(), updateTrustPageTemplate: vi.fn() }));
vi.mock('@/lib/api/trustPageTemplate', () => api);
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro', createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {} },
};
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as unknown as Response);

const DEFAULTS = { introHtml: null, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [], frameworkView: ['nist_csf_2'] };
const EMPTY = { introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null, showHistory: null, hiddenControlIds: null, frameworkView: null };
const loaded = (over: Record<string, unknown> = {}) => ({ template: null, revision: 2, defaults: DEFAULTS, frameworkOptions: [], canManage: true, ...over });
const conflict = () => new Response(JSON.stringify({ error: 'stale', code: 'REVISION_MISMATCH' }), { status: 409 });
const sentBodies = () => api.updateTrustPageTemplate.mock.calls.map(c => (c as unknown as [unknown, Record<string, unknown>])[1]);

beforeEach(() => {
  vi.clearAllMocks();
  usePartnerSettingsDraftStore.getState().reset();
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(
    url === '/orgs/partners/me' ? json(PARTNER) : json({ data: [] }),
  ));
  api.getTrustPageTemplate.mockResolvedValue(loaded());
  window.location.hash = '';
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

async function editTrust() {
  window.location.hash = '#trust-center';
  render(<PartnerSettingsPage />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByTestId('trust-template-showManagedBy'), 'off');
  return user;
}

describe('PartnerSettingsPage — Trust Center tab (W02g)', () => {
  it('lists the tab in the branding group at #trust-center', async () => {
    render(<PartnerSettingsPage />);
    const link = await screen.findByTestId('partner-settings-tab-trustCenter');
    expect(link.getAttribute('href')).toBe('#trust-center');
    expect(link.textContent).toContain('Trust Center');
    expect(link.closest('div')!.textContent).toContain('Login Branding');
  });

  it('mounts the template form from the URL hash, with no in-card Save', async () => {
    window.location.hash = '#trust-center';
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('trust-template-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-template-save')).toBeNull();
  });
});

describe('Trust Center saves through the header (W2 Task 21)', () => {
  it('conflict keeps draft and offers reload', async () => {
    api.updateTrustPageTemplate.mockImplementation(async () => conflict());
    const user = await editTrust();
    await user.click(screen.getByTestId('partner-settings-save'));
    expect(await screen.findByTestId('partner-settings-trust-conflict')).toBeInTheDocument();
    expect(screen.getByTestId('trust-template-showManagedBy')).toHaveValue('off');
    expect(screen.getByRole('link', { name: /^trust center \(unsaved changes\)$/i })).toBeTruthy();
    expect(screen.getByTestId('partner-settings-status').textContent).toBe("Couldn't save Trust Center.");
    // The draft is never silently replaced by the server copy.
    expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(1);
  });

  it('Reload theirs replaces the draft with the server copy and clears dirty', async () => {
    api.updateTrustPageTemplate.mockImplementation(async () => conflict());
    const user = await editTrust();
    await user.click(screen.getByTestId('partner-settings-save'));
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ template: { ...EMPTY, showHistory: true }, revision: 7 }));
    await user.click(await screen.findByRole('button', { name: /reload theirs/i }));
    await waitFor(() => expect(screen.getByTestId('trust-template-showHistory')).toHaveValue('on'));
    expect(screen.getByTestId('trust-template-showManagedBy')).toHaveValue('inherit');
    expect(screen.queryByTestId('partner-settings-trust-conflict')).toBeNull();
    expect(screen.getByRole('link', { name: /^trust center$/i })).toBeTruthy();
    expect((screen.getByTestId('partner-settings-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Keep editing keeps the stale revision, so the next Save conflicts again', async () => {
    api.updateTrustPageTemplate.mockImplementation(async () => conflict());
    const user = await editTrust();
    await user.click(screen.getByTestId('partner-settings-save'));
    await user.click(await screen.findByRole('button', { name: /keep editing/i }));
    expect(screen.queryByTestId('partner-settings-trust-conflict')).toBeNull();
    await user.click(screen.getByTestId('partner-settings-save'));
    expect(await screen.findByTestId('partner-settings-trust-conflict')).toBeInTheDocument();
    expect(sentBodies().map(b => b.expectedRevision)).toEqual([2, 2]);
  });

  it('other units still save during a trust conflict', async () => {
    api.updateTrustPageTemplate.mockImplementation(async () => conflict());
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(
      url === '/orgs/partners/me' ? json(PARTNER) : json({ data: [] }),
    ));
    const user = await editTrust();
    await user.click(screen.getByRole('link', { name: /^company$/i }));
    await user.type(await screen.findByLabelText(/company name/i), ' Inc.');
    await user.click(screen.getByTestId('partner-settings-save'));
    await waitFor(() => expect(screen.getByTestId('partner-settings-status').getAttribute('data-state')).toBe('partial'));
    expect(screen.getByTestId('partner-settings-status').textContent).toBe("Couldn't save Trust Center. Other changes saved.");
    expect(fetchWithAuthMock.mock.calls.some(([url, init]) => url === '/orgs/partners/me' && init?.method === 'PATCH')).toBe(true);
    expect(screen.getByRole('link', { name: /^company$/i })).toBeTruthy();
  });

  it('header Save sends the existing request body and then holds the returned revision', async () => {
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ data: { template: { ...EMPTY, showManagedBy: false }, revision: 3 } }), { status: 200 }));
    const user = await editTrust();
    await user.click(screen.getByTestId('partner-settings-save'));
    await waitFor(() => expect(screen.getByTestId('partner-settings-status').getAttribute('data-state')).toBe('clean'));
    expect(sentBodies()[0]).toEqual({ ...EMPTY, showManagedBy: false, expectedRevision: 2 });
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ data: { template: EMPTY, revision: 4 } }), { status: 200 }));
    await user.selectOptions(screen.getByTestId('trust-template-showManagedBy'), 'inherit');
    await user.click(screen.getByTestId('partner-settings-save'));
    await waitFor(() => expect(sentBodies()).toHaveLength(2));
    expect(sentBodies()[1]).toMatchObject({ showManagedBy: null, expectedRevision: 3 });
  });
});
