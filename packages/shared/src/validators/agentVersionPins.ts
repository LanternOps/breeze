/**
 * Agent / watchdog version pins — shared grammar + validation (issue #2124).
 *
 * Partner and org settings may pin the update target for the `agent` and
 * `watchdog` components independently:
 *
 *   settings.defaults.agentVersionPins = { agent?: <version|'latest'>, watchdog?: <version|'latest'> }
 *
 * A pin either names a specific registered version string OR the sentinel
 * `'latest'` (equivalent to leaving the field unset) meaning "track the globally
 * promoted latest version". This module is the ONE source of truth for the shape
 * so the web editor, the save-time validators, and the heartbeat resolver never
 * drift — mirroring the maintenanceWindow validator's role.
 *
 * The heartbeat gate is authoritative for turning a pin into an actual upgrade
 * target (see getOrgAgentUpdateConfig / heartbeat.ts): a pin merely names WHICH
 * version to aim for, replacing the global isLatest target. Per-component /
 * platform / arch existence is confirmed at save time (against agent_versions)
 * and again at resolution time (fail-closed if the pinned version has no build
 * for the device's platform+arch).
 */

import { z } from 'zod';

/** Sentinel meaning "no pin — track the globally promoted latest version". */
export const AGENT_VERSION_PIN_LATEST = 'latest';

/**
 * Components that can be pinned. The full agent_versions component set also
 * includes helper / viewer / user-helper, but issue #2124 scopes pins to the
 * two operator-facing binaries: the main agent and its watchdog.
 */
export const PINNABLE_COMPONENTS = ['agent', 'watchdog'] as const;
export type PinnableComponent = (typeof PINNABLE_COMPONENTS)[number];

/** Single source of the rejection message shared by every save path + the UI. */
export const AGENT_VERSION_PIN_ERROR_MESSAGE =
  'Agent version pin must be "latest" or a registered agent/watchdog version.';

// A pin value is either the 'latest' sentinel or a version string. The stored
// agent_versions.version column is varchar(20), so bound the length to match;
// existence against the registry is checked separately at save time.
const pinValueSchema = z.string().trim().min(1).max(20);

/**
 * Zod shape for `settings.defaults.agentVersionPins`. Both sub-fields are
 * optional and independent. Structural only — it does NOT prove the version is
 * registered (that needs a DB lookup, done in the PATCH handlers).
 */
export const agentVersionPinsSchema = z
  .object({
    agent: pinValueSchema.optional(),
    watchdog: pinValueSchema.optional(),
  })
  .strict();

export type AgentVersionPinsInput = z.infer<typeof agentVersionPinsSchema>;

/**
 * Normalize a raw pin value to either a concrete version string or `null`
 * (no pin → global latest). The `'latest'` sentinel, empty string, whitespace,
 * and non-strings all collapse to `null`. Case-insensitive on the sentinel.
 */
export function normalizeVersionPin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase() === AGENT_VERSION_PIN_LATEST) return null;
  return trimmed;
}

/**
 * Extract the normalized { agent, watchdog } pins from a `settings.defaults`
 * object (or anything shaped like it). Unset / 'latest' → null. Safe for any
 * input; never throws.
 */
export function extractAgentVersionPins(defaults: unknown): {
  agent: string | null;
  watchdog: string | null;
} {
  const root =
    defaults && typeof defaults === 'object' && !Array.isArray(defaults)
      ? (defaults as Record<string, unknown>)
      : {};
  const pins =
    root.agentVersionPins &&
    typeof root.agentVersionPins === 'object' &&
    !Array.isArray(root.agentVersionPins)
      ? (root.agentVersionPins as Record<string, unknown>)
      : {};
  return {
    agent: normalizeVersionPin(pins.agent),
    watchdog: normalizeVersionPin(pins.watchdog),
  };
}
