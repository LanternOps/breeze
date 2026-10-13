import { describe, expect, it } from 'vitest';
import {
  DEMO_LAKESIDE_SITE_ID, DEMO_SITE_ID, assertLocalDevDatabase, demoAssets, demoDevices, demoDiscoveryProfiles, demoLegacyPins, demoPresenceHistory,
} from './seed-topology-demo.lib';
import { evaluateSuggestion } from '../src/services/topology/presenceEligibility';

const env = (DATABASE_URL: string | undefined, NODE_ENV: string | undefined = 'development') => ({ DATABASE_URL, NODE_ENV });

describe('seed-topology-demo safety guard', () => {
  it.each([
    'postgresql://breeze:breeze@localhost:5432/breeze',
    'postgresql://breeze:breeze@127.0.0.1:5432/breeze',
    'postgres://breeze:breeze@127.10.2.3/breeze',
    'postgresql://breeze:breeze@[::1]:5432/breeze',
    'postgresql://breeze:breeze@postgres:5432/breeze',
    'postgresql://breeze:breeze@breeze-wt-demo-postgres-1:5432/breeze',
    'postgresql://breeze:breeze@host.docker.internal:5433/breeze',
  ])('accepts a local or docker-service database: %s', (url) => {
    expect(() => assertLocalDevDatabase(env(url))).not.toThrow();
  });

  it.each([
    ['a managed cloud host', 'postgresql://breeze:x@db.example.com:5432/breeze'],
    ['a public IP', 'postgresql://breeze:x@203.0.113.7:5432/breeze'],
    ['an RFC1918 IP (a real server on a LAN)', 'postgresql://breeze:x@10.0.0.5:5432/breeze'],
    ['a docker-ish name that is still a FQDN', 'postgresql://breeze:x@postgres.internal.example:5432/breeze'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertLocalDevDatabase(env(url))).toThrow(/refusing to seed/i);
  });

  it('refuses NODE_ENV=production even against localhost', () => {
    expect(() => assertLocalDevDatabase(env('postgresql://breeze:breeze@localhost:5432/breeze', 'production')))
      .toThrow(/NODE_ENV=production/);
  });

  it('refuses a missing or unparseable DATABASE_URL', () => {
    expect(() => assertLocalDevDatabase(env(undefined))).toThrow(/DATABASE_URL/);
    expect(() => assertLocalDevDatabase(env('not a url'))).toThrow(/DATABASE_URL/);
  });
});

describe('seed-topology-demo fixture shape', () => {
  const devices = demoDevices();
  const assets = demoAssets(devices);

  it('mirrors the measured site: 24 managed+discovered, 8 managed-only, 56 discovered-only', () => {
    expect(devices).toHaveLength(37);
    expect(devices.filter(d => d.linked)).toHaveLength(24);
    expect(assets.filter(a => !a.linkedDeviceKey)).toHaveLength(56);
    expect(devices.filter(d => d.status === 'online')).toHaveLength(17);
    expect(devices.filter(d => d.status === 'decommissioned').map(d => d.hostname)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^CHECKOUT-02\.decom-[0-9a-f]{8}$/)]));
    expect(devices.filter(d => d.status === 'decommissioned')).toHaveLength(4);
  });

  it('has 8 assets missing from the latest scan, 16 sticky-online stale ones and 3 IP collisions', () => {
    expect(assets.filter(a => a.presence === 'missed')).toHaveLength(8);
    const stale = assets.filter(a => a.presence === 'stale');
    expect(stale).toHaveLength(16);
    expect(stale.every(a => a.staleDays! >= 18 && a.staleDays! <= 112)).toBe(true);
    const collisions = assets.filter(a => a.collision);
    expect(collisions).toHaveLength(3);
    for (const asset of collisions) expect(devices.some(d => d.ip === asset.ip && !d.linked)).toBe(true);
  });

  it('uses only unique private addresses and locally administered MACs', () => {
    expect(new Set(assets.map(a => a.ip)).size).toBe(assets.length);
    for (const value of [...devices, ...assets]) {
      expect(value.ip).toMatch(/^(10\.1\.[25]\.|192\.168\.1\.)/);
      expect(parseInt(value.mac.slice(0, 2), 16) & 0b11).toBe(0b10);
    }
  });

  it('saves 37 legacy pins inside a ~1400x900 flat map, most on big-LAN members', () => {
    const pins = demoLegacyPins(assets);
    expect(pins).toHaveLength(37);
    expect(pins.every(p => p.x >= 0 && p.x <= 1400 && p.y >= 0 && p.y <= 900)).toBe(true);
    expect(new Set(pins.map(p => p.assetKey)).size).toBe(37);
  });

  it('seeds a Lakeside sister site owning 10.1.5.0/24 with misassigned, travelling and home-network devices', () => {
    const on = (site: string, lan: string) => devices.filter((d) => d.siteId === site && d.lan === lan).map((d) => d.hostname).sort();
    expect(on('main', 'second')).toEqual(['DESKTOP-HD7K2QF', 'WIN-HD4M8T2C9']); // the 2 misassigned desktops
    expect(on('lakeside', 'second').length).toBeGreaterThanOrEqual(3); // Lakeside's own observers: >=2 fresh for MAC corroboration
    const lakesideFresh = devices.filter((d) => d.siteId === 'lakeside' && d.lan === 'second' && d.capture?.mode === 'fresh' && d.extras.includes('neighbors'));
    expect(lakesideFresh.length).toBeGreaterThanOrEqual(2);
    expect(on('lakeside', 'main')).toEqual(['LAPTOP-LOV-01']); // travelling laptop visiting Main Office
    expect(on('main', 'home')).toEqual(['LAPTOP-HOME-01']); // home network laptop on 192.168.1.0/24
    for (const d of devices.filter((x) => x.hostname === 'DESKTOP-HD7K2QF' || x.hostname === 'WIN-HD4M8T2C9' || x.lan === 'home' || x.hostname === 'LAPTOP-LOV-01')) {
      expect(d.status).toBe('online');
      expect(d.capture?.mode).toBe('fresh');
      expect(d.extras).toContain('neighbors');
    }
    expect(demoDiscoveryProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteId: DEMO_SITE_ID, subnets: ['10.1.2.0/24'] }),
      expect.objectContaining({ siteId: DEMO_LAKESIDE_SITE_ID, subnets: ['10.1.5.0/24'] }),
    ]));
  });
});

