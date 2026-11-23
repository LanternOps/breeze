import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';
import { FEATURE_META } from '../configurationPolicies/featureTabs/types';

// #9565 — demo-video QA papercuts:
//  (1) a card's settings summary followed JSONB key order, so the Maintenance
//      card showed "Timezone / Recurrence / Notify On End / Window Start" and
//      never the duration. Summaries now pick the fields that describe each
//      feature, falling back to key order for features without a pick list.
//  (2) the Inheritance Chain listed every feature a policy links, including
//      ones a closer policy won, and gave no hint that level (not priority)
//      decided between two priority-0 rows.

const response = {
  deviceId: 'dev-9565',
  features: {
    maintenance: {
      featureType: 'maintenance',
      featurePolicyId: null,
      // Key order deliberately matches what the API returned in the demo:
      // the meaningful fields are NOT first.
      inlineSettings: {
        timezone: 'America/Denver',
        recurrence: 'weekly',
        notifyOnEnd: true,
        notifyOnStart: true,
        suppressAlerts: true,
        windowStart: '18:00',
        durationHours: 3,
        // #9574: the day rides on the recurrence line, so a Saturday and a
        // Sunday window no longer summarize identically.
        dayOfWeek: 'sat',
        dayOfMonth: 1,
      },
      sourceLevel: 'organization',
      sourceTargetId: 'org-1',
      sourcePolicyId: 'pol-org',
      sourcePolicyName: 'Org Override',
      sourcePriority: 0,
    },
    warranty: {
      featureType: 'warranty',
      featurePolicyId: null,
      inlineSettings: { enabled: true },
      sourceLevel: 'partner',
      sourceTargetId: 'partner-1',
      sourcePolicyId: 'pol-partner',
      sourcePolicyName: 'MSP Baseline',
      sourcePriority: 0,
    },
    // A feature with no curated pick list keeps the key-order fallback.
    helper: {
      featureType: 'helper',
      featurePolicyId: null,
      inlineSettings: { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd', epsilon: 'e' },
      sourceLevel: 'organization',
      sourceTargetId: 'org-1',
      sourcePolicyId: 'pol-org',
      sourcePolicyName: 'Org Override',
      sourcePriority: 0,
    },
  },
  inheritanceChain: [
    { level: 'organization', targetId: 'org-1', policyId: 'pol-org', policyName: 'Org Override', priority: 0, featureTypes: ['maintenance', 'helper'] },
    // The partner policy links maintenance too, but the org override won it.
    { level: 'partner', targetId: 'partner-1', policyId: 'pol-partner', policyName: 'MSP Baseline', priority: 0, featureTypes: ['maintenance', 'warranty'] },
  ],
  // #12306: who owns each policy, so the tab links only what the caller can open.
  policyOwners: { 'pol-org': 'organization', 'pol-partner': 'partner' },
};

// The response each render reads; a test may swap it before rendering.
let currentResponse: unknown = response;
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => currentResponse })),
}));

// Partner scope by default (every policy openable); a test switches to an
// organization-scope caller to check the MSP-managed winner is not linked.
const { claimsRef } = vi.hoisted(() => ({
  claimsRef: {
    current: { scope: 'partner', partnerId: 'partner-1', orgId: null } as {
      scope: 'partner' | 'organization';
      partnerId: string | null;
      orgId: string | null;
    },
  },
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: claimsRef.current }),
  getJwtClaims: () => claimsRef.current,
}));

function summaryLines(cardHeading: string): string[] {
  const heading = screen.getByRole('heading', { level: 4, name: cardHeading });
  const card = heading.closest('div.rounded-lg') as HTMLElement;
  return within(card)
    .getAllByRole('listitem')
    .map((li) => (li.textContent ?? '').toLowerCase());
}

describe('DeviceEffectiveConfigTab per-feature summary (#9565)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('summarizes Maintenance by start, duration, recurrence and timezone', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Maintenance' });
    const lines = summaryLines('Maintenance');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/window start: 18:00/);
    expect(lines[1]).toMatch(/duration hours: 3/);
    expect(lines[2]).toMatch(/recurrence: weekly on sat$/);
    expect(lines[3]).toMatch(/timezone: america\/denver/);
    expect(lines.join('|')).not.toMatch(/notify on end/);
    expect(lines.join('|')).not.toMatch(/day of (week|month)/);
  });

  it('falls back to key order for a feature without a curated summary', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Breeze Assist' });
    const lines = summaryLines('Breeze Assist');
    expect(lines.map((l) => l.split(':')[0])).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });
});

