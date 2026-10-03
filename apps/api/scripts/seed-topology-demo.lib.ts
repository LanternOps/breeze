/**
 * Pure (no I/O) helpers for scripts/seed-topology-demo.ts, split out so the
 * unit test can import them without opening the database pool.
 *
 * Everything here is SYNTHETIC. The shape mirrors a measured US-prod dental
 * site (88 endpoints, one big /24, three IP collisions, sticky scan status,
 * legacy pins), but no hostname, MAC, IP or vendor relationship is real:
 * addresses are RFC1918 / RFC3927 / CGNAT / ULA, and every MAC is locally
 * administered (02:…), so nothing here identifies a customer or a device.
 */

/**
 * The demo seed erases and rewrites a whole organization. It must never reach a
 * shared or production database, so it runs only when BOTH hold:
 *  - NODE_ENV is not `production`;
 *  - the DATABASE_URL host is loopback (`localhost`, 127.0.0.0/8, ::1),
 *    `host.docker.internal`, or a single-label docker-compose service name
 *    (`postgres`, `breeze-wt-x-postgres-1`). Any FQDN or non-loopback IP —
 *    including RFC1918 addresses, which can be a real server — is refused.
 */
export function assertLocalDevDatabase(env: { DATABASE_URL?: string; NODE_ENV?: string }): { host: string } {
  if (env.NODE_ENV === 'production') {
    throw new Error('seed-topology-demo: refusing to seed with NODE_ENV=production. This fixture is for local/dev stacks only.');
  }
  if (!env.DATABASE_URL) throw new Error('seed-topology-demo: DATABASE_URL is not set; refusing to seed.');
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname.toLowerCase();
  } catch {
    throw new Error('seed-topology-demo: DATABASE_URL is not a parseable URL; refusing to seed.');
  }
  if (!host) throw new Error('seed-topology-demo: DATABASE_URL has no host; refusing to seed.');
  const bare = host.replace(/^\[|\]$/g, '');
  const loopbackV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
  const serviceName = !ipLiteral && /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(bare);
  if (bare === 'localhost' || bare === '::1' || loopbackV4 || bare === 'host.docker.internal' || serviceName) return { host: bare };
  throw new Error(`seed-topology-demo: refusing to seed DATABASE_URL host "${bare}". Only localhost, 127.x, ::1, `
    + 'host.docker.internal or a single-label docker service name (e.g. "postgres") are allowed.');
}

/** Fixed ids keep the explorer URL (#topology/site/<id>) stable across re-seeds. */
export const DEMO_ORG_ID = '7090106e-de70-4a00-8000-00000000d0a1';
export const DEMO_SITE_ID = '7090106e-de70-4a00-8000-00000000517e';
export const DEMO_ORG_NAME = 'Topology Demo — Harbor Dental';
export const DEMO_ORG_SLUG = 'topology-demo-harbor-dental';
export const DEMO_SITE_NAME = 'Harbor Dental — Main Office';
export const MAIN_LAN = { prefix: '10.1.2.0/24', base: '10.1.2.', gateway: '10.1.2.100' } as const;
export const SECOND_LAN = { prefix: '10.1.5.0/24', base: '10.1.5.', gateway: '10.1.5.1' } as const;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Locally administered unicast MAC (first octet 0x02): never a real vendor OUI. */
export function demoMac(group: number, index: number): string {
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, '0');
  return ['02', 'b7', hex(group), hex(index >> 8), hex(index), hex(group * 7 + index)].join(':');
}

/**
 * How an agent's last network-context capture looks:
 *  - `fresh`: captured now and re-confirmed by `--keep-fresh` (online agents);
 *  - `stale`: an online agent whose collection stalled `ageMs` ago (never confirmed);
 *  - `aged`: captured `ageMs` ago and never again (offline/decommissioned). Captures
 *    older than 7 days are archived by the retention pass, leaving their per-observer
 *    network/gateway nodes orphaned (#7879).
 */
