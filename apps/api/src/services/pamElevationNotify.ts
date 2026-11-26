/**
 * #11231: tell every user who can decide a pending elevation request that one
 * is waiting, by in-app notification and by email. Mobile push (the approval
 * fan-out in routes/agents/elevationRequests.ts) stays an extra channel for
 * those who have the app; before this, a permission holder without a paired
 * phone was told nothing and the request expired unseen.
 *
 * Recipients: the users `resolveUsersWithPermissionForOrg` returns for
 * `pam:approve` on the request's org (org members whose role grants it, plus
 * partner staff of the owning partner whose org access covers the org, all
 * active), narrowed to org members whose site allowlist covers the device's
 * site. The narrowing only removes people: a member restricted to other sites
 * cannot open or decide the request (routes/pam.ts checks `canAccessSite`), so
 * they are not sent its device and org name either.
 *
 * Throttle: a request is announced unless an EARLIER request from the same
 * device is still pending and was created within the last
 * PAM_ELEVATION_NOTIFY_WINDOW_MINUTES (the pending TTL). That earlier
 * request's notice already sent everyone to the Requests tab, where the new
 * one is listed too, so a device raising many requests produces one notice and
 * one email per person until someone decides or the earlier request expires.
 * A request raised after the earlier one was decided is announced again.
 * "Earlier" is ordered by (created_at, id), so of two requests racing each
 * other exactly one is announced, never neither. Each announced request writes
 * one in-app notice per person (dedupe key per request, so a repeated call
 * writes nothing twice), and the email goes to each person whose notice this
 * call created. A person whose in-app write failed is still emailed, so one
 * channel failing never silences the other; the earlier-pending rule bounds
 * that path too.
 *
 * Content: device hostname and org name only. No executable path, command line
 * or requesting username: those are in the PAM page, behind sign-in.
 *
 * Best-effort throughout. The caller runs this after the elevation row has
 * committed and after the mobile fan-out, and never fails the agent's request
 * on it.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import { elevationRequests, organizations, organizationUsers, users } from '../db/schema';
import { getEmailService } from './email';
import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';
import { PERMISSIONS } from './permissions';
import { captureException } from './sentry';
import { normalizeSiteAllowlist } from './siteAllowlist';
import { createNotification } from './userNotifications';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

/**
 * How far back an earlier pending request from the same device suppresses the
 * announcement of a newer one. Matches PAM_PENDING_REQUEST_TTL_MINUTES.
 */
export const PAM_ELEVATION_NOTIFY_WINDOW_MINUTES = 15;

/** Where a permission holder decides a pending request on the web. */
export const PAM_REQUESTS_PATH = '/pam#requests';

const MAIL_PURPOSE = 'staff.pam_elevation_request' as const;

/** The in-app dedupe key: one notice per person and request. */
export function pamElevationNotifyDedupeKey(elevationRequestId: string): string {
  return `pam-elevation:${elevationRequestId}`;
}

function dashboardBase(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

/** Hostnames come from the agent: keep them to one printable line in a subject. */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');
}

export interface PendingElevationEmail { subject: string; html: string; text: string }

export function buildPendingElevationEmail(p: { deviceName: string; orgName: string; reviewUrl: string }): PendingElevationEmail {
  const device = oneLine(p.deviceName, 120) || 'a device';
  const org = oneLine(p.orgName, 120);
  const lead = org
    ? `An elevation request from ${device} (${org}) is waiting for a decision.`
    : `An elevation request from ${device} is waiting for a decision.`;
  const note = `A request nobody decides expires after ${PAM_ELEVATION_NOTIFY_WINDOW_MINUTES} minutes. `
    + 'Further requests from this device while this one is waiting are listed there without another email.';
  return {
    subject: `Elevation request waiting: ${device}`,
    html: renderLayout({
      title: 'Elevation request waiting',
      preheader: lead,
      heading: 'Elevation request waiting',
      body: renderParagraph(escapeHtml(lead))
        + renderButton('Review requests', p.reviewUrl)
        + renderParagraph(escapeHtml(note), { muted: true, marginTop: 16 }),
    }),
    text: `${lead}\n\nReview requests: ${p.reviewUrl}\n\n${note}`,
  };
}

