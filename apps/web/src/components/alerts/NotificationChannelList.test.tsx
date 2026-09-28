import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotificationChannelList from './NotificationChannelList';

describe('NotificationChannelList filter select accessible name (#7156)', () => {
  it('gives the channel-type filter select a real accessible name', () => {
    render(<NotificationChannelList channels={[]} />);
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
  });
});
