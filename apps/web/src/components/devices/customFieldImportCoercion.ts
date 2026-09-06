import type { CustomFieldType } from '@breeze/shared';

/**
 * CSV cell coercion for the RMM custom-field VALUE importer (#3257 W09).
 *
 * Without this, every `number` cell arrives at the server as a raw string and
 * `validateCustomFieldValue` annotates the whole column `type-error` — the
 * mapper would work for exactly zero incumbent exports, all of which quote or
 * comma-format numbers and spell booleans as `Yes`/`No`. Coercion happens
 * client-side, before the row is sent, so the preview an operator sees is the
 * value that will actually land.
 *
 * Every branch is conservative: a cell it cannot confidently coerce is passed
 * through UNCHANGED (never guessed), so the server's own `validateValue`
 * refusal — a `type-error` annotation the operator can act on — is still the
 * worst case. Guessing wrong here is silent; refusing at the server is not.
 */

export type CustomFieldImportDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'ISO';

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

const BOOLEAN_TRUE = new Set(['true', 'yes', 'y', '1']);
const BOOLEAN_FALSE = new Set(['false', 'no', 'n', '0']);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Rejects calendar-invalid combinations (month 13, April 31, …) — never a guess. */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

function coerceNumber(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/[$,]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== '' ? n : raw;
}

function coerceBoolean(raw: string): unknown {
  const trimmed = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(trimmed)) return true;
  if (BOOLEAN_FALSE.has(trimmed)) return false;
  return raw;
}

function coerceDate(raw: string, format?: CustomFieldImportDateFormat): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const isoMatch = ISO_DATE_PREFIX.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m}-${d}`;
  }

  const slashMatch = SLASH_DATE.exec(trimmed);
  if (slashMatch) {
    const [, aStr, bStr, yStr] = slashMatch;
    const a = Number(aStr);
    const b = Number(bStr);
    const y = Number(yStr);

    if (format === 'MM/DD/YYYY') {
      return isValidCalendarDate(y, a, b) ? `${yStr}-${pad2(a)}-${pad2(b)}` : raw;
    }
    if (format === 'DD/MM/YYYY') {
      return isValidCalendarDate(y, b, a) ? `${yStr}-${pad2(b)}-${pad2(a)}` : raw;
    }

    // No explicit format (or 'ISO', which a slash-delimited cell can never
    // satisfy): resolve only when exactly ONE reading is a valid calendar
    // date. Both valid (03/04) is genuinely ambiguous; neither valid (13/13)
    // is refused either way — both cases pass the raw cell through.
    const asMonthDay = isValidCalendarDate(y, a, b);
    const asDayMonth = isValidCalendarDate(y, b, a);
    if (asMonthDay && !asDayMonth) return `${yStr}-${pad2(a)}-${pad2(b)}`;
    if (asDayMonth && !asMonthDay) return `${yStr}-${pad2(b)}-${pad2(a)}`;
    return raw;
  }

  return raw;
}

/**
 * Coerce one CSV cell for its mapped custom-field (or warranty) type.
 *
 * `dateFormat` is the operator's explicit choice from the mapping UI's
 * date-format selector; omitted (or `'ISO'`, which cannot itself disambiguate
 * a slash-delimited cell) falls back to unambiguous-only resolution.
 */
export function coerceCellForType(
  raw: string,
  type: CustomFieldType,
  dateFormat?: CustomFieldImportDateFormat,
): unknown {
  switch (type) {
    case 'number':
      return coerceNumber(raw);
    case 'boolean':
      return coerceBoolean(raw);
    case 'date':
      return coerceDate(raw, dateFormat);
    case 'text':
    case 'dropdown':
    default: {
      const trimmed = raw.trim();
      return trimmed === '' ? null : raw;
    }
  }
}
