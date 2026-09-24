// A-W05 Task 5c: get_incident_timeline actions/evidence/timeline caps.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
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

function unrestrictedAuth(): AuthContext {
  return {
    principal: { kind: 'user' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

const INCIDENT = {
  id: 'inc-1', orgId: 'org-1', title: 'Incident', classification: 'malware',
  severity: 'p1', status: 'open', summary: 'summary', relatedAlerts: [], affectedDevices: [],
  timeline: Array.from({ length: 150 }, (_, i) => ({ at: `t${i}`, note: `note-${i}` })),
  detectedAt: null, containedAt: null, resolvedAt: null, closedAt: null,
};

function action(i: number) {
  return { id: `act-${i}`, actionType: 'collect_evidence', description: `action ${i}`, executedBy: 'u1', status: 'completed', result: 'ok', reversible: false, reversed: false, executedAt: new Date() };
}
function evidenceRow(i: number) {
  return { id: `ev-${i}`, evidenceType: 'logs', description: `evidence ${i}`, collectedAt: new Date(), collectedBy: 'u1', hash: 'abc', metadata: { secret: 'SECRET' } };
}

describe('get_incident_timeline output shape (A-W05 5c)', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockReads() {
    const actions = Array.from({ length: 80 }, (_, i) => action(i));
    const evidence = Array.from({ length: 80 }, (_, i) => evidenceRow(i));
    mockDb.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([INCIDENT]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(actions) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(evidence) }) }) });
  }

  it('caps actions/evidence at 50 and timeline at 100, reporting the real counts', async () => {
    mockReads();
    const raw = await handlerFor('get_incident_timeline')({ incidentId: 'inc-1' }, unrestrictedAuth());
    const out = JSON.parse(raw) as {
      actions: unknown[]; actionCount: number; evidence: Array<{ metadata?: unknown }>; evidenceCount: number;
      timeline: unknown[]; timelineCount: number;
    };
    expect(out.actions).toHaveLength(50);
    expect(out.actionCount).toBe(80);
    expect(out.evidence).toHaveLength(50);
    expect(out.evidenceCount).toBe(80);
    expect(out.timeline).toHaveLength(100);
    expect(out.timelineCount).toBe(150);
    // metadata excluded by default
    expect(out.evidence[0]!.metadata).toBeUndefined();
  });

  it('includes evidence metadata only when includeEvidenceMetadata is true', async () => {
    mockReads();
    const raw = await handlerFor('get_incident_timeline')({ incidentId: 'inc-1', includeEvidenceMetadata: true }, unrestrictedAuth());
    const out = JSON.parse(raw) as { evidence: Array<{ metadata?: unknown }> };
    expect(out.evidence[0]!.metadata).toEqual({ secret: 'SECRET' });
  });

  it('a default (small) incident fits the chat budget uncompacted', async () => {
    const small = { ...INCIDENT, timeline: [{ at: 't0', note: 'created' }] };
    mockDb.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([small]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([action(0), action(1)]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([evidenceRow(0)]) }) }) });
    const raw = await handlerFor('get_incident_timeline')({ incidentId: 'inc-1' }, unrestrictedAuth());
    expectDefaultPageFits('get_incident_timeline', raw);
  });
});
