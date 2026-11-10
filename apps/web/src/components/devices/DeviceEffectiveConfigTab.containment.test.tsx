import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import deDevices from '@/locales/de-DE/devices.json';
import dePolicies from '@/locales/de-DE/policies.json';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

const DE_CARD = deDevices.deviceEffectiveConfigTab.containment;
const DE_TAB = dePolicies.configurationPolicies.featureTabs.containmentTab;

const m =vi.hoisted(() => ({ body: {} as unknown }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => m.body })),
}));

const SOURCE = {
  featureType: 'containment',
  featurePolicyId: null,
  sourceLevel: 'organization',
  sourceTargetId: 'org-1',
  sourcePolicyId: 'pol-1',
  sourcePolicyName: 'Org Containment Policy',
  sourcePriority: 0,
};
const CHAIN = [
  { level: 'organization', targetId: 'org-1', policyId: 'pol-1', policyName: 'Org Containment Policy', priority: 0, featureTypes: ['containment'] },
];

function respondWith(inlineSettings: unknown) {
  m.body = { deviceId: 'dev-1', features: { containment: { ...SOURCE, inlineSettings } }, inheritanceChain: CHAIN };
}

const STORED = {
  version: 1,
  extraAllow: [
    { host: 'updates.example.com', proto: 'tcp', ports: [443, 8443], label: 'Vendor updates' },
    { cidr: '203.0.113.0/24', proto: 'udp+tcp', ports: [53], label: 'Branch DNS' },
  ],
  defaultTtlHours: 48,
};

describe('DeviceEffectiveConfigTab containment card (#11101)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders each extra destination and the policy it comes from', async () => {
    respondWith(STORED);
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const card = await screen.findByTestId('effective-config-containment-card');
    expect(within(card).getByText('Containment')).toBeInTheDocument();
    expect(within(card).getByText('Org Containment Policy')).toBeInTheDocument();

    const first = within(card).getByTestId('effective-config-containment-row-0');
    expect(first).toHaveTextContent('updates.example.com');
    expect(first).toHaveTextContent('TCP · 443, 8443 · Vendor updates');

    const second = within(card).getByTestId('effective-config-containment-row-1');
    expect(second).toHaveTextContent('203.0.113.0/24');
    expect(second).toHaveTextContent('TCP and UDP · 53 · Branch DNS');
    expect(within(card).queryByTestId('effective-config-containment-none')).toBeNull();
  });

  it('does not fall back to the raw key/value settings summary', async () => {
    respondWith(STORED);
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const card = await screen.findByTestId('effective-config-containment-card');
    expect(card.textContent).not.toMatch(/extra allow/i);
    expect(card.textContent).not.toMatch(/default ttl hours/i);
    expect(card.textContent).not.toMatch(/\bversion\b/i);
  });

  it.each([
    ['an empty list', { version: 1, extraAllow: [] }],
    ['no list at all', { version: 1 }],
  ])('shows the none state for %s', async (_name, settings) => {
    respondWith(settings);
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const card = await screen.findByTestId('effective-config-containment-card');
    expect(within(card).getByTestId('effective-config-containment-none')).toHaveTextContent(/No extra destinations/);
    expect(within(card).queryByTestId('effective-config-containment-row-0')).toBeNull();
  });

  // resolveContainmentPolicy fails closed on settings the schema refuses: the device gets no extras,
  // so the card must not list these rows as if they were in effect.
  it.each([
    ['a refused destination', { version: 1, extraAllow: [{ host: '*.example.com', proto: 'tcp', ports: [443], label: 'Bad' }] }],
    ['a missing version', { extraAllow: STORED.extraAllow }],
    ['null settings', null],
  ])('says the fixed defaults apply and lists no rows for %s', async (_name, settings) => {
    respondWith(settings);
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const card = await screen.findByTestId('effective-config-containment-card');
    expect(within(card).getByTestId('effective-config-containment-invalid')).toHaveTextContent(/fixed defaults/);
    expect(within(card).queryByTestId('effective-config-containment-row-0')).toBeNull();
    expect(within(card).queryByTestId('effective-config-containment-none')).toBeNull();
  });

  it('collapses an unassigned device into the not-enforced strip instead of a card', async () => {
    m.body = {
      deviceId: 'dev-1',
      features: {
        containment: { ...SOURCE, sourceLevel: 'default', sourcePolicyName: 'Breeze Defaults', inlineSettings: null },
        warranty: { ...SOURCE, featureType: 'warranty', inlineSettings: { enabled: true } },
      },
      inheritanceChain: [{ ...CHAIN[0], featureTypes: ['warranty'] }],
    };
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const strip = await screen.findByTestId('effective-config-not-enforced');
    expect(within(strip).getByText('Containment')).toBeInTheDocument();
    expect(screen.queryByTestId('effective-config-containment-card')).toBeNull();
  });

  it('names the feature in the inheritance chain', async () => {
    respondWith(STORED);
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    await screen.findByTestId('effective-config-containment-card');
    expect(screen.getByTestId('chain-feature-contributed')).toHaveTextContent('Containment');
  });

  it('renders translated copy in a non-English locale (no raw keys, no English leftovers)', async () => {
    const { i18n, loadLocale } = await import('@/lib/i18n');
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');
    try {
      respondWith(STORED);
      const { unmount } = render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
      const card = await screen.findByTestId('effective-config-containment-card');
      expect(card.textContent).not.toMatch(/containmentTab\.|deviceEffectiveConfigTab\./);
      expect(card.textContent).not.toMatch(/Extra destinations/);
      expect(within(card).getByText(DE_TAB.title)).toBeInTheDocument();
      expect(within(card).getByText(DE_CARD.extraDestinations)).toBeInTheDocument();
      expect(within(card).getByTestId('effective-config-containment-row-1')).toHaveTextContent(DE_TAB.protoBoth);
      unmount();

      respondWith({ version: 1, extraAllow: [] });
      const none = render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
      expect(await screen.findByTestId('effective-config-containment-none')).toHaveTextContent(DE_TAB.empty);
      none.unmount();

      respondWith(null);
      render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
      expect(await screen.findByTestId('effective-config-containment-invalid')).toHaveTextContent(DE_CARD.invalid);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
