import { render, screen, fireEvent } from '@testing-library/react';
import '../../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationChannel } from '../NotificationChannelList';

vi.mock('./deliveryActions', () => ({
  runChannelSave: vi.fn(),
  runChannelDelete: vi.fn(),
  runChannelTest: vi.fn(),
  fetchChannelRoutingImpact: vi.fn(),
}));

import ChannelsSection from './ChannelsSection';
import { fetchChannelRoutingImpact } from './deliveryActions';

const channel: NotificationChannel = {
  id: 'ch-1',
  name: 'NOC webhook',
  type: 'webhook',
  enabled: true,
  config: { url: 'https://example.com/hook', method: 'POST' },
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
};
const rule = (id: string, name: string, isDefault = false) => ({ id, name, isDefault });

function openDeleteConfirm() {
  render(
    <ChannelsSection
      channels={[channel]}
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
  beforeEach(() => vi.mocked(fetchChannelRoutingImpact).mockReset());

  it('names the rules the delete leaves with no channels apart from the rules that only lose this channel', async () => {
    vi.mocked(fetchChannelRoutingImpact).mockResolvedValue({
      emptied: [rule('r-1', 'Critical to NOC'), rule('d', 'Everything else', true)],
      reduced: [rule('r-2', 'Disk alerts')],
    });
    openDeleteConfirm();
    expect(fetchChannelRoutingImpact).toHaveBeenCalledWith('ch-1');
    expect(await screen.findByTestId('channel-delete-emptied-rules')).toHaveTextContent('Leaves 2 routing rules with no channels: Critical to NOC, Everything else');
    expect(screen.getByTestId('channel-delete-reduced-rules')).toHaveTextContent('Also removed from 1 routing rule: Disk alerts');
  });

  it('uses the singular form and omits an empty group', async () => {
    vi.mocked(fetchChannelRoutingImpact).mockResolvedValue({ emptied: [rule('r-1', 'Critical to NOC')], reduced: [] });
    openDeleteConfirm();
    expect(await screen.findByTestId('channel-delete-emptied-rules')).toHaveTextContent('Leaves 1 routing rule with no channels: Critical to NOC');
    expect(screen.queryByTestId('channel-delete-reduced-rules')).toBeNull();
  });

  it('adds nothing when the delete changes no routing rule or the check fails', async () => {
    vi.mocked(fetchChannelRoutingImpact).mockResolvedValue(null);
    openDeleteConfirm();
    expect(screen.getByText(/Alerts routed only to it will stop being delivered/)).toBeInTheDocument();
    await Promise.resolve();
    expect(screen.queryByTestId('channel-delete-emptied-rules')).toBeNull();
    expect(screen.queryByTestId('channel-delete-reduced-rules')).toBeNull();
  });
});
