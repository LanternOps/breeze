import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

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
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => response })),
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
    await screen.findByRole('heading', { level: 4, name: 'Maintenance Windows' });
    const lines = summaryLines('Maintenance Windows');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/window start: 18:00/);
    expect(lines[1]).toMatch(/duration hours: 3/);
    expect(lines[2]).toMatch(/recurrence: weekly/);
    expect(lines[3]).toMatch(/timezone: america\/denver/);
    expect(lines.join('|')).not.toMatch(/notify on end/);
  });

  it('falls back to key order for a feature without a curated summary', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { level: 4, name: 'Breeze Assist' });
    const lines = summaryLines('Breeze Assist');
    expect(lines.map((l) => l.split(':')[0])).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });
});

describe('DeviceEffectiveConfigTab inheritance chain contributions (#9565)', () => {
  beforeEach(() => vi.clearAllMocks());

  function chainRow(policyName: string): HTMLElement {
    return screen.getByRole('link', { name: policyName }).closest('tr') as HTMLElement;
  }

  it('marks a feature a closer policy won as overridden, not contributed', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { name: 'Inheritance Chain' });

    const partnerRow = chainRow('MSP Baseline');
    const contributed = within(partnerRow).getAllByTestId('chain-feature-contributed');
    const overridden = within(partnerRow).getAllByTestId('chain-feature-overridden');
    expect(contributed.map((el) => el.textContent)).toEqual(['Warranty']);
    expect(overridden.map((el) => el.textContent)).toEqual(['Maintenance Windows']);
    // The overridden chip says who won, so the grey-out is explained.
    expect(overridden[0]).toHaveAttribute('title', expect.stringContaining('Org Override'));

    const orgRow = chainRow('Org Override');
    expect(within(orgRow).queryAllByTestId('chain-feature-overridden')).toHaveLength(0);
    expect(within(orgRow).getAllByTestId('chain-feature-contributed').map((el) => el.textContent)).toEqual([
      'Maintenance Windows',
      'Breeze Assist',
    ]);
  });

  it('explains that level decides first and priority only breaks ties within a level', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-9565" />);
    await screen.findByRole('heading', { name: 'Inheritance Chain' });
    expect(screen.getByTestId('inheritance-chain-rule')).toHaveTextContent(
      /level decides first.*priority.*same level/i,
    );
  });
});
