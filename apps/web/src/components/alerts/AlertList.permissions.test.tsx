import { fireEvent, render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AlertList, { type Alert } from './AlertList';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

const alert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-07-17T00:00:00Z',
};

beforeEach(() => h.granted.clear());

const rowBtn = (re: RegExp) => screen.queryByRole('button', { name: re });

describe('AlertList row actions are permission-gated (#7215)', () => {
  it('hides every row action without permissions but still renders the row', () => {
    render(<AlertList alerts={[alert]} />);
    expect(screen.getByText('CPU high')).toBeTruthy();
    expect(rowBtn(/^Acknowledge:/)).toBeNull();
    expect(rowBtn(/^Resolve:/)).toBeNull();
    expect(rowBtn(/^Suppress:/)).toBeNull();
    expect(rowBtn(/^Dismiss:/)).toBeNull();
  });

  it('alerts:acknowledge grants only Ack', () => {
    h.granted.add('alerts:acknowledge');
    render(<AlertList alerts={[alert]} />);
    expect(rowBtn(/^Acknowledge:/)).not.toBeNull();
    expect(rowBtn(/^Resolve:/)).toBeNull();
    expect(rowBtn(/^Suppress:/)).toBeNull();
    expect(rowBtn(/^Dismiss:/)).toBeNull();
  });

  it('alerts:write grants Resolve, Mute and Dismiss but not Ack', () => {
    h.granted.add('alerts:write');
    render(<AlertList alerts={[alert]} />);
    expect(rowBtn(/^Acknowledge:/)).toBeNull();
    expect(rowBtn(/^Resolve:/)).not.toBeNull();
    expect(rowBtn(/^Suppress:/)).not.toBeNull();
    expect(rowBtn(/^Dismiss:/)).not.toBeNull();
  });
});

describe('AlertList bulk actions are permission-gated (#7215)', () => {
  function selectRow() {
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
  }

  it('hides the bulk bar when neither permission is granted', () => {
    render(<AlertList alerts={[alert]} />);
    selectRow();
    expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: /bulk actions/i })).toBeNull();
  });

  it('shows only Acknowledge in the bulk menu with alerts:acknowledge', () => {
    h.granted.add('alerts:acknowledge');
    render(<AlertList alerts={[alert]} />);
    selectRow();
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    expect(screen.queryByRole('menuitem', { name: /acknowledge/i })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /resolve/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /suppress/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /dismiss/i })).toBeNull();
  });

  it('shows Resolve, Suppress, Dismiss but not Acknowledge with alerts:write', () => {
    h.granted.add('alerts:write');
    render(<AlertList alerts={[alert]} />);
    selectRow();
    fireEvent.click(screen.getByRole('button', { name: /bulk actions/i }));
    expect(screen.queryByRole('menuitem', { name: /acknowledge/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /resolve/i })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /suppress/i })).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /dismiss/i })).not.toBeNull();
  });
});
