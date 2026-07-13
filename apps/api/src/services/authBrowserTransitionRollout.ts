import { authBrowserTransitionsEnforced } from '../config/env';

// Kept beside the startup assertion rather than importing the protected
// issuer module: the exact source inventory is the build-time proof that this
// declaration remains false, and protected issuers may not be namespace-
// inspected or imported outside their approved finalizers.
const USER_SESSION_LEGACY_ISSUER_EXPORT_PRESENT = false;

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
