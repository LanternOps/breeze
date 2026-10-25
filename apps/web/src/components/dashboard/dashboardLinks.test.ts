import { describe, expect, it } from 'vitest';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readDeviceClassFromHash } from '../devices/deviceClassFilter';
import { topLevelNav, navSections } from '../layout/Sidebar';
import { canOpenDestination, pickNavGate, type NavViewer } from '../../lib/navVisibility';
import {
  DASHBOARD_METRICS,
  DESTINATION_GATES,
  metricHref,
  type MetricDef,
  type MetricKey,
} from './dashboardLinks';
import type { DeviceStats } from './types';

const stats: DeviceStats = {
  total: 10,
  online: 6,
  offline: 3,
  byStatus: { online: 6, offline: 3, maintenance: 1 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};

const viewer = (over: Partial<NavViewer> = {}): NavViewer => ({
  isPlatformAdmin: false,
  permissions: [{ resource: '*', action: '*' }],
  getScope: () => 'partner',
  toolSourcesEnabled: false,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
  ...over,
});

const entries = Object.entries(DASHBOARD_METRICS) as Array<[MetricKey, MetricDef]>;

describe('DASHBOARD_METRICS registry', () => {
  it('every entry has a valid kind', () => {
    for (const [, def] of entries) {
      expect(['count', 'affected', 'section', 'exempt']).toContain(def.kind);
    }
  });

  it('every exempt entry has a non-empty reason', () => {
    for (const [key, def] of entries) {
      if (def.kind === 'exempt') expect(def.reason?.trim(), key).toBeTruthy();
    }
  });

  it('every count/affected/section entry has an href', () => {
    for (const [key, def] of entries) {
      if (def.kind !== 'exempt') expect(typeof def.href, key).toBe('function');
    }
  });

  it('links never carry an org (R3)', () => {
    for (const [key] of entries) {
      const href = metricHref(key, { devices: stats });
      if (href) expect(href, key).not.toMatch(/orgId/i);
    }
  });

  it('security.atRisk is exempt with a reason (Gate B #6)', () => {
    expect(DASHBOARD_METRICS['security.atRisk'].kind).toBe('exempt');
  });
});

describe('devices hrefs', () => {
  const decode = (key: MetricKey) => {
    const href = metricHref(key, { devices: stats })!;
    const hash = href.slice(href.indexOf('#'));
    return { href, hash, filter: decodeFilterFromHash(hash), cls: readDeviceClassFromHash(hash) };
  };

  it('Total devices → agent class, no status filter', () => {
    const { href, filter, cls } = decode('kpi.totalDevices');
    expect(href).toBe('/devices#deviceClass=agent');
    expect(filter).toBeNull();
    expect(cls).toBe('agent');
  });

  it('Online tile and legend decode to status equals online + agent', () => {
    for (const key of ['kpi.online', 'fleet.legend.online'] as const) {
      const { href, filter, cls } = decode(key);
      expect(href, key).not.toContain('?status=');
      expect(cls).toBe('agent');
      expect(filter).toEqual({ operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] });
    }
  });

  it('Offline legend and "View N offline" decode to status equals offline + agent', () => {
    for (const key of ['fleet.legend.offline', 'fleet.viewOffline'] as const) {
      const { href, filter, cls } = decode(key);
      expect(href, key).not.toContain('?status=');
      expect(cls).toBe('agent');
      expect(filter?.conditions).toEqual([{ field: 'status', operator: 'equals', value: 'offline' }]);
    }
  });

  it('Other legend is status in the remaining byStatus keys', () => {
    const { filter } = decode('fleet.legend.other');
    expect(filter?.conditions).toEqual([{ field: 'status', operator: 'in', value: ['maintenance'] }]);
  });

  it('Other legend has no href when nothing remains', () => {
    const none = { devices: { ...stats, byStatus: { online: 6, offline: 3 } } };
    expect(metricHref('fleet.legend.other', none)).toBeNull();
  });

  it('card titles are section links', () => {
    expect(DASHBOARD_METRICS['fleet.title'].kind).toBe('section');
    expect(metricHref('fleet.title', { devices: stats })).toBe('/devices#deviceClass=agent');
  });
});

