// Client-side bounds for the Billing defaults tab. They mirror
// partnerBillingSettingsSchema (packages/shared/src/validators/invoices.ts):
// defaultTaxRate is a fraction 0..1 on the wire but the form edits a PERCENT,
// so the UI bound is 0..100; invoiceTermsDays is an int 0..365;
// invoiceNumberPrefix is 1..12 characters.

export type BillingDefaultsField = 'taxRate' | 'termsDays' | 'prefix';
export type BillingDefaultsErrors = Partial<Record<BillingDefaultsField, true>>;

export function validateBillingDefaults(v: { taxPercent: string; termsDays: string; prefix: string }): BillingDefaultsErrors {
  const errors: BillingDefaultsErrors = {};
  const tax = v.taxPercent.trim();
  if (tax !== '') {
    const n = Number(tax);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.taxRate = true;
  }
  const days = v.termsDays.trim();
  const d = Number(days);
  if (days === '' || !Number.isInteger(d) || d < 0 || d > 365) errors.termsDays = true;
  const prefix = v.prefix.trim();
  if (prefix.length < 1 || prefix.length > 12) errors.prefix = true;
  return errors;
}

const API_FIELD_TO_FORM: Record<string, BillingDefaultsField> = {
  defaultTaxRate: 'taxRate',
  invoiceTermsDays: 'termsDays',
  invoiceNumberPrefix: 'prefix',
};

/** Maps a zValidator 400 body (`details.fieldErrors`) onto this tab's inputs so
 *  the failing field is flagged inline instead of surfacing raw zod text. */
export function extractBillingDefaultsFieldErrors(body: unknown): BillingDefaultsErrors | null {
  if (!body || typeof body !== 'object') return null;
  const details = (body as Record<string, unknown>).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const fieldErrors = (details as Record<string, unknown>).fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object' || Array.isArray(fieldErrors)) return null;
  const out: BillingDefaultsErrors = {};
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    const mapped = API_FIELD_TO_FORM[field];
    if (mapped && Array.isArray(messages) && messages.length > 0) out[mapped] = true;
  }
  return Object.keys(out).length > 0 ? out : null;
}
