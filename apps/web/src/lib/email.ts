import { z } from 'zod';

// Client-side email-format guard, mirroring the server's `z.string().email()`
// and the "Enter a valid email address" copy the app's react-hook-form schemas
// already use (LoginForm, UserInviteForm, SiteForm, …). This is a pre-submit UX
// guard for the hand-rolled (non-RHF) forms only — the API still validates every
// payload, so this never becomes the sole line of defense.
const emailSchema = z.string().email();

/** True when `value` (trimmed) is a syntactically valid email address. */
export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value.trim()).success;
}
