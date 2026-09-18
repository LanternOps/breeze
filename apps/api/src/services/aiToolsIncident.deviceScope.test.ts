/**
 * #6096 finding 8 — `findIncidentWithAccess` gated on the ORG axis only, so
 * `get_incident_timeline` / `generate_incident_report` handed a device-bound AI
 * run the full timeline, actions and forensic evidence of any incident in the
 * org, including ones about devices it was never bound to.
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

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
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

function mockReads(inc: ReturnType<typeof incident>) {
  mockDb.select.mockImplementation((cols?: any) => {
    if (cols === undefined) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([inc]) }) }) };
    }
    return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) };
  });
  // both the incident read and the action/evidence reads go through select()
  mockDb.select.mockImplementation(() => {
    let usedLimit = false;
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => Promise.resolve([]),
      limit: () => { usedLimit = true; return Promise.resolve([inc]); },
    };
    void usedLimit;
    return chain;
  });
}

describe('incident reads — exact-device scope', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const tool of ['get_incident_timeline', 'generate_incident_report']) {
    it(`${tool} refuses an incident about only a sibling device`, async () => {
      mockReads(incident(['dev-2']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, auth(['dev-1'], ['site-1'])));
      expect(out.error).toBeTruthy();
      expect(JSON.stringify(out)).not.toContain('SECRET-TIMELINE');
    });

    it(`${tool} refuses it for a device-LESS analysis run too`, async () => {
      mockReads(incident(['dev-2']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, auth(['dev-1'], undefined)));
      expect(out.error).toBeTruthy();
    });

    it(`${tool} refuses an incident with NO affected devices (not attributable)`, async () => {
      mockReads(incident([]));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, auth(['dev-1'], ['site-1'])));
      expect(out.error).toBeTruthy();
    });

    it(`${tool} still serves an incident touching the run's OWN device`, async () => {
      mockReads(incident(['dev-1']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, auth(['dev-1'], ['site-1'])));
      expect(out.error).toBeUndefined();
    });

    it(`${tool} is unchanged for an unrestricted caller`, async () => {
      mockReads(incident(['dev-2']));
      const out = JSON.parse(await handlerFor(tool)({ incidentId: 'inc-1' }, auth(undefined, undefined)));
      expect(out.error).toBeUndefined();
    });
  }

  it('get_incident_timeline filters affectedDevices down to the allowlist', async () => {
    mockReads(incident(['dev-1', 'dev-2']));
    const out = JSON.parse(await handlerFor('get_incident_timeline')({ incidentId: 'inc-1' }, auth(['dev-1'], ['site-1'])));
    expect(out.incident.affectedDevices).toEqual(['dev-1']);
  });
});