export type DemoCapture = { mode: 'fresh' | 'stale' | 'aged'; ageMs: number };
export type DemoExtra = 'tailscale' | 'vpn_full_tunnel' | 'apipa_nic' | 'apipa_only' | 'neighbors' | 'neighbors_truncated' | 'neighbor_mac_conflicts';
export type DemoDevice = {
  key: string; hostname: string; ip: string; mac: string; lan: 'main' | 'second'; role: 'workstation' | 'server';
  status: 'online' | 'offline' | 'decommissioned'; lastSeenAgoMs: number;
  /** A discovered asset with the same IP/MAC exists and is auto-linked to this device. */
  linked: boolean;
  /** null = an older agent that never sent network context. */
  capture: DemoCapture | null;
  /** IPv6 link-local (fe80::/64 with a zone) on the LAN NIC. */
  linkLocal: boolean;
  extras: DemoExtra[];
  agentVersion: string;
};

const m = (n: number) => `${MAIN_LAN.base}${n}`;
const s = (n: number) => `${SECOND_LAN.base}${n}`;
let deviceIndex = 0;
function device(hostname: string, ip: string, lan: 'main' | 'second', status: DemoDevice['status'], lastSeenAgoMs: number, linked: boolean,
  capture: DemoCapture | null, extras: DemoExtra[] = [], role: DemoDevice['role'] = 'workstation', linkLocal = capture !== null): DemoDevice {
  deviceIndex += 1;
  return { key: hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-'), hostname, ip, mac: demoMac(1, deviceIndex), lan, role, status, lastSeenAgoMs,
    linked, capture, linkLocal, extras, agentVersion: capture ? '0.121.0' : '0.98.1' };
}
const fresh: DemoCapture = { mode: 'fresh', ageMs: 0 };
const stale = (ageMs: number): DemoCapture => ({ mode: 'stale', ageMs });
const aged = (ageMs: number): DemoCapture => ({ mode: 'aged', ageMs });

