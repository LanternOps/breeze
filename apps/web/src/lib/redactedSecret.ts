/**
 * The string the API treats as "keep the stored secret" on write. Sending it
 * back unchanged preserves the stored value (`isMaskedSecret` in
 * `apps/api/src/services/notificationChannelSecrets.ts` accepts any run of
 * asterisks).
 */
export const MASKED_SECRET = '********';

/**
 * Turn a secret config value read from the API into a string an edit form can
 * hold and send back.
 *
 * The API never returns a stored secret. It returns a redaction marker object,
 * `{ redacted, hasSecret, masked }`, in its place. Copying that object into a
 * string form field shows "[object Object]", fails string validation on submit,
 * and can be stringified into a literal "[object Object]" that overwrites the
 * real secret (#4983). A configured secret becomes MASKED_SECRET so a save
 * leaves it untouched. An unset one becomes the empty string.
 */
export function formSecretValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    return (value as { hasSecret?: unknown }).hasSecret === true ? MASKED_SECRET : '';
  }
  return '';
}
