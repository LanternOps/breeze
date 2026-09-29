import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import type { NotificationChannel } from '../NotificationChannelList';

const runChannelSave = vi.fn();
vi.mock('./deliveryActions', () => ({
  runChannelSave: (...args: unknown[]) => runChannelSave(...args),
  runChannelDelete: vi.fn(),
  runChannelTest: vi.fn(),
}));

import ChannelsSection from './ChannelsSection';

const channel: NotificationChannel = {
  id: 'ch-1',
  name: 'Old name',
  type: 'webhook',
  enabled: true,
  config: { url: 'https://example.com/hook', method: 'POST' },
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
};

describe('ChannelsSection rename', () => {
  it('passes the submitted (new) name to the save action so the toast names it', async () => {
    runChannelSave.mockReset();
    runChannelSave.mockResolvedValue(undefined);
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
    fireEvent.click(screen.getByTitle(/edit/i));
    fireEvent.change(screen.getByDisplayValue('Old name'), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(runChannelSave).toHaveBeenCalledTimes(1));
    expect(runChannelSave.mock.calls[0]![0].channelName).toBe('New name');
  });
});
