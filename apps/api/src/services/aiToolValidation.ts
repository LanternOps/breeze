/**
 * Shared input-validation helpers for AI tool action multiplexers.
 *
 * The `manage_*` tools accept a flat action + params object whose Zod layer
 * (`toolInputSchemas`) marks every id/payload optional — required-ness depends
 * on the action. Before this helper existed, a missing param sailed past that
 * layer, got coerced (`String(undefined)` → the literal string "undefined"),
 * and blew up downstream as a raw DB/uuid error the caller saw as an opaque
 * HTTP 500 (#2362). These helpers turn both failure modes into the same
 * structured tool error shape the service-error paths already use:
 * `{ "error": "<message>", "code": "VALIDATION_ERROR" }`.
 */

import { ZodError } from 'zod';

/** Structured tool-error JSON for a validation failure. */
export function validationErrorJson(message: string): string {
  return JSON.stringify({ error: message, code: 'VALIDATION_ERROR' });
}

/**
 * Presence check for the params an action requires, run BEFORE any coercion.
 * Returns a structured error JSON naming the missing params, or null when all
 * are present. `null` and `undefined` both count as missing; empty strings/
 * arrays/objects are left to the per-payload Zod schemas.
 */
export function missingParamsJson(
  input: Record<string, unknown>,
  action: string,
  required: readonly string[]
): string | null {
  const missing = required.filter((key) => input[key] == null);
  if (missing.length === 0) return null;
  return validationErrorJson(
    `Missing required parameter${missing.length > 1 ? 's' : ''} for action "${action}": ${missing.join(', ')}`
  );
}

/**
 * Convert a ZodError into a structured tool error carrying each issue's path
 * (e.g. "line.sourceType: Invalid option ..."), or null for any other error so
 * the caller can fall through to its domain service-error mapping / rethrow.
 * Payload parses should wrap the value under its param name
 * (`z.object({ line: schema }).parse({ line: input.line })`) so the paths are
 * self-describing for the calling model.
 */
export function zodErrorToJson(err: unknown): string | null {
  if (!(err instanceof ZodError)) return null;
  const message = err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return validationErrorJson(message);
}