// #9791 C: device-grain patch numbers are count links into the filtered
// compliance list; patch-grain numbers stay text with a named affected link.
describe('patch registry (#9791 C)', () => {
  it.each([
    ['kpi.patchCompliance', 'count', '/patches#compliance'],
    ['patch.devicesCompliant', 'count', '/patches#compliance&status=compliant'],
    ['patch.devicesNonCompliant', 'count', '/patches#compliance&status=needs-patches'],
    ['patch.viewPendingDevices', 'affected', '/patches#compliance&status=needs-patches'],
    ['patch.viewFailedDevices', 'affected', '/patches#compliance&status=failed'],
    ['patch.viewCriticalDevices', 'affected', '/patches#compliance&status=critical'],
  ] as const)('%s is %s → %s', (key, kind, href) => {
    expect(DASHBOARD_METRICS[key].kind).toBe(kind);
    expect(metricHref(key)).toBe(href);
  });

  it.each([
    'patch.headline',
    'patch.installed',
    'patch.pending',
    'patch.failed',
    'patch.criticalPending',
    'patch.unratedPending',
    'patch.imagesNotChecked',
  ] as const)('%s stays exempt with a reason', (key) => {
    const def: MetricDef = DASHBOARD_METRICS[key];
    expect(def.kind).toBe('exempt');
    expect(def.reason?.length).toBeGreaterThan(10);
  });

  it('patch links need devices:read (the /patches nav gate)', () => {
    const noDevices = viewer({ permissions: [{ resource: 'alerts', action: 'read' }] });
    for (const key of ['kpi.patchCompliance', 'patch.devicesCompliant', 'patch.viewFailedDevices'] as const) {
      expect(DASHBOARD_METRICS[key].visible?.(noDevices)).toBe(false);
      expect(DASHBOARD_METRICS[key].visible?.(viewer())).toBe(true);
    }
  });
});

describe('visibility gates (R4)', () => {
  it('devices links need devices:read', () => {
    const v = viewer({ permissions: [{ resource: 'alerts', action: 'read' }] });
    expect(DASHBOARD_METRICS['kpi.online'].visible?.(v)).toBe(false);
    expect(DASHBOARD_METRICS['kpi.online'].visible?.(viewer())).toBe(true);
  });

  it('tickets link hides when service management is off', () => {
    expect(DASHBOARD_METRICS['kpi.tickets'].visible?.(viewer({ serviceManagementMode: 'off' }))).toBe(false);
    expect(DASHBOARD_METRICS['kpi.tickets'].visible?.(viewer())).toBe(true);
  });
});

describe('each metric is gated by its own destination', () => {
  const viewers = [
    viewer(),
    viewer({ permissions: [] }),
    viewer({ permissions: [{ resource: 'tickets', action: 'read' }] }),
    viewer({ permissions: [{ resource: 'alerts', action: 'read' }] }),
    viewer({ permissions: [{ resource: 'devices', action: 'read' }] }),
    viewer({ serviceManagementMode: 'off' }),
  ];
  for (const [key, def] of entries) {
    if (def.kind === 'exempt') continue;
    it(key, () => {
      const href = metricHref(key, { devices: stats })!;
      // A sub-page (`/security/vulnerabilities`) is gated by its Sidebar section
      // root (`/security`): resolve to the longest registered gate prefix.
      const pathname = new URL(href, 'http://x').pathname;
      const path = ((Object.keys(DESTINATION_GATES) as Array<keyof typeof DESTINATION_GATES>)
        .filter((g) => pathname === g || pathname.startsWith(`${g}/`))
        .sort((a, b) => b.length - a.length)[0] ?? pathname) as keyof typeof DESTINATION_GATES;
      expect(DESTINATION_GATES[path], `no gate for ${path}`).toBeTruthy();
      for (const v of viewers) {
        expect(def.visible?.(v)).toBe(canOpenDestination(DESTINATION_GATES[path], v));
      }
    });
  }
});

describe('gates match the Sidebar item for the same destination', () => {
  const allItems = [...topLevelNav, ...navSections.flatMap((s) => s.items)];
  const sectionGate = (path: string) => {
    for (const s of navSections) {
      if (s.items.some((i) => i.href === path)) return s.requiresModule;
    }
    return undefined;
  };
  for (const [path, gate] of Object.entries(DESTINATION_GATES)) {
    it(path, () => {
      const item = allItems.find((i) => i.href === path);
      expect(item, `no Sidebar item for ${path}`).toBeTruthy();
      const expected = { ...pickNavGate(item!) };
      const mod = sectionGate(path);
      if (mod && !expected.requiresModule) expected.requiresModule = mod;
      expect(gate).toEqual(expected);
    });
  }
});