/** 32 managed devices: 12 online / 20 offline (4 decommissioned); 24 linked to a discovered asset, 8 managed-only. */
export function demoDevices(): DemoDevice[] {
  deviceIndex = 0;
  return [
    // Online, collection current (re-confirmed by --keep-fresh).
    device('FRONT-01', m(21), 'main', 'online', 0, true, fresh, ['tailscale', 'neighbors']),
    device('FRONT-02', m(22), 'main', 'online', 0, true, fresh, ['neighbors', 'neighbor_mac_conflicts']),
    device('OP-ROOM-1', m(31), 'main', 'online', 0, true, fresh, ['neighbors']),
    device('OP-ROOM-2', m(32), 'main', 'online', 0, true, fresh, ['neighbors']),
    device('OP-ROOM-3', m(33), 'main', 'online', 0, true, fresh, ['neighbors']),
    device('XRAY-01', m(41), 'main', 'online', 0, true, fresh, ['apipa_nic', 'neighbors']),
    device('DR-LAPTOP-02', m(57), 'main', 'online', 0, true, fresh, ['vpn_full_tunnel']),
    device('BILLING-01', m(212), 'main', 'online', 0, false, fresh, ['neighbors']),
    device('SERVER-01', m(10), 'main', 'online', 0, true, fresh, ['neighbors_truncated'], 'server', false),
    // Online agent, but its network collection stalled 11 h ago (#7879 item 3).
    device('OP-ROOM-4', m(34), 'main', 'online', 0, true, stale(11 * HOUR), ['neighbors']),
    device('HYGIENE-1', m(51), 'main', 'online', 0, true, stale(11 * HOUR)),
    // Offline agents whose last capture is hours to days old (still active, stale).
    device('OP-ROOM-5', m(35), 'main', 'offline', 2 * HOUR, true, aged(2 * HOUR)),
    device('OP-ROOM-7', m(37), 'main', 'offline', 9 * HOUR, true, aged(9 * HOUR)),
    device('OP-ROOM-8', m(38), 'main', 'offline', 1 * DAY, true, aged(1 * DAY)),
    device('HYGIENE-2', m(52), 'main', 'offline', 2 * DAY, true, aged(2 * DAY)),
    device('HYGIENE-3', m(53), 'main', 'offline', 3 * DAY, true, aged(3 * DAY), [], 'workstation', false),
    device('STERILE-01', m(61), 'main', 'offline', 4 * DAY, true, aged(4 * DAY)),
    device('LAB-01', m(62), 'main', 'offline', 5 * DAY, true, aged(5 * DAY)),
    device('CONSULT-01', m(233), 'main', 'offline', 6 * HOUR, false, aged(6 * HOUR)),
    device('BILLING-02', m(210), 'main', 'offline', 6 * DAY, false, aged(6 * DAY)),
    // Offline long enough that the retention pass archives their support: the
    // per-observer gateway / 10.1.2.0/24 / fe80::/64 / 169.254.0.0/16 nodes orphan.
    device('PANO-01', m(44), 'main', 'offline', 20 * DAY, true, aged(20 * DAY)),
    device('KIOSK-01', m(137), 'main', 'offline', 9 * DAY, true, aged(9 * DAY), ['apipa_only'], 'workstation', false),
    // Decommissioned (#7879 item 4): two reported before decommissioning, two never.
    device('CHECKOUT-02.decom-3f9a1c2e', m(71), 'main', 'decommissioned', 5 * DAY, true, aged(5 * DAY)),
    device('FRONT-03.decom-a41b77d0', m(23), 'main', 'decommissioned', 4 * DAY, true, aged(4 * DAY)),
    device('OP-ROOM-6.decom-0c55e9b3', m(36), 'main', 'decommissioned', 40 * DAY, true, null),
    device('XRAY-02.decom-7d20f4a6', m(42), 'main', 'decommissioned', 70 * DAY, true, null),
    // Older agents that never sent network context.
    device('DR-OFFICE-01', m(14), 'main', 'offline', 3 * DAY, true, null),
    device('BREAK-01', m(90), 'main', 'offline', 12 * DAY, false, null),
    device('TRAINING-01', m(91), 'main', 'offline', 30 * DAY, false, null),
    // Second LAN 10.1.5.0/24 via 10.1.5.1 (not in the discovery profile).
    device('SURGERY-01', s(21), 'second', 'online', 0, false, fresh, ['neighbors']),
    device('SURGERY-02', s(22), 'second', 'offline', 1 * DAY, false, aged(1 * DAY)),
    device('CBCT-01', s(30), 'second', 'offline', 3 * DAY, false, aged(3 * DAY), [], 'server'),
  ];
}

export type DemoScanPresence = 'answered' | 'missed' | 'stale';
export type DemoAsset = {
  key: string; ip: string; mac: string; hostname: string | null; manufacturer: string | null; model: string | null;
  assetType: 'workstation' | 'server' | 'printer' | 'router' | 'switch' | 'access_point' | 'phone' | 'iot' | 'unknown';
  linkedDeviceKey: string | null;
  /** answered = in the latest completed scan; missed = not in it (is_online false);
   * stale = last answered `staleDays` ago but its sticky is_online is still true (#7879 item 1). */
  presence: DemoScanPresence; staleDays?: number;
  /** Shares its IP with a managed device it is NOT linked to (#7880 item 3). */
  collision?: boolean;
};

