import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { ALL_TABS } from './partnerSettings/tabRegistry';
import { PARTNERS_ME_FIXTURE } from './partnerSettings/partnersMeFixture';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';

const authState = vi.hoisted(() => ({ user: { id: 'u-1', canManagePartnerWide: true as boolean | undefined } }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: unknown) => unknown) => sel(authState),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./EmailTemplatesTab', () => ({ default: () => <div data-testid="stub-email-templates-tab" /> }));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

export const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes fetchWithAuth by `METHOD path`; anything unrouted answers `{ data: [] }`. */
function routeFetch(routes: Record<string, Handler>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const handler = routes[`${method} ${url}`];
    return handler ? handler(init) : json({ data: [] });
  });
}

const partnerWith = (settings: Record<string, unknown> = {}) => ({
  ...PARTNERS_ME_FIXTURE,
  settings: { ...PARTNERS_ME_FIXTURE.settings, ...settings },
});

const patchCalls = () => fetchMock.mock.calls.filter(([url, init]) => url === '/orgs/partners/me' && (init as RequestInit | undefined)?.method === 'PATCH');
const saveButton = () => screen.getByTestId('partner-settings-save') as HTMLButtonElement;
const status = () => screen.getByTestId('partner-settings-status');

async function renderPage(hash = '') {
  window.location.hash = hash;
  render(<PartnerSettingsPage />);
  await screen.findByTestId('partner-settings-panel-heading');
  return userEvent.setup();
}

async function openTab(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('link', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user.canManagePartnerWide = true;
  usePartnerSettingsDraftStore.getState().reset();
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  routeFetch({ 'GET /orgs/partners/me': () => json(partnerWith()) });
});

afterEach(() => { window.location.hash = ''; });

describe('PartnerSettingsPage header status and validity (W2 Task 18)', () => {
  it('status line is a polite live region and Save shows on every tab', async () => {
    const user = await renderPage();
    expect(status().getAttribute('role')).toBe('status');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('All changes saved');
    // AI providers and Trust Center need their own fixtures (covered by their unit tests); the rest render on the default mock.
    for (const tab of ALL_TABS.filter(t => t.kind === 'panel' && !['sendingDomains', 'callerVerification', 'aiProvider', 'trustCenter'].includes(t.key))) {
      window.location.hash = `#${tab.hash}`;
      await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(screen.getByTestId('partner-settings-save')).toBeTruthy();
      expect(screen.queryByText('This section saves its own changes.')).toBeNull();
    }
    void user;
  });

  it('status lists every dirty tab before save, and each name opens its tab', async () => {
    const user = await renderPage();
    await user.type(screen.getByLabelText('City'), 'ville');
    await openTab(user, /^security$/i);
    await user.type(screen.getByLabelText('Max Concurrent Sessions'), '4');
    expect(status().textContent).toBe('Unsaved changes in Company, Security.');
    expect(saveButton().disabled).toBe(false);
    await user.click(within(status()).getByRole('button', { name: 'Company' }));
    expect(window.location.hash).toBe('#company');
    expect(screen.getByTestId('partner-settings-panel-heading').textContent).toBe('Company');
  });

  it('an invalid draft on one tab disables Save after switching tabs', async () => {
    const user = await renderPage('#ai-budgets');
    const input = await screen.findByTestId('partner-ai-budget-thresholds-input');
    await user.clear(input);
    await user.type(input, '50,abc');
    await openTab(user, /^company$/i);
    expect(saveButton().disabled).toBe(true);
    expect(status().getAttribute('data-state')).toBe('invalid');
    expect(status().textContent).toBe('Fix 1 field in AI Budgets to save.');
    await openTab(user, /^ai budgets/i);
    expect((screen.getByTestId('partner-ai-budget-thresholds-input') as HTMLInputElement).value).toBe('50,abc');
    expect(screen.getByTestId('partner-ai-budget-thresholds-error')).toBeTruthy();
  });

  it('invalid website shows inline error with aria-invalid/aria-describedby and blocks Save', async () => {
    const user = await renderPage();
    const website = screen.getByLabelText(/website/i) as HTMLInputElement;
    await user.clear(website);
    await user.type(website, 'ftp://acme.example');
    expect(website.getAttribute('aria-invalid')).toBe('true');
    expect(website.getAttribute('aria-describedby')).toBe('contact-website-error');
    expect(saveButton().disabled).toBe(true);
    expect(status().textContent).toBe('Fix 1 field in Company to save.');
  });

  it('invalid maintenance window blocks Save', async () => {
    const user = await renderPage('#defaults');
    const mw = screen.getByLabelText(/maintenance window/i) as HTMLInputElement;
    await user.clear(mw);
    await user.type(mw, 'whenever');
    expect(saveButton().disabled).toBe(true);
    expect(status().getAttribute('data-state')).toBe('invalid');
  });

  it('invalid link focuses the first invalid field', async () => {
    const user = await renderPage();
    const website = screen.getByLabelText(/website/i);
    await user.clear(website);
    await user.type(website, 'ftp://x');
    await openTab(user, /^security$/i);
    await user.click(within(status()).getByRole('button', { name: 'Company' }));
    await waitFor(() => expect(document.activeElement?.id).toBe('contact-website'));
  });

  it('save disabled without partner-wide access', async () => {
    authState.user.canManagePartnerWide = false;
    const user = await renderPage();
    await user.type(screen.getByLabelText('City'), 'ville');
    expect(saveButton().disabled).toBe(true);
    expect(status().textContent).toBe('Saving needs full partner access');
  });

  it('a successful save shows one aggregate toast, re-baselines and keeps the saved event', async () => {
    const saved = vi.fn();
    window.addEventListener('breeze:partner-settings-saved', saved);
    routeFetch({
      'GET /orgs/partners/me': () => json(partnerWith()),
      'PATCH /orgs/partners/me': () => json(partnerWith()),
    });
    const user = await renderPage();
    await user.type(screen.getByLabelText('City'), 'ville');
    await user.click(saveButton());
    await waitFor(() => expect(status().textContent).toMatch(/^All changes saved · /));
    expect(patchCalls()).toHaveLength(1);
    expect(saved).toHaveBeenCalledTimes(1);
    const successToasts = showToastMock.mock.calls.filter(([arg]) => (arg as { type: string }).type === 'success');
    expect(successToasts).toEqual([[{ type: 'success', message: 'Partner settings saved' }]]);
    expect(saveButton().disabled).toBe(true);
    window.removeEventListener('breeze:partner-settings-saved', saved);
  });
});

