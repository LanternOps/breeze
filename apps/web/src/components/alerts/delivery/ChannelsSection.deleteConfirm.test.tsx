import { render, screen, fireEvent } from '@testing-library/react';
import '../../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import type { NotificationChannel } from '../NotificationChannelList';
import type { RoutingRule } from './deliveryActions';

vi.mock('./deliveryActions', () => ({
  runChannelSave: vi.fn(),
  runChannelDelete: vi.fn(),
  runChannelTest: vi.fn(),
}));

import ChannelsSection from './ChannelsSection';

const channel: NotificationChannel = {
  id: 'ch-1',
  name: 'NOC webhook',
  type: 'webhook',
  enabled: true,
  config: { url: 'https://example.com/hook', method: 'POST' },
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
};
const rule = (id: string, name: string, channelIds: string[], isDefault = false): RoutingRule => ({
  id, name, channelIds, isDefault, orgId: 'org-1', partnerId: null, priority: 10, conditions: {}, escalationPolicyId: null, enabled: true,
});

function openDeleteConfirm(routingRules: RoutingRule[]) {
  render(
    <ChannelsSection
      channels={[channel]}
      routingRules={routingRules}
      currentOrgId="org-1"
      isPartnerScope={false}
      defaultOwnerScope="organization"
      onChanged={async () => {}}
      onUnauthorized={() => {}}
    />
  );
  fireEvent.click(screen.getByTitle('Delete channel'));
}

describe('ChannelsSection delete confirm (#12002)', () => {
  it('names the routing rules that send to the channel', () => {
    openDeleteConfirm([
      rule('r-1', 'Critical to NOC', ['ch-1']),
      rule('r-2', 'Other', ['ch-2']),
      rule('r-3', 'Everything else', ['ch-2', 'ch-1'], true),
    ]);
    expect(screen.getByTestId('channel-delete-routing-usage')).toHaveTextContent('Used by 2 routing rules: Critical to NOC, Everything else');
  });

  it('uses the singular form for one rule', () => {
    openDeleteConfirm([rule('r-1', 'Critical to NOC', ['ch-1'])]);
    expect(screen.getByTestId('channel-delete-routing-usage')).toHaveTextContent('Used by 1 routing rule: Critical to NOC');
  });

  it('adds nothing when no routing rule sends to the channel', () => {
    openDeleteConfirm([rule('r-2', 'Other', ['ch-2'])]);
    expect(screen.getByText(/Alerts routed only to it will stop being delivered/)).toBeInTheDocument();
    expect(screen.queryByTestId('channel-delete-routing-usage')).toBeNull();
  });
});
