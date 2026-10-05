import { describe, expect, it } from 'vitest';
import { assertLocalDevDatabase, demoAssets, demoDevices, demoLegacyPins } from './seed-topology-demo.lib';

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
    expect(devices).toHaveLength(32);
    expect(devices.filter(d => d.linked)).toHaveLength(24);
    expect(assets.filter(a => !a.linkedDeviceKey)).toHaveLength(56);
    expect(devices.filter(d => d.status === 'online')).toHaveLength(12);
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
      expect(value.ip).toMatch(/^10\.1\.[25]\./);
      expect(parseInt(value.mac.slice(0, 2), 16) & 0b11).toBe(0b10);
    }
  });

  it('saves 37 legacy pins inside a ~1400x900 flat map, most on big-LAN members', () => {
    const pins = demoLegacyPins(assets);
    expect(pins).toHaveLength(37);
    expect(pins.every(p => p.x >= 0 && p.x <= 1400 && p.y >= 0 && p.y <= 900)).toBe(true);
    expect(new Set(pins.map(p => p.assetKey)).size).toBe(37);
  });
});
