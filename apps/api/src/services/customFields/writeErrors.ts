/**
 * The ONE mapping from a `custom_field_definitions` write failure to
 * operator-facing copy (#3257 W03/W07).
 *
 * Two database rules can refuse a definition write, and neither is a server
 * fault, so neither may surface as a 500 — a 500 tells the operator nothing and
 * hides a one-word fix (rename the key):
 *
 *  - **P0001** — W03's `custom_field_definitions_no_shadow` BEFORE-write
 *    trigger (`2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql`).
 *    Its message is written to be read by a human: it names the key and which
 *    axis already owns it, and deliberately discloses nothing else about the
 *    conflicting definition, so it is safe to pass through verbatim.
 *  - **23505** — W02's per-axis unique indexes
 *    (`custom_field_definitions_{org,partner}_key_uq`). The driver message is
 *    NOT safe to pass through: postgres.js puts the offending column VALUES in
 *    `detail` and the constraint name in the text. Fixed copy is built from the
 *    caller's own `fieldKey` instead.
 *
 * Extracted from `routes/customFields.ts` when the definitions importer (W07)
 * needed the identical mapping per row. Two copies would drift, and the codes
 * (`field-key-shadowed`, `field-key-duplicate`) are part of the wire contract
 * the web client branches on.
 */

import { pgErrorCode, pgErrorNode } from '../../utils/pgErrors';

export type CustomFieldWriteConflictCode = 'field-key-shadowed' | 'field-key-duplicate';

export interface CustomFieldWriteConflict {
  /** Safe to place in a response body — see the module header. */
  error: string;
  code: CustomFieldWriteConflictCode;
}

/**
 * Map a thrown definition-write error to its conflict body, or `null` when the
 * error is not one of the two known conflicts (callers rethrow those).
 *
 * @param fieldKey the key the caller asked for, used to build the 23505 copy.
 */
export function customFieldWriteConflict(err: unknown, fieldKey: string): CustomFieldWriteConflict | null {
  const code = pgErrorCode(err);
  if (code === 'P0001') {
    return {
      error: String(pgErrorNode(err)?.message ?? 'Custom field key conflicts with an existing field'),
      code: 'field-key-shadowed',
    };
  }
  if (code === '23505') {
    return {
      error: `A custom field with key "${fieldKey}" already exists for this owner`,
      code: 'field-key-duplicate',
    };
  }
  return null;
}