describe('DeviceEffectiveConfigTab inheritance chain contributions (#9565)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentResponse = response;
  });

  function chainRow(policyName: string): HTMLElement {
    // The card names the same policy, so pick the link inside the chain table.
    const link = screen.getAllByRole('link', { name: policyName }).find((el) => el.closest('tr'));
    return link!.closest('tr') as HTMLElement;
  }

  it('marks a feature a closer policy won as overridden, not contributed', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { name: 'Precedence' });

    const partnerRow = chainRow('MSP Baseline');
    const contributed = within(partnerRow).getAllByTestId('chain-feature-contributed');
    const overridden = within(partnerRow).getAllByTestId('chain-feature-overridden');
    expect(contributed.map((el) => el.textContent)).toEqual(['Warranty']);
    expect(overridden.map((el) => el.textContent)).toEqual(['Maintenance']);
    // The overridden chip says who won, so the grey-out is explained.
    expect(overridden[0]).toHaveAttribute('title', expect.stringContaining('Org Override'));

    const orgRow = chainRow('Org Override');
    expect(within(orgRow).queryAllByTestId('chain-feature-overridden')).toHaveLength(0);
    expect(within(orgRow).getAllByTestId('chain-feature-contributed').map((el) => el.textContent)).toEqual([
      'Maintenance',
      'Breeze Assist',
    ]);
  });

});

