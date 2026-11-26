/**
 * #11231: tell every user who can decide a pending elevation request that one
 * is waiting, by in-app notification and by email. Mobile push (the approval
 * fan-out in routes/agents/elevationRequests.ts) stays an extra channel for
 * those who have the app; before this, a permission holder without a paired
 * phone was told nothing and the request expired unseen.
 *
 * Recipients (resolveElevationNoticeAudience): the users who hold
 * `pam:approve` for the request's org: org members whose role grants it, and
 * partner staff of the owning partner whose role grants it and whose org
 * access covers the org, all active. A user who also has an org membership is
 * judged by that membership alone (org membership wins, as in
 * getUserPermissions): its role must grant the permission and its site
 * allowlist must cover the device's site. These checks only remove people:
 * someone who cannot decide the request (routes/pam.ts) is not sent its
 * device and org name either.
 *
 * Announce rule. The endpoint agent controls when requests are filed, so the
 * rule bounds how often it can make the platform write to people:
 *   1. Only a uac_intercept request that is still `pending` when the notifier
 *      runs is announced.
 *   2. Per-device cooldown: the request is not announced when another
 *      uac_intercept request from the same device and org, created within the
 *      last PAM_ELEVATION_NOTIFY_COOLDOWN_MINUTES, was announced and no person
 *      has approved or denied it. What the device did with that request
 *      (left it pending, withdrew it, let it expire) does not matter; a
 *      person's decision on it ends the cooldown early. "Announced" is read
 *      from durable state, the announced request's own in-app notice rows,
 *      so a request whose notifier never ran, threw, or found nobody to tell
 *      never suppresses another, and neither does a request of another flow.
 *      Suppressed requests are listed on the Requests tab the announced
 *      notice points to.
 *   3. Per-recipient email ceiling: a person who has received
 *      PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR elevation notices in the
 *      last hour still gets the in-app notice, but no email, and a warn line
 *      records the counts. This bounds a mass event across many devices of
 *      one org, which the per-device cooldown cannot.
 * Decisions for one device are serialized by a transaction-scoped advisory
 * lock taken before rule 1 is read, and the notices commit before the lock is
 * released. So of requests from one device racing each other, the first to
 * take the lock is announced and the others read its committed notices and
 * are not: one announcement, never none. If every in-app write of the first
 * fails, it leaves no notice and the next one is announced too; the rule errs
 * towards telling people. (Ordering by created_at could not promise any of
 * this: created_at is the inserting transaction's start time, not its commit
 * order.)
 *
 * Writes: one in-app notice per person (dedupe key per request, so a repeated
 * call writes nothing twice), then an email to each person whose notice this
 * call created and who is under the ceiling. A person whose in-app write
 * failed is still emailed when under the ceiling, so one failed channel never
 * silences the other; such a send has no notice row, so it is not counted
 * towards the ceiling or the cooldown.
 *
 * Content: device hostname and org name only. No executable path, command line
 * or requesting username: those are on the PAM page, behind sign-in. The
 * hostname is chosen by the agent: the email carries only its first DNS label
 * reduced to letters, digits, '-' and '_' (emailDeviceLabel), so it holds no
 * dot, colon, slash or '@' and no mail client can turn it into a link or an
 * address; the HTML is escaped as well. The in-app notice keeps the full
 * hostname, rendered as text.
 *
 * Best-effort throughout. The caller runs this after the elevation row has
 * committed and after the mobile fan-out, and never fails the agent's request
 * on it.
 */

import { runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import { getEmailService } from './email';
import { escapeHtml, renderButton, renderLayout, renderParagraph } from './emailLayout';
import {
  countRecentElevationNotices,
  deviceAnnouncedWithin,
  type ElevationNoticeRecipient,
  lockDeviceAnnouncements,
  pamElevationNotifyDedupeKey,
  readElevationRequestState,
  readOrgName,
  resolveElevationNoticeAudience,
} from './pamElevationNotifyQueries';
import { captureException } from './sentry';
import { createNotification } from './userNotifications';

export { pamElevationNotifyDedupeKey };

/**
 * After an announcement, further requests from the device are not announced
 * for this long. Matches PAM_PENDING_REQUEST_TTL_MINUTES, so the cooldown ends
 * when the announced request would have expired.
 */
export const PAM_ELEVATION_NOTIFY_COOLDOWN_MINUTES = 15;

/**
 * Elevation emails one person may receive in an hour. The per-device cooldown
 * already limits one device to 4 an hour, so 12 is three devices at their
 * fastest, or one every five minutes on average: enough to follow a busy
 * morning by email. Past it, the bell and the Requests tab show every request
 * and further email adds noise, not information.
 */
export const PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR = 12;

/** Where a permission holder decides a pending request on the web. */
export const PAM_REQUESTS_PATH = '/pam#requests';

const MAIL_PURPOSE = 'staff.pam_elevation_request' as const;

function dashboardBase(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/+$/, '');
}

/** Keep a value to one printable line (no control characters), at most `max` code points. */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('');
}

/**
 * The hostname as the email shows it: its first DNS label, reduced to
 * letters, digits, '-' and '_' (at most 63). With no dot, colon, slash or
 * '@' left, no mail client can read it as a URL, a domain or an address,
 * whatever the agent reported. A Windows computer name is a single label, so
 * it is usually shown in full.
 */
export function emailDeviceLabel(hostname: string): string {
  const first = hostname.trim().split('.')[0] ?? '';
  return Array.from(first.replace(/[^\p{L}\p{N}_-]+/gu, '')).slice(0, 63).join('');
}

export interface PendingElevationEmail { subject: string; html: string; text: string }

