import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { db } from '../../db';
import { agentSecurityRoutes, managementPostureChanges } from './security';
import { writeAuditEvent } from '../../services/auditEvents';
import { upsertSecurityStatusForDevice } from './helpers';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    managementPosture: 'devices.managementPosture',
  },
  securityStatus: {
    deviceId: 'security_status.deviceId',
    provider: 'security_status.provider',
    threatCount: 'security_status.threatCount',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('./helpers', () => ({
  upsertSecurityStatusForDevice: vi.fn(async () => ({ provider: 'windows_defender', threatCount: 0 })),
}));

const recordAgentIngestSubmission = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({ recordAgentIngestSubmission }));

function mountWithRole(role: 'agent' | 'watchdog' | undefined): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // Simulate agentAuthMiddleware setting the credential context.
    if (role) {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
        role,
      } as never);
    }
    return next();
  });
  app.route('/agents', agentSecurityRoutes);
  return app;
}

function selectResolving(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never;
}

/**
 * Queue the handler's reads in order: the device row, then (security status
 * only) the previously stored status row.
 */
function mockDeviceLookup(
  device: Record<string, unknown> = {},
  previousStatus: Array<Record<string, unknown>> = [],
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(selectResolving([{ id: DEVICE_ID, orgId: ORG_ID, managementPosture: null, ...device }]))
    .mockReturnValueOnce(selectResolving(previousStatus));
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return set;
}

