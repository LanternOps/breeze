/**
 * Shared validation + coercion for one device custom-field VALUE against its
 * definition. Extracted here (the path #3257's backfill-import plan reserved)
 * so the script write-back path, the value PATCH endpoint and a future
 * importer share one truth about what a field will accept.
 *
 * Deliberately total: it never throws. A malformed `options` jsonb means "no
 * constraint", not "explode" — options are user-authored and two different
 * `choices` shapes are already in the wild (`z.array(z.string())` in the API
 * create validator vs `Array<{label,value}>` in the shared type and the web
 * form).
 */

export type CustomFieldValueRejection =
  | 'invalid_type'
  | 'out_of_range'
  | 'not_a_choice'
  | 'too_long'
  | 'invalid_date';

export interface CustomFieldValidationTarget {
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
}

export type CustomFieldValueResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; reason: CustomFieldValueRejection };

// Matches `customFieldValueSchema` in routes/devices/customFieldValues.ts so a
// script write and a PATCH write have the same ceiling.
const MAX_TEXT_LENGTH = 10_000;

function readOptions(options: unknown): Record<string, unknown> {
  return options !== null && typeof options === 'object' && !Array.isArray(options)
    ? (options as Record<string, unknown>)
    : {};
}

/** Both shipped `choices` shapes, normalised to the stored value strings. */
function readChoices(options: unknown): string[] | null {
  const raw = readOptions(options).choices;
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      values.push(entry);
    } else if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { value?: unknown }).value === 'string'
    ) {
      values.push((entry as { value: string }).value);
    } else {
      return null; // mixed / unrecognised — treat as no constraint
    }
  }
  return values.length > 0 ? values : null;
}

export function validateCustomFieldValue(
  definition: CustomFieldValidationTarget,
  raw: unknown,
): CustomFieldValueResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  const isScalar = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean';
  if (!isScalar) return { ok: false, reason: 'invalid_type' };

  switch (definition.type) {
    case 'text': {
      const value = String(raw);
      if (value.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too_long' };
      return { ok: true, value };
    }
    case 'number': {
      // Explicit, though String(true) -> 'true' -> NaN would also reject it:
      // a bare Number(raw) would coerce true to 1, and this states that is wrong.
      if (typeof raw === 'boolean') return { ok: false, reason: 'invalid_type' };
      const trimmed = typeof raw === 'number' ? raw : String(raw).trim();
      // `Number('')` is 0 — an empty string is not a number.
      if (trimmed === '') return { ok: false, reason: 'invalid_type' };
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_type' };
      const options = readOptions(definition.options);
      if (typeof options.min === 'number' && value < options.min) {
        return { ok: false, reason: 'out_of_range' };
      }
      if (typeof options.max === 'number' && value > options.max) {
        return { ok: false, reason: 'out_of_range' };
      }
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const normalized = String(raw).trim().toLowerCase();
      if (normalized === 'true') return { ok: true, value: true };
      if (normalized === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'invalid_type' };
    }
    case 'date': {
      if (typeof raw !== 'string') return { ok: false, reason: 'invalid_date' };
      const parsed = new Date(raw.trim());
      if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'invalid_date' };
      // Stored as a plain calendar date: the field type is `date`, and keeping
      // a time component would make two writes of the same day unequal and
      // defeat the compare-before-write skip in scriptWriteBack.
      return { ok: true, value: parsed.toISOString().slice(0, 10) };
    }
    case 'dropdown': {
      const value = String(raw);
      if (value.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too_long' };
      const choices = readChoices(definition.options);
      if (choices && !choices.includes(value)) return { ok: false, reason: 'not_a_choice' };
      return { ok: true, value };
    }
    default:
      return { ok: false, reason: 'invalid_type' };
  }
}