describe('DeviceEffectiveConfigTab precedence: winner link, level and why others lost (#12306)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentResponse = response;
    claimsRef.current = { scope: 'partner', partnerId: 'partner-1', orgId: null };
  });

  function card(heading: string): HTMLElement {
    return screen.getByRole('heading', { level: 4, name: heading }).closest('div.rounded-lg') as HTMLElement;
  }
  function chainRowByText(policyName: string): HTMLElement {
    const cell = screen.getAllByText(policyName).find((el) => el.closest('tr'));
    return cell!.closest('tr') as HTMLElement;
  }

  it('the winning policy is a link for a partner-scope caller', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Warranty' });
    const link = within(card('Warranty')).getByTestId('effective-config-winner-link');
    expect(link).toHaveAttribute('href', '/configuration-policies/pol-partner');
    expect(link).toHaveTextContent('MSP Baseline');
  });

  it('an org-scope caller sees no link to an MSP-managed winner', async () => {
    claimsRef.current = { scope: 'organization', partnerId: null, orgId: 'org-1' };
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Warranty' });
    const warranty = card('Warranty');
    expect(within(warranty).queryByTestId('effective-config-winner-link')).toBeNull();
    expect(warranty).toHaveTextContent('MSP Baseline');
    expect(warranty).toHaveTextContent('Managed by your MSP');
    // Its own organization's policy still links.
    expect(within(card('Maintenance')).getByTestId('effective-config-winner-link')).toHaveAttribute(
      'href',
      '/configuration-policies/pol-org',
    );
    // The chain rows follow the same rule.
    expect(within(chainRowByText('MSP Baseline')).queryByRole('link')).toBeNull();
    expect(within(chainRowByText('Org Override')).getByRole('link', { name: 'Org Override' })).toBeTruthy();
  });

  it('does not link when the API names no owner for the policy', async () => {
    claimsRef.current = { scope: 'organization', partnerId: null, orgId: 'org-1' };
    const { policyOwners: _omit, ...legacy } = response;
    currentResponse = legacy;
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Maintenance' });
    expect(screen.queryAllByTestId('effective-config-winner-link')).toHaveLength(0);
  });

  it('the card states the level the feature arrived through', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Maintenance' });
    expect(within(card('Maintenance')).getByTestId('effective-config-winner-level')).toHaveTextContent(
      'via Organization',
    );
    expect(within(card('Warranty')).getByTestId('effective-config-winner-level')).toHaveTextContent(
      'via All organizations',
    );
  });

  it('a row that lost on level says more specific level', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { name: 'Precedence' });
    const reason = within(chainRowByText('MSP Baseline')).getByTestId('chain-row-lost-reason');
    expect(reason).toHaveTextContent('Replaced for Maintenance by Org Override');
    expect(reason).toHaveTextContent(/more specific level/i);
    expect(within(chainRowByText('Org Override')).queryByTestId('chain-row-lost-reason')).toBeNull();
  });

  const sameLevel = (loserPriority: number) => ({
    deviceId: 'dev-tie',
    features: {
      patch: {
        featureType: 'patch',
        featurePolicyId: null,
        inlineSettings: { scheduleFrequency: 'weekly' },
        sourceLevel: 'site',
        sourceTargetId: 'site-1',
        sourcePolicyId: 'pol-a',
        sourcePolicyName: 'Site A',
        sourcePriority: 1,
      },
    },
    inheritanceChain: [
      { level: 'site', targetId: 'site-1', policyId: 'pol-a', policyName: 'Site A', priority: 1, featureTypes: ['patch'] },
      { level: 'site', targetId: 'site-1', policyId: 'pol-b', policyName: 'Site B', priority: loserPriority, featureTypes: ['patch'] },
    ],
    policyOwners: { 'pol-a': 'organization', 'pol-b': 'organization' },
  });

  it('a row that lost on priority at the same level says lower priority number', async () => {
    currentResponse = sameLevel(5);
    render(<DeviceEffectiveConfigTab deviceId="dev-tie" />);
    await screen.findByRole('heading', { name: 'Precedence' });
    const reason = within(chainRowByText('Site B')).getByTestId('chain-row-lost-reason');
    expect(reason).toHaveTextContent('Replaced for Patches by Site A');
    expect(reason).toHaveTextContent(/lower priority number/i);
  });

  it('a tie on level and priority says assigned earlier', async () => {
    currentResponse = sameLevel(1);
    render(<DeviceEffectiveConfigTab deviceId="dev-tie" />);
    await screen.findByRole('heading', { name: 'Precedence' });
    expect(within(chainRowByText('Site B')).getByTestId('chain-row-lost-reason')).toHaveTextContent(
      /assigned earlier/i,
    );
  });

  it('chain heading reads Precedence and shows the legend', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { name: 'Precedence' });
    expect(screen.queryByRole('heading', { name: 'Inheritance Chain' })).toBeNull();
    expect(screen.getByTestId('precedence-legend')).toHaveTextContent(
      'Most specific wins, per feature: Device › Device group › Site › Organization › All organizations. A closer policy replaces the whole feature; it does not merge.',
    );
  });

  it("card labels match the editor's labels", async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: FEATURE_META.maintenance.label });
    expect(screen.getByRole('heading', { level: 4, name: FEATURE_META.warranty.label })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: FEATURE_META.helper.label })).toBeTruthy();
  });

  it('names the parent a feature came from as Based on', async () => {
    currentResponse = {
      ...response,
      features: {
        ...response.features,
        warranty: { ...response.features.warranty, inheritedFromPolicyId: 'pol-parent', inheritedFromPolicyName: 'Standard' },
      },
    };
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    expect(await screen.findByTestId('effective-config-inherited-from')).toHaveTextContent('Based on Standard');
  });

  it('never links the Breeze Defaults layer, even for a partner-scope caller', async () => {
    // Hardware collection is enforced from Breeze Defaults, so its card renders
    // with the sentinel as its "policy"; there is no page to open.
    currentResponse = {
      ...response,
      features: {
        ...response.features,
        hardware_monitoring: {
          featureType: 'hardware_monitoring',
          featurePolicyId: null,
          inlineSettings: null,
          sourceLevel: 'default',
          sourceTargetId: 'breeze-defaults',
          sourcePolicyId: 'breeze-defaults',
          sourcePolicyName: 'Breeze Defaults',
          sourcePriority: 0,
        },
      },
    };
    const { container } = render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Hardware Monitoring' });
    expect(within(card('Hardware Monitoring')).queryByTestId('effective-config-winner-link')).toBeNull();
    expect(container.querySelector('a[href="/configuration-policies/breeze-defaults"]')).toBeNull();
  });
});
