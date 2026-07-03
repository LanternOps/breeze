import { describe, expect, it } from 'vitest';
import { collapseLinkedDevices, type LinkGroupSummary } from './linkedDevices';
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

const group = (id: string, deviceIds: string[], name: string | null = null): LinkGroupSummary => ({
  id,
  name,
  deviceIds,
});

describe('collapseLinkedDevices', () => {
  it('returns the input unchanged when there are no groups', () => {
    const devices = [mk('a'), mk('b')];
    expect(collapseLinkedDevices(devices, [])).toBe(devices);
  });

  it('collapses a group to the online (active) profile and de-emphasizes siblings', () => {
    const win = mk('win', { os: 'windows', status: 'online' });
    const linux = mk('lin', { os: 'linux', status: 'offline' });
    const out = collapseLinkedDevices([win, linux], [group('g1', ['win', 'lin'], 'Bootbox')]);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('win');
    expect(out[0]!.linkGroupId).toBe('g1');
    expect(out[0]!.linkGroupName).toBe('Bootbox');
    expect(out[0]!.linkedSiblings?.map((s) => s.id)).toEqual(['lin']);
    expect(out[0]!.linkConflict).toBe(false);
  });

  it('surfaces the most-recently-seen profile when all are offline', () => {
    const older = mk('old', { status: 'offline', lastSeen: '2026-01-01T00:00:00.000Z' });
    const newer = mk('new', { status: 'offline', lastSeen: '2026-06-01T00:00:00.000Z' });
    const out = collapseLinkedDevices([older, newer], [group('g1', ['old', 'new'])]);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('new');
    expect(out[0]!.linkConflict).toBe(false);
  });

  it('flags a conflict when more than one profile is online', () => {
    const a = mk('a', { status: 'online', lastSeen: '2026-06-02T00:00:00.000Z' });
    const b = mk('b', { status: 'online', lastSeen: '2026-06-01T00:00:00.000Z' });
    const out = collapseLinkedDevices([a, b], [group('g1', ['a', 'b'])]);

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('a'); // most-recently-seen online
    expect(out[0]!.linkConflict).toBe(true);
    expect(out[0]!.linkedSiblings?.map((s) => s.id)).toEqual(['b']);
  });

  it('does not collapse a group with only one present member', () => {
    // Sibling 'b' filtered out of the current view → 'a' renders normally.
    const a = mk('a');
    const out = collapseLinkedDevices([a], [group('g1', ['a', 'b'])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.linkedSiblings).toBeUndefined();
    expect(out[0]!.linkGroupId).toBeUndefined();
  });

  it('keeps ungrouped devices and preserves first-encountered ordering', () => {
    const solo1 = mk('s1');
    const win = mk('win', { status: 'online' });
    const lin = mk('lin', { status: 'offline' });
    const solo2 = mk('s2');
    const out = collapseLinkedDevices([solo1, win, lin, solo2], [group('g1', ['win', 'lin'])]);

    expect(out.map((d) => d.id)).toEqual(['s1', 'win', 's2']);
  });
});
