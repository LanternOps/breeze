import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { PARTNERS_ME_FIXTURE } from './partnerSettings/partnersMeFixture';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';
import { ALL_TABS } from './partnerSettings/tabRegistry';
import { SNAPSHOT } from './aiModels/testFixtures';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u-1', canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: vi.fn(() => ({ scope: null, orgId: null, partnerId: null })) }));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./EmailTemplatesTab', () => ({ default: () => <div data-testid="stub-email-templates-tab" /> }));
const cvEnabled = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => cvEnabled.value }));
vi.mock('@/lib/api/callerVerification', async () => {
  const { policy, policyValues } = await import('../callerVerification/testFixtures');
  return { getPolicy: vi.fn(async () => ({ maxAchievableTier: 3, row: null, defaults: policyValues, baseline: policyValues, effective: policy })), putPolicy: vi.fn() };
});
const trustApi = vi.hoisted(() => ({ getTrustPageTemplate: vi.fn(), updateTrustPageTemplate: vi.fn() }));
vi.mock('@/lib/api/trustPageTemplate', () => trustApi);
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const patches = () => fetchMock.mock.calls.filter(([url, init]) => url === '/orgs/partners/me' && (init as RequestInit | undefined)?.method === 'PATCH');

function navigate(): Event {
  const event = new Event('astro:before-preparation', { cancelable: true });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  cvEnabled.value = true;
  usePartnerSettingsDraftStore.getState().reset();
  vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false } as never);
  trustApi.getTrustPageTemplate.mockResolvedValue({
    template: null, revision: 0, canManage: true, frameworkOptions: [],
    defaults: { introHtml: null, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [], frameworkView: [] },
  });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/orgs/partners/me') return json(PARTNERS_ME_FIXTURE);
    if (url === '/ai/models') return json(SNAPSHOT);
    if (url === '/partner/ai/data-policy') return json({ policy: null, canManage: true, defaults: { deviceFileReadLevel: 'off', toolOutputRetentionDays: 30 } });
    void init;
    return json({ data: [] });
  });
});
afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

async function renderPage(hash = '') {
  window.location.hash = hash;
  render(<PartnerSettingsPage />);
  await screen.findByTestId('partner-settings-panel-heading');
  return userEvent.setup();
}

describe('PartnerSettingsPage navigation guard and form semantics (W2 Task 23)', () => {
  it('astro:before-preparation is cancelled while dirty and confirm declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = await renderPage();
    expect(navigate().defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('City'), 'ville');
    const blocked = navigate();
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave this page and discard them?');
    expect(blocked.defaultPrevented).toBe(true);
    confirm.mockReturnValue(true);
    expect(navigate().defaultPrevented).toBe(false);
  });

  it('Enter in a form card runs the header Save', async () => {
    fetchMock.mockImplementation(async (url: string) => json(url === '/orgs/partners/me' ? PARTNERS_ME_FIXTURE : { data: [] }));
    const user = await renderPage();
    await user.type(screen.getByLabelText('City'), 'ville{Enter}');
    await waitFor(() => expect(patches()).toHaveLength(1));
  });

  it('every <button> inside a FormCard has an explicit type', async () => {
    await renderPage();
    const formTabs = ALL_TABS.filter(t => t.kind === 'panel' && !['sendingDomains', 'emailTemplates', 'knownGuests', 'modules', 'aiProvider'].includes(t.key));
    for (const tab of formTabs) {
      window.location.hash = `#${tab.hash}`;
      await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(document.querySelectorAll('form').length, tab.key).toBeGreaterThan(0);
      expect(document.querySelectorAll('form form').length, tab.key).toBe(0);
      const untyped = [...document.querySelectorAll('form button:not([type])')].map(b => b.outerHTML.slice(0, 80));
      expect(untyped, tab.key).toEqual([]);
    }
  });

  it.each([
    ...ALL_TABS.filter(t => t.kind === 'panel' && t.key !== 'sendingDomains').flatMap(t => [[`#${t.hash}`, t.key], [`#${t.key}`, t.key]]),
    ['#ai-models', 'aiProvider'],
  ])('legacy and canonical hashes still resolve after W2: %s', async (hash, key) => {
    await renderPage(hash);
    expect(screen.getByTestId(`partner-settings-tab-${key}`).getAttribute('aria-current')).toBe('page');
  });

  it('#ticketing keeps its static panel', async () => {
    window.location.hash = '#ticketing';
    render(<PartnerSettingsPage />);
    expect(await screen.findByTestId('partner-settings-ticketing-panel')).toBeTruthy();
    expect(window.location.hash).toBe('#ticketing');
  });
});
