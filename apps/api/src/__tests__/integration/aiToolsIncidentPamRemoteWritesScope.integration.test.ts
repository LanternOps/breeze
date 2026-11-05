/**
 * Integration test — W04 (#6758) incident, PAM and remote-session write tools
 * honour the site axis and the org axis, against real Postgres as the
 * unprivileged `breeze_app` role (org-axis RLS genuinely enforced; the site
 * axis is applied app-layer).
 *
 * Tools: create_incident, execute_containment, collect_evidence,
 * request_elevation, revoke_elevation, create_remote_session.
 *
 * Entry point: `executeTool`, so the CENTRAL `enforceDeviceArgs` gate (the
 * tools' `deviceArgs`) runs before the handler exactly as in production.
 * execute_containment, request_elevation and create_remote_session are Tier 3;
 * the human approval step lives in the chat layer (unit-tested in
 * aiGuardrails.*), not in `executeTool`, so this suite tests the scope
 * behaviour that runs AFTER approval.
 *
 * Fixture: one org with two sites (A = the restricted caller's allowed site,
 * B = forbidden), an online device in each, plus a second org with its own
 * device, incidents and elevation requests. For every tool:
 *   (i)   out-of-site device / record -> refused, nothing written or queued
 *   (ii)  in-site                     -> succeeds (non-vacuous)
 *   (iii) cross-org caller            -> "not found"
 *   (iv)  unrestricted caller         -> reaches the site-B resources
 *
 * Plus W04-D12: a multi-org caller aiming collect_evidence / execute_containment
 * at a device in ANOTHER org than the incident is refused by the handler.
 *
 * Only the device command queue (`aiQueueCommandForExecution`) and the Redis
 * event bus are stubbed; every refusal under test happens before them.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const { queueCommandMock, publishEventMock } = vi.hoisted(() => ({
  queueCommandMock: vi.fn(async (..._args: unknown[]) => ({ command: { id: crypto.randomUUID(), status: 'pending' } })),
  publishEventMock: vi.fn(async (..._args: unknown[]) => 'test-event-id'),
}));

vi.mock('../../services/aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDispatch')>();
  return { ...actual, aiQueueCommandForExecution: queueCommandMock };
});
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  elevationRequests,
  incidentActions,
  incidents,
  remoteSessions,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { MAX_ACTIVE_REMOTE_SESSIONS_PER_USER } from '../../routes/remote/helpers';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DEVICE_DENIED = 'Device not found or access denied';
const INCIDENT_DENIED = 'Incident not found or access denied';
const ELEVATION_DENIED = 'Elevation request not found or access denied';
const CROSS_ORG_DEVICE = 'The device must belong to the same organization as the incident';

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `inc-pam-${randomUUID()}`,
    hostname: `ip-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedIncident(orgId: string, affectedDevices: string[], title: string): Promise<string> {
  const [row] = await getTestDb().insert(incidents).values({
    orgId,
    title,
    classification: 'malware',
    severity: 'p3',
    status: 'detected',
    affectedDevices,
    detectedAt: new Date(),
  }).returning({ id: incidents.id });
  return row!.id;
}

async function seedElevation(args: {
  orgId: string; siteId: string; partnerId: string; deviceId: string; userId: string;
}): Promise<string> {
  const now = new Date();
  const [row] = await getTestDb().insert(elevationRequests).values({
    orgId: args.orgId,
    siteId: args.siteId,
    partnerId: args.partnerId,
    deviceId: args.deviceId,
    deviceEpoch: sql`(SELECT d.ownership_epoch FROM devices d WHERE d.id = ${args.deviceId}::uuid)` as unknown as number,
    flowType: 'tech_jit_admin',
    subjectUserId: args.userId,
    subjectUsername: 'scope-test',
    reason: 'scope test',
    status: 'approved',
    requestedAt: now,
    approvedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    metadata: {},
  }).returning({ id: elevationRequests.id });
  return row!.id;
}

function makeAuth(opts: {
  userId: string;
  partnerId: string;
  orgIds: string[];
  scope?: 'organization' | 'partner';
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'incident-pam-remote-scope' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  siteA: string;
  siteB: string;
  devA: string;
  devB: string;
  devOther: string;
  /** Incident in org A naming BOTH org-A devices (so a site-A caller reaches it). */
  incidentAB: string;
  /** Incident in org A naming only the site-B device. */
  incidentBOnly: string;
  /** Incident in org A naming an org-A and an org-B device (multi-org caller only). */
  incidentCrossOrg: string;
  incidentOtherOrg: string;
  elevA: string;
  elevB: string;
  elevOther: string;
  restricted: AuthContext;
  unrestricted: AuthContext;
  otherOrg: AuthContext;
  multiOrg: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'Inc PAM A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'Inc PAM B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'Inc PAM other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `ip-${randomUUID()}@example.com` });

  const devA = await seedDevice(orgA.id, siteA.id);
  const devB = await seedDevice(orgA.id, siteB.id);
  const devOther = await seedDevice(orgB.id, siteOther.id);

  const base = { userId: user.id, partnerId: partner.id };
  const elev = (orgId: string, siteId: string, deviceId: string) =>
    seedElevation({ orgId, siteId, partnerId: partner.id, deviceId, userId: user.id });

  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    siteA: siteA.id,
    siteB: siteB.id,
    devA,
    devB,
    devOther,
    incidentAB: await seedIncident(orgA.id, [devA, devB], 'in-scope incident'),
    incidentBOnly: await seedIncident(orgA.id, [devB], 'site-B only incident'),
    incidentCrossOrg: await seedIncident(orgA.id, [devA, devOther], 'cross-org device incident'),
    incidentOtherOrg: await seedIncident(orgB.id, [devOther], 'other-org incident'),
    elevA: await elev(orgA.id, siteA.id, devA),
    elevB: await elev(orgA.id, siteB.id, devB),
    elevOther: await elev(orgB.id, siteOther.id, devOther),
    restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
    unrestricted: makeAuth({ ...base, orgIds: [orgA.id] }),
    otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
    multiOrg: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner' }),
  };
}