export interface PendingElevationNotifyArgs {
  elevationRequestId: string;
  orgId: string;
  siteId: string | null;
  deviceId: string;
  deviceHostname: string;
  now?: Date;
}

export interface PendingElevationNotifyResult {
  /** Set when nobody was notified because an earlier request from the device is still pending. */
  skipped: 'earlier_request_pending' | null;
  /** Permission holders who may decide this request (0 when skipped). */
  recipients: number;
  /** In-app notices created by this call (0 for a person this request already told). */
  inAppCreated: number;
  /** Recipients whose in-app write failed. */
  inAppFailed: number;
  /** Settles when the emails have been handed off; never rejects. */
  emailDelivery: Promise<{ sent: number; failed: number }>;
}

interface Recipient { id: string; email: string }

/**
 * Narrow permission holders to those who can see the device's site. A user
 * with an org membership in this org takes that membership's site allowlist
 * (org membership wins over partner membership in getUserPermissions); a NULL
 * allowlist is unrestricted. Partner staff have no site allowlist.
 */
async function holdersWhoCanSeeSite(orgId: string, siteId: string | null, holderIds: string[]): Promise<string[]> {
  if (!siteId || holderIds.length === 0) return holderIds;
  const memberships = await db
    .select({ userId: organizationUsers.userId, siteIds: organizationUsers.siteIds })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.orgId, orgId), inArray(organizationUsers.userId, holderIds)));
  const blocked = new Set<string>();
  for (const m of memberships) {
    const allowed = normalizeSiteAllowlist(m.siteIds ?? undefined);
    if (allowed !== undefined && !allowed.includes(siteId)) blocked.add(m.userId);
  }
  return holderIds.filter((id) => !blocked.has(id));
}

/**
 * True when another request from the device, ordered before this one by
 * (created_at, id), is still pending and was created within the window. A
 * missing row for `elevationRequestId` compares as NULL, so it never suppresses.
 */
async function earlierRequestStillPending(args: {
  orgId: string; deviceId: string; elevationRequestId: string; now: Date;
}): Promise<boolean> {
  const since = new Date(args.now.getTime() - PAM_ELEVATION_NOTIFY_WINDOW_MINUTES * 60_000);
  const rows = await db
    .select({ id: elevationRequests.id })
    .from(elevationRequests)
    .where(and(
      eq(elevationRequests.orgId, args.orgId),
      eq(elevationRequests.deviceId, args.deviceId),
      eq(elevationRequests.status, 'pending'),
      gte(elevationRequests.createdAt, since),
      sql`(${elevationRequests.createdAt}, ${elevationRequests.id}) < (SELECT r.created_at, r.id FROM elevation_requests r WHERE r.id = ${args.elevationRequestId})`,
    ))
    .limit(1);
  return rows.length > 0;
}

/** The SQLSTATE or error name only: a query or mail error can carry bound values or addresses. */
function errorCode(err: unknown): string {
  const { cause, name, code } = (err ?? {}) as { cause?: { code?: unknown }; name?: unknown; code?: unknown };
  return String(cause?.code ?? code ?? name ?? 'unknown');
}

