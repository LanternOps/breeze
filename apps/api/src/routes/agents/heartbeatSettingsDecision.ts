import type { HelperSettings } from '../../services/helperSettings';

/**
 * #8616 (heartbeat retain-state W02) — the heartbeat response's PAM, helper
 * and remote-management fields, built in one place.
 *
 * Legacy mode (the beat did not advertise `retainStateProtocolVersion` 1, or
 * the HEARTBEAT_RETAIN_STATE_ENABLED kill switch is off) reproduces the
 * pre-#8616 expressions exactly, including key order: a missing decision is
 * sent as `false`/absent, as before.
 *
 * Retain mode sends a feature's legacy keys only when this beat produced a
 * decision for it, and otherwise names the feature in `retainState` so a
 * protocol-aware agent keeps its current state. A decided "off" is still sent
 * explicitly and is never retained.
 *
 * "No decision" is derived here, never by catching an error: a resolver that
 * threw leaves its value `null`; PAM and helper values are trusted only when
 * the beat's own hierarchy load succeeded (on the fallback path the resolvers
 * can return defaults for a device they cannot see); remote management carries
 * its own `resolved` flag (false when no effective config was found).
 */

export type RetainFeature = 'pam' | 'helper' | 'remoteManagement';

/** `resolved` false = no decision (the resolver threw or found no effective config). */
export interface RemoteManagementDecision {
  resolved: boolean;
  value: boolean;
}

export interface SettingsDecisionInput {
  /** Normalised from THIS beat (normalizeRetainStateProtocolVersion). */
  retainProtocol: 0 | 1;
  /** Kill switch: HEARTBEAT_RETAIN_STATE_ENABLED !== 'false'. */
  enabled: boolean;
  /** The policy context loaded the device hierarchy (`hierarchyOutcome === 'loaded'`). */
  policyHierarchyLoaded: boolean;
  /** null = the resolver produced nothing this beat. */
  pamSettings: { uacInterceptionEnabled: boolean } | null;
  /** null = the resolver produced nothing this beat. */
  helperSettings: HelperSettings | null;
  remoteManagement: RemoteManagementDecision;
}

/**
 * Every key is always present (possibly `undefined`, which serializes as
 * absent) so the caller can place each one at its legacy position in the
 * response object; `retainState` is present only when non-empty.
 */
export interface SettingsDecisionFields {
  uacInterceptionEnabled: boolean | undefined;
  helperEnabled: boolean | undefined;
  helperSettings: HelperSettings | undefined;
  manageRemoteManagement: true | undefined;
  retainState?: RetainFeature[];
}

export function retainStateKillSwitchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEARTBEAT_RETAIN_STATE_ENABLED !== 'false';
}

export function buildSettingsDecisionFields(i: SettingsDecisionInput): SettingsDecisionFields {
  if (i.retainProtocol !== 1 || !i.enabled) {
    return {
      uacInterceptionEnabled: i.pamSettings?.uacInterceptionEnabled ?? false,
      helperEnabled: i.helperSettings?.enabled ?? false,
      helperSettings: i.helperSettings ?? undefined,
      manageRemoteManagement: i.remoteManagement.value || undefined,
    };
  }

  const pam = i.policyHierarchyLoaded ? i.pamSettings : null;
  const helper = i.policyHierarchyLoaded ? i.helperSettings : null;
  const retainState: RetainFeature[] = [];
  if (!pam) retainState.push('pam');
  if (!helper) retainState.push('helper');
  if (!i.remoteManagement.resolved) retainState.push('remoteManagement');

  return {
    uacInterceptionEnabled: pam ? pam.uacInterceptionEnabled : undefined,
    helperEnabled: helper ? helper.enabled : undefined,
    helperSettings: helper ?? undefined,
    manageRemoteManagement: i.remoteManagement.resolved ? (i.remoteManagement.value || undefined) : undefined,
    ...(retainState.length > 0 ? { retainState } : {}),
  };
}
