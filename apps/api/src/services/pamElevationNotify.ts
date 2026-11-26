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
 * Throttle: one in-app notice per recipient, device and 15-minute window
 * (`pamElevationNotifyDedupeKey`, enforced by the user_notifications dedupe
 * index), and the email goes only to recipients whose notice was created by
 * this call. A device raising many requests, an agent retrying, or two
 * requests racing each other therefore produce one notice and one email per
 * person per window. The window matches the pending TTL, so a request that is
 * still waiting has been announced. A recipient whose in-app write failed is
 * still emailed, so one channel failing never silences the other.
 *
 * Content: device hostname and org name only. No executable path, command line
 * or requesting username: those are in the PAM page, behind sign-in.
 *
 * Best-effort throughout. The caller runs this after the elevation row has
 * committed and after the mobile fan-out, and never fails the agent's request
 * on it.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import { organizations, organizationUsers, users } from '../db/schema';
import { getEmailService } from './email';
import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';
import { PERMISSIONS } from './permissions';
import { captureException } from './sentry';
import { normalizeSiteAllowlist } from './siteAllowlist';
import { createNotification } from './userNotifications';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

/** One notice per recipient and device per window. Matches PAM_PENDING_REQUEST_TTL_MINUTES. */
export const PAM_ELEVATION_NOTIFY_WINDOW_MINUTES = 15;

/** Where a permission holder decides a pending request on the web. */
export const PAM_REQUESTS_PATH = '/pam#requests';

const MAIL_PURPOSE = 'staff.pam_elevation_request' as const;

/**
 * The dedupe key for `deviceId` at `at`: fixed windows of
 * PAM_ELEVATION_NOTIFY_WINDOW_MINUTES on the server clock.
 */
export function pamElevationNotifyDedupeKey(deviceId: string, at: Date): string {
  const window = Math.floor(at.getTime() / (PAM_ELEVATION_NOTIFY_WINDOW_MINUTES * 60_000));
  return `pam-elevation:${deviceId}:${window}`;
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
    + `You get at most one email per device every ${PAM_ELEVATION_NOTIFY_WINDOW_MINUTES} minutes.`;
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
  /** Permission holders who may decide this request. */
  recipients: number;
  /** In-app notices created by this call (0 for a recipient already told this window). */
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
      console.error(`[PamElevationNotify] ${MAIL_PURPOSE} send failed`, { elevationRequestId, userId: r.id }, err);
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
 * Throws only if the recipient lookup itself fails; the caller catches that.
 */
export async function notifyPendingElevation(args: PendingElevationNotifyArgs): Promise<PendingElevationNotifyResult> {
  const { elevationRequestId, orgId, siteId, deviceId, deviceHostname } = args;
  const now = args.now ?? new Date();
  const dedupeKey = pamElevationNotifyDedupeKey(deviceId, now);

  const { recipients, toEmail, orgName, inAppCreated, inAppFailed } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const holderIds = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.PAM_APPROVE);
      const ids = await holdersWhoCanSeeSite(orgId, siteId, holderIds);
      if (ids.length === 0) {
        return { recipients: [] as Recipient[], toEmail: [] as Recipient[], orgName: '', inAppCreated: 0, inAppFailed: 0 };
      }
      const people = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.status, 'active')));
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
          // The SQLSTATE or error name only, as the approval insert does.
          const { cause, name: errName } = err as { cause?: { code?: unknown }; name?: unknown };
          console.error(
            `[PamElevationNotify] in-app notice failed for user=${person.id} elevation=${elevationRequestId}: ${String(cause?.code ?? errName ?? 'unknown')}`,
          );
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return { recipients: people, toEmail: emailTo, orgName: name, inAppCreated: created, inAppFailed: failed };
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
        console.error('[PamElevationNotify] email delivery failed', { elevationRequestId }, err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        return { sent: 0, failed: toEmail.length };
      });
  }

  return { recipients: recipients.length, inAppCreated, inAppFailed, emailDelivery };
}
