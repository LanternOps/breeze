/**
 * Audit 2026-09-17 §1.1 — `findIncidentWithAccess` / `scopedAffectedDevices`
 * narrowed the EXACT-DEVICE axis only, which is correct for an agent run and a
 * complete no-op for the human the site axis exists to constrain: a technician
 * restricted to site-1 read any org incident's full timeline, containment
 * history and forensic evidence for devices in sites they cannot access.
 *
 * Both axes now apply, via `resolveSiteAllowedDeviceIds` (their INTERSECTION).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));

import { db } from '../db';
import { registerIncidentTools } from './aiToolsIncident';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerIncidentTools(reg);
  return reg.get(name)!.handler;
}

/** A HUMAN technician: `canAccessSite` is ALWAYS defined (true when unrestricted),
 *  and a site-restricted human never carries `allowedDeviceIds`. */
function human(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

function incident(affectedDevices: string[]) {
  return {
    id: 'inc-1', orgId: 'org-1', title: 'SECRET-INCIDENT', classification: 'malware',
    severity: 'p1', status: 'open', summary: 's', relatedAlerts: [], affectedDevices,
    timeline: [{ at: 'now', note: 'SECRET-TIMELINE' }],
    detectedAt: null, containedAt: null, resolvedAt: null, closedAt: null,
  };
}

/** dev-1 lives in site-1, dev-2 in site-2. */
const ORG_DEVICES = [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-2' }];
let deviceScans = 0;

function mockReads(inc: ReturnType<typeof incident>) {
  deviceScans = 0;
  mockDb.select.mockImplementation((cols?: any) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => Promise.resolve([]),
      limit: () => Promise.resolve([inc]),
      // Awaiting the chain without limit/orderBy = the device→site scan.
      then: (resolve: (v: unknown) => unknown) => {
        if (cols !== undefined) deviceScans += 1;
        return Promise.resolve(ORG_DEVICES).then(resolve);
      },
    };
    return chain;
  });
}

describe('incident reads — site axis', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const tool of ['get_incident_timeline', 'generate_incident_report']) {
    it(`${tool} refuses a site-restricted human an incident about a device in another site`, async () => {
      mockReads(incident(['dev-2']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, human(['site-1'])));
      expect(out.error).toBeTruthy();
      expect(JSON.stringify(out)).not.toContain('SECRET-TIMELINE');
    });

    it(`${tool} refuses a site-restricted human a device-LESS incident (not attributable)`, async () => {
      mockReads(incident([]));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, human(['site-1'])));
      expect(out.error).toBeTruthy();
    });

    it(`${tool} still serves an incident about a device in the human's OWN site`, async () => {
      mockReads(incident(['dev-1']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, human(['site-1'])));
      expect(out.error).toBeUndefined();
    });

    it(`${tool} is unchanged for an unrestricted human, with NO device scan`, async () => {
      mockReads(incident(['dev-2']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, human(undefined)));
      expect(out.error).toBeUndefined();
      expect(deviceScans).toBe(0);
    });
  }

  it('get_incident_timeline echoes only the devices inside the human\'s sites', async () => {
    mockReads(incident(['dev-1', 'dev-2']));
    const out = JSON.parse(await handlerFor('get_incident_timeline')({ incidentId: 'inc-1' }, human(['site-1'])));
    expect(out.incident.affectedDevices).toEqual(['dev-1']);
  });

  it('generate_incident_report echoes only the devices inside the human\'s sites', async () => {
    mockReads(incident(['dev-1', 'dev-2']));
    const out = JSON.parse(await handlerFor('generate_incident_report')({ incidentId: 'inc-1' }, human(['site-1'])));
    expect(out.report.affectedDevices).toEqual(['dev-1']);
  });

  it('execute_containment refuses a site-restricted human an out-of-site incident', async () => {
    mockReads(incident(['dev-2']));
    const out = JSON.parse(await handlerFor('execute_containment')(
      { incidentId: 'inc-1', deviceId: 'dev-2', actionType: 'collect_evidence' }, human(['site-1']),
    ));
    expect(out.error).toBeTruthy();
  });

  it('collect_evidence refuses a site-restricted human an out-of-site incident', async () => {
    mockReads(incident(['dev-2']));
    const out = JSON.parse(await handlerFor('collect_evidence')(
      { incidentId: 'inc-1', deviceId: 'dev-2', evidenceTypes: ['logs'] }, human(['site-1']),
    ));
    expect(out.error).toBeTruthy();
  });
});
