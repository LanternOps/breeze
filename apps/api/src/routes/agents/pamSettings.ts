/**
 * PAM config-policy feature ('pam') — inline settings shape.
 *
 * Controls whether the agent's ETW UAC interception posts elevation events.
 * Rule authoring / approvals / audit are NOT configured here — they live in
 * the standalone /pam control plane (pam_rules, elevation_requests).
 */
export interface PamSettings {
  uacInterceptionEnabled: boolean;
}

/**
 * Default OFF (opt-in). UAC capture interrupts end users with an elevation-
 * approval dialog, so a device with no 'pam' feature link anywhere in its
 * hierarchy must NOT capture. Admins opt IN via a config policy.
 *
 * Orgs that had deliberately configured PAM before the opt-in switch are
 * grandfathered back to ON via pam_org_config.uac_interception_enabled — see
 * resolveDevicePamSettings and migration 2026-07-01-pam-uac-opt-in-grandfathering.
 */
export const PAM_DEFAULTS: PamSettings = {
  uacInterceptionEnabled: false,
};

export function parsePamSettings(inlineSettings: unknown): PamSettings {
  if (!inlineSettings || typeof inlineSettings !== 'object') return PAM_DEFAULTS;
  const s = inlineSettings as Record<string, unknown>;
  return {
    uacInterceptionEnabled:
      typeof s.uacInterceptionEnabled === 'boolean'
        ? s.uacInterceptionEnabled
        : PAM_DEFAULTS.uacInterceptionEnabled,
  };
}
