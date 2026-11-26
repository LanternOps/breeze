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
 *   - per-device cooldown: after a request is announced, the device's next
 *     requests are not announced for 15 minutes, whatever the device did with
 *     the announced one (still pending, withdrawn, expired); a human decision
 *     on the announced request ends the cooldown early;
 *   - only an announced uac_intercept request starts a cooldown: a pending
 *     request of another flow, or an earlier request that was never announced,
 *     never silences a new one;
 *   - per-recipient ceiling: past 12 announcements in an hour, a holder still
 *     gets the in-app notice but no email;
 *   - partner staff whose org membership role lacks the permission are not
 *     told (org membership wins, as in getUserPermissions);
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
import {
  devices, elevationRequests, mobileDevices, organizationUsers, partnerUsers, userNotifications,
} from '../../db/schema';
import { elevationRequestsRoutes } from '../../routes/agents/elevationRequests';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { pamElevationNotifyDedupeKey } from '../../services/pamElevationNotify';
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

function noticeRequestId(n: { metadata: unknown }): string | undefined {
  return (n.metadata as { elevationRequestId?: string } | null)?.elevationRequestId;
}

async function restrictToSites(userId: string, orgId: string, siteIds: string[]) {
  await getTestDb().update(organizationUsers).set({ siteIds })
    .where(and(eq(organizationUsers.userId, userId), eq(organizationUsers.orgId, orgId)));
}

function emailRecipients(): string[] {
  return mail.sendEmail.mock.calls.flatMap(([p]) => (Array.isArray(p.to) ? p.to : [p.to]));
}

/** Give a stray background notice a moment before asserting it is absent. */
function settle(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The end user declined the request on the device (#8971). */
async function withdrawOnDevice(id: string) {
  await getTestDb().update(elevationRequests)
    .set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnReason: 'user_denied' })
    .where(eq(elevationRequests.id, id));
}

/** Move every request on the device `minutes` into the past. */
async function ageRequests(deviceId: string, minutes: number) {
  await getTestDb().update(elevationRequests)
    .set({ createdAt: sql`${elevationRequests.createdAt} - make_interval(mins => ${minutes}::int)` })
    .where(eq(elevationRequests.deviceId, deviceId));
}

