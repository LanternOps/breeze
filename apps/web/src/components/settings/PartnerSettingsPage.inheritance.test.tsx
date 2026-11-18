import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InheritanceTabDto } from '@breeze/shared';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import { PARTNERS_ME_FIXTURE } from './partnerSettings/partnersMeFixture';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';
import { useInheritanceStore } from './partnerSettings/useTabInheritance';

const authState = vi.hoisted(() => ({ user: { id: 'u-1', canManagePartnerWide: true as boolean | undefined } }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: unknown) => unknown) => sel(authState),
  handleSessionExpired: vi.fn(),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => false }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SECURITY: InheritanceTabDto = {
  tab: 'security',
  orgCount: 12,
  fields: [
    { id: 'security.requireMfa', kind: 'locks', partnerSet: true, inForce: true, platformDefault: false, sealed: false, counts: { ownValue: 2, overrides: 0, shadowed: 2 } },
    { id: 'security.sessionTimeout', kind: 'locks', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
  ],
};

const INHERITANCE = '/orgs/partners/me/settings-inheritance?tab=security';
const inheritanceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/orgs/partners/me/settings-inheritance'));

let inheritance: () => Response;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  authState.user.canManagePartnerWide = true;
  usePartnerSettingsDraftStore.getState().reset();
  useInheritanceStore.getState().reset();
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  inheritance = () => json({ data: SECURITY });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/orgs/partners/me') return json(PARTNERS_ME_FIXTURE);
    if (url === INHERITANCE && method === 'GET') return inheritance();
    return json({ data: [] });
  });
});

afterEach(() => { window.location.hash = ''; });

async function renderPage(hash: string) {
  window.location.hash = hash;
  render(<PartnerSettingsPage />);
  await screen.findByTestId('partner-settings-panel-heading');
  return userEvent.setup();
}

describe('PartnerSettingsPage inheritance (#9790 W4)', () => {
  it('a full-access user sees the per-field line for the active tab, fetched once without the ambient orgId', async () => {
    await renderPage('#security');
    expect(await screen.findByTestId('partner-settings-line-security.requireMfa')).toHaveTextContent('Applies to all 12 orgs · 2 had their own value');
    expect(inheritanceCalls()).toEqual([[INHERITANCE, expect.objectContaining({ skipOrgIdInjection: true, signal: expect.any(AbortSignal) })]]);
  });

  it('restricted state renders badges without counts, never fetches and never toasts (Review Focus 1)', async () => {
    authState.user.canManagePartnerWide = false;
    await renderPage('#security');
    expect(screen.getByTestId('partner-settings-badge-security.requireMfa')).toHaveTextContent('Locks orgs');
    expect(screen.getByTestId('partner-settings-line-security.requireMfa')).toHaveTextContent('Org breakdown requires full partner access');
    expect(screen.queryByRole('button', { name: /had their own value/ })).toBeNull();
    expect(inheritanceCalls()).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a failed read leaves the badge, renders no line and never toasts', async () => {
    inheritance = () => json({ error: 'boom' }, 500);
    await renderPage('#security');
    await waitFor(() => expect(inheritanceCalls()).toHaveLength(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(screen.getByTestId('partner-settings-badge-security.requireMfa')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-settings-line-security.requireMfa')).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a tab without classified fields does not fetch', async () => {
    await renderPage('#company');
    await screen.findByLabelText('City');
    expect(inheritanceCalls()).toHaveLength(0);
  });

  it('an unsaved edit marks the line as the saved value; a successful Save refetches the tab', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/orgs/partners/me') return json(PARTNERS_ME_FIXTURE);
      if (url === INHERITANCE && method === 'GET') return inheritance();
      return json({ data: [] });
    });
    const user = await renderPage('#security');
    const line = await screen.findByTestId('partner-settings-line-security.sessionTimeout');
    expect(line.textContent).not.toMatch(/^Saved value:/);
    // Clear first: the fixture holds 720, and typing after it would make 72060,
    // which the shared session-timeout bound now blocks before Save (#10081).
    const timeout = screen.getByLabelText('Session Timeout (minutes)');
    await user.clear(timeout);
    await user.type(timeout, '60');
    expect(screen.getByTestId('partner-settings-line-security.sessionTimeout').textContent).toMatch(/^Saved value: /);
    expect(screen.getByTestId('partner-settings-line-security.requireMfa').textContent).not.toMatch(/^Saved value:/);

    // The saved value now locks: the refetched counts replace the old line.
    inheritance = () => json({ data: { ...SECURITY, fields: [SECURITY.fields[0], { ...SECURITY.fields[1], partnerSet: true, inForce: true }] } });
    await user.click(screen.getByTestId('partner-settings-save'));
    await waitFor(() => expect(inheritanceCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('partner-settings-line-security.sessionTimeout')).toHaveTextContent('Applies to all 12 orgs'));
  });

  it('a failed read retries when its tab is opened again, not on every render', async () => {
    inheritance = () => json({ error: 'boom' }, 500);
    const user = await renderPage('#security');
    await waitFor(() => expect(inheritanceCalls()).toHaveLength(1));
    inheritance = () => json({ data: SECURITY });
    await user.click(screen.getByTestId('partner-settings-tab-company'));
    await user.click(screen.getByTestId('partner-settings-tab-security'));
    expect(await screen.findByTestId('partner-settings-line-security.requireMfa')).toHaveTextContent('Applies to all 12 orgs');
    expect(inheritanceCalls()).toHaveLength(2);
  });
});
