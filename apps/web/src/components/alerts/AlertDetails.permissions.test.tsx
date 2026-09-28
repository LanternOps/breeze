import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
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

beforeEach(() => h.granted.clear());

const renderDrawer = () => render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
const btn = (re: RegExp) => screen.queryByRole('button', { name: re });

describe('AlertDetails footer actions are permission-gated (#7215)', () => {
  it('hides all write actions without permissions but keeps Close', () => {
    renderDrawer();
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThan(0);
    expect(btn(/^acknowledge/i)).toBeNull();
    expect(btn(/^suppress/i)).toBeNull();
    expect(btn(/^dismiss/i)).toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
    expect(screen.queryByTestId('alert-create-ticket-button')).toBeNull();
  });

  it('alerts:acknowledge grants only Acknowledge', () => {
    h.granted.add('alerts:acknowledge');
    renderDrawer();
    expect(btn(/^acknowledge/i)).not.toBeNull();
    expect(btn(/^suppress/i)).toBeNull();
    expect(btn(/^dismiss/i)).toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
  });

  it('alerts:write grants Suppress, Dismiss and Resolve', () => {
    h.granted.add('alerts:write');
    renderDrawer();
    expect(btn(/^acknowledge/i)).toBeNull();
    expect(btn(/^suppress/i)).not.toBeNull();
    expect(btn(/^dismiss/i)).not.toBeNull();
    expect(btn(/^resolve/i)).not.toBeNull();
  });

  it('tickets:write grants Create ticket', () => {
    h.granted.add('tickets:write');
    renderDrawer();
    expect(screen.queryByTestId('alert-create-ticket-button')).not.toBeNull();
    expect(btn(/^resolve/i)).toBeNull();
  });
});