/** A pending request written straight to the table, so no notifier ran for it. */
async function seedPendingRow(
  f: Fixture,
  opts: { flowType: 'uac_intercept' | 'tech_jit_admin'; subjectUserId?: string },
): Promise<string> {
  const [row] = await getTestDb().insert(elevationRequests).values({
    orgId: f.orgId,
    siteId: f.siteId,
    partnerId: f.partnerId,
    deviceId: f.deviceId,
    deviceEpoch: currentOwnershipEpochSql(f.deviceId),
    flowType: opts.flowType,
    subjectUserId: opts.subjectUserId,
    subjectUsername: 'WS\\enduser',
    reason: 'seeded without the notifier',
    ...(opts.flowType === 'uac_intercept' ? { targetExecutablePath: 'C:\\Temp\\seeded.exe' } : {}),
  }).returning({ id: elevationRequests.id });
  return row!.id;
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
    const deviceSiteOnly = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await restrictToSites(deviceSiteOnly.id, f.orgId, [f.siteId]);

    // Should not be told.
    const nonHolder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.DEVICES_EXECUTE]);
    const disabledHolder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE], { status: 'disabled' });
    const otherSiteOnly = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await restrictToSites(otherSiteOnly.id, f.orgId, [otherSite.id]);
    const noSites = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await restrictToSites(noSites.id, f.orgId, []);
    // Partner staff who also belong to the org: that membership's site
    // allowlist is the one that applies, as in getUserPermissions.
    const partnerWithRestrictedMembership = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'all');
    await assignUserToOrganization(partnerWithRestrictedMembership.id, f.orgId, (await orgRole(f.orgId, [])).id);
    await restrictToSites(partnerWithRestrictedMembership.id, f.orgId, [otherSite.id]);
    const siblingOrg = await createOrganization({ partnerId: f.partnerId });
    const siblingOrgHolder = await seedMember(f.partnerId, siblingOrg.id, [PERMISSIONS.PAM_APPROVE]);
    const partnerSelectedElsewhere = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'selected', [siblingOrg.id]);
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherPartnerOrgHolder = await seedMember(otherPartner.id, otherOrg.id, [PERMISSIONS.PAM_APPROVE]);
    const otherPartnerAdmin = await seedPartnerMember(otherPartner.id, [{ resource: '*', action: '*' }], 'all');

    const told = [phoneless, withPhone, partnerAll, partnerSelectedCovering, deviceSiteOnly];
    const notTold = [
      nonHolder, disabledHolder, otherSiteOnly, noSites, partnerWithRestrictedMembership, siblingOrgHolder,
      partnerSelectedElsewhere, otherPartnerOrgHolder, otherPartnerAdmin,
    ];

    await submitElevation(f);

    // The notices are written after the 201, in the background.
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(told.length), { timeout: 5_000, interval: 50 });
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

  runDb('a request while an announced one from the device is pending tells nobody; after a human decision, the next one does', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    const first = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    const second = await submitElevation(f);
    expect(second).not.toBe(first);
    await settle();
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId)).toEqual([first]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);

    // A person decides the announced request; a new request is announced again.
    await getTestDb().update(elevationRequests)
      .set({ status: 'denied', denialReason: 'test decision', deniedByUserId: holder.id })
      .where(eq(elevationRequests.id, first));
    const third = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 50 });
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId).sort()).toEqual([first, third].sort());
  });

  runDb('withdrawing the announced request and filing again does not announce again inside the cooldown', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    const first = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    await withdrawOnDevice(first);
    const second = await submitElevation(f);
    await settle();
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId)).toEqual([first]);

    // Nor after the system expires the requests: an expiry is not a decision.
    await getTestDb().update(elevationRequests).set({ status: 'expired', expiredAt: new Date() })
      .where(eq(elevationRequests.id, second));
    await submitElevation(f);
    await settle();
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);

    // Once the announced request is older than the cooldown, the next one is announced.
    await ageRequests(f.deviceId, 16);
    const fourth = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 50 });
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId).sort()).toEqual([first, fourth].sort());
  });

  runDb('a pending request of another flow on the device does not silence a UAC request', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    await seedPendingRow(f, { flowType: 'tech_jit_admin', subjectUserId: holder.id });

    const id = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId)).toEqual([id]);
  });

  runDb('an earlier pending UAC request that was never announced does not silence a new one', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    // Written without the notifier: as if its notifier threw or the process restarted.
    await seedPendingRow(f, { flowType: 'uac_intercept' });

    const id = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId)).toEqual([id]);
  });

  runDb('after overlapping requests expire and the cooldown passes, a new request is announced', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    const first = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    await submitElevation(f);
    await settle();
    await getTestDb().update(elevationRequests).set({ status: 'expired', expiredAt: new Date() })
      .where(eq(elevationRequests.deviceId, f.deviceId));
    await ageRequests(f.deviceId, 16);

    const third = await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(2), { timeout: 5_000, interval: 50 });
    expect((await elevationNotices([holder.id], f.deviceId)).map(noticeRequestId).sort()).toEqual([first, third].sort());
  });

  runDb('two requests racing from one device announce exactly one of them', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);

    const ids = await Promise.all([submitElevation(f), submitElevation(f)]);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    await settle();
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const notices = await elevationNotices([holder.id], f.deviceId);
    expect(notices).toHaveLength(1);
    expect(ids).toContain(noticeRequestId(notices[0]!));
  });

  runDb('past the hourly ceiling a holder gets the in-app notice but no email, and the skip is logged', async () => {
    const f = await seedOrgWithDevice();
    const busy = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    const quiet = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    // Twelve announcements to `busy` in the last hour, about other devices.
    await getTestDb().insert(userNotifications).values(Array.from({ length: 12 }, () => ({
      userId: busy.id,
      orgId: f.orgId,
      type: 'approval' as const,
      title: 'Elevation request waiting',
      dedupeKey: pamElevationNotifyDedupeKey(randomUUID()),
    })));
    const warn = vi.spyOn(console, 'warn');
    try {
      const id = await submitElevation(f);
      await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
      await settle();
      expect(emailRecipients()).toEqual([quiet.email]);
      expect((await elevationNotices([busy.id, quiet.id], f.deviceId)).map((n) => n.userId).sort())
        .toEqual([busy.id, quiet.id].sort());
      expect(warn).toHaveBeenCalledWith('[PamElevationNotify] email ceiling reached; in-app notice only', {
        elevationRequestId: id, orgId: f.orgId, recipients: 2, overCeiling: 1, ceilingPerHour: 12,
      });
    } finally {
      warn.mockRestore();
    }
  });

  runDb('partner staff whose org membership role lacks pam:approve are not told', async () => {
    const f = await seedOrgWithDevice();
    const holder = await seedMember(f.partnerId, f.orgId, [PERMISSIONS.PAM_APPROVE]);
    const partnerWithWeakMembership = await seedPartnerMember(f.partnerId, [PERMISSIONS.PAM_APPROVE], 'all');
    // Unrestricted sites: only the membership's role excludes this user.
    await assignUserToOrganization(
      partnerWithWeakMembership.id, f.orgId, (await orgRole(f.orgId, [PERMISSIONS.DEVICES_EXECUTE])).id,
    );

    await submitElevation(f);
    await vi.waitFor(() => expect(mail.sendEmail).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 });
    await settle();
    expect(emailRecipients()).toEqual([holder.email]);
    expect((await elevationNotices([holder.id, partnerWithWeakMembership.id], f.deviceId)).map((n) => n.userId))
      .toEqual([holder.id]);
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
      await vi.waitFor(async () => expect(await elevationNotices([holder.id], f.deviceId)).toHaveLength(1),
        { timeout: 5_000, interval: 50 });
    } finally {
      errors.mockRestore();
    }
  });
});
