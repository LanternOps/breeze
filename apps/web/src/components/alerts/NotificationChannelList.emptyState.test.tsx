import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';

function channel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'ch-1',
    name: 'QA Channel',
    type: 'email',
    enabled: true,
    config: {},
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

// #3992 — a tenant with no channels was told to "try adjusting your search or
// filters" when it had never searched. "No results" and "nothing exists yet"
// are different states and need different copy.
describe('NotificationChannelList — zero-data vs no-search-results', () => {
  it('offers the create action when there are no channels and no search', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelList channels={[]} onCreate={onCreate} />);

    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
    // Assert the SENTENCE, not just the absence of the old one.
    expect(screen.getByText(/no notification channels yet/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /new channel/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('omits the create button when no handler is supplied', () => {
    render(<NotificationChannelList channels={[]} />);

    expect(screen.queryByRole('button', { name: /new channel/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
  });

  it('still says "adjust your search" when a search matched nothing', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelList channels={[channel()]} onCreate={onCreate} />);

    // The channel renders first, so this proves the search is what emptied it.
    expect(screen.getByText('QA Channel')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'zzzznomatch');

    expect(screen.getByText(/adjusting your search/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new channel/i })).not.toBeInTheDocument();
  });
});
