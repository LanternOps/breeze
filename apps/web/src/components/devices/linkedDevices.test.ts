import { describe, expect, it } from 'vitest';
import { groupLinkedDevices } from './linkedDevices';
import type { Device } from './DeviceList';

function mk(id: string, over: Partial<Device> = {}): Device {
  return {
    id,
    hostname: `host-${id}`,
    os: 'windows',
    osVersion: '11',
    status: 'offline',
    cpuPercent: 0,
    ramPercent: 0,
    lastSeen: '2026-01-01T00:00:00.000Z',
    orgId: 'org-1',
    orgName: 'Org',
    siteId: 'site-1',
    siteName: 'Site',
    agentVersion: '1.0.0',
    tags: [],
    ...over,
  };
}

describe('groupLinkedDevices', () => {
  it('passes unlinked devices through as plain rows', () => {
    const devices = [mk('a'), mk('b')];
    const out = groupLinkedDevices(devices, true);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.device.id)).toEqual(['a', 'b']);
    expect(out.every((r) => r.inactiveSiblings.length === 0 && !r.offlineGroup)).toBe(true);
  });

  it('returns a flat list when the toggle is off, even for linked devices', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'offline' });
    const out = groupLinkedDevices([win, lin], false);
    expect(out.map((r) => r.device.id)).toEqual(['win', 'lin']);
    expect(out.every((r) => r.inactiveSiblings.length === 0 && !r.offlineGroup)).toBe(true);
  });

  it('tucks offline siblings beneath the single online member as strips', () => {
    const before = mk('before');
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'offline' });
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const after = mk('after');

    const out = groupLinkedDevices([before, lin, win, after], true);

    // The offline sibling no longer renders as its own row…
    expect(out.map((r) => r.device.id)).toEqual(['before', 'win', 'after']);
    // …but attaches beneath the online member as a strip.
    const anchor = out.find((r) => r.device.id === 'win')!;
    expect(anchor.inactiveSiblings.map((d) => d.id)).toEqual(['lin']);
    expect(anchor.offlineGroup).toBe(false);
  });

  it('supports several strips under one anchor (3-way multi-boot)', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'offline' });
    const mac = mk('mac', { os: 'macos', linkGroupId: 'g1', status: 'offline' });

    const out = groupLinkedDevices([win, lin, mac], true);
    expect(out).toHaveLength(1);
    expect(out[0]!.device.id).toBe('win');
    expect(out[0]!.inactiveSiblings.map((d) => d.id)).toEqual(['lin', 'mac']);
  });

  it('marks all members with the offline-group bar when every profile is offline (no primary election)', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'offline', lastSeen: '2026-01-02T00:00:00.000Z' });
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'offline' });
    const plain = mk('plain');

    const out = groupLinkedDevices([win, lin, plain], true);
    expect(out.map((r) => r.device.id)).toEqual(['win', 'lin', 'plain']);
    expect(out.find((r) => r.device.id === 'win')!.offlineGroup).toBe(true);
    expect(out.find((r) => r.device.id === 'lin')!.offlineGroup).toBe(true);
    expect(out.find((r) => r.device.id === 'plain')!.offlineGroup).toBe(false);
    expect(out.every((r) => r.inactiveSiblings.length === 0)).toBe(true);
  });

  it('renders all members as normal full rows when two or more are online (conflict state designed out)', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'online' });

    const out = groupLinkedDevices([win, lin], true);
    expect(out.map((r) => r.device.id)).toEqual(['win', 'lin']);
    expect(out.every((r) => r.inactiveSiblings.length === 0 && !r.offlineGroup)).toBe(true);
  });

  it('leaves a lone member ungrouped when its sibling is on another page (pagination caveat)', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const out = groupLinkedDevices([win], true);
    expect(out).toHaveLength(1);
    expect(out[0]!.inactiveSiblings).toHaveLength(0);
    expect(out[0]!.offlineGroup).toBe(false);
  });

  it('keeps a non-offline sibling (e.g. maintenance) as a full row, not an expected-offline strip', () => {
    const win = mk('win', { linkGroupId: 'g1', status: 'online' });
    const lin = mk('lin', { os: 'linux', linkGroupId: 'g1', status: 'maintenance' });
    const mac = mk('mac', { os: 'macos', linkGroupId: 'g1', status: 'offline' });

    const out = groupLinkedDevices([win, lin, mac], true);
    expect(out.map((r) => r.device.id)).toEqual(['win', 'lin']);
    expect(out.find((r) => r.device.id === 'win')!.inactiveSiblings.map((d) => d.id)).toEqual(['mac']);
  });

  it('handles two independent groups on the same page', () => {
    const aWin = mk('a-win', { linkGroupId: 'gA', status: 'online' });
    const aLin = mk('a-lin', { os: 'linux', linkGroupId: 'gA', status: 'offline' });
    const bWin = mk('b-win', { linkGroupId: 'gB', status: 'offline' });
    const bLin = mk('b-lin', { os: 'linux', linkGroupId: 'gB', status: 'offline' });

    const out = groupLinkedDevices([aWin, aLin, bWin, bLin], true);
    expect(out.map((r) => r.device.id)).toEqual(['a-win', 'b-win', 'b-lin']);
    expect(out.find((r) => r.device.id === 'a-win')!.inactiveSiblings.map((d) => d.id)).toEqual(['a-lin']);
    expect(out.find((r) => r.device.id === 'b-win')!.offlineGroup).toBe(true);
    expect(out.find((r) => r.device.id === 'b-lin')!.offlineGroup).toBe(true);
  });
});