describe('seed-topology-demo synthetic presence history (site location W3)', () => {
  const now = new Date('2026-10-12T14:00:00.000Z');
  const history = demoPresenceHistory(now);
  const siteId = { main: DEMO_SITE_ID, lakeside: DEMO_LAKESIDE_SITE_ID } as const;
  const rowsFor = (hostname: string) => history.filter((r) => r.hostname === hostname).map((r) => ({
    day: r.day, assignedSiteId: siteId[r.assigned], state: r.state, matchedSiteId: r.matched ? siteId[r.matched] : null,
    firstObservedAt: r.firstObservedAt, lastObservedAt: r.lastObservedAt,
  }));
  const eligibility = (hostname: string, assigned: 'main' | 'lakeside', matched: 'main' | 'lakeside') => {
    // What the evaluator adds for today's visit, then S§10.2 as the evaluator applies it.
    const today = { day: now.toISOString().slice(0, 10), assignedSiteId: siteId[assigned], state: 'visiting' as const, matchedSiteId: siteId[matched],
      firstObservedAt: now.toISOString(), lastObservedAt: now.toISOString() };
    return evaluateSuggestion({ now, assignedSiteId: siteId[assigned], confirmedAt: null, anchoredUniquely: true,
      current: { valid: true, state: 'visiting', matchedSiteId: siteId[matched] }, days: [...rowsFor(hostname), today] });
  };

  it('gives the two misassigned desktops 9 days of Lakeside visits with nightly stale rows', () => {
    for (const hostname of ['DESKTOP-HD7K2QF', 'WIN-HD4M8T2C9']) {
      const rows = history.filter((r) => r.hostname === hostname);
      expect(rows.every((r) => r.assigned === 'main')).toBe(true);
      expect(new Set(rows.filter((r) => r.state === 'visiting' && r.matched === 'lakeside').map((r) => r.day)).size).toBe(9);
      expect(rows.filter((r) => r.state === 'stale')).toHaveLength(9);
      expect(rows.some((r) => r.state === 'home')).toBe(false);
      expect(eligibility(hostname, 'main', 'lakeside')).toMatchObject({ siteId: DEMO_LAKESIDE_SITE_ID, days: 10 });
    }
  });

  it('gives the travelling laptop 3 mixed days, which never makes it eligible', () => {
    const rows = history.filter((r) => r.hostname === 'LAPTOP-LOV-01');
    expect(new Set(rows.map((r) => r.day)).size).toBe(3);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(['visiting', 'home']));
    expect(eligibility('LAPTOP-LOV-01', 'lakeside', 'main')).toBeNull();
  });

  it('only names the demo hostnames, and every row is well-formed (first <= last, day = UTC date of first)', () => {
    expect(new Set(history.map((r) => r.hostname))).toEqual(new Set(['DESKTOP-HD7K2QF', 'WIN-HD4M8T2C9', 'LAPTOP-LOV-01']));
    for (const r of history) {
      expect(Date.parse(r.firstObservedAt)).toBeLessThanOrEqual(Date.parse(r.lastObservedAt));
      expect(r.day).toBe(r.firstObservedAt.slice(0, 10));
      expect(Date.parse(r.lastObservedAt)).toBeLessThan(now.getTime());
      expect(r.state === 'visiting').toBe(r.matched !== null);
    }
  });
});
