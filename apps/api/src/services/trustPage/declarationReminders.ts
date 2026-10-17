// Owner: W02b (30-day declaration expiry reminders, spec §18.2). Called by the hourly trust-page sweep
// (jobs/trustPageSnapshotWorker.ts) in its own try/catch, OUTSIDE any db context: every db step below opens
// its own `runOutsideDbContext(() => withSystemDbAccessContext(...))`, or its writes match zero rows under
// forced RLS.
//
// Delivery is at-most-once (Open Decision 3): each row is claimed with a conditional UPDATE … RETURNING in the
// same transaction that writes its in-app notifications (dedupeKey per declaration), so a failure there rolls
// the claim back and the next sweep retries without duplicating notifications. Email goes out after that
// transaction commits, outside any db context (never hold a pooled connection across SMTP), and is not retried.
import { and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { declaredControlById, DECLARED_CONTROL_IDS, TRUST_DECLARATION_REMINDER_DAYS, type DeclaredControlId } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPageDeclarations, users } from '../../db/schema';
import { PERMISSIONS } from '../permissions';
import { resolveUsersWithPermissionForOrg } from '../usersWithPermission';
import { createNotification } from '../userNotifications';
import { getEmailService } from '../email';
import { captureException } from '../sentry';
import { buildAutomationEligibleOrgPredicate } from '../tenantStatus';
import { buildDeclarationReminderEmail, formatReminderDate } from './declarationReminderEmail';

const DAY_MS = 86_400_000;
export const DECLARATION_REMINDER_BATCH = 200;
const LABEL = 'trustPage.declarationReminders';
const DECLARED = new Set<string>(DECLARED_CONTROL_IDS);

const sys = <T>(fn: () => Promise<T>, label: string) => runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

function appBaseUrl(): string | null {
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : null;
}

interface Candidate { id: string; orgId: string; controlId: string; expiresAt: Date; orgName: string; partnerName: string }

export async function runDeclarationReminders(now: Date): Promise<{ reminded: number }> {
  const horizon = new Date(now.getTime() + TRUST_DECLARATION_REMINDER_DAYS * DAY_MS);
  // Active, unreminded, expiring within the window and not yet expired (the reminder partial index).
  const candidates: Candidate[] = await sys(() => db.select({
    id: trustPageDeclarations.id, orgId: trustPageDeclarations.orgId, controlId: trustPageDeclarations.controlId,
    expiresAt: trustPageDeclarations.expiresAt, orgName: organizations.name, partnerName: partners.name,
  }).from(trustPageDeclarations)
    .innerJoin(organizations, eq(organizations.id, trustPageDeclarations.orgId))
    .innerJoin(partners, eq(partners.id, organizations.partnerId))
    .where(and(
      isNull(trustPageDeclarations.supersededAt), isNull(trustPageDeclarations.withdrawnAt), isNull(trustPageDeclarations.reminderSentAt),
      // Only catalog controls: a retired id would never be claimed and would crowd the batch every hour.
      inArray(trustPageDeclarations.controlId, [...DECLARED_CONTROL_IDS]),
      lte(trustPageDeclarations.expiresAt, horizon), gt(trustPageDeclarations.expiresAt, now),
      // An archived / purging / merging org is not nagged about its trust page (contract-renewal precedent).
      buildAutomationEligibleOrgPredicate(trustPageDeclarations.orgId),
    ))
    .orderBy(asc(trustPageDeclarations.expiresAt))
    .limit(DECLARATION_REMINDER_BATCH), `${LABEL}.scan`);
  if (candidates.length === DECLARATION_REMINDER_BATCH) {
    console.warn(`[trustPage] declaration reminder batch is full (${DECLARATION_REMINDER_BATCH}); the rest wait for the next sweep`);
  }

  const base = appBaseUrl();
  if (!base && candidates.length > 0) console.warn('[trustPage] DASHBOARD_URL / PUBLIC_APP_URL unset or not absolute; reminder emails go out without a link');
  const emails: Array<{ to: string; subject: string; html: string; text: string; declarationId: string }> = [];
  let reminded = 0;

  for (const c of candidates) {
    if (!DECLARED.has(c.controlId)) continue;
    const def = declaredControlById(c.controlId as DeclaredControlId);
    if (!def) continue;
    const path = `/organizations/${c.orgId}#trust`;
    try {
      const recipients = await sys(async () => {
        // Recipients first: claiming a row nobody can act on would burn its only reminder. An org with no
        // organizations:write user is left unclaimed (and logged), so it is reminded once someone has access.
        const userIds = await resolveUsersWithPermissionForOrg(c.orgId, PERMISSIONS.ORGS_WRITE);
        if (userIds.length === 0) return 'no_recipients' as const;
        // The claim re-checks what the scan checked: a row superseded, withdrawn or expired since is not reminded.
        const claimed = await db.update(trustPageDeclarations).set({ reminderSentAt: now })
          .where(and(
            eq(trustPageDeclarations.id, c.id), isNull(trustPageDeclarations.reminderSentAt),
            isNull(trustPageDeclarations.supersededAt), isNull(trustPageDeclarations.withdrawnAt), gt(trustPageDeclarations.expiresAt, now),
          ))
          .returning({ id: trustPageDeclarations.id });
        if (claimed.length === 0) return null; // another sweep won the claim, or the row changed
        const message = `${def.title} on ${c.orgName}’s trust page expires on ${formatReminderDate(c.expiresAt)}. Re-declare it and republish.`;
        for (const userId of userIds) {
          await createNotification({
            userId, orgId: c.orgId, type: 'system', title: 'A declared control expires soon', message,
            link: path, priority: 'normal', dedupeKey: `trust-declaration-reminder:${c.id}`,
          });
        }
        return db.select({ id: users.id, email: users.email }).from(users)
          .where(and(inArray(users.id, userIds), eq(users.status, 'active')));
      }, `${LABEL}.claim`);
      if (recipients === 'no_recipients') {
        console.warn('[trustPage] declaration reminder has no recipients (no organizations:write user); left unclaimed', `declarationId=${c.id}`, `orgId=${c.orgId}`);
        continue;
      }
      if (recipients === null) continue;
      reminded++;
      const tpl = buildDeclarationReminderEmail({
        controlTitle: def.title, orgName: c.orgName, partnerName: c.partnerName, expiresAt: c.expiresAt,
        link: base ? `${base}${path}` : null,
      });
      for (const r of recipients) if (r.email) emails.push({ to: r.email, ...tpl, declarationId: c.id });
    } catch (err) {
      // The row's transaction rolled back (claim included), so the next sweep retries it.
      console.error('[trustPage] declaration reminder failed', `declarationId=${c.id}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const emailService = getEmailService();
  if (!emailService && emails.length > 0) {
    console.warn(`[trustPage] email service not configured; ${emails.length} declaration reminder email(s) skipped (in-app notifications were created)`);
  }
  if (emailService) {
    for (const e of emails) {
      try {
        // To MSP staff, never the customer: platform lane.
        await emailService.sendEmail({ purpose: 'staff.trust_declaration_reminder', to: e.to, subject: e.subject, html: e.html, text: e.text });
      } catch (err) {
        // At-most-once: the in-app notification already exists and the claim stands; the email is not retried.
        console.error('[trustPage] declaration reminder email failed', `declarationId=${e.declarationId}`, err instanceof Error ? err.message : err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  return { reminded };
}
