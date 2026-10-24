import { fireEvent, render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import AlertList, { type Alert } from './AlertList';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const mk = (id: string, severity: Alert['severity'], status: Alert['status'] = 'active'): Alert => ({
  id,
  title: `alert-${id}`,
  message: 'm',
  severity,
  status,
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-07-17T00:00:00Z',
  orgId: 'org-1',
  orgName: 'Acme',
});

const alerts = [
  mk('c', 'critical'),
  mk('h', 'high'),
  mk('m', 'medium'),
  mk('l', 'low'),
  mk('c-ack', 'critical', 'acknowledged'),
];

describe('AlertList multi-value severity filter (#6721)', () => {
  it('initialSeverity [critical, high] filters the row set to both severities', () => {
    render(<AlertList alerts={alerts} initialSeverity={['critical', 'high']} />);
    expect(screen.getByText('alert-c')).toBeTruthy();
    expect(screen.getByText('alert-h')).toBeTruthy();
    expect(screen.queryByText('alert-m')).toBeNull();
    expect(screen.queryByText('alert-l')).toBeNull();
  });

  it('shows a chip for every selected severity', () => {
    render(<AlertList alerts={alerts} initialSeverity={['critical', 'high']} />);
    expect(screen.getByTestId('alert-severity-chip-critical')).toBeTruthy();
    expect(screen.getByTestId('alert-severity-chip-high')).toBeTruthy();
    expect(screen.queryByTestId('alert-severity-chip-medium')).toBeNull();
  });

  it('initialStatus=active hides non-active rows and the footer count follows', () => {
    render(<AlertList alerts={alerts} initialStatus="active" initialSeverity={['critical']} />);
    expect(screen.getByText('alert-c')).toBeTruthy();
    expect(screen.queryByText('alert-c-ack')).toBeNull();
    expect(screen.getByText(/^1 of 5$/)).toBeTruthy();
  });

  it('removing a chip drops that severity from the filter', () => {
    render(<AlertList alerts={alerts} initialSeverity={['critical', 'high']} />);
    fireEvent.click(screen.getByTestId('alert-severity-chip-high-remove'));
    expect(screen.queryByText('alert-h')).toBeNull();
    expect(screen.getByText('alert-c')).toBeTruthy();
  });

  it('picking a single severity in the select still works', () => {
    render(<AlertList alerts={alerts} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Severity' }), { target: { value: 'medium' } });
    expect(screen.getByText('alert-m')).toBeTruthy();
    expect(screen.queryByText('alert-c')).toBeNull();
    expect(screen.getByTestId('alert-severity-chip-medium')).toBeTruthy();
  });

  it('no initial props: nothing filtered, no chips', () => {
    render(<AlertList alerts={alerts} />);
    expect(screen.getByText('alert-l')).toBeTruthy();
    expect(screen.queryByTestId('alert-severity-chip-critical')).toBeNull();
  });
});
