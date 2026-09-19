import { describe, it, expect } from 'vitest';

import {
  deviceRowMeta,
  matchesQuery,
  matchesStatus,
  shapeDeviceList,
  statusCounts,
} from './deviceListFilters';
import type { Device } from '../../services/api';

const dev = (over: Partial<Device>): Device =>
  ({
    id: over.id ?? 'd1',
    name: over.name ?? 'BOX-1',
    status: over.status ?? 'online',
    hostname: over.hostname,
    os: over.os,
    siteName: over.siteName,
    lastSeen: over.lastSeen,
    organizationId: over.organizationId,
    organizationName: over.organizationName,
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T00:00:00Z',
  }) as Device;

describe('matchesStatus', () => {
  it('treats warning as not-online, because a warning box is not healthy', () => {
    expect(matchesStatus(dev({ status: 'warning' }), 'offline')).toBe(true);
    expect(matchesStatus(dev({ status: 'warning' }), 'online')).toBe(false);
  });

  it('all matches everything', () => {
    for (const s of ['online', 'offline', 'warning'] as const) {
      expect(matchesStatus(dev({ status: s }), 'all')).toBe(true);
    }
  });
});

describe('matchesQuery', () => {
  it('matches name, hostname, site and OS, case-insensitively', () => {
    const d = dev({ name: 'Reception', hostname: 'RECEP-01', os: 'windows', siteName: 'HQ' });
    for (const q of ['recep', 'RECEP-01', 'WINDOWS', 'hq']) {
      expect(matchesQuery(d, q)).toBe(true);
    }
    expect(matchesQuery(d, 'zzz')).toBe(false);
  });

  it('an empty or whitespace query matches everything', () => {
    expect(matchesQuery(dev({}), '   ')).toBe(true);
  });

  it('does not throw on devices missing optional fields', () => {
    expect(matchesQuery(dev({ name: 'X', hostname: undefined, os: undefined }), 'x')).toBe(true);
  });
});

describe('shapeDeviceList', () => {
  const fleet = [
    dev({ id: '1', name: 'Zulu', status: 'online' }),
    dev({ id: '2', name: 'Alpha', status: 'offline' }),
    dev({ id: '3', name: 'Mike', status: 'warning' }),
    dev({ id: '4', name: 'Bravo', status: 'online' }),
  ];

  it('sorts problems first, then alphabetically', () => {
    // A phone user opens this to find what is broken, so offline leads.
    const out = shapeDeviceList(fleet, { status: 'all', query: '' });
    expect(out.map((d) => d.name)).toEqual(['Alpha', 'Mike', 'Bravo', 'Zulu']);
  });

  it('restricts to one organization when asked', () => {
    const scoped = [
      dev({ id: '1', name: 'A', organizationId: 'o1' }),
      dev({ id: '2', name: 'B', organizationId: 'o2' }),
    ];
    const out = shapeDeviceList(scoped, { status: 'all', query: '', orgId: 'o1' });
    expect(out.map((d) => d.id)).toEqual(['1']);
  });

  it('combines status and text filters', () => {
    const out = shapeDeviceList(fleet, { status: 'offline', query: 'a' });
    expect(out.map((d) => d.name)).toEqual(['Alpha']);
  });

  it('does not mutate the input array', () => {
    const before = fleet.map((d) => d.id);
    shapeDeviceList(fleet, { status: 'all', query: '' });
    expect(fleet.map((d) => d.id)).toEqual(before);
  });
});

describe('statusCounts', () => {
  it('counts warning devices as offline so the chips sum to the total', () => {
    const c = statusCounts([
      dev({ id: '1', status: 'online' }),
      dev({ id: '2', status: 'offline' }),
      dev({ id: '3', status: 'warning' }),
    ]);
    expect(c).toEqual({ all: 3, online: 1, offline: 2 });
    expect(c.online + c.offline).toBe(c.all);
  });
});

// #5104: the device list row meta line — the visible fix for "no
// organization on device rows".
describe('deviceRowMeta', () => {
  it('joins org and site when both are known', () => {
    expect(deviceRowMeta(dev({ organizationName: 'Acme Corp', siteName: 'HQ' }))).toBe('Acme Corp · HQ');
  });

  it('shows org alone when site is unknown', () => {
    expect(deviceRowMeta(dev({ organizationName: 'Acme Corp', siteName: undefined }))).toBe('Acme Corp');
  });

  it('shows site alone when org is unknown', () => {
    expect(deviceRowMeta(dev({ organizationName: undefined, siteName: 'HQ' }))).toBe('HQ');
  });

  it('falls back to the OS label when neither org nor site is known', () => {
    expect(
      deviceRowMeta(dev({ organizationName: undefined, siteName: undefined, os: 'windows' }))
    ).toBe('Windows');
  });

  it('falls back to an em dash when org, site AND os are all unknown', () => {
    expect(
      deviceRowMeta(dev({ organizationName: undefined, siteName: undefined, os: undefined }))
    ).toBe('—');
  });
});
