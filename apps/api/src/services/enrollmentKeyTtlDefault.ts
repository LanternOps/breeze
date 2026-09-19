import { envInt } from '../utils/envInt';

/**
 * The single fallback TTL (in minutes) for an enrollment/installer key when
 * nothing more specific overrides it. 43200 minutes = 30 days.
 *
 * #4126 raised the human "Add Device" create route's fallback
 * (routes/enrollmentKeys.ts, `DEFAULT_ENROLLMENT_KEY_TTL_MINUTES`) from 60
 * minutes to this 30-day value, on the theory that techs stage installers
 * through deploy tooling and expect them to keep working well past the
 * download day. It missed two sibling fallbacks that mint keys the same way:
 *
 *   - services/enrollmentKeySecurity.ts's `getDefaultEnrollmentKeyTtlMinutes`
 *     (used by the Partner-API provisioning route, #3243) stayed at 60.
 *   - routes/installer.ts's `childEnrollmentKeyTtlMinutes` (installer
 *     downloads / redemptions) stayed at `24 * 60` (1 day).
 *
 * A self-hoster who never set ENROLLMENT_KEY_DEFAULT_TTL_MINUTES or
 * CHILD_ENROLLMENT_KEY_TTL_MINUTES therefore got 30-day keys from the web UI
 * but 1-hour partner-API keys and 1-day installer child keys — three
 * different lifetimes behind what looks like one "default TTL" knob. All
 * three sites (plus routes/devices/core.ts, which already matched by luck)
 * now read this single constant so the fallback can't drift apart again.
 *
 * Read via envInt (never a hand-rolled `Number(x ?? default)`) so an EMPTY
 * env value — compose renders an unset var as `VAR: ""`, not absent — also
 * falls back to the default instead of resolving to 0 (#2776). Resolved per
 * call rather than cached at module load so the fallback stays directly
 * testable and reflects `ENROLLMENT_KEY_DEFAULT_TTL_MINUTES` set at any
 * point before the call; the env is fixed at boot in production, so this is
 * the same value every time in practice.
 */
export function getDefaultEnrollmentKeyTtlMinutes(): number {
  return envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60 * 24 * 30);
}
