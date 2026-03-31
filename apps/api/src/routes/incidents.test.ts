import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
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

import { db } from '../db';
import { incidentRoutes } from './incidents';
import { publishEvent } from '../services/eventBus';

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
    app = new Hono();
    app.route('/incidents', incidentRoutes);
  });

  it('creates an incident from POST /incidents', async () => {
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
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
