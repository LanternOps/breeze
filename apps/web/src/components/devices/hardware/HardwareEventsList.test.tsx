import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HardwareEventsList from './HardwareEventsList';
import type { HardwareEventView } from './types';
const event: HardwareEventView = {
  id: '44444444-4444-4444-8444-444444444444', deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333', componentKey: 'storcli:c0:e1:s3',
  componentType: 'physical_disk', eventType: 'state_changed',
  fromHealth: 'ok', toHealth: 'critical', fromState: 'online', toState: 'failed',
  detail: { serial: 'DISK-3' }, snapshotId: null,
  occurredAt: '2026-09-23T12:00:00Z', createdAt: '2026-09-23T12:00:01Z',
};
describe('HardwareEventsList', () => {
  it('starts collapsed and exposes the transition and scalar details', () => {
    render(<HardwareEventsList events={[event]} />);
    expect(screen.getByTestId('hardware-events-list')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('hardware-events-toggle'));
    expect(screen.getByTestId('hardware-events-list')).toHaveAttribute('open');
    expect(screen.getByTestId(`hardware-event-${event.id}`)).toHaveTextContent('online → failed');
    expect(screen.getByTestId(`hardware-event-${event.id}`)).toHaveTextContent('ok → critical');
    expect(screen.getByText(/DISK-3/)).toBeInTheDocument();
  });
  it('explains an empty history', () => {
    render(<HardwareEventsList events={[]} />);
    fireEvent.click(screen.getByTestId('hardware-events-toggle'));
    expect(screen.getByText('No hardware events recorded.')).toBeVisible();
  });
});
