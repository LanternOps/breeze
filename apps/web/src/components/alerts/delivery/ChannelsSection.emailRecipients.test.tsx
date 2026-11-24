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
  name: 'On-call email',
  type: 'email',
  enabled: true,
  config: { recipients: ['ops@example.com'] },
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
};

// #12148 — the form validates trimmed rows, so the payload must carry the same
// trimmed list; otherwise a spaces-only row passes the form and the API 400s.
describe('ChannelsSection email recipients', () => {
  it('sends trimmed recipients and drops spaces-only rows', async () => {
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
    fireEvent.change(screen.getByDisplayValue('ops@example.com'), { target: { value: ' ops@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: /add recipient/i }));
    fireEvent.change(screen.getAllByPlaceholderText('email@example.com')[1]!, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(runChannelSave).toHaveBeenCalledTimes(1));
    expect(runChannelSave.mock.calls[0]![0].payload.config.recipients).toEqual(['ops@example.com']);
  });
});
