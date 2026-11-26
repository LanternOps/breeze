/**
 * #11231: every user who holds `pam:approve` for a device's org hears about a
 * new pending elevation request by in-app notification and by email, whether
 * or not they have the mobile app. Real Postgres, through the agent route, with
 * the code under test connected as `breeze_app` (forced RLS). Nothing in the
 * recipient resolution is mocked; only the outbound mail transport is.
 *
 *   - recipients are the permission holders for THIS org: org members whose
 *     role grants it and partner staff whose org access covers the org;
 *   - never a user of another partner, a partner member whose org access does
 *     not cover the org, a member of a sibling org, a member restricted to
 *     other sites, a disabled account, or a member without the permission;
 *   - a second request from the same device inside the window notifies nobody
 *     again (one in-app row and one email per recipient, device and window);
 *   - the email names the device and org and links to the PAM requests tab,
 *     and carries no executable path, command line or requesting username.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({
  /** Elevation ingest refuses a device with UAC capture off, the default. */
  pamEnabled: false,
}));

const mail = vi.hoisted(() => ({
  sendEmail: vi.fn<(params: { to: string | string[]; subject: string; html: string; text?: string; purpose: string }) => Promise<void>>(),
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

// Only the transport is replaced; recipients and content are the real code's.
vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  return { ...actual, getEmailService: () => ({ sendEmail: mail.sendEmail }) };
});

import { db, withSystemDbAccessContext } from '../../db';
import { devices, mobileDevices, organizationUsers, partnerUsers, userNotifications } from '../../db/schema';
import { elevationRequestsRoutes } from '../../routes/agents/elevationRequests';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const EXE_PATH = 'C:\\Temp\\notify-probe-installer.exe';
const COMMAND_LINE = 'notify-probe-installer.exe /S /secret-flag';
const SUBJECT_USERNAME = 'NOTIFYPROBE\\enduser';

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  hostname: string;
  orgName: string;
}

async function seedOrgWithDevice(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id, name: `Notify Org ${randomUUID().slice(0, 8)}` });
  const site = await createSite({ orgId: org.id });
  const agentId = `approver-notify-${randomUUID()}`;
  const hostname = `notify-host-${randomUUID().slice(0, 8)}`;
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId,
    hostname,
    osType: 'windows',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId,
    hostname,
    orgName: org.name,
  };
}

async function orgRole(orgId: string, perms: Array<{ resource: string; action: string }>) {
  const role = await createRole({ scope: 'organization', orgId, name: `Role ${randomUUID().slice(0, 8)}` });
  if (perms.length > 0) await grantRolePermissions(role.id, perms);
  return role;
}

/** An org member of `orgId` whose role grants exactly `perms`. */
async function seedMember(
  partnerId: string,
  orgId: string,
  perms: Array<{ resource: string; action: string }>,
  opts: { status?: 'active' | 'disabled' } = {},
) {
  const role = await orgRole(orgId, perms);
  const user = await createUser({
    partnerId,
    orgId,
    email: `member-${randomUUID()}@notify.test`,
    ...(opts.status ? { status: opts.status } : {}),
  });
  await assignUserToOrganization(user.id, orgId, role.id);
  return user;
}

