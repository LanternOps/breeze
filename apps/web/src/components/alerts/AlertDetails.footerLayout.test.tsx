import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

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

// The drawer is max-w-2xl; with every permission granted the footer carries six
// buttons, which is wider than the drawer. They must wrap onto a second row
// instead of squeezing their labels onto two lines ("Create" / "ticket").
describe('AlertDetails footer layout', () => {
  it('wraps the action row and keeps each button label on one line', () => {
    render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
    const footer = screen.getByTestId('alert-details-footer');
    expect(footer.className.split(' ')).toContain('flex-wrap');
    const buttons = Array.from(footer.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const button of buttons) {
      expect(button.className.split(' '), button.textContent ?? '').toContain('whitespace-nowrap');
    }
  });
});
