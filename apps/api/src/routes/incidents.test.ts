import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const testPerms = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (testPerms.current) c.set('permissions', testPerms.current);
    c.set('auth', {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'ops@example.com',
        name: 'Ops User',
      },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue('event-id'),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('./incidents.helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./incidents.helpers')>();
  return {
    ...actual,
    buildIncidentFeed: vi.fn(),
  };
});

import { db } from '../db';
import { incidentRoutes } from './incidents';
import { publishEvent } from '../services/eventBus';
import { buildIncidentFeed, FeedScopeError } from './incidents.helpers';

function mockSelectSingle(row: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as any;
}

function mockCountSelect(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: total }]),
    }),
  } as any;
}

function mockListSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as any;
}

function mockOrderedSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any;
}

function mockContainmentTransaction(incident: unknown, action: unknown, updatedIncident: unknown) {
  vi.mocked(db.transaction).mockImplementationOnce(async (callback: any) => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(incident ? [incident] : []),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([action]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedIncident]),
          }),
        }),
      }),
    };
    return callback(tx);
  });
}

function mockCloseTransaction(incident: unknown, updated: unknown) {
  vi.mocked(db.transaction).mockImplementationOnce(async (callback: any) => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(incident ? [incident] : []),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updated ? [updated] : []),
          }),
        }),
      }),
    };
    return callback(tx);
  });
}