/** A partner member whose partner role grants `perms`, with the given org access. */
async function seedPartnerMember(
  partnerId: string,
  perms: Array<{ resource: string; action: string }>,
  orgAccess: 'all' | 'selected',
  orgIds: string[] = [],
) {
  const role = await createRole({ scope: 'partner', partnerId, name: `Partner role ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(role.id, perms);
  const user = await createUser({ partnerId, email: `partner-${randomUUID()}@notify.test` });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  if (orgAccess === 'selected') {
    await getTestDb().update(partnerUsers).set({ orgIds }).where(eq(partnerUsers.userId, user.id));
  }
  return user;
}

async function seedPhone(userId: string) {
  await getTestDb().insert(mobileDevices).values({
    userId,
    deviceId: `phone-${randomUUID()}`,
    platform: 'ios',
    notificationsEnabled: true,
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
      subject_username: SUBJECT_USERNAME,
      target_executable_path: EXE_PATH,
      command_line: COMMAND_LINE,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await res.json() as { id: string; status: string };
  expect(body.status).toBe('pending');
  return body.id;
}

/** In-app notifications any of `userIds` received about elevations on `deviceId`. */
async function elevationNotices(userIds: string[], deviceId: string) {
  if (userIds.length === 0) return [];
  const rows = await getTestDb()
    .select({
      userId: userNotifications.userId,
      orgId: userNotifications.orgId,
      type: userNotifications.type,
      title: userNotifications.title,
      message: userNotifications.message,
      link: userNotifications.link,
      metadata: userNotifications.metadata,
    })
    .from(userNotifications)
    .where(inArray(userNotifications.userId, userIds));
  return rows.filter((r) => (r.metadata as { deviceId?: string } | null)?.deviceId === deviceId);
}

function emailRecipients(): string[] {
  return mail.sendEmail.mock.calls.flatMap(([p]) => (Array.isArray(p.to) ? p.to : [p.to]));
}

describe('pending elevation notifies every permission holder (real PostgreSQL)', () => {
  beforeEach(() => {
    flags.pamEnabled = true;
    mail.sendEmail.mockReset();
    mail.sendEmail.mockResolvedValue(undefined);
  });
  afterEach(() => {
    flags.pamEnabled = false;
  });

  runDb('the code under test connects as breeze_app, so RLS applies', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT current_user AS who`));
    expect((rows as unknown as Array<{ who: string }>)[0]?.who).toBe('breeze_app');
  });

  runDb('holders of this org are told in-app and by email; nobody outside the org is', async () => {
    const f = await seedOrgWithDevice();
    const otherSite = await createSite({ orgId: f.orgId });

    // Should be told.
    const phoneless = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    const withPhone = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await seedPhone(withPhone.id);
    const partnerAll = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'all');
    const partnerSelectedCovering = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'selected', [f.orgId]);

    // Should not be told.
    const nonHolder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.DEVICES_EXECUTE]);
    const disabledHolder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE], { status: 'disabled' });
    const otherSiteOnly = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await getTestDb().update(organizationUsers).set({ siteIds: [otherSite.id] })
      .where(and(eq(organizationUsers.userId, otherSiteOnly.id), eq(organizationUsers.orgId, f.orgId)));
    const siblingOrg = await createOrganization({ partnerId: f.partnerId });
    const siblingOrgHolder = await seedMember(f.partnerId, siblingOrg.id, [PERMISSIONS.PAM_APPROVE]);
    const partnerSelectedElsewhere = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'selected', [siblingOrg.id]);
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherPartnerOrgHolder = await seedMember(otherPartner.id, otherOrg.id, [PERMISSIONS.PAM_APPROVE]);
    const otherPartnerAdmin = await seedPartnerMember(otherPartner.id, [{ resource: '*', action: '*' }], 'all');

    const told = [phoneless, withPhone, partnerAll, partnerSelectedCovering];
    const notTold = [
      nonHolder, disabledHolder, otherSiteOnly, siblingOrgHolder,
      partnerSelectedElsewhere, otherPartnerOrgHolder, otherPartnerAdmin,
    ];

    await submitElevation(f);

    const notices = await elevationNotices([...told, ...notTold].map((u) => u.id), f.deviceId);
    expect(notices.map((n) => n.userId).sort()).toEqual(told.map((u) => u.id).sort());
    for (const n of notices) {
      expect(n).toMatchObject({ orgId: f.orgId, type: 'approval', link: '/pam#requests' });
      expect(n.message).toContain(f.hostname);
      expect(n.message).toContain(f.orgName);
    }

    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(told.length), { timeout: 5_000, interval: 50 });
    expect(emailRecipients().sort()).toEqual(told.map((u) => u.email).sort());
    for (const notTo of notTold) expect(emailRecipients()).not.toContain(notTo.email);
  });

  runDb('a second request from the same device in the window tells nobody again', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    await submitElevation(f);
    // Give a stray fire-and-forget send a moment before asserting it is absent.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await elevationNotices([holder.id], f.deviceId)).toHaveLength(1);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });

  runDb('the email names the device and org, links to the requests tab, and leaks no request detail', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });

    const [params] = mail.sendEmail.mock.calls[0]!;
    expect(params.to).toBe(holder.email);
    expect(params.purpose).toBe('staff.pam_elevation_request');
    const everything = [params.subject, params.html, params.text ?? ''].join('\n');
    expect(everything).toContain(f.hostname);
    expect(everything).toContain(f.orgName);
    expect(everything).toContain('/pam#requests');
    for (const secret of ['notify-probe-installer', 'secret-flag', 'NOTIFYPROBE', 'enduser']) {
      expect(everything).not.toContain(secret);
    }
  });

  runDb('a failing mail transport still returns 201 and keeps the in-app notice', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    mail.sendEmail.mockRejectedValue(new Error('smtp down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await submitElevation(f);
      await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
      expect(await elevationNotices([holder.id], f.deviceId)).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });
});