async function sendEmails(recipients: Recipient[], mail: PendingElevationEmail, elevationRequestId: string) {
  let sent = 0;
  let failed = 0;
  const service = getEmailService();
  if (!service) {
    if (recipients.length > 0) {
      console.warn(`[PamElevationNotify] email not configured; ${MAIL_PURPOSE} not sent`, { elevationRequestId });
    }
    return { sent, failed };
  }
  // One message per recipient, so no recipient sees the others' addresses.
  for (const r of recipients) {
    try {
      await service.sendEmail({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text, purpose: MAIL_PURPOSE });
      sent++;
    } catch (err) {
      failed++;
      console.error(`[PamElevationNotify] ${MAIL_PURPOSE} send failed for user=${r.id} elevation=${elevationRequestId}: ${errorCode(err)}`);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { sent, failed };
}

/**
 * Notify the permission holders for a new pending elevation request. All
 * reads and the in-app writes run in one system context opened outside any
 * caller context (the cross-user insert needs system scope, and a bare system
 * wrapper inside a request context is a passthrough). Emails are sent after
 * that context closes, in the background: `emailDelivery` reports how they
 * went and never rejects.
 *
 * Throws only if a lookup itself fails; the caller catches that.
 */
export async function notifyPendingElevation(args: PendingElevationNotifyArgs): Promise<PendingElevationNotifyResult> {
  const { elevationRequestId, orgId, siteId, deviceId, deviceHostname } = args;
  const now = args.now ?? new Date();
  const dedupeKey = pamElevationNotifyDedupeKey(elevationRequestId);
  const none = {
    recipients: [] as Recipient[], toEmail: [] as Recipient[], orgName: '', inAppCreated: 0, inAppFailed: 0,
  };

  const { skipped, recipients, toEmail, orgName, inAppCreated, inAppFailed } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      if (await earlierRequestStillPending({ orgId, deviceId, elevationRequestId, now })) {
        return { ...none, skipped: 'earlier_request_pending' as const };
      }
      const holderIds = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.PAM_APPROVE);
      const ids = await holdersWhoCanSeeSite(orgId, siteId, holderIds);
      const people = ids.length === 0 ? [] : await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.status, 'active')));
      if (people.length === 0) {
        // Nobody who can decide this request can be told. Counts only. With
        // holders but none left after the site narrowing, the mobile side may
        // have audited `no_notifying_device`; this line is what says the
        // request was not announced at all.
        console.warn('[PamElevationNotify] pending elevation has no one to notify', {
          elevationRequestId,
          orgId,
          permissionHolders: holderIds.length,
          withSiteAccess: ids.length,
        });
        return { ...none, skipped: null };
      }
      const [orgRow] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const name = orgRow?.name ?? '';

      const title = 'Elevation request waiting';
      const device = oneLine(deviceHostname, 120) || 'a device';
      const org = oneLine(name, 120);
      const message = org
        ? `An elevation request from ${device} (${org}) is waiting for a decision.`
        : `An elevation request from ${device} is waiting for a decision.`;

      const emailTo: Recipient[] = [];
      let created = 0;
      let failed = 0;
      for (const person of people) {
        try {
          // A savepoint, so one recipient's failed insert leaves the others and
          // this context's commit intact.
          const id = await withDbTransaction(() => createNotification({
            userId: person.id,
            orgId,
            type: 'approval',
            priority: 'high',
            title,
            message,
            link: PAM_REQUESTS_PATH,
            metadata: { elevationRequestId, deviceId },
            dedupeKey,
          }));
          if (id) {
            created++;
            emailTo.push(person);
          }
        } catch (err) {
          failed++;
          emailTo.push(person);
          console.error(
            `[PamElevationNotify] in-app notice failed for user=${person.id} elevation=${elevationRequestId}: ${errorCode(err)}`,
          );
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return {
        skipped: null, recipients: people, toEmail: emailTo, orgName: name, inAppCreated: created, inAppFailed: failed,
      };
    }),
  );

  let emailDelivery: Promise<{ sent: number; failed: number }>;
  if (toEmail.length === 0) {
    emailDelivery = Promise.resolve({ sent: 0, failed: 0 });
  } else {
    emailDelivery = Promise.resolve()
      .then(() => sendEmails(
        toEmail,
        buildPendingElevationEmail({ deviceName: deviceHostname, orgName, reviewUrl: `${dashboardBase()}${PAM_REQUESTS_PATH}` }),
        elevationRequestId,
      ))
      .catch((err: unknown) => {
        // Building the mail threw; sendEmails itself never rejects.
        console.error(`[PamElevationNotify] email delivery failed for elevation=${elevationRequestId}: ${errorCode(err)}`);
        captureException(err instanceof Error ? err : new Error(String(err)));
        return { sent: 0, failed: toEmail.length };
      });
  }

  return { skipped, recipients: recipients.length, inAppCreated, inAppFailed, emailDelivery };
}
