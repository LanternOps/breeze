import { describe, expect, it } from 'vitest';
import {
  DEMO_LAKESIDE_SITE_ID, DEMO_SITE_ID, assertLocalDevDatabase, demoAssets, demoDevices, demoDiscoveryProfiles, demoLegacyPins,
} from './seed-topology-demo.lib';

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
