/**
 * Customer-portal self-registration (portal registration W6, plan D2).
 *
 * `PORTAL_SELF_REGISTRATION_ENABLED` is a deployment kill switch for abuse
 * emergencies, not a setting: unset (or empty), `true` or `1` → on; `false`
 * or `0` → off; any other value fails boot in config/validate.ts. Whether an
 * org uses self-registration is the org's access policy
 * (`self_registration_mode`, default `off`).
 *
 * Self-registration also needs a configured email service: the verification
 * link IS the mailbox proof. {@link isPortalSelfRegistrationAvailable} is the
 * one predicate for both legs. Read at call time, never at module load.
 */
import { getEmailService } from '../services/email';

export const PORTAL_SELF_REGISTRATION_ENV = 'PORTAL_SELF_REGISTRATION_ENABLED';

/** Throws on a value that is neither unset/empty nor one of true/1/false/0. */
export function parsePortalSelfRegistrationEnabled(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${PORTAL_SELF_REGISTRATION_ENV} must be one of true, 1, false or 0`);
}

/** The env leg. A malformed value reads as off here (boot validation refuses it first). */
export function isPortalSelfRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return parsePortalSelfRegistrationEnabled(env[PORTAL_SELF_REGISTRATION_ENV]);
  } catch {
    return false;
  }
}

/** The deployment can run self-registration: enabled AND an email service is configured. */
export function isPortalSelfRegistrationAvailable(): boolean {
  return isPortalSelfRegistrationEnabled() && getEmailService() !== null;
}
