import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';
import AlertList, { type Alert } from './AlertList';

const baseAlert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-07-17T00:00:00Z',
  orgId: 'org-1',
  orgName: 'Acme Corp',
};

describe('AlertList — Organization column follows fleet view', () => {
  it('hides the Organization column in single-org scope', () => {
    render(<AlertList alerts={[baseAlert]} showOrgColumn={false} />);
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
    // The org name is not rendered as a cell when the column is off.
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });

  it('shows the Organization column and each alert’s org in fleet view', () => {
    render(<AlertList alerts={[baseAlert]} showOrgColumn />);
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
  });

  it('renders an em-dash for an alert with no org name in fleet view', () => {
    render(<AlertList alerts={[{ ...baseAlert, orgName: null }]} showOrgColumn />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('spans the empty-state row across the extra column when the org column is shown', () => {
    const { container } = render(<AlertList alerts={[]} showOrgColumn />);
    const emptyCell = container.querySelector('td[colspan]');
    expect(emptyCell?.getAttribute('colspan')).toBe('8');
  });
});
