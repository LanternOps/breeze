import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import '@/lib/i18n';
import { i18n } from '@/lib/i18n';

import PartnerSettingsPage from './PartnerSettingsPage';
import { ALL_TABS } from './partnerSettings/tabRegistry';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { user: { id: 'u-1', canManagePartnerWide: true }, tokens: null };
    return sel ? sel(state) : state;
  },
}));
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea aria-label="Rich text" data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));

import PartnerSecurityTab from './PartnerSecurityTab';
import PartnerNotificationsTab from './PartnerNotificationsTab';
import PartnerEventLogsTab from './PartnerEventLogsTab';
import PartnerDefaultsTab from './PartnerDefaultsTab';
import PartnerBrandingTab from './PartnerBrandingTab';
import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';

/**
 * #9168: every form control on the partner settings tabs must carry an
 * accessible name. A sibling `<label>` with no `htmlFor` (the old pattern on
 * these six tabs) names nothing — a screen reader announced the control by
 * role alone ("spin button", "combo box").
 *
 * Each tab is rendered with the data that reveals its conditional sections
 * (custom SMTP, event-log shipping, AI budgets), so the walk covers every
 * control the tab can show, not just the always-visible ones.
 */
const tabs: Array<[string, ReactElement]> = [
  [
    'Security',
    <PartnerSecurityTab
      data={{ minLength: 12, ipAllowlist: ['203.0.113.0/24'] }}
      onChange={vi.fn()}
      status={{ currentIp: '198.51.100.7', enforced: true, active: true } as never}
    />,
  ],
  ['Notifications', <PartnerNotificationsTab data={{ useCustomSmtp: true }} onChange={vi.fn()} />],
  ['Event Logs', <PartnerEventLogsTab data={{ enabled: true }} onChange={vi.fn()} />],
  ['Defaults', <PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />],
  ['Branding', <PartnerBrandingTab data={{}} onChange={vi.fn()} />],
  ['AI Budgets', <PartnerAiBudgetsTab data={{ enabled: true }} onChange={vi.fn()} />],
];

function describeControl(el: Element): string {
  const type = el.getAttribute('type');
  const testId = el.getAttribute('data-testid');
  return `<${el.tagName.toLowerCase()}${type ? ` type="${type}"` : ''}${testId ? ` data-testid="${testId}"` : ''}> in ${el.parentElement?.outerHTML.slice(0, 200)}`;
}

describe('partner settings tabs: every form control has an accessible name (#9168)', () => {
  it.each(tabs)('%s tab', (_name, ui) => {
    const { container } = render(ui);
    const controls = Array.from(container.querySelectorAll('input, select, textarea'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect.soft(control, `${describeControl(control)} has no accessible name`).toHaveAccessibleName();
    }
  });
});

// ---------------------------------------------------------------------------
// Page-level: every panel tab renders one h1, then an h2 naming the tab, and a
// strict heading ladder (#9787, spec §4.1). The shell owns the h2; child
// panels contribute h3s only.
// ---------------------------------------------------------------------------
const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {}, address: {} },
};
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: 'OK', json: async () => body }) as unknown as Response;

const panelTabs = ALL_TABS.filter(t => t.kind === 'panel');

describe('partner settings page: heading ladder and nesting on every panel (#9787)', () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(fetchWithAuth).mockReset();
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url === '/orgs/partners/me') return json(PARTNER);
      if (url === '/partner/sending-domains') {
        return json({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
      }
      if (url === '/orgs/partners/me/ip-allowlist/status') return json({ currentIp: '198.51.100.7', enforced: false, active: false });
      if (url === '/ai/models') {
        return json({ partner: { residencyRequired: false, plan: 'pro', hosted: false }, connections: [], offerings: [], defaults: [], catalog: [], catalogEnabled: false });
      }
      if (url === '/trust-page-template') {
        const none = { introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null, showHistory: null, hiddenControlIds: null, frameworkView: null };
        return json({ data: { template: null, revision: 0, defaults: { ...none, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [], frameworkView: ['nist_csf_2'] }, frameworkOptions: [{ framework: 'nist_csf_2', available: true, suggested: false }], canManage: true } });
      }
      return json({ data: [] });
    });
    vi.mocked(useOrgStore).mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
    void i18n.changeLanguage('en');
  });

  const mountTab = async (hash: string, label: string) => {
    window.location.hash = `#${hash}`;
    render(<PartnerSettingsPage />);
    await screen.findByTestId('partner-settings-panel-heading');
    await waitFor(() => expect(screen.getByTestId('partner-settings-panel-heading').textContent).toBe(label));
    // Let the panel's own fetches settle so the walk sees loaded content, not a spinner.
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  };

  it.each(panelTabs.map(t => [t.key, t.hash, t.label] as const))('heading order h1 → h2 → h3 for %s', async (_key, hash, labelKey) => {
    await mountTab(hash, i18n.t(labelKey, { ns: 'settings' }));
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const levels = headings.map(h => Number(h.tagName[1]));
    expect(levels.filter(l => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    expect(levels[1]).toBe(2);
    expect(headings[1].textContent).toBe(i18n.t(labelKey, { ns: 'settings' }));
    expect(levels.filter(l => l === 2)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i], `${headings[i].textContent} jumps a level`).toBeLessThanOrEqual(levels[i - 1] + 1);
    }
  });

  it.each(panelTabs.map(t => [t.key, t.hash, t.label] as const))('every control has an accessible name on %s', async (_key, hash, labelKey) => {
    await mountTab(hash, i18n.t(labelKey, { ns: 'settings' }));
    const controls = Array.from(document.querySelectorAll('main input, main select, main textarea, section input, section select, section textarea'));
    // callerVerification (form loads policy data) and emailTemplates (link list) expose no inputs under these fixtures.
    if (!['callerVerification', 'emailTemplates'].includes(_key)) expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect.soft(control, `${describeControl(control)} has no accessible name`).toHaveAccessibleName();
    }
  });

  it.each(panelTabs.map(t => [t.key, t.hash, t.label] as const))('no card inside a card on %s', async (_key, hash, labelKey) => {
    await mountTab(hash, i18n.t(labelKey, { ns: 'settings' }));
    const nested = Array.from(document.querySelectorAll('section .rounded-lg.border .rounded-lg.border')).filter(
      el => !el.closest('[role="radiogroup"]') && !el.closest('[data-list-row], [data-preview]'),
    );
    expect(nested.map(el => el.className)).toEqual([]);
  });
});
