/**
 * Agent-version gates for the #6958 software-install features: pre/post-install
 * scripts, `zip` archive installs, and the `service_running` detection clause.
 *
 * Pure helpers, no DB. Used at enqueue (services/softwareDeployment.ts) and
 * again at claim (services/commandDelivery.ts), because a device's reported
 * agent version is not sticky across a downgrade.
 *
 * Why a gate and not "the agent ignores what it does not know": an older agent
 * ignores unknown payload keys, so it would run a pkg WITHOUT its pre-install
 * script, or fail a zip only after downloading it. And it treats an unknown
 * detection clause as "rule set unsupported", which disables detection
 * outright (agent/internal/remote/tools/software_detection.go).
 */
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

/**
 * First agent release carrying #6958 PR B (scripts, zip, service_running).
 * It MUST equal the agent release that contains PR B: set to the first
 * unreleased version (newest tag v0.124.0, +1 minor) when this was written,
 * and re-checked at release cut. If that release ships without PR B, bump it;
 * a slip only makes the gate stricter, never looser.
 */
export const MIN_AGENT_VERSION_INSTALL_SCRIPTS = '0.125.0';

/** Same release as the scripts gate (PR B ships both). */
export const MIN_AGENT_VERSION_SERVICE_RUNNING_RULE = MIN_AGENT_VERSION_INSTALL_SCRIPTS;

/** Prefix of the per-device failure text when an agent is too old. */
export const AGENT_UPDATE_REQUIRED_INSTALL_PREFIX = 'agent_update_required';

export function agentUpdateRequiredInstallMessage(): string {
  return `${AGENT_UPDATE_REQUIRED_INSTALL_PREFIX} (minimum agent ${MIN_AGENT_VERSION_INSTALL_SCRIPTS})`;
}

/**
 * Core-semver compare that fails CLOSED on anything unparseable (the
 * yaraScanRefs.ts rules): '' and 'dev…' never compare as "equal to the
 * minimum", and a prerelease of the minimum (a lab build) counts as the
 * minimum.
 */
function agentAtLeast(agentVersion: unknown, minimum: string): boolean {
  if (typeof agentVersion !== 'string') return false;
  const core = agentVersion.trim().split('-', 1)[0] ?? '';
  if (!parseComparableVersion(core)) return false;
  return compareAgentVersions(core, minimum) >= 0;
}

export function agentSupportsInstallScripts(agentVersion: unknown): boolean {
  return agentAtLeast(agentVersion, MIN_AGENT_VERSION_INSTALL_SCRIPTS);
}

export function agentSupportsServiceRunningRule(agentVersion: unknown): boolean {
  return agentAtLeast(agentVersion, MIN_AGENT_VERSION_SERVICE_RUNNING_RULE);
}

const isPresent = (s: string | null | undefined): boolean =>
  typeof s === 'string' && s.trim().length > 0;

/**
 * Does dispatching this version need an agent that runs install scripts?
 * True for a `zip` (the agent only extracts; a post-install script installs)
 * and for an ENABLED non-blank script. A stored script with
 * installScriptsEnabled=false is dormant: it is never sent, so it needs no gate.
 */
export function versionNeedsInstallScriptSupport(v: {
  fileType: string | null;
  installScriptsEnabled: boolean;
  preInstallScript: string | null;
  postInstallScript: string | null;
}): boolean {
  if (v.fileType === 'zip') return true;
  return v.installScriptsEnabled && (isPresent(v.preInstallScript) || isPresent(v.postInstallScript));
}

/**
 * The claim-time form of the same question, asked of an already-built
 * `software_install` command payload.
 */
export function payloadNeedsInstallScriptSupport(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return p.preInstallScript != null || p.postInstallScript != null || p.fileType === 'zip';
}

/**
 * Detection rules to send to this agent. `undefined` means send no
 * `detectionRules` key at all.
 *
 * A non-array is not sent (the dispatch's historical behavior). For an agent
 * below MIN_AGENT_VERSION_SERVICE_RUNNING_RULE every `service_running` clause
 * is removed; if that leaves nothing, no rules are sent rather than an empty
 * set. Otherwise the array is returned as is, so a payload without the clause
 * is byte-identical to before.
 */
export function stripUnsupportedDetectionClauses(rules: unknown, agentVersion: unknown): unknown[] | undefined {
  if (!Array.isArray(rules)) return undefined;
  if (agentSupportsServiceRunningRule(agentVersion)) return rules;
  const kept = rules.filter(
    (rule) => !(rule && typeof rule === 'object' && (rule as { type?: unknown }).type === 'service_running'),
  );
  if (kept.length === rules.length) return rules;
  return kept.length > 0 ? kept : undefined;
}
