import { isAlwaysMaintenanceWindow, resolveInheritedAgentVersionPins } from '@breeze/shared';
import { normalizeAgentUpdatePolicy, type AgentUpdateSettings } from '../routes/agents/agentUpdatePolicy';

/**
 * Effective per-component update version pins (issue #2124). `null` means "no
 * pin" → track the globally promoted latest version (historical behaviour).
 */
export interface AgentVersionPins {
  agent: string | null;
  watchdog: string | null;
}

/**
 * The full effective agent-update config for an org: the update-policy gate
 * inputs PLUS the version pins. Both are resolved from the SAME single org⋈
 * partner join (see getOrgAgentUpdateConfig in routes/agents/helpers.ts) so the
 * heartbeat hot path pays one round trip for everything it needs.
 */
export interface AgentUpdateConfig {
  settings: AgentUpdateSettings;
  pins: AgentVersionPins;
}

function asDefaults(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pure core of `getOrgAgentUpdateConfig` (#9170): resolve an org's effective
 * agent-update config from its own `settings.defaults` and its partner's.
 * The partner settings inheritance read model calls it too, so the runtime and
 * the read model share one implementation.
 *
 * - `agentUpdatePolicy` / `maintenanceWindow`: partner-locks, per field and by
 *   presence (`in`, matching effectiveSettings.mergeCategory): a partner-set
 *   field wins; the org value fills the gap only where the partner has not set
 *   that field.
 * - `agentVersionPins`: inherit-with-override, per component, via the shared
 *   `resolveInheritedAgentVersionPins` (issue #2124): an org-set pin wins.
 *
 * Unknown policies normalize to `staged`; an empty or "24/7" window means no
 * restriction (`null`). Never throws.
 */
export function resolveAgentUpdateConfig(partnerDefaultsRaw: unknown, orgDefaultsRaw: unknown): AgentUpdateConfig {
  const partnerDefaults = asDefaults(partnerDefaultsRaw);
  const orgDefaults = asDefaults(orgDefaultsRaw);

  const effectivePolicy =
    'agentUpdatePolicy' in partnerDefaults
      ? partnerDefaults.agentUpdatePolicy
      : orgDefaults.agentUpdatePolicy;
  const effectiveWindow =
    'maintenanceWindow' in partnerDefaults
      ? partnerDefaults.maintenanceWindow
      : orgDefaults.maintenanceWindow;

  const pins: AgentVersionPins = resolveInheritedAgentVersionPins(orgDefaults, partnerDefaults);

  const policy = normalizeAgentUpdatePolicy(effectivePolicy);
  const rawWindow = typeof effectiveWindow === 'string' ? effectiveWindow.trim() : '';
  // The explicit "24/7"/empty always-state means "no restriction" → null, same
  // as an absent window. Only a real window string is carried through to the gate.
  const maintenanceWindow = rawWindow && !isAlwaysMaintenanceWindow(rawWindow) ? rawWindow : null;
  return { settings: { policy, maintenanceWindow }, pins };
}
