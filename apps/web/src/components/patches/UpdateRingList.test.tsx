import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';

import UpdateRingList, { type UpdateRingItem } from './UpdateRingList';

function makeRing(overrides: Partial<UpdateRingItem> = {}): UpdateRingItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Ring A',
    enabled: true,
    ringOrder: 1,
    deferralDays: 0,
    deadlineDays: null,
    gracePeriodHours: 4,
    ...overrides,
  };
}

describe('UpdateRingList auto-approve column', () => {
  it('summarizes auto-approve as badges: OS severities, third-party, or Manual', () => {
    const ringA = makeRing({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'Ring A',
      autoApprove: {
        enabled: true,
        severities: ['critical', 'important'],
        deferralDays: 0,
        thirdPartyApps: true,
        thirdPartyDeferralDays: null,
      },
    });
    const ringB = makeRing({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      name: 'Ring B',
      ringOrder: 2,
      autoApprove: {
        enabled: false,
        severities: ['critical'],
        deferralDays: 0,
        thirdPartyApps: true,
        thirdPartyDeferralDays: null,
      },
    });
    const ringC = makeRing({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      name: 'Ring C',
      ringOrder: 3,
      autoApprove: {
        enabled: true,
        severities: [],
        deferralDays: 0,
        thirdPartyApps: true,
        thirdPartyDeferralDays: 3,
      },
    });

    render(<UpdateRingList rings={[ringA, ringB, ringC]} />);

    // Ring A: OS severities badge + third-party badge.
    const osBadge = screen.getByTestId(`ring-badge-os-${ringA.id}`);
    expect(osBadge.textContent).toContain('Critical');
    expect(osBadge.textContent).toContain('Important');
    expect(screen.getByTestId(`ring-badge-third-party-${ringA.id}`)).toBeTruthy();

    // Ring B: auto-approve disabled → no badges, Manual label instead.
    expect(screen.queryByTestId(`ring-badge-os-${ringB.id}`)).toBeNull();
    expect(screen.queryByTestId(`ring-badge-third-party-${ringB.id}`)).toBeNull();
    const rowB = screen.getByText('Ring B').closest('tr');
    expect(rowB).not.toBeNull();
    expect(within(rowB as HTMLElement).getByText('Manual')).toBeTruthy();

    // Ring C: third-party only — an empty severity list means no OS badge.
    expect(screen.queryByTestId(`ring-badge-os-${ringC.id}`)).toBeNull();
    expect(screen.getByTestId(`ring-badge-third-party-${ringC.id}`)).toBeTruthy();
  });

  it('renders the auto-approve header column', () => {
    render(<UpdateRingList rings={[]} />);

    expect(screen.getByRole('columnheader', { name: 'Auto-approve' })).toBeTruthy();
    // Empty state must span every column, including the new one.
    expect(screen.getByText('No update rings found.').getAttribute('colspan')).toBe('9');
  });
});

describe('UpdateRingList application-rules badge (#8187)', () => {
  it('shows the rule count when a ring carries application rules, and nothing otherwise', () => {
    render(
      <UpdateRingList
        rings={[
          makeRing({
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: 'Ring A',
            appRules: [
              { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
              { source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' },
            ],
          }),
          makeRing({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Ring B', ringOrder: 2, appRules: [] }),
        ]}
      />
    );
    const badges = screen.getAllByTestId('ring-app-rules-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('2 app rules');
    const rowA = screen.getByText('Ring A').closest('tr')!;
    expect(within(rowA).getByTestId('ring-app-rules-badge')).toBeInTheDocument();
  });
});