describe('PartnerSettingsPage header Save runs the units (W2 Task 19)', () => {
  it('a failed partners/me save keeps the tabs dirty, says which failed and allows a retry', async () => {
    let fail = true;
    routeFetch({
      'GET /orgs/partners/me': () => json(partnerWith()),
      'PATCH /orgs/partners/me': () => (fail ? json({ error: 'boom' }, 500) : json(partnerWith())),
    });
    const user = await renderPage();
    await user.type(screen.getByLabelText('City'), 'ville');
    await user.click(saveButton());
    await waitFor(() => expect(status().getAttribute('data-state')).toBe('failed'));
    expect(status().textContent).toBe("Couldn't save Company.");
    expect(screen.getByRole('link', { name: /^company \(unsaved changes\)$/i })).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    fail = false;
    await user.click(saveButton());
    await waitFor(() => expect(status().getAttribute('data-state')).toBe('clean'));
    expect(patchCalls()).toHaveLength(2);
  });

  it('an edit made while the save is in flight stays dirty afterwards', async () => {
    let release!: (r: Response) => void;
    routeFetch({
      'GET /orgs/partners/me': () => json(partnerWith()),
      'PATCH /orgs/partners/me': () => new Promise<Response>(r => { release = r; }),
    });
    const user = await renderPage();
    const city = screen.getByLabelText('City');
    await user.type(city, 'A');
    await user.click(saveButton());
    expect(status().textContent).toBe('Saving…');
    await user.type(city, 'B');
    await act(async () => { release(json(partnerWith())); });
    await waitFor(() => expect(status().getAttribute('data-state')).toBe('dirty'));
    expect(JSON.parse((patchCalls()[0][1] as RequestInit).body as string).settings.address.city).toBe('SpringfieldA');
  });
});
