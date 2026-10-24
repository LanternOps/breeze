import { fireEvent, render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import AlertDetails from './AlertDetails';
import type { Alert } from './AlertList';

const alert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 't-1', internalNumber: 'TKT-42', subject: 'CPU high', status: 'open', ...over,
});

beforeEach(() => {
  h.granted.clear();
  h.granted.add('tickets:write');
});

describe('AlertDetails create-ticket flow (#9624)', () => {
  it.each(['off', 'external', undefined])('hides Create ticket when Service Management mode is %s', (mode) => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode={mode as never} />);
    expect(screen.queryByTestId('alert-create-ticket-button')).toBeNull();
  });

  it('opens the create dialog instead of POSTing immediately in native mode', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode="native" linkedTickets={[]} />);
    fireEvent.click(screen.getByTestId('alert-create-ticket-button'));
    expect(screen.getByTestId('alert-ticket-dialog')).toBeInTheDocument();
  });

  it('links to the existing open ticket instead of offering a duplicate', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode="native" linkedTickets={[ticket()]} />);
    expect(screen.queryByTestId('alert-create-ticket-button')).toBeNull();
    expect(screen.getByTestId('alert-view-ticket')).toHaveAttribute('href', '/tickets#TKT-42');
  });

  it('still offers Create ticket when the only linked ticket is closed', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode="native" linkedTickets={[ticket({ status: 'closed' })]} />);
    expect(screen.getByTestId('alert-create-ticket-button')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-view-ticket')).toBeNull();
  });

  it('shows the duplicate-check-failed warning in the dialog when the lookup failed', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode="native" linkedTicketsFailed />);
    fireEvent.click(screen.getByTestId('alert-create-ticket-button'));
    expect(screen.getByTestId('alert-ticket-duplicate-check-failed')).toBeInTheDocument();
  });

  it('keeps the permission gate in native mode', () => {
    h.granted.clear();
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} serviceManagementMode="native" linkedTickets={[]} />);
    expect(screen.queryByTestId('alert-create-ticket-button')).toBeNull();
  });
});

describe('AlertDetails history sections (#9623)', () => {
  const notif = { id: 'n-1', channelType: 'slack' as const, channelName: 'Ops Slack', sentAt: '2026-08-24T16:01:00Z', status: 'failed' as const, errorMessage: 'channel_not_found' };

  it('renders Notifications Sent with the delivery error', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} notificationHistory={[notif]} />);
    expect(screen.getByText('Notifications Sent')).toBeInTheDocument();
    expect(screen.getByText('Ops Slack')).toBeInTheDocument();
    expect(screen.getByText('channel_not_found')).toBeInTheDocument();
  });

  it('omits both sections when there is nothing to show', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
    expect(screen.queryByText('Notifications Sent')).toBeNull();
    expect(screen.queryByText('Status History')).toBeNull();
  });
});