type Who = 'restricted' | 'unrestricted' | 'otherOrg' | 'multiOrg';

function ctxFor(f: Fixture, who: Who): DbAccessContext {
  const auth = f[who];
  return buildDbAccessContext({
    scope: auth.scope,
    orgId: auth.orgId,
    accessibleOrgIds: auth.accessibleOrgIds ?? [],
    partnerId: f.partnerId,
    userId: f.userId,
  });
}

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(ctxFor(f, who), () => executeTool(tool, input, f[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const countIncidents = async (orgId: string) =>
  (await getTestDb().select({ id: incidents.id }).from(incidents).where(eq(incidents.orgId, orgId))).length;
const actionsFor = async (incidentId: string) =>
  getTestDb().select({ id: incidentActions.id }).from(incidentActions).where(eq(incidentActions.incidentId, incidentId));
const elevationStatus = async (id: string) =>
  (await getTestDb().select({ s: elevationRequests.status }).from(elevationRequests).where(eq(elevationRequests.id, id)))[0]!.s;
const elevationsOnDevice = async (deviceId: string) =>
  getTestDb().select({ id: elevationRequests.id }).from(elevationRequests).where(eq(elevationRequests.deviceId, deviceId));
const sessionsOnDevice = async (deviceId: string) =>
  getTestDb().select({ id: remoteSessions.id }).from(remoteSessions).where(eq(remoteSessions.deviceId, deviceId));

describe('W04 incident / PAM / remote write tools — site axis + org axis (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    await clearPermissionCache();
    queueCommandMock.mockClear();
    publishEventMock.mockClear();
    f = await seedFixture();
  });

  describe('create_incident', () => {
    runDb('out-of-site affectedDeviceIds are refused by the central gate and no incident is created', async () => {
      const before = await countIncidents(f.orgA);
      const base = { title: 'scope probe', classification: 'malware', severity: 'p3' };
      expect(await run(f, 'restricted', 'create_incident', { ...base, affectedDeviceIds: [f.devB] })).toEqual({ error: DEVICE_DENIED });
      // in-site id FIRST: the gate must still refuse the out-of-site id after it
      expect(await run(f, 'restricted', 'create_incident', { ...base, affectedDeviceIds: [f.devA, f.devB] })).toEqual({ error: DEVICE_DENIED });
      expect(await countIncidents(f.orgA)).toBe(before);
    });

    runDb('in-site affectedDeviceIds create the incident; cross-org device is not found; unrestricted reaches site B', async () => {
      const base = { title: 'scope probe', classification: 'malware', severity: 'p3' };
      const before = await countIncidents(f.orgA);
      const ok = await run(f, 'restricted', 'create_incident', { ...base, affectedDeviceIds: [f.devA] });
      expect(ok.error).toBeUndefined();
      expect(await countIncidents(f.orgA)).toBe(before + 1);

      expect(await run(f, 'otherOrg', 'create_incident', { ...base, affectedDeviceIds: [f.devA] })).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', 'create_incident', { ...base, affectedDeviceIds: [f.devOther] })).toEqual({ error: DEVICE_DENIED });
      expect(await countIncidents(f.orgA)).toBe(before + 1);

      const wide = await run(f, 'unrestricted', 'create_incident', { ...base, affectedDeviceIds: [f.devB] });
      expect(wide.error).toBeUndefined();
      expect(await countIncidents(f.orgA)).toBe(before + 2);
    });
  });

  describe.each([
    {
      tool: 'execute_containment',
      extra: { actionType: 'process_kill', parameters: { pid: 4242 }, approvalRef: 'scope-test-approval' } as Record<string, unknown>,
    },
    {
      tool: 'collect_evidence',
      extra: { evidenceTypes: ['logs', 'processes'] } as Record<string, unknown>,
    },
  ])('$tool', ({ tool, extra }) => {
    runDb('out-of-site device is refused by the central gate and nothing is queued or recorded', async () => {
      const denied = await run(f, 'restricted', tool, { incidentId: f.incidentAB, deviceId: f.devB, ...extra });
      expect(denied).toEqual({ error: DEVICE_DENIED });
      expect(queueCommandMock).not.toHaveBeenCalled();
      expect(await actionsFor(f.incidentAB)).toHaveLength(0);
    });

    runDb('an incident reachable only through an out-of-site device is not found', async () => {
      const denied = await run(f, 'restricted', tool, { incidentId: f.incidentBOnly, deviceId: f.devA, ...extra });
      expect(denied).toEqual({ error: INCIDENT_DENIED });
      expect(queueCommandMock).not.toHaveBeenCalled();
    });

    runDb('in-site device dispatches the (stubbed) command', async () => {
      const ok = await run(f, 'restricted', tool, { incidentId: f.incidentAB, deviceId: f.devA, ...extra });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(queueCommandMock).toHaveBeenCalledTimes(1);
      const call = queueCommandMock.mock.calls[0]!;
      expect(call[1]).toBe(tool);
      expect(call[2]).toBe(f.devA);
      if (tool === 'execute_containment') expect(await actionsFor(f.incidentAB)).toHaveLength(1);
    });

    runDb('cross-org caller gets not found, whether the device or the incident is the foreign one', async () => {
      expect(await run(f, 'otherOrg', tool, { incidentId: f.incidentAB, deviceId: f.devA, ...extra })).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'otherOrg', tool, { incidentId: f.incidentAB, deviceId: f.devOther, ...extra })).toEqual({ error: INCIDENT_DENIED });
      expect(await run(f, 'restricted', tool, { incidentId: f.incidentOtherOrg, deviceId: f.devA, ...extra })).toEqual({ error: INCIDENT_DENIED });
      expect(queueCommandMock).not.toHaveBeenCalled();
    });

    runDb('W04-D12: a device in ANOTHER org than the incident is refused for a multi-org caller', async () => {
      const denied = await run(f, 'multiOrg', tool, { incidentId: f.incidentCrossOrg, deviceId: f.devOther, ...extra });
      expect(denied).toEqual({ error: CROSS_ORG_DEVICE });
      expect(queueCommandMock).not.toHaveBeenCalled();
      expect(await actionsFor(f.incidentCrossOrg)).toHaveLength(0);

      // the same multi-org caller IS allowed onto the incident's own org
      const ok = await run(f, 'multiOrg', tool, { incidentId: f.incidentCrossOrg, deviceId: f.devA, ...extra });
      expect(ok.error).toBeUndefined();
      expect(queueCommandMock).toHaveBeenCalledTimes(1);
    });

    runDb('unrestricted caller reaches the site-B device', async () => {
      const ok = await run(f, 'unrestricted', tool, { incidentId: f.incidentAB, deviceId: f.devB, ...extra });
      expect(ok.error).toBeUndefined();
      expect(ok.success).toBe(true);
      expect(queueCommandMock).toHaveBeenCalledTimes(1);
      expect(queueCommandMock.mock.calls[0]![2]).toBe(f.devB);
    });
  });

  describe('request_elevation', () => {
    const req = (deviceId: string) => ({ deviceId, subjectUsername: 'scope-test', reason: 'scope probe', durationMinutes: 15 });

    runDb('out-of-site device is refused by the central gate and no request is written', async () => {
      const before = (await elevationsOnDevice(f.devB)).length;
      expect(await run(f, 'restricted', 'request_elevation', req(f.devB))).toEqual({ error: DEVICE_DENIED });
      expect((await elevationsOnDevice(f.devB)).length).toBe(before);
    });

    runDb('in-site device creates a pending request; unrestricted reaches site B', async () => {
      const ok = await run(f, 'restricted', 'request_elevation', req(f.devA));
      expect(ok.error).toBeUndefined();
      expect(ok.status).toBe('pending');
      expect(await elevationStatus(ok.elevationRequestId)).toBe('pending');

      const wide = await run(f, 'unrestricted', 'request_elevation', req(f.devB));
      expect(wide.error).toBeUndefined();
      expect(wide.status).toBe('pending');
    });

    runDb('cross-org caller gets not found', async () => {
      const before = (await elevationsOnDevice(f.devA)).length;
      expect(await run(f, 'otherOrg', 'request_elevation', req(f.devA))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', 'request_elevation', req(f.devOther))).toEqual({ error: DEVICE_DENIED });
      expect((await elevationsOnDevice(f.devA)).length).toBe(before);
    });
  });

  describe('revoke_elevation', () => {
    const rev = (id: string) => ({ elevationRequestId: id, reason: 'scope probe' });

    runDb('an out-of-site request is not found and stays active', async () => {
      expect(await run(f, 'restricted', 'revoke_elevation', rev(f.elevB))).toEqual({ error: ELEVATION_DENIED });
      expect(await elevationStatus(f.elevB)).toBe('approved');
    });

    runDb('an in-site request is revoked; unrestricted revokes the site-B request', async () => {
      const ok = await run(f, 'restricted', 'revoke_elevation', rev(f.elevA));
      expect(ok.error).toBeUndefined();
      expect(ok.status).toBe('revoked');
      expect(await elevationStatus(f.elevA)).toBe('revoked');

      const wide = await run(f, 'unrestricted', 'revoke_elevation', rev(f.elevB));
      expect(wide.error).toBeUndefined();
      expect(await elevationStatus(f.elevB)).toBe('revoked');
    });

    runDb('cross-org caller gets not found in both directions', async () => {
      expect(await run(f, 'otherOrg', 'revoke_elevation', rev(f.elevA))).toEqual({ error: ELEVATION_DENIED });
      expect(await run(f, 'restricted', 'revoke_elevation', rev(f.elevOther))).toEqual({ error: ELEVATION_DENIED });
      expect(await elevationStatus(f.elevA)).toBe('approved');
      expect(await elevationStatus(f.elevOther)).toBe('approved');
    });
  });

  describe('create_remote_session', () => {
    const open = (deviceId: string) => ({ deviceId, type: 'terminal' });

    runDb('out-of-site device is refused by the central gate and no session is created', async () => {
      expect(await run(f, 'restricted', 'create_remote_session', open(f.devB))).toEqual({ error: DEVICE_DENIED });
      expect(await sessionsOnDevice(f.devB)).toHaveLength(0);
    });

    runDb('in-site device opens a session; unrestricted reaches site B', async () => {
      const ok = await run(f, 'restricted', 'create_remote_session', open(f.devA));
      expect(ok.error).toBeUndefined();
      expect(ok.deviceId).toBe(f.devA);
      expect(await sessionsOnDevice(f.devA)).toHaveLength(1);

      const wide = await run(f, 'unrestricted', 'create_remote_session', open(f.devB));
      expect(wide.error).toBeUndefined();
      expect(await sessionsOnDevice(f.devB)).toHaveLength(1);
    });

    runDb('cross-org caller gets not found', async () => {
      expect(await run(f, 'otherOrg', 'create_remote_session', open(f.devA))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', 'create_remote_session', open(f.devOther))).toEqual({ error: DEVICE_DENIED });
      expect(await sessionsOnDevice(f.devA)).toHaveLength(0);
      expect(await sessionsOnDevice(f.devOther)).toHaveLength(0);
    });

    runDb('the per-user concurrent-session cap refuses an in-site device once reached', async () => {
      await getTestDb().insert(remoteSessions).values(
        Array.from({ length: MAX_ACTIVE_REMOTE_SESSIONS_PER_USER }, () => ({
          deviceId: f.devA,
          orgId: f.orgA,
          userId: f.userId,
          type: 'terminal' as const,
          status: 'active' as const,
          startedAt: new Date(),
        })),
      );
      const capped = await run(f, 'restricted', 'create_remote_session', open(f.devA));
      expect(capped.error).toBe('Maximum concurrent sessions reached for this user');
      expect(capped.maxAllowed).toBe(MAX_ACTIVE_REMOTE_SESSIONS_PER_USER);
      expect(await sessionsOnDevice(f.devA)).toHaveLength(MAX_ACTIVE_REMOTE_SESSIONS_PER_USER);
    });
  });
});
