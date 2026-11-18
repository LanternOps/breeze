// #10293: the contract editor's manual-quantity field checks the SAME grammar
// the API's contractLineInputSchema enforces (shared contractQuantityIssue), so
// a blank or malformed quantity is caught inline instead of round-tripping to a
// 400 whose Zod text ("must be a 2-decimal money string") the user saw raw.
export { contractQuantityIssue, type ContractQuantityIssue } from '@breeze/shared';

/** The `details.fieldErrors` map of a shared-zValidator 400 body
 *  (apps/api/src/lib/validation.ts), or null for any other shape. */
export function validationFieldErrors(body: unknown): Record<string, string[]> | null {
  if (!body || typeof body !== 'object') return null;
  const details = (body as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object' || Array.isArray(fieldErrors)) return null;
  return fieldErrors as Record<string, string[]>;
}

/** True when a 400 body rejects `manualQuantity` and nothing else — the form
 *  can then own the whole failure on the field and skip the generic toast. */
export function isOnlyManualQuantityError(body: unknown): boolean {
  const fieldErrors = validationFieldErrors(body);
  if (!fieldErrors) return false;
  const keys = Object.keys(fieldErrors);
  const formErrors = (body as { details: { formErrors?: unknown } }).details.formErrors;
  const noFormErrors = !Array.isArray(formErrors) || formErrors.length === 0;
  return noFormErrors && keys.length === 1 && keys[0] === 'manualQuantity';
}
