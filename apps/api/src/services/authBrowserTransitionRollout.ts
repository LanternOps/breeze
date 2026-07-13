import { authBrowserTransitionsEnforced } from '../config/env';

type UserSessionLegacyIssuerExportPresent =
  'issueUserSessionLegacyDuringTransition' extends keyof typeof import('./userSession')
    ? true
    : false;

// This assignment is mechanically coupled to the actual module export type:
// reintroducing the legacy export changes the conditional type to `true` and
// makes the production build fail before an enforcement-enabled replica can
// start. The runtime assertion remains explicit for rollout diagnostics.
const USER_SESSION_LEGACY_ISSUER_EXPORT_PRESENT: UserSessionLegacyIssuerExportPresent = false;

function assertCompatible(legacyIssuerPresent: boolean): void {
  if (!authBrowserTransitionsEnforced()) return;
  if (legacyIssuerPresent) {
    throw new Error(
      '[AuthBrowserTransition] Refusing startup: enforcement is enabled while the legacy user-session issuer export exists.',
    );
  }
}

/** Fail startup if a guarded rollout is paired with a legacy issuer build. */
export function assertAuthBrowserTransitionRolloutCompatible(): void {
  assertCompatible(USER_SESSION_LEGACY_ISSUER_EXPORT_PRESENT);
}

export const __testOnly = Object.freeze({ assertCompatible });
