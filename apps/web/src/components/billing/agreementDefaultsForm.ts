import {
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX,
  AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN,
  AGREEMENT_MAX_REMINDERS_DEFAULT,
  AGREEMENT_MAX_REMINDERS_MAX,
  AGREEMENT_MAX_REMINDERS_MIN,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MAX,
  AGREEMENT_REMINDER_INTERVAL_DAYS_MIN,
  AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS,
} from '@breeze/shared';

// #9075 W4a (OD8 B): form state for Settings → Billing → Agreements. Inputs
// stay strings while editing; the bounds are the shared ones the API and the
// partners CHECKs enforce.

export interface AgreementDefaultsDraft {
  expiryDays: string;
  remindersOn: boolean;
  intervalDays: string;
  maxReminders: string;
}

export type AgreementDefaultsErrors = Partial<Record<'expiryDays' | 'intervalDays' | 'maxReminders', true>>;

/** Interval shown when the user switches reminders on for the first time. */
const SUGGESTED_INTERVAL_DAYS = 3;

/** The GET /orgs/partners/me fields → the draft (absent on an older API → built-in defaults). */
export function agreementDefaultsDraft(p: {
  agreementDefaultExpiryDays?: number | null;
  agreementReminderIntervalDays?: number | null;
  agreementMaxReminders?: number | null;
}): AgreementDefaultsDraft {
  const interval = p.agreementReminderIntervalDays ?? null;
  return {
    expiryDays: String(p.agreementDefaultExpiryDays ?? AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS),
    remindersOn: interval !== null,
    intervalDays: String(interval ?? SUGGESTED_INTERVAL_DAYS),
    maxReminders: String(p.agreementMaxReminders ?? AGREEMENT_MAX_REMINDERS_DEFAULT),
  };
}

function intIn(text: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(text.trim())) return false;
  const n = Number(text);
  return n >= min && n <= max;
}

/** The cadence fields are validated only while reminders are on. */
export function validateAgreementDefaults(d: AgreementDefaultsDraft): AgreementDefaultsErrors {
  const errors: AgreementDefaultsErrors = {};
  if (!intIn(d.expiryDays, AGREEMENT_DEFAULT_EXPIRY_DAYS_MIN, AGREEMENT_DEFAULT_EXPIRY_DAYS_MAX)) errors.expiryDays = true;
  if (d.remindersOn) {
    if (!intIn(d.intervalDays, AGREEMENT_REMINDER_INTERVAL_DAYS_MIN, AGREEMENT_REMINDER_INTERVAL_DAYS_MAX)) errors.intervalDays = true;
    if (!intIn(d.maxReminders, AGREEMENT_MAX_REMINDERS_MIN, AGREEMENT_MAX_REMINDERS_MAX)) errors.maxReminders = true;
  }
  return errors;
}

/** The PATCH /partner/billing-settings fields. Reminders off → a null interval;
 *  the cap is only sent while it is valid, so switching reminders off never
 *  fails on a half-typed cap. */
export function agreementDefaultsPatch(d: AgreementDefaultsDraft): {
  agreementDefaultExpiryDays: number;
  agreementReminderIntervalDays: number | null;
  agreementMaxReminders?: number;
} {
  if (Object.keys(validateAgreementDefaults(d)).length > 0) throw new RangeError('Invalid agreement defaults');
  const capValid = intIn(d.maxReminders, AGREEMENT_MAX_REMINDERS_MIN, AGREEMENT_MAX_REMINDERS_MAX);
  return {
    agreementDefaultExpiryDays: Number(d.expiryDays),
    agreementReminderIntervalDays: d.remindersOn ? Number(d.intervalDays) : null,
    ...(capValid ? { agreementMaxReminders: Number(d.maxReminders) } : {}),
  };
}
