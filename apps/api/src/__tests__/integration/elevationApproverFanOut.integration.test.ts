/**
 * #11231: the elevation-request mobile fan-out with REAL approvers, on real
 * Postgres, through the agent route, with the code under test connected as
 * `breeze_app` (forced RLS). Nothing in the approver resolution is mocked: the
 * role grant, the org membership and the phone row are what decide who is asked.
 *
 *   - an approver who holds `pam:approve` and has an active, notifications-on
 *     phone gets one `approval_requests` row for the new elevation;
 *   - with nobody holding the permission, nobody is asked, and the request is
 *     audited as `agent.elevation_request.no_approver` with reason
 *     `no_permission_holder` and its counts;
 *   - with permission holders but none with such a phone, nobody is asked, and
 *     the audit says `no_notifying_device` with the counts that show why.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const flags = vi.hoisted(() => ({
  /** Elevation ingest refuses a device with UAC capture off, the default. */
  pamEnabled: false,
}));

vi.mock('../../routes/agents/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agents/helpers')>();
  return {
    ...actual,
    buildPamConfigUpdate: async (...args: Parameters<typeof actual.buildPamConfigUpdate>) => {
      const settings = await actual.buildPamConfigUpdate(...args);
      return flags.pamEnabled ? { ...settings, uacInterceptionEnabled: true } : settings;
    },
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests, auditLogs, devices, mobileDevices } from '../../db/schema';
import { elevationRequestsRoutes } from '../../routes/agents/elevationRequests';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const NO_APPROVER_ACTION = 'agent.elevation_request.no_approver';

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
}

async function seedOrgWithDevice(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const agentId = `approver-fanout-${randomUUID()}`;
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId,
    hostname: `approver-fanout-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device!.id, agentId };
}

/** An org member whose role grants exactly `perms`. */
async function seedMember(f: Fixture, perms: Array<{ resource: string; action: string }>) {
  const role = await createRole({ scope: 'organization', orgId: f.orgId, name: `Role ${randomUUID().slice(0, 8)}` });
  if (perms.length > 0) await grantRolePermissions(role.id, perms);
  const user = await createUser({ partnerId: f.partnerId, orgId: f.orgId, email: `member-${randomUUID()}@fanout.test` });
  await assignUserToOrganization(user.id, f.orgId, role.id);
  return user;
}

/**
 * A paired phone. No push token, so the fan-out has nothing to send over the
 * network; eligibility only reads status and notifications_enabled.
 */
async function seedPhone(userId: string, opts: { notificationsEnabled?: boolean } = {}) {
  await getTestDb().insert(mobileDevices).values({
    userId,
    deviceId: `phone-${randomUUID()}`,
    platform: 'ios',
    notificationsEnabled: opts.notificationsEnabled ?? true,
  });
}

function agentApp(f: Fixture): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: f.deviceId,
      agentId: f.agentId,
      orgId: f.orgId,
      siteId: f.siteId,
      partnerId: f.partnerId,
      role: 'agent',
      isPreAssignment: false,
    } as never);
    await next();
  });
  app.route('/agents', elevationRequestsRoutes);
  return app;
}

async function submitElevation(f: Fixture): Promise<string> {
  const res = await agentApp(f).request(`/agents/${f.agentId}/elevation-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject_username: 'FANOUT\\enduser',
      target_executable_path: 'C:\\Temp\\setup.exe',
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json() as { id: string; status: string };
  expect(body.status).toBe('pending');
  return body.id;
}

function approvalRowsFor(elevationRequestId: string) {
  return getTestDb()
    .select({ userId: approvalRequests.userId, status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.elevationRequestId, elevationRequestId));
}

function noApproverAudits(elevationRequestId: string) {
  return getTestDb()
    .select({ orgId: auditLogs.orgId, actorType: auditLogs.actorType, details: auditLogs.details })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, elevationRequestId), eq(auditLogs.action, NO_APPROVER_ACTION)));
}

