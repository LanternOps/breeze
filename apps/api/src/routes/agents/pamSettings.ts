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
 * Default ON: UAC capture has always been unconditional on Windows agents.
 * A device with no 'pam' feature link anywhere in its hierarchy must keep
 * capturing, so upgrades are behavior-preserving. Admins opt OUT via policy.
 */
export const PAM_DEFAULTS: PamSettings = {
  uacInterceptionEnabled: true,
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