export function buildPendingElevationEmail(p: { deviceName: string; orgName: string; reviewUrl: string }): PendingElevationEmail {
  const device = emailDeviceLabel(p.deviceName) || 'a device';
  const org = oneLine(p.orgName, 120);
  const lead = org
    ? `An elevation request from ${device} (${org}) is waiting for a decision.`
    : `An elevation request from ${device} is waiting for a decision.`;
  const note = `A request nobody decides expires after ${PAM_ELEVATION_NOTIFY_COOLDOWN_MINUTES} minutes. `
    + `Further requests from this device in the next ${PAM_ELEVATION_NOTIFY_COOLDOWN_MINUTES} minutes are listed there without another email.`;
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

export type PendingElevationSkip = 'not_pending' | 'not_uac_request' | 'device_cooldown';

export interface PendingElevationNotifyResult {
  /** Why nobody was notified, when the announce rule said not to. */
  skipped: PendingElevationSkip | null;
  /** People who may decide this request (0 when skipped). */
  recipients: number;
  /** In-app notices created by this call (0 for a person this request already told). */
  inAppCreated: number;
  /** Recipients whose in-app write failed. */
  inAppFailed: number;
  /** Recipients given the in-app notice only, because they reached the hourly email ceiling. */
  emailCeilingReached: number;
  /** Settles when the emails have been handed off; never rejects. */
  emailDelivery: Promise<{ sent: number; failed: number }>;
}

/** The SQLSTATE or error name only: a query or mail error can carry bound values or addresses. */
function errorCode(err: unknown): string {
  const { cause, name, code } = (err ?? {}) as { cause?: { code?: unknown }; name?: unknown; code?: unknown };
  return String(cause?.code ?? code ?? name ?? 'unknown');
}

async function sendEmails(recipients: ElevationNoticeRecipient[], mail: PendingElevationEmail, elevationRequestId: string) {
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
 * Notify the people who may decide a new pending elevation request, under the
 * announce rule above. The lock, all reads and the in-app writes run in one
 * system context opened outside any caller context (the cross-user insert
 * needs system scope, and a bare system wrapper inside a request context is a
 * passthrough). Emails are sent after that context commits, in the
 * background: `emailDelivery` reports how they went and never rejects.
 *
 * Throws only if the lock or a lookup itself fails; the caller catches that.
 */
export async function notifyPendingElevation(args: PendingElevationNotifyArgs): Promise<PendingElevationNotifyResult> {
  const { elevationRequestId, orgId, siteId, deviceId, deviceHostname } = args;
  const now = args.now ?? new Date();
  const dedupeKey = pamElevationNotifyDedupeKey(elevationRequestId);
  const none = {
    recipients: [] as ElevationNoticeRecipient[], toEmail: [] as ElevationNoticeRecipient[], orgName: '',
    inAppCreated: 0, inAppFailed: 0, emailCeilingReached: 0,
  };

  const { skipped, recipients, toEmail, orgName, inAppCreated, inAppFailed, emailCeilingReached } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await lockDeviceAnnouncements(deviceId);

      const request = await readElevationRequestState({ elevationRequestId, orgId, deviceId });
      if (!request || request.status !== 'pending') return { ...none, skipped: 'not_pending' as const };
      if (request.flowType !== 'uac_intercept') return { ...none, skipped: 'not_uac_request' as const };

      const audience = await resolveElevationNoticeAudience(orgId, siteId);
      const people = audience.people;
      if (people.length === 0) {
        // Nobody who can decide this request can be told. Counts only. With
        // holders but none left after the membership checks, the mobile side
        // may have audited `no_notifying_device`; this line is what says the
        // request was not announced at all.
        console.warn('[PamElevationNotify] pending elevation has no one to notify', {
          elevationRequestId,
          orgId,
          permissionHolders: audience.permissionHolders,
          withSiteAccess: audience.withAccess,
        });
        return { ...none, skipped: null };
      }

      const peopleIds = people.map((p) => p.id);
      const cooldownSince = new Date(now.getTime() - PAM_ELEVATION_NOTIFY_COOLDOWN_MINUTES * 60_000);
      if (await deviceAnnouncedWithin({ orgId, deviceId, elevationRequestId, recipientIds: peopleIds, since: cooldownSince })) {
        return { ...none, skipped: 'device_cooldown' as const };
      }

      // Read before this call's own notices are written, so they are not counted.
      const recentNotices = await countRecentElevationNotices(peopleIds, new Date(now.getTime() - 60 * 60_000));
      const underCeiling = (id: string) => (recentNotices.get(id) ?? 0) < PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR;

      const name = await readOrgName(orgId);
      const title = 'Elevation request waiting';
      const device = oneLine(deviceHostname, 120) || 'a device';
      const org = oneLine(name, 120);
      const message = org
        ? `An elevation request from ${device} (${org}) is waiting for a decision.`
        : `An elevation request from ${device} is waiting for a decision.`;

      const emailTo: ElevationNoticeRecipient[] = [];
      let created = 0;
      let failed = 0;
      let overCeiling = 0;
      const queueEmail = (person: ElevationNoticeRecipient) => {
        if (underCeiling(person.id)) emailTo.push(person);
        else overCeiling++;
      };
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
            queueEmail(person);
          }
        } catch (err) {
          failed++;
          queueEmail(person);
          console.error(
            `[PamElevationNotify] in-app notice failed for user=${person.id} elevation=${elevationRequestId}: ${errorCode(err)}`,
          );
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (overCeiling > 0) {
        console.warn('[PamElevationNotify] email ceiling reached; in-app notice only', {
          elevationRequestId,
          orgId,
          recipients: people.length,
          overCeiling,
          ceilingPerHour: PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR,
        });
      }
      return {
        skipped: null, recipients: people, toEmail: emailTo, orgName: name,
        inAppCreated: created, inAppFailed: failed, emailCeilingReached: overCeiling,
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

  return {
    skipped, recipients: recipients.length, inAppCreated, inAppFailed, emailCeilingReached, emailDelivery,
  };
}
