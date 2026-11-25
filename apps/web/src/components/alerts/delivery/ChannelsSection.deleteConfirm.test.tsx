import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('keeps Delete disabled until the routing check answers', async () => {
    let answer!: (value: { emptied: never[]; reduced: never[] }) => void;
    vi.mocked(fetchChannelRoutingImpact).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    openDeleteConfirm();
    expect(screen.getByTestId('channel-delete-confirm')).toBeDisabled();
    answer({ emptied: [], reduced: [] });
    await waitFor(() => expect(screen.getByTestId('channel-delete-confirm')).toBeEnabled());
    expect(screen.queryByTestId('channel-delete-emptied-rules')).toBeNull();
    expect(screen.queryByTestId('channel-delete-reduced-rules')).toBeNull();
    expect(screen.queryByTestId('channel-delete-impact-failed')).toBeNull();
  });

  it('says the routing rules could not be checked when the check fails, then allows Delete', async () => {
    vi.mocked(fetchChannelRoutingImpact).mockResolvedValue(null);
    openDeleteConfirm();
    expect(await screen.findByTestId('channel-delete-impact-failed')).toHaveTextContent('Could not check which routing rules use this channel');
    expect(screen.getByTestId('channel-delete-confirm')).toBeEnabled();
    expect(screen.queryByTestId('channel-delete-emptied-rules')).toBeNull();
  });
});