function mockEvidenceTransaction(evidence: unknown) {
  vi.mocked(db.transaction).mockImplementationOnce(async (callback: any) => {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([evidence]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    return callback(tx);
  });
}

describe('incidentRoutes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    testPerms.current = undefined;
    app = new Hono();
    app.route('/incidents', incidentRoutes);
  });

  it('creates an incident from POST /incidents', async () => {
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: '33333333-3333-4333-8333-333333333333',
              orgId: '22222222-2222-4222-8222-222222222222',
              title: 'Ransomware behavior detected',
              classification: 'malware',
              severity: 'p1',
              status: 'detected',
              relatedAlerts: [],
              affectedDevices: [],
            },
          ]),
        }),
      }),
    } as any);

    const res = await app.request('/incidents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Ransomware behavior detected',
        classification: 'malware',
        severity: 'p1',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      'incident.created',
      '22222222-2222-4222-8222-222222222222',
      expect.any(Object),
      'incidents-route',
      expect.any(Object),
    );
  });

  it('persists sourceType/sourceRef when promoting an EDR finding', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: '33333333-3333-4333-8333-333333333333',
            orgId: '22222222-2222-4222-8222-222222222222',
            title: 'Huntress: Suspicious login',
            classification: 'huntress-incident',
            severity: 'p1',
            status: 'detected',
            relatedAlerts: [],
            affectedDevices: [],
            sourceType: 'huntress_incident',
            sourceRef: 'hunt-abc-123',
          },
        ]),
      }),
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as any);

    const res = await app.request('/incidents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Huntress: Suspicious login',
        classification: 'huntress-incident',
        severity: 'p1',
        sourceType: 'huntress_incident',
        sourceRef: 'hunt-abc-123',
      }),
    });

    expect(res.status).toBe(201);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'huntress_incident',
        sourceRef: 'hunt-abc-123',
      })
    );
  });

  it('returns 409 (not 500) when the same EDR finding is promoted twice', async () => {
    // The route uses .onConflictDoNothing().returning() rather than catching a
    // raised 23505: withDbAccessContext wraps the request in a postgres.js
    // transaction that re-throws the original error at commit time even after
    // it's caught, turning a mapped 409 back into a raw 500 (see
    // createCatalogItem in catalogService.ts). Zero returned rows is how the
    // route detects the duplicate `incidents_source_ref_unique` collision.
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request('/incidents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Huntress: Suspicious login',
        classification: 'huntress-incident',
        severity: 'p1',
        sourceType: 'huntress_incident',
        sourceRef: 'hunt-abc-123',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already been promoted/i);
  });

  // #8166 A4: EDR-framework promotion verifies sourceRef server-side.
  describe('promoting an EDR-framework detection (edr_detection)', () => {
    const DET_ID = 'abcdef44-4444-4444-8444-44444444abcd';
    const DEV_A = '55555555-5555-4555-8555-555555555555';
    const DEV_B = '66666666-6666-4666-8666-666666666666';
    const SITE_A = '77777777-7777-4777-8777-777777777777';
    const SITE_B = '88888888-8888-4888-8888-888888888888';
    const restrictedToSiteA = { permissions: [], partnerId: null, orgId: null, roleId: 'r', scope: 'organization', allowedSiteIds: [SITE_A] };
    const promote = (sourceRef: unknown) => app.request('/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        title: 'EDR: Trojan detected', classification: 'malware', severity: 'p2',
        sourceType: 'edr_detection', ...(sourceRef === undefined ? {} : { sourceRef }),
      }),
    });
    const insertReturning = (rows: unknown[]) => {
      const values = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
      });
      vi.mocked(db.insert).mockReturnValueOnce({ values } as any);
      return values;
    };
    const devicesSelect = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    }) as any;
    const detection = (over: Record<string, unknown> = {}) => ({
      id: DET_ID, breezeDeviceId: DEV_A, deviceDetachedAt: null, lastSiteId: null, ...over,
    });
    const created = {
      id: '33333333-3333-4333-8333-333333333333', orgId: '22222222-2222-4222-8222-222222222222',
      title: 'EDR: Trojan detected', classification: 'malware', severity: 'p2', status: 'detected',
      relatedAlerts: [], affectedDevices: [], sourceType: 'edr_detection', sourceRef: DET_ID,
    };

    it('promotes a visible detection (201) with source_type edr_detection', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle(detection()));
      const values = insertReturning([created]);
      const res = await promote(DET_ID);
      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'edr_detection', sourceRef: DET_ID }));
    });

    it('stores the canonical (lowercase) detection id so an uppercase sourceRef cannot dodge the unique index', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle(detection()));
      const values = insertReturning([created]);
      const res = await promote(DET_ID.toUpperCase());
      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: DET_ID }));
    });

    it('the detection lookup is pinned to the incident org, the id and live rows', async () => {
      const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) } as any);
      await promote(DET_ID);
      const { PgDialect } = await import('drizzle-orm/pg-core');
      const q = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
      expect(q.sql).toContain('"edr_detections"."id" = $');
      expect(q.sql).toContain('"edr_detections"."org_id" = $');
      expect(q.sql).toContain('"edr_detections"."detached_at" is null');
      expect(q.params).toEqual(expect.arrayContaining([DET_ID, '22222222-2222-4222-8222-222222222222']));
    });

    it('a second promotion of the same detection is a 409', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle(detection()));
      insertReturning([]);
      const res = await promote(DET_ID);
      expect(res.status).toBe(409);
    });

    it('a detection id not visible in the incident org (foreign org / tombstone) is a 404 and inserts nothing', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle(null));
      const res = await promote(DET_ID);
      expect(res.status).toBe(404);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('a non-uuid or missing sourceRef is a 400 and touches nothing', async () => {
      for (const ref of ['not-a-uuid', undefined]) {
        const res = await promote(ref);
        expect(res.status).toBe(400);
      }
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('a site-restricted caller cannot promote another site detection (403, no insert)', async () => {
      testPerms.current = restrictedToSiteA;
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectSingle(detection({ breezeDeviceId: DEV_B })))
        .mockReturnValueOnce(devicesSelect([{ id: DEV_A, siteId: SITE_A }, { id: DEV_B, siteId: SITE_B }]));
      const res = await promote(DET_ID);
      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('a site-restricted caller cannot promote a detection detached from another site', async () => {
      testPerms.current = restrictedToSiteA;
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectSingle(detection({ breezeDeviceId: null, deviceDetachedAt: new Date(), lastSiteId: SITE_B })))
        .mockReturnValueOnce(devicesSelect([{ id: DEV_A, siteId: SITE_A }]));
      const res = await promote(DET_ID);
      expect(res.status).toBe(403);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('a site-restricted caller may promote a detection on an allowed-site device', async () => {
      testPerms.current = restrictedToSiteA;
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectSingle(detection()))
        .mockReturnValueOnce(devicesSelect([{ id: DEV_A, siteId: SITE_A }]));
      insertReturning([created]);
      const res = await promote(DET_ID);
      expect(res.status).toBe(201);
    });
  });

  it('rejects high-risk containment without approvalRef', async () => {
    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/contain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        actionType: 'network_isolation',
        description: 'Isolate host from network',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/approvalRef/i);
  });

  it('does not mark incident contained for failed containment actions', async () => {
    mockContainmentTransaction(
      {
        id: '33333333-3333-4333-8333-333333333333',
        orgId: '22222222-2222-4222-8222-222222222222',
        title: 'Credential compromise',
        status: 'analyzing',
        timeline: [],
      },
      {
        id: 'action-1',
        actionType: 'process_kill',
        executedBy: 'user',
        status: 'failed',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'analyzing',
      }
    );

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/contain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        actionType: 'process_kill',
        description: 'Kill suspicious process',
        status: 'failed',
        approvalRef: 'APPROVE-001',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incident.status).toBe('analyzing');
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalledWith(
      'incident.contained',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('lists incidents with pagination metadata', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockCountSelect(2))
      .mockReturnValueOnce(mockListSelect([
        {
          id: 'i-1',
          title: 'Incident 1',
          status: 'detected',
        },
        {
          id: 'i-2',
          title: 'Incident 2',
          status: 'contained',
        },
      ]));

    const res = await app.request('/incidents?page=1&limit=2', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.total).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  it('denies list access when organization query is outside org scope', async () => {
    const res = await app.request('/incidents?orgId=99999999-9999-4999-8999-999999999999', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/denied/i);
  });

  it('rejects hash/content mismatch during evidence upload', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle({
      id: '33333333-3333-4333-8333-333333333333',
      orgId: '22222222-2222-4222-8222-222222222222',
      title: 'Credential compromise',
      status: 'analyzing',
      timeline: [],
    }));

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/evidence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        evidenceType: 'log',
        storagePath: 's3://incident-evidence/org-1/log.txt',
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentBase64: 'aGVsbG8=',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hash/i);
  });

  it('stores evidence when content hash is computed server-side', async () => {
    vi.mocked(db.select).mockReturnValueOnce(mockSelectSingle({
      id: '33333333-3333-4333-8333-333333333333',
      orgId: '22222222-2222-4222-8222-222222222222',
      title: 'Credential compromise',
      status: 'analyzing',
      timeline: [],
    }));
    mockEvidenceTransaction({
      id: 'evidence-1',
      evidenceType: 'log',
      storagePath: 's3://incident-evidence/org-1/log.txt',
      hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      hashAlgorithm: 'sha256',
    });

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/evidence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        evidenceType: 'log',
        storagePath: 's3://incident-evidence/org-1/log.txt',
        contentBase64: 'aGVsbG8=',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hashAlgorithm).toBe('sha256');
  });

  it('rejects close transition from analyzing', async () => {
    mockCloseTransaction(
      {
        id: '33333333-3333-4333-8333-333333333333',
        orgId: '22222222-2222-4222-8222-222222222222',
        title: 'Credential compromise',
        status: 'analyzing',
        timeline: [],
      },
      null
    );

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/close', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        summary: 'Attempted premature close',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot transition/i);
  });

  it('closes an incident from POST /incidents/:id/close', async () => {
    mockCloseTransaction(
      {
        id: '33333333-3333-4333-8333-333333333333',
        orgId: '22222222-2222-4222-8222-222222222222',
        title: 'Credential compromise',
        status: 'contained',
        timeline: [],
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        orgId: '22222222-2222-4222-8222-222222222222',
        title: 'Credential compromise',
        status: 'closed',
        resolvedAt: new Date('2026-02-26T10:00:00.000Z'),
        closedAt: new Date('2026-02-26T10:00:00.000Z'),
      }
    );

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/close', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        summary: 'Credentials rotated and endpoint restored',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('closed');
    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      'incident.closed',
      '22222222-2222-4222-8222-222222222222',
      expect.any(Object),
      'incidents-route',
      expect.any(Object),
    );
  });

  it('GET /incidents/feed returns the unified union with pagination', async () => {
    vi.mocked(buildIncidentFeed).mockResolvedValueOnce({
      rows: [
        {
          kind: 'tracked',
          source: 'breeze',
          sourceId: 'i-1',
          title: 'Test incident',
          severity: 'p1',
          edrStatus: null,
          status: 'detected',
          deviceId: null,
          detectedAt: new Date().toISOString(),
          trackedIncidentId: 'i-1',
          linkOut: null,
        },
      ],
      total: 1,
    });

    const res = await app.request('/incidents/feed?limit=25', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      data: expect.any(Array),
      pagination: { page: 1, limit: 25 },
    });
  });

  it('GET /incidents/feed surfaces scope errors as their status', async () => {
    vi.mocked(buildIncidentFeed).mockRejectedValueOnce(
      new FeedScopeError(403, 'Access to this organization denied')
    );

    const res = await app.request('/incidents/feed?orgId=00000000-0000-0000-0000-000000000999', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(403);
  });

  it('builds incident report with evidence and action summaries', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectSingle({
        id: '33333333-3333-4333-8333-333333333333',
        orgId: '22222222-2222-4222-8222-222222222222',
        title: 'Credential compromise',
        classification: 'identity',
        severity: 'p1',
        status: 'closed',
        summary: 'Resolved',
        detectedAt: new Date('2026-02-26T09:00:00.000Z'),
        containedAt: new Date('2026-02-26T09:15:00.000Z'),
        resolvedAt: new Date('2026-02-26T10:00:00.000Z'),
        closedAt: new Date('2026-02-26T10:10:00.000Z'),
        timeline: [],
      }))
      .mockReturnValueOnce(mockOrderedSelect([
        {
          id: 'ev-1',
          evidenceType: 'log',
        },
        {
          id: 'ev-2',
          evidenceType: 'log',
        },
      ]))
      .mockReturnValueOnce(mockOrderedSelect([
        {
          id: 'ac-1',
          status: 'completed',
          reversible: true,
        },
        {
          id: 'ac-2',
          status: 'failed',
          reversible: false,
        },
      ]));

    const res = await app.request('/incidents/33333333-3333-4333-8333-333333333333/report', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.evidenceSummary.total).toBe(2);
    expect(body.report.actionSummary.completed).toBe(1);
    expect(body.report.actionSummary.failed).toBe(1);
  });
});
