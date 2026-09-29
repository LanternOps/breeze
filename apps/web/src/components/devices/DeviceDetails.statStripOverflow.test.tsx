/**
 * Issue #7153: at 1024px the Overview stat strip's 5th stat (Logged-in User)
 * spilled out from under the Activity panel. Root cause: the Health block
 * (CPU/RAM/Uptime) was `flex flex-1` with no `min-w-0`, so it never shrank
 * below its content width; and the "Logged-in User" label row was
 * `whitespace-nowrap` with no truncation, so once squeezed it overflowed
 * instead of eliding. jsdom has no layout engine, so this asserts the
 * markup/classes that carry the fix rather than pixel overflow.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
  lastUser: 'a-very-long-domain\\username-that-would-otherwise-overflow',
} as Device;

describe('DeviceDetails overview stat strip (#7153)', () => {
  it('lets the Health (CPU/RAM/Uptime) block shrink so it does not force the Activity block to overflow', () => {
    render(<DeviceDetails device={device} />);
    const cpuLabel = screen.getByText('CPU');
    // cpuLabel's div ancestors: label row -> "shrink-0" stat wrapper ->
    // Health block wrapper (flex flex-1 gap-x-6), which must be able to
    // shrink below its content width (min-w-0) or it starves the sibling
    // Activity block.
    const healthBlock = cpuLabel.closest('div')?.parentElement?.parentElement;
    expect(healthBlock).not.toBeNull();
    expect(healthBlock).toHaveClass('min-w-0');
  });

  it('truncates the "Logged-in User" label instead of letting it overflow under the Activity panel', () => {
    render(<DeviceDetails device={device} />);
    const label = screen.getByText(/logged-in user/i);
    // The label text must be allowed to truncate (not a bare
    // whitespace-nowrap element with no overflow handling), and its row
    // must permit shrinking so the truncation can actually engage.
    expect(label.className).toMatch(/truncate/);
    const labelRow = label.closest('div');
    expect(labelRow).not.toBeNull();
    expect(labelRow!.className).not.toMatch(/whitespace-nowrap/);
  });

  // 1024px: the Activity rail sits beside the strip (lg:flex-row), so the
  // strip is narrow. Both groups must stack and wrap below xl so labels and
  // values never collide or clip.
  it('stacks the Health/Activity groups below xl and lets each group wrap', () => {
    render(<DeviceDetails device={device} />);
    const healthBlock = screen.getByText('CPU').closest('div')!.parentElement!.parentElement!;
    const strip = healthBlock.parentElement!;
    expect(strip.className).toMatch(/xl:flex-row/);
    expect(strip.className).not.toMatch(/(^|\s)sm:flex-row/);
    expect(healthBlock).toHaveClass('flex-wrap');
    const activityBlock = healthBlock.nextElementSibling!.nextElementSibling!;
    expect(activityBlock).toHaveClass('flex-wrap');
    // The divider is only meaningful when the groups sit side by side.
    expect(healthBlock.nextElementSibling!.className).toMatch(/xl:block/);
    expect(healthBlock.nextElementSibling!.className).not.toMatch(/sm:block/);
  });
});