/** The audit write is fire-and-forget, so wait for its row to land. */
async function waitForNoApproverAudit(elevationRequestId: string) {
  let rows: Awaited<ReturnType<typeof noApproverAudits>> = [];
  await vi.waitFor(async () => {
    rows = await noApproverAudits(elevationRequestId);
    expect(rows).toHaveLength(1);
  }, { timeout: 5_000, interval: 50 });
  return rows[0]!;
}

/** The structured warn line for `elevationRequestId`, if it was written. */
function noApproverWarnings(warn: MockInstance<typeof console.warn>, elevationRequestId: string) {
  return warn.mock.calls
    .filter(([message, fields]) =>
      message === '[ElevationRequests] pending elevation reached no approver'
      && (fields as { elevationRequestId?: string } | undefined)?.elevationRequestId === elevationRequestId)
    .map(([, fields]) => fields);
}

describe('elevation request fan-out with real approvers (real PostgreSQL)', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    flags.pamEnabled = true;
    warn = vi.spyOn(console, 'warn');
  });
  afterEach(() => {
    flags.pamEnabled = false;
    warn.mockRestore();
  });

  runDb('the code under test connects as breeze_app, so RLS applies', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT current_user AS who`));
    expect((rows as unknown as Array<{ who: string }>)[0]?.who).toBe('breeze_app');
  });

  runDb('an approver with pam:approve and a notifying phone gets an approval row for the request', async () => {
    const f = await seedOrgWithDevice();
    const approver = await seedMember(f, [PERMISSIONS.PAM_APPROVE]);
    await seedPhone(approver.id);
    // A member without the permission is not asked, phone or not.
    const technician = await seedMember(f, [PERMISSIONS.DEVICES_EXECUTE]);
    await seedPhone(technician.id);

    const elevationId = await submitElevation(f);

    expect(await approvalRowsFor(elevationId)).toEqual([{ userId: approver.id, status: 'pending' }]);
    // Give a stray fire-and-forget audit a moment to land before asserting it is absent.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await noApproverAudits(elevationId)).toEqual([]);
    expect(noApproverWarnings(warn, elevationId)).toEqual([]);
  });

  runDb('nobody holds pam:approve: no approval row, audited as no_permission_holder', async () => {
    const f = await seedOrgWithDevice();
    const technician = await seedMember(f, [PERMISSIONS.DEVICES_EXECUTE]);
    await seedPhone(technician.id);

    const elevationId = await submitElevation(f);

    expect(await approvalRowsFor(elevationId)).toEqual([]);
    const audit = await waitForNoApproverAudit(elevationId);
    expect(audit.orgId).toBe(f.orgId);
    expect(audit.actorType).toBe('agent');
    expect(audit.details).toMatchObject({
      flow_type: 'uac_intercept',
      reason: 'no_permission_holder',
      permission_holders: 0,
      with_notifying_device: 0,
    });
    expect(noApproverWarnings(warn, elevationId)).toEqual([{
      elevationRequestId: elevationId,
      orgId: f.orgId,
      reason: 'no_permission_holder',
      permissionHolders: 0,
      withNotifyingDevice: 0,
    }]);
  });

  runDb('holders exist but none has a notifying phone: no approval row, audited as no_notifying_device', async () => {
    const f = await seedOrgWithDevice();
    // One holder never paired a phone; the other muted notifications.
    await seedMember(f, [PERMISSIONS.PAM_APPROVE]);
    const muted = await seedMember(f, [PERMISSIONS.PAM_APPROVE]);
    await seedPhone(muted.id, { notificationsEnabled: false });

    const elevationId = await submitElevation(f);

    expect(await approvalRowsFor(elevationId)).toEqual([]);
    const audit = await waitForNoApproverAudit(elevationId);
    expect(audit.orgId).toBe(f.orgId);
    expect(audit.details).toMatchObject({
      flow_type: 'uac_intercept',
      reason: 'no_notifying_device',
      permission_holders: 2,
      with_notifying_device: 0,
    });
    expect(noApproverWarnings(warn, elevationId)).toEqual([{
      elevationRequestId: elevationId,
      orgId: f.orgId,
      reason: 'no_notifying_device',
      permissionHolders: 2,
      withNotifyingDevice: 0,
    }]);
  });
});