describe('agent security routes — requireAgentRole gate (F3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued mockReturnValueOnce values; the status route
    // reads less on some paths, so drop any leftover queued select.
    vi.mocked(db.select).mockReset();
  });

  describe('PUT /agents/:id/security/status', () => {
    it('rejects a watchdog-role token with 403', async () => {
      const app = mountWithRole('watchdog');
      const res = await app.request(`/agents/${AGENT_ID}/security/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'defender', threatCount: 0 }),
      });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows the main agent-role token', async () => {
      mockDeviceLookup();
      const app = mountWithRole('agent');
      const res = await app.request(`/agents/${AGENT_ID}/security/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'defender', threatCount: 0 }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /agents/:id/management/posture', () => {
    const validPosture = {
      collectedAt: '2026-06-20T00:00:00.000Z',
      scanDurationMs: 0,
      categories: {},
      identity: {
        joinType: 'none',
        azureAdJoined: false,
        domainJoined: false,
        workplaceJoined: false,
        source: 'agent',
      },
    };

    it('rejects a watchdog-role token with 403', async () => {
      const app = mountWithRole('watchdog');
      const res = await app.request(`/agents/${AGENT_ID}/management/posture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPosture),
      });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows the main agent-role token', async () => {
      mockDeviceLookup();
      const app = mountWithRole('agent');
      const res = await app.request(`/agents/${AGENT_ID}/management/posture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPosture),
      });
      expect(res.status).toBe(200);
    });

    // Pinning test, not coverage of a behaviour change: `source` is already
    // `z.string()` and the payload is stored whole, so this passes pre-fix too.
    // It exists because the web identity card distinguishes "never checked"
    // from "checked and not joined" purely by identity.source === 'unsupported'
    // (#5626). If anyone later narrows `source` to an enum allowlist or picks
    // fields on write, Linux devices silently go back to reading as genuinely
    // unjoined — this test is what stops that landing unnoticed.
    it('pins the unsupported detection source as accepted and stored verbatim', async () => {
      const set = mockDeviceLookup();
      const app = mountWithRole('agent');
      const unsupportedPosture = {
        ...validPosture,
        identity: { ...validPosture.identity, source: 'unsupported' },
      };
      const res = await app.request(`/agents/${AGENT_ID}/management/posture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unsupportedPosture),
      });

      expect(res.status).toBe(200);
      expect(set).toHaveBeenCalledTimes(1);
      const written = set.mock.calls[0]?.[0] as { managementPosture: typeof unsupportedPosture };
      expect(written.managementPosture.identity).toEqual(unsupportedPosture.identity);
    });
  });

  // #4340 — per-submit `agent.security_status.submit` / `.management_posture.
  // submit` audits were ~15% of audit_logs. The canonical rows are overwritten
  // in place, so the audit is kept — but only for a REAL change.
  describe('change-only auditing (#4340)', () => {
    const put = (path: string, body: unknown) => mountWithRole('agent').request(`/agents/${AGENT_ID}/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    describe('security status', () => {
      it('does NOT audit a re-report with the same provider and threat count', async () => {
        mockDeviceLookup({}, [{ provider: 'windows_defender', threatCount: 0 }]);
        const res = await put('security/status', { provider: 'defender', threatCount: 0 });

        expect(res.status).toBe(200);
        expect(writeAuditEvent).not.toHaveBeenCalled();
        expect(recordAgentIngestSubmission).toHaveBeenCalledWith('security_status', 'success');
      });

      it('audits a threat-count change with before/after', async () => {
        mockDeviceLookup({}, [{ provider: 'windows_defender', threatCount: 0 }]);
        vi.mocked(upsertSecurityStatusForDevice).mockResolvedValueOnce({ provider: 'windows_defender', threatCount: 3 });
        const res = await put('security/status', { provider: 'defender', threatCount: 3 });

        expect(res.status).toBe(200);
        expect(writeAuditEvent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({
          orgId: ORG_ID,
          actorType: 'agent',
          actorId: AGENT_ID,
          action: 'agent.security_status.submit',
          resourceType: 'device',
          resourceId: DEVICE_ID,
          details: {
            provider: 'windows_defender',
            threatCount: 3,
            changes: [{ field: 'threatCount', before: 0, after: 3 }],
          },
        });
      });

      it('audits a provider change with before/after', async () => {
        mockDeviceLookup({}, [{ provider: 'windows_defender', threatCount: 0 }]);
        vi.mocked(upsertSecurityStatusForDevice).mockResolvedValueOnce({ provider: 'crowdstrike', threatCount: 0 });
        const res = await put('security/status', { provider: 'crowdstrike', threatCount: 0 });

        expect(res.status).toBe(200);
        const details = (vi.mocked(writeAuditEvent).mock.calls[0]![1] as unknown as { details: { changes: unknown[] } }).details;
        expect(details.changes).toEqual([{ field: 'provider', before: 'windows_defender', after: 'crowdstrike' }]);
      });

      it('counts a failed previous-row read as a failed ingest and rethrows', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(selectResolving([{ id: DEVICE_ID, orgId: ORG_ID, managementPosture: null }]))
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(new Error('db down')) }),
            }),
          } as never);
        const res = await put('security/status', { provider: 'defender', threatCount: 0 });

        expect(res.status).toBe(500);
        expect(upsertSecurityStatusForDevice).not.toHaveBeenCalled();
        expect(writeAuditEvent).not.toHaveBeenCalled();
        expect(recordAgentIngestSubmission).toHaveBeenCalledTimes(1);
        expect(recordAgentIngestSubmission).toHaveBeenCalledWith('security_status', 'failed');
      });

      it('audits the first-ever report for a device (no stored row yet)', async () => {
        mockDeviceLookup({}, []);
        const res = await put('security/status', { provider: 'defender', threatCount: 0 });

        expect(res.status).toBe(200);
        const details = (vi.mocked(writeAuditEvent).mock.calls[0]![1] as unknown as { details: { changes: unknown[] } }).details;
        expect(details.changes).toEqual([
          { field: 'provider', before: null, after: 'windows_defender' },
          { field: 'threatCount', before: null, after: 0 },
        ]);
      });
    });

    describe('management posture', () => {
      const posture = {
        collectedAt: '2026-06-20T00:00:00.000Z',
        scanDurationMs: 120,
        categories: {
          mdm: [{ name: 'Intune', status: 'active' }],
          rmm: [{ name: 'Breeze', status: 'active' }, { name: 'ScreenConnect', status: 'installed' }],
        },
        identity: {
          joinType: 'azure_ad',
          azureAdJoined: true,
          domainJoined: false,
          workplaceJoined: false,
          tenantId: 'tenant-1',
          source: 'dsregcmd',
        },
        errors: ['wmi timeout'],
      };

      it('does NOT audit a re-scan that differs only in collectedAt, duration, errors and entry order', async () => {
        mockDeviceLookup({ managementPosture: posture });
        const res = await put('management/posture', {
          ...posture,
          collectedAt: '2026-06-20T00:15:00.000Z',
          scanDurationMs: 95,
          errors: [],
          categories: { rmm: [...posture.categories.rmm].reverse(), mdm: posture.categories.mdm },
        });

        expect(res.status).toBe(200);
        expect(writeAuditEvent).not.toHaveBeenCalled();
        expect(recordAgentIngestSubmission).toHaveBeenCalledWith('management_posture', 'success');
      });

      it('audits a detection change, naming the changed category', async () => {
        mockDeviceLookup({ managementPosture: posture });
        const res = await put('management/posture', {
          ...posture,
          categories: { ...posture.categories, rmm: [{ name: 'Breeze', status: 'active' }] },
        });

        expect(res.status).toBe(200);
        expect(writeAuditEvent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({
          action: 'agent.management_posture.submit',
          resourceType: 'device',
          resourceId: DEVICE_ID,
          details: { changed: ['categories.rmm'] },
        });
      });

      it('audits an identity change', async () => {
        mockDeviceLookup({ managementPosture: posture });
        const res = await put('management/posture', {
          ...posture,
          identity: { ...posture.identity, joinType: 'none', azureAdJoined: false },
        });

        expect(res.status).toBe(200);
        const details = (vi.mocked(writeAuditEvent).mock.calls[0]![1] as unknown as { details: { changed: string[] } }).details;
        expect(details.changed).toEqual(['identity']);
      });

      it('audits the first-ever posture for a device', async () => {
        mockDeviceLookup({ managementPosture: null });
        const res = await put('management/posture', posture);

        expect(res.status).toBe(200);
        const details = (vi.mocked(writeAuditEvent).mock.calls[0]![1] as unknown as { details: { changed: string[] } }).details;
        expect(details.changed).toEqual(['identity', 'categories.mdm', 'categories.rmm']);
      });

      it('counts a failed posture write as a failed ingest', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockDeviceLookup({ managementPosture: null });
        vi.mocked(db.update).mockReturnValueOnce({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('db down')) }),
        } as never);
        const res = await put('management/posture', posture);

        expect(res.status).toBe(500);
        expect(writeAuditEvent).not.toHaveBeenCalled();
        expect(recordAgentIngestSubmission).toHaveBeenCalledWith('management_posture', 'failed');
        consoleError.mockRestore();
      });
    });
  });
});

describe('managementPostureChanges (#4340)', () => {
  const identity = { joinType: 'none', azureAdJoined: false, domainJoined: false, workplaceJoined: false, source: 'agent' };
  const base = {
    collectedAt: '2026-06-20T00:00:00.000Z',
    scanDurationMs: 10,
    identity,
    categories: {
      policy: [{ name: 'macOS Configuration Profiles', status: 'active', details: { profileCount: 2, profiles: ['a', 'b'] } }],
      rmm: [{ name: 'Breeze', status: 'active' }],
    },
  };

  it('flags a detection whose only change is in its details', () => {
    const after = {
      ...base,
      categories: {
        ...base.categories,
        policy: [{ name: 'macOS Configuration Profiles', status: 'active', details: { profileCount: 3, profiles: ['a', 'b', 'c'] } }],
      },
    };
    expect(managementPostureChanges(base, after)).toEqual(['categories.policy']);
  });

  it('ignores reordered values inside details', () => {
    const after = {
      ...base,
      categories: {
        ...base.categories,
        policy: [{ name: 'macOS Configuration Profiles', status: 'active', details: { profiles: ['b', 'a'], profileCount: 2 } }],
      },
    };
    expect(managementPostureChanges(base, after)).toEqual([]);
  });

  it('flags a category that disappears, whether omitted or sent empty', () => {
    const omitted = { ...base, categories: { policy: base.categories.policy } };
    const emptied = { ...base, categories: { ...base.categories, rmm: [] } };
    expect(managementPostureChanges(base, omitted)).toEqual(['categories.rmm']);
    expect(managementPostureChanges(base, emptied)).toEqual(['categories.rmm']);
    // ...and omitted vs empty are the same state ("nothing detected").
    expect(managementPostureChanges(omitted, emptied)).toEqual([]);
  });

  it('distinguishes a duplicated detection from a single one', () => {
    const dup = { ...base, categories: { ...base.categories, rmm: [base.categories.rmm[0], base.categories.rmm[0]] } };
    expect(managementPostureChanges(base, dup)).toEqual(['categories.rmm']);
  });

  it('treats a missing stored posture as every present part changing', () => {
    expect(managementPostureChanges(null, base)).toEqual(['identity', 'categories.policy', 'categories.rmm']);
  });
});
