import { coreRequest } from './api';

/**
 * Whether the server takes an authenticator-app code from the signed-in
 * account: `totpEnrolled` on the signed-in profile (`GET /users/me`), true for
 * an authenticator app held as the primary factor or as the backup beside a
 * primary passkey. `undefined` when the profile does not say or cannot be read.
 */
/**
 * A reader that keeps the first definite answer from `read` and asks again
 * after an unknown one, so an unread profile is retried at the next refusal.
 */
export function createCodeUsableReader(
  read: () => Promise<boolean | undefined> = getAuthenticatorCodeUsable,
): () => Promise<boolean | undefined> {
  let known: boolean | undefined;
  return async () => {
    if (known === undefined) known = await read();
    return known;
  };
}

export async function getAuthenticatorCodeUsable(): Promise<boolean | undefined> {
  try {
    const profile = await coreRequest<{ totpEnrolled?: unknown }>('/users/me');
    return typeof profile?.totpEnrolled === 'boolean' ? profile.totpEnrolled : undefined;
  } catch {
    return undefined;
  }
}