/** 80 discovered assets on 10.1.2.0/24: 24 linked to managed devices + 56 discovered-only. */
export function demoAssets(devices: DemoDevice[]): DemoAsset[] {
  const missedDevices = new Set(['pano-01', 'kiosk-01', 'op-room-6-decom-0c55e9b3', 'xray-02-decom-7d20f4a6', 'checkout-02-decom-3f9a1c2e', 'front-03-decom-a41b77d0']);
  const linked: DemoAsset[] = devices.filter(d => d.linked).map(d => ({
    key: `asset-${d.key}`, ip: d.ip, mac: d.mac, hostname: d.hostname.split('.')[0]!.toLowerCase(), manufacturer: 'Dell Inc.',
    model: d.role === 'server' ? 'PowerEdge T150' : 'OptiPlex 7010', assetType: d.role, linkedDeviceKey: d.key,
    presence: missedDevices.has(d.key) ? 'missed' : 'answered',
  }));
  let index = 0;
  const only = (n: number, assetType: DemoAsset['assetType'], manufacturer: string | null, model: string | null, hostname: string | null,
    presence: DemoScanPresence = 'answered', staleDays?: number, collision = false): DemoAsset => {
    index += 1;
    return { key: `asset-${n}`, ip: m(n), mac: demoMac(2, index), hostname, manufacturer, model, assetType, linkedDeviceKey: null, presence,
      ...(staleDays ? { staleDays } : {}), ...(collision ? { collision } : {}) };
  };
  const discovered: DemoAsset[] = [
    only(100, 'router', 'Ubiquiti Inc.', 'UDM-SE', 'gateway'),
    only(2, 'switch', 'Ubiquiti Inc.', 'USW-Pro-24', 'sw-core'),
    only(3, 'switch', 'Ubiquiti Inc.', 'USW-Lite-8', 'sw-ops'),
    only(4, 'access_point', 'Ubiquiti Inc.', 'U6-Lite', 'ap-front'),
    only(5, 'access_point', 'Ubiquiti Inc.', 'U6-Lite', 'ap-ops'),
    only(6, 'access_point', 'Ubiquiti Inc.', 'U6-Mesh', 'ap-lab'),
    // IP collisions: same address as BILLING-01 / CONSULT-01 / BILLING-02, different machine.
    only(212, 'workstation', 'Dell Inc.', 'OptiPlex 3080', 'desktop-7q2lk3m', 'answered', undefined, true),
    only(233, 'workstation', 'Compal Information', null, 'laptop-guest-4', 'answered', undefined, true),
    only(210, 'iot', 'Murata Manufacturing', null, null, 'answered', undefined, true),
    only(150, 'printer', 'Brother Industries', 'MFC-L8900CDW', 'brn-front'),
    only(151, 'printer', 'Brother Industries', 'HL-L6200DW', 'brn-ops'),
    only(152, 'printer', 'Kyocera', 'ECOSYS M3655idn', 'kyo-billing'),
    only(153, 'printer', 'Ricoh', 'IM C3000', null),
    ...Array.from({ length: 16 }, (_, i) => only(160 + i, 'phone', 'Yealink', 'T54W', `sip-ext-${201 + i}`,
      i >= 12 ? 'stale' : 'answered', i >= 12 ? [21, 27, 52, 74][i - 12] : undefined)),
    ...Array.from({ length: 8 }, (_, i) => only(180 + i, 'workstation', 'Dell Inc.', 'OptiPlex 5090', `desktop-${(0x4a1 + i * 37).toString(36)}`,
      i >= 6 ? 'stale' : 'answered', i >= 6 ? [18, 33][i - 6] : undefined)),
    ...Array.from({ length: 4 }, (_, i) => only(190 + i, 'workstation', 'Compal Information', null, null, 'stale', [40, 47, 61, 66][i])),
    ...Array.from({ length: 6 }, (_, i) => only(200 + i, 'iot', 'Murata Manufacturing', null, null, i === 5 ? 'missed' : 'answered')),
    ...Array.from({ length: 3 }, (_, i) => only(220 + i, 'iot', 'Veritone Inc.', null, null, i === 2 ? 'missed' : 'answered')),
    ...[226, 227, 230, 240, 241, 245].map((n, i) => only(n, 'unknown', null, null, null, 'stale', [112, 90, 85, 98, 104, 79][i])),
  ];
  return [...linked, ...discovered];
}

/** 37 saved legacy pins on flat-map coordinates over ~1400×900 (#7880), most on big-LAN members. */
export function demoLegacyPins(assets: DemoAsset[]): { assetKey: string; x: number; y: number }[] {
  let seed = 0x5eed;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const linked = assets.filter(a => a.linkedDeviceKey).slice(0, 20);
  const discovered = assets.filter(a => !a.linkedDeviceKey).slice(0, 17);
  return [...linked, ...discovered].map(asset => ({ assetKey: asset.key, x: Math.round(40 + next() * 1360), y: Math.round(30 + next() * 870) }));
}
