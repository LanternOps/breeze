/** "…" and Power menus follow the menu-button pattern (#9025). */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import DeviceActions from './DeviceActions';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
vi.mock('@/lib/moveOrgCapability', () => ({ useCanMoveDeviceOrg: () => false }));
vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: vi.fn() };
});

const device = {
  id: 'device-1', hostname: 'edge-01', os: 'windows', osVersion: '11', status: 'online',
  cpuPercent: 1, ramPercent: 1, lastSeen: '2026-06-29T10:00:00.000Z', orgId: 'o', orgName: 'O',
  siteId: 's', siteName: 'S', agentVersion: '1', tags: [],
} as Device;

describe.each([
  ['full "…" menu', false, () => screen.getByTestId('device-actions-menu')],
  ['compact "…" menu', true, () => screen.getByTestId('device-actions-menu')],
  ['Power menu', false, () => screen.getByTestId('device-power-menu')],
])('%s', (_name, compact, getTrigger) => {
  const setup = () => render(<div><DeviceActions device={device} compact={compact} onAction={vi.fn()} /><button data-testid="outside">x</button></div>);

  it('exposes menu ARIA on the trigger and popup', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = getTrigger();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label') || trigger.textContent).toBeTruthy();
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });

  it('moves focus into the menu and supports arrow keys', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(getTrigger());
    const items = screen.getAllByRole('menuitem').filter((i) => !(i as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    setup();
    const trigger = getTrigger();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(getTrigger());
    await user.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('unavailable menu items (#9025)', () => {
  it('stay keyboard-focusable with aria-disabled, and do not fire', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<DeviceActions device={{ ...device, status: 'offline' } as Device} compact onAction={onAction} />);
    await user.click(screen.getByTestId('device-actions-menu'));
    const reboot = screen.getByRole('menuitem', { name: /^reboot$/i });
    expect(reboot.getAttribute('aria-disabled')).toBe('true');
    expect(reboot.hasAttribute('disabled')).toBe(false);
    reboot.focus();
    expect(document.activeElement).toBe(reboot);
    await user.click(reboot);
    expect(onAction).not.toHaveBeenCalled();
  });
});
