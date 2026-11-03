import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InheritanceTabDto } from '@breeze/shared';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { PARTNERS_ME_FIXTURE } from './partnerSettings/partnersMeFixture';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';
import { invalidateInheritance, useInheritanceStore } from './partnerSettings/useTabInheritance';

const authState = vi.hoisted(() => ({ user: { id: 'u-1', canManagePartnerWide: true as boolean } }));
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
vi.mock('./KnownGuestsSettings', () => ({ default: () => <div data-testid="stub-known-guests" /> }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SECURITY: InheritanceTabDto = {
  tab: 'security',
  orgCount: 12,
  fields: [
    { id: 'security.requireMfa', kind: 'locks', partnerSet: true, inForce: true, platformDefault: false, sealed: false, counts: { ownValue: 2, overrides: 0, shadowed: 2 } },
    { id: 'security.sessionTimeout', kind: 'locks', partnerSet: true, inForce: true, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
  ],
};
const ORGS = {
  field: 'security.requireMfa',
  rows: [{ orgId: 'o-1', orgName: 'Alpha Dental', ownValue: { set: true, value: false }, inEffect: false }],
  nextCursor: null,
};

let wide = false;
const media = { listeners: new Set<(e: { matches: boolean }) => void>() };

beforeEach(() => {
  vi.clearAllMocks();
  wide = false;
  authState.user.canManagePartnerWide = true;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === '(min-width: 1920px)' && wide,
    media: query,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => media.listeners.add(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => media.listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
  usePartnerSettingsDraftStore.getState().reset();
  useInheritanceStore.getState().reset();
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/orgs/partners/me') return json(PARTNERS_ME_FIXTURE);
    if (url === '/orgs/partners/me/settings-inheritance?tab=security') return json({ data: SECURITY });
    if (url.startsWith('/orgs/partners/me/settings-inheritance/orgs?field=security.requireMfa')) return json({ data: ORGS });
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

describe('PartnerSettingsPage drill-down layout (#9790 W4, spec §5.5, §6)', () => {
  it('below 1920 the count opens a drawer, and there is no side panel', async () => {
    const user = await renderPage('#security');
    expect(screen.queryByTestId('partner-settings-side-panel')).toBeNull();
    await user.click(await screen.findByTestId('partner-settings-line-security.requireMfa-shadowed'));
    const drawer = await screen.findByTestId('partner-settings-drilldown-drawer');
    expect(within(drawer).getByText('Require MFA for all users')).toBeInTheDocument();
    expect(within(drawer).getByText('Orgs whose own value is not in effect')).toBeInTheDocument();
    expect(await within(drawer).findByTestId('partner-settings-drilldown-row-o-1')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/orgs/partners/me/settings-inheritance/orgs?field=security.requireMfa&bucket=shadowed', expect.objectContaining({ skipOrgIdInjection: true, signal: expect.any(AbortSignal) }));
  });

  it('at 1920 the side panel renders the tab summary, and a count opens in it rather than a drawer', async () => {
    wide = true;
    const user = await renderPage('#security');
    const panel = await screen.findByTestId('partner-settings-side-panel');
    const summary = await within(panel).findByTestId('partner-settings-side-panel-summary');
    expect(summary.textContent).toContain('2 settings lock orgs · 0 can be overridden · 1 has orgs that differ from your defaults');

    await user.click(screen.getByTestId('partner-settings-line-security.requireMfa-shadowed'));
    expect(await within(panel).findByTestId('partner-settings-drilldown-row-o-1')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-settings-drilldown-drawer')).toBeNull();

    await user.click(within(panel).getByTestId('partner-settings-side-panel-back'));
    await user.click(await within(panel).findByTestId('partner-settings-side-panel-field-security.requireMfa'));
    expect(await within(panel).findByTestId('partner-settings-drilldown-row-o-1')).toBeInTheDocument();
  });

  it('at 1920 the grid gains the third column only where there are classified fields', async () => {
    wide = true;
    await renderPage('#security');
    await screen.findByTestId('partner-settings-side-panel');
    const grid = screen.getByTestId('partner-settings-side-panel').parentElement!;
    expect(grid.className).toContain('grid-cols-[240px_minmax(0,1fr)_360px]');
    expect(grid.className).not.toContain('lg:grid-cols');
  });

  it.each(['#company', '#modules', '#known-guests', '#branding', '#email-templates'])('no third column on %s', async (hash) => {
    wide = true;
    await renderPage(hash);
    await waitFor(() => expect(screen.getByTestId('partner-settings-panel-heading')).toBeInTheDocument());
    expect(screen.queryByTestId('partner-settings-side-panel')).toBeNull();
    expect(document.querySelector('[class*="_360px]"]')).toBeNull();
  });

  it('at 1920 a selected-access user sees the restricted notice in the side panel and nothing is fetched', async () => {
    wide = true;
    authState.user.canManagePartnerWide = false;
    await renderPage('#security');
    const panel = await screen.findByTestId('partner-settings-side-panel');
    expect(panel).toHaveTextContent('Org breakdown requires full partner access');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('settings-inheritance'))).toHaveLength(0);
  });

  it('an open org list re-reads after a save instead of keeping pre-save rows', async () => {
    const user = await renderPage('#security');
    await user.click(await screen.findByTestId('partner-settings-line-security.requireMfa-shadowed'));
    await screen.findByTestId('partner-settings-drilldown-row-o-1');
    const orgReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/settings-inheritance/orgs?')).length;
    expect(orgReads()).toBe(1);
    act(() => { invalidateInheritance(['security']); });
    await waitFor(() => expect(orgReads()).toBe(2));
    // The counts stay on screen while the tab refetches (no blink).
    expect(screen.getByTestId('partner-settings-line-security.requireMfa')).toBeInTheDocument();
  });

  it('switching tabs closes an open drill-down', async () => {
    const user = await renderPage('#security');
    await user.click(await screen.findByTestId('partner-settings-line-security.requireMfa-shadowed'));
    await screen.findByTestId('partner-settings-drilldown-drawer');
    window.location.hash = '#defaults';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(screen.queryByTestId('partner-settings-drilldown-drawer')).toBeNull());
  });
});
