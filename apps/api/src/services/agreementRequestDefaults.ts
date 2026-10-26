// #9075 W4a (spec OD8 B) — the ONE resolver for the agreement-request defaults
// a partner sets under Settings → Billing → Agreements (settings rule 5):
//
//   home      Settings → Billing → Agreements (partners.agreement_* columns,
//             PATCH /partner/billing-settings)
//   level     partner only — there is no org override (OD8 B names a
//             partner-level setting; the per-request expiry is the override)
//   resolver  this module: partner default → the sender's own expiry on the
//             request → snapshotted as agreement_requests.expires_at at create
//
// Every reader goes through here: the create path (default expiry), the Send
// dialog's pre-fill (GET /contracts/agreement-requests/defaults) and the
// automatic-reminder job (cadence + cap). Never read the partners columns
// directly.

import { eq } from 'drizzle-orm';
import {
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX,
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN,
  AGREEMENT_MAX_REMINDERS_DEFAULT,
  AGREEMENT_MAX_REMINDERS_MAX,
  AGREEMENT_MAX_REMINDERS_MIN,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MAX,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MIN,
  AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS,
  type AgreementRequestDefaultsDto,
} from '@breeze/shared';
import { db } from '../db';
import { partners } from '../db/schema';
import type { AgreementRequestStatus } from '../db/schema/contractDocuments';
import { isAgreementRequestExpired } from './agreementRequestService';

const DAY_MS = 24 * 60 * 60 * 1000;

export type AgreementRequestDefaults = AgreementRequestDefaultsDto;

/** What a partner that never opened the settings gets (= the column DEFAULTs). */
export const BUILT_IN_AGREEMENT_REQUEST_DEFAULTS: AgreementRequestDefaults = Object.freeze({
  defaultExpiryDays: AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS,
  autoReminder: null,
});

export interface PartnerAgreementDefaultColumns {
  agreementDefaultExpiryDays: number | null;
  agreementReminderIntervalDays: number | null;
  agreementMaxReminders: number | null;
}

function inRange(value: number | null | undefined, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Pure: the partner's columns → the resolved defaults. A value outside the
 *  bounds (only possible if the DB CHECK was bypassed) falls back per field
 *  rather than throwing — a bad setting must not break sending. */
export function resolveAgreementRequestDefaults(row: PartnerAgreementDefaultColumns | null): AgreementRequestDefaults {
  if (!row) return BUILT_IN_AGREEMENT_REQUEST_DEFAULTS;
  const defaultExpiryDays = inRange(row.agreementDefaultExpiryDays, AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN, AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX)
    ? row.agreementDefaultExpiryDays
    : AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS;
  const intervalDays = row.agreementReminderIntervalDays;
  if (!inRange(intervalDays, AGREEMENT_REMINDER_INTERVAL_DAYS_MIN, AGREEMENT_REMINDER_INTERVAL_DAYS_MAX)) {
    return { defaultExpiryDays, autoReminder: null };
  }
  const maxReminders = inRange(row.agreementMaxReminders, AGREEMENT_MAX_REMINDERS_MIN, AGREEMENT_MAX_REMINDERS_MAX)
    ? row.agreementMaxReminders
    : AGREEMENT_MAX_REMINDERS_DEFAULT;
  return { defaultExpiryDays, autoReminder: { intervalDays, maxReminders } };
}

/** The columns this resolver reads — for a caller that joins partners itself
 *  (the reminder job's batch selector). */
export const partnerAgreementDefaultColumns = () => ({
  agreementDefaultExpiryDays: partners.agreementDefaultExpiryDays,
  agreementReminderIntervalDays: partners.agreementReminderIntervalDays,
  agreementMaxReminders: partners.agreementMaxReminders,
});

/** Reads the partner row in the CALLER's DB context. A row RLS hides (an
 *  org-scoped token cannot read its partner) resolves to the built-in defaults;
 *  such a caller cannot send a request anyway (SELLER_UNAVAILABLE at send). */
export async function loadAgreementRequestDefaults(partnerId: string): Promise<AgreementRequestDefaults> {
  const [row] = await db
    .select(partnerAgreementDefaultColumns())
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return resolveAgreementRequestDefaults(row ?? null);
}

/** The expiry a new request gets when the sender sets none. */
export function defaultAgreementRequestExpiresAt(defaults: AgreementRequestDefaults, now: Date): Date {
  return new Date(now.getTime() + defaults.defaultExpiryDays * DAY_MS);
}

export interface AutoReminderCandidate {
  status: AgreementRequestStatus;
  expiresAt: Date;
  publicLinkRevokedAt: Date | null;
  sentAt: Date | null;
  lastRemindedAt: Date | null;
  reminderCount: number;
}

/** When the next automatic reminder is due: `intervalDays` after the later of
 *  the send and the last reminder (manual or automatic). Null when never sent. */
export function autoReminderDueAt(
  req: Pick<AutoReminderCandidate, 'sentAt' | 'lastRemindedAt'>,
  intervalDays: number,
): Date | null {
  if (!req.sentAt) return null;
  const anchor = req.lastRemindedAt && req.lastRemindedAt > req.sentAt ? req.lastRemindedAt : req.sentAt;
  return new Date(anchor.getTime() + intervalDays * DAY_MS);
}

/** The single due-ness rule. The job's SQL prefilter mirrors it and every
 *  locked candidate is re-checked here, so the two can never disagree about the
 *  boundary: open (sent | viewed), link not revoked, not expired, under the
 *  cap, and the interval has elapsed. */
export function isAutoReminderDue(req: AutoReminderCandidate, defaults: AgreementRequestDefaults, now: Date): boolean {
  const cadence = defaults.autoReminder;
  if (!cadence) return false;
  if (req.status !== 'sent' && req.status !== 'viewed') return false;
  if (req.publicLinkRevokedAt) return false;
  if (isAgreementRequestExpired(req.expiresAt, now)) return false;
  if (req.reminderCount >= cadence.maxReminders) return false;
  const dueAt = autoReminderDueAt(req, cadence.intervalDays);
  return dueAt !== null && now.getTime() >= dueAt.getTime();
}
