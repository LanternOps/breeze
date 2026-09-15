import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import DeviceActivityFeed from './DeviceActivityFeed';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function feed(details?: Record<string, string>) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => ({
    ok: true, status: 200, json: async () => ({ data: url.includes('/events') ? [{
      id: 'event-1', action: 'script.run', message: 'Restarted service', result: 'success',
      initiatedBy: 'ai_agent', actor: { type: 'user', name: 'Ada' },
      timestamp: new Date().toISOString(), details,
    }] : [], pagination: { page: 1, limit: 10, total: null } }),
  }) as Response);
  render(<DeviceActivityFeed deviceId="device-1" />);
}
it('renders the translated trigger chip with the key as a tooltip beside the initiator', async () => {
  feed({ triggerKind: 'sweep_finding', triggerKey: 'sweep:service_down:MSSQLSERVER' });
  const chip = await screen.findByText('Sweep finding');
  expect(chip).toHaveAttribute('title', 'sweep:service_down:MSSQLSERVER');
  expect(chip).toHaveClass('rounded-full', 'uppercase', 'tracking-wide');
  expect(screen.queryByText('sweep:service_down:MSSQLSERVER')).not.toBeInTheDocument();
});
it('omits the chip for historical activity without a trigger', async () => {
  feed();
  await screen.findByText('Restarted service');
  expect(screen.queryByText('Sweep finding')).not.toBeInTheDocument();
  expect(screen.queryByText('Unknown trigger')).not.toBeInTheDocument();
});
it('shows an unknown future trigger kind verbatim', async () => {
  feed({ triggerKind: 'future_cause' });
  expect(await screen.findByText('future_cause')).toBeInTheDocument();
});
