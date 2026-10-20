import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ granted: new Set<string>(), phone: false }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

import DeviceActions from './DeviceActions';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
vi.mock('@/lib/moveOrgCapability', () => ({ useCanMoveDeviceOrg: () => false }));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => h.phone }));
vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: vi.fn() };
});

// The case this action exists for: the agent is down, the watchdog is not.
const silentDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'offline',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '2026-10-20T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
  watchdogStatus: 'failover',
  watchdogLastSeen: '2026-10-20T12:00:00.000Z',
};

beforeEach(() => {
  h.granted.clear();
  h.phone = false;
});

type Variant = 'compact' | 'desktop' | 'phone';
const VARIANTS: Variant[] = ['compact', 'desktop', 'phone'];

// DeviceActions renders the menu three ways (compact "…", desktop "…", phone
// sheet); each must carry the item.
async function openMenu(variant: Variant) {
  h.phone = variant === 'phone';
  render(<DeviceActions device={silentDevice} compact={variant === 'compact'} onAction={vi.fn()} />);
  await userEvent.click(
    screen.getByTestId(variant === 'phone' ? 'device-actions-sheet-trigger' : 'device-actions-menu'),
  );
}

describe('DeviceActions "Restart agent" is gated on devices:recover_agent (#9234)', () => {
  it.each(VARIANTS)('is absent without the grant, even with devices:execute (%s)', async (variant) => {
    h.granted.add('devices:execute');
    await openMenu(variant);
    expect(screen.queryByTestId('device-action-restart-agent')).toBeNull();
  });

  it.each(VARIANTS)('is offered with the grant while the agent is offline (%s)', async (variant) => {
    h.granted.add('devices:recover_agent');
    await openMenu(variant);
    const item = screen.getByTestId('device-action-restart-agent');
    expect(item).toHaveAccessibleName(/restart agent/i);
    // A silent agent is the whole point: never disabled for being offline.
    expect(item).not.toHaveAttribute('aria-disabled');
  });

  it('is not offered for a decommissioned device', async () => {
    h.granted.add('devices:recover_agent');
    render(<DeviceActions device={{ ...silentDevice, status: 'decommissioned' }} compact onAction={vi.fn()} />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.queryByTestId('device-action-restart-agent')).toBeNull();
  });
});

describe('DeviceActions "Restart agent" confirms before dispatch (#9234)', () => {
  it('asks first, shows the watchdog last-seen state, then hands off restart-agent', async () => {
    h.granted.add('devices:recover_agent');
    const onAction = vi.fn();
    render(<DeviceActions device={silentDevice} compact onAction={onAction} />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    await userEvent.click(screen.getByTestId('device-action-restart-agent'));

    expect(onAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/edge-01/);
    expect(dialog).toHaveTextContent(/watchdog last reported/i);

    await userEvent.click(within(dialog).getByRole('button', { name: /restart agent/i }));
    expect(onAction).toHaveBeenCalledWith('restart-agent', silentDevice);
  });

  it('says so when the watchdog has never reported', async () => {
    h.granted.add('devices:recover_agent');
    render(
      <DeviceActions device={{ ...silentDevice, watchdogStatus: null, watchdogLastSeen: null }} compact onAction={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    await userEvent.click(screen.getByTestId('device-action-restart-agent'));

    expect(screen.getByRole('dialog')).toHaveTextContent(/watchdog has not reported/i);
  });
});
