/**
 * push_notifications policies: the recipient keeps their own rows; anyone
 * else needs access to the organization of the alert the notification is for.
 *
 * Migration under test: 2026-12-05-100100-push-notifications-alert-org-policies.sql
 *
 * push_notifications has no org_id column. A row carries the alert's title,
 * body and data, so for a non-recipient the alert's org (alert_id ->
 * alerts.org_id) decides visibility. Rows with no alert, or whose alert no
 * longer exists, are visible to the recipient and system scope only.
 * Exercised with a partner technician whose org list is a subset of the
 * partner's orgs.
 *
 * Runs through the real postgres.js driver (breeze_app, bound parameters).
 * Fixtures are seeded inside each `it` — setup.ts truncates between tests.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { alerts, devices, mobileDevices, pushNotifications } from '../../db/schema';
import { sendPushToDevice } from '../../services/notifications';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

async function seedSelectedOrgTechnician() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner();
  const allowedOrg = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `pn-alert-org-tech-${unique}@example.test`,
  });
  const colleague = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `pn-alert-org-colleague-${unique}@example.test`,
  });

  async function alertIn(orgId: string, label: string) {
    const site = await createSite({ orgId });
    const [device] = await adminDb
      .insert(devices)
      .values({
        orgId,
        siteId: site.id,
        agentId: `pn-agent-${label}-${unique}`,
        hostname: `pn-${label}`,
        status: 'online',
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.99.0',
      })
      .returning();
    const [alert] = await adminDb
      .insert(alerts)
      .values({ deviceId: device.id, orgId, status: 'active', severity: 'critical', title: `alert ${label}` })
      .returning();
    return alert;
  }

  const allowedAlert = await alertIn(allowedOrg.id, 'allowed');
  const otherAlert = await alertIn(otherOrg.id, 'other');

  async function phoneFor(userId: string, label: string) {
    const [phone] = await adminDb
      .insert(mobileDevices)
      .values({ userId, deviceId: `pn-phone-${label}-${unique}`, platform: 'android', fcmToken: `tok-${label}-${unique}` })
      .returning();
    return phone;
  }

  const techPhone = await phoneFor(tech.id, 'tech');
  const colleaguePhone = await phoneFor(colleague.id, 'colleague');

  async function notify(phone: { id: string; userId: string }, alertId: string | null, title: string) {
    const [row] = await adminDb
      .insert(pushNotifications)
      .values({ mobileDeviceId: phone.id, userId: phone.userId, title, platform: 'android', status: 'sent', alertId })
      .returning();
    return row;
  }

  const rows = {
    ownNoAlert: await notify(techPhone, null, 'own, no alert'),
    ownOtherOrg: await notify(techPhone, otherAlert.id, 'own, other org'),
    colleagueAllowedOrg: await notify(colleaguePhone, allowedAlert.id, 'colleague, allowed org'),
    colleagueOtherOrg: await notify(colleaguePhone, otherAlert.id, 'colleague, other org'),
    colleagueNoAlert: await notify(colleaguePhone, null, 'colleague, no alert'),
  };

  const ctx: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [allowedOrg.id],
    accessiblePartnerIds: [partner.id],
    userId: tech.id,
  };

  return { ctx, rows, techPhone, allowedAlert };
}

async function adminRead(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .select({ id: pushNotifications.id, title: pushNotifications.title, status: pushNotifications.status })
    .from(pushNotifications)
    .where(eq(pushNotifications.id, id));
  return row as { id: string; title: string; status: string | null } | undefined;
}

describe('push_notifications policies follow the recipient and the alert organization', () => {
  it('recipient sees all own rows; colleague rows only for accessible-org alerts', async () => {
    const { ctx, rows } = await seedSelectedOrgTechnician();

    const visible = await withDbAccessContext(ctx, () =>
      db.select({ id: pushNotifications.id }).from(pushNotifications)
    );
    const ids = visible.map((r) => r.id).sort();

    expect(ids).toEqual(
      [rows.ownNoAlert.id, rows.ownOtherOrg.id, rows.colleagueAllowedOrg.id].sort()
    );
  });

  it('updates a colleague row whose alert is in an accessible org', async () => {
    const { ctx, rows } = await seedSelectedOrgTechnician();

    const result = await withDbAccessContext(ctx, () =>
      db
        .update(pushNotifications)
        .set({ status: 'read' })
        .where(eq(pushNotifications.id, rows.colleagueAllowedOrg.id))
        .returning({ id: pushNotifications.id })
    );

    expect(result).toHaveLength(1);
    expect((await adminRead(rows.colleagueAllowedOrg.id))?.status).toBe('read');
  });

  it('recipient can update and delete an own row for an alert outside their org list', async () => {
    const { ctx, rows } = await seedSelectedOrgTechnician();

    const updated = await withDbAccessContext(ctx, () =>
      db
        .update(pushNotifications)
        .set({ status: 'read' })
        .where(eq(pushNotifications.id, rows.ownOtherOrg.id))
        .returning({ id: pushNotifications.id })
    );
    expect(updated).toHaveLength(1);

    const deleted = await withDbAccessContext(ctx, () =>
      db
        .delete(pushNotifications)
        .where(eq(pushNotifications.id, rows.ownOtherOrg.id))
        .returning({ id: pushNotifications.id })
    );
    expect(deleted).toHaveLength(1);
    expect(await adminRead(rows.ownOtherOrg.id)).toBeUndefined();
  });

  it.each([['colleagueOtherOrg'], ['colleagueNoAlert']] as const)(
    'does not update or delete %s',
    async (key) => {
      const { ctx, rows } = await seedSelectedOrgTechnician();
      const target = rows[key];

      const updated = await withDbAccessContext(ctx, () =>
        db
          .update(pushNotifications)
          .set({ title: 'changed' })
          .where(eq(pushNotifications.id, target.id))
          .returning({ id: pushNotifications.id })
      );
      expect(updated).toHaveLength(0);

      const deleted = await withDbAccessContext(ctx, () =>
        db
          .delete(pushNotifications)
          .where(eq(pushNotifications.id, target.id))
          .returning({ id: pushNotifications.id })
      );
      expect(deleted).toHaveLength(0);
      expect((await adminRead(target.id))?.title).toBe(target.title);
    }
  );

  it('cannot insert a row for a colleague under an alert outside the org list', async () => {
    const { ctx, rows } = await seedSelectedOrgTechnician();
    const adminDb = getTestDb() as any;
    const [colleagueRow] = await adminDb
      .select({ mobileDeviceId: pushNotifications.mobileDeviceId, userId: pushNotifications.userId, alertId: pushNotifications.alertId })
      .from(pushNotifications)
      .where(eq(pushNotifications.id, rows.colleagueOtherOrg.id));

    await expect(
      withDbAccessContext(ctx, () =>
        db.insert(pushNotifications).values({ ...colleagueRow, title: 'inserted', platform: 'android' })
      )
    ).rejects.toThrow();
  });

  it('the notification writer records and updates rows under system scope', async () => {
    const { techPhone, allowedAlert } = await seedSelectedOrgTechnician();

    await withSystemDbAccessContext(() =>
      sendPushToDevice(techPhone, {
        title: 'writer path',
        body: 'body',
        data: { severity: 'critical' },
        alertId: allowedAlert.id,
        eventType: 'alert.triggered',
      })
    );

    const adminDb = getTestDb() as any;
    const written = await adminDb
      .select({ status: pushNotifications.status, alertId: pushNotifications.alertId })
      .from(pushNotifications)
      .where(eq(pushNotifications.title, 'writer path'));
    expect(written).toHaveLength(1);
    expect(written[0].alertId).toBe(allowedAlert.id);
    // FCM is not configured in tests, so the send is stubbed — the follow-up
    // UPDATE moved the row off 'pending'.
    expect(written[0].status).toBe('stubbed');
  });
});
