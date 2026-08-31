/**
 * Agent artifact-edition compatibility (#4072, #4093).
 *
 * A LEAF module on purpose. The predicate below has to be callable from both
 * doors that can put a new agent binary on a device:
 *
 *   - the heartbeat upgrade OFFER path (routes/agents/heartbeat.ts), and
 *   - the command DISPATCH path (services/commandQueue.ts -> `update_agent` /
 *     `update_watchdog`, reached from the manual/AI `trigger_agent_upgrade`
 *     tool).
 *
 * It used to live in routes/agents/helpers.ts, which imports
 * services/commandQueue — so importing it from commandQueue would have closed
 * an import cycle. Moving it here (it depends on nothing but the served
 * edition) removes the cycle rather than papering over it with a lazy import.
 * helpers.ts re-exports the same symbols, so every existing import site and
 * the suites that mock `./helpers` are unaffected.
 */

import { getBinaryEdition } from './binaryEdition';

// ============================================
// Version Comparison
// ============================================

export function parseComparableVersion(raw: string): { core: number[]; prerelease: string | null } | null {
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  const [rawCorePart, prereleasePart] = trimmed.split('-', 2);
  const corePart = rawCorePart ?? '';
  if (!corePart) return null;
  const coreTokens = corePart.split('.');
  if (coreTokens.length === 0) return null;

  const core: number[] = [];
  for (const token of coreTokens) {
    if (!/^\d+$/.test(token)) return null;
    core.push(Number.parseInt(token, 10));
  }

  return {
    core,
    prerelease: prereleasePart ?? null,
  };
}

export function compareAgentVersions(leftRaw: string, rightRaw: string): number {
  const left = parseComparableVersion(leftRaw);
  const right = parseComparableVersion(rightRaw);
  if (!left || !right) return 0;

  const maxLen = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < maxLen; i += 1) {
    const leftPart = left.core[i] ?? 0;
    const rightPart = right.core[i] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

/**
 * The agent release that introduced the client-side artifact-edition check
 * (updater.editionAllowed, #3349). Builds older than this never consult the
 * manifest's edition field and can apply artifacts of either edition; builds
 * from this version on refuse a mismatched edition AFTER download, so the
 * server must not offer them one (#4072).
 */
export const AGENT_EDITION_CHECK_INTRODUCED = '0.105.0';

/**
 * Can the binary that would perform a download apply an artifact of THIS
 * server's edition (#4072)?
 *
 * The updater's edition check runs agent-side after the download, so offering
 * a version the build will refuse does not fail once — it wedges the device in
 * a permanent ~60s retry loop (`status='updating'`, never converges, no
 * server-side escape hatch). This predicate is the server-side gate: withhold
 * the offer instead, and the device idles quietly on its current version.
 *
 * Inference, in order:
 *  - A REPORTED agentEdition (either value) means the build both knows its
 *    edition and — because the heartbeat reporting and the one-way
 *    self-host → hosted allowance in updater.editionAllowed shipped in the
 *    same agent release — can apply a hosted artifact. So when serving hosted,
 *    any reporter is accepted; when serving self-host, a 'hosted' reporter is
 *    refused (hosted builds hard-refuse self-host artifacts by design — that
 *    direction would strip the host-policy allowlist and is never relaxed).
 *  - A SILENT agent (no reported edition) is either a pre-0.105.0 build (no
 *    edition check at all → accepts anything) or a self-host build without
 *    the transition allowance (the stranded 0.105.0–0.106.x band, plus any
 *    unfixed self-host build pointed at a hosted control plane → refuses
 *    hosted). Split on the version that introduced the check. A missing or
 *    unparseable version fails closed — the offer resumes on the next beat
 *    once the agent reports something usable.
 *
 * `reportedEdition`/`agentVersion` must describe the binary that DOWNLOADS
 * (this beat's payload values): the main agent for agent/helper/watchdog
 * offers on the main branch, the watchdog itself on the failover branch.
 */
export function agentAcceptsServedEdition(args: {
  reportedEdition: string | null | undefined;
  agentVersion: string | null | undefined;
}): boolean {
  const served = getBinaryEdition();
  if (served === 'self-host') {
    return args.reportedEdition !== 'hosted';
  }
  if (args.reportedEdition === 'hosted' || args.reportedEdition === 'self-host') {
    return true;
  }
  const version = args.agentVersion?.trim();
  if (!version) return false;
  // Compare the CORE version only: semver orders `0.105.0-rc.1` BELOW
  // `0.105.0`, but a prerelease of the introducing version already carries
  // the check. A prerelease of an older core (0.104.x-rc) predates it.
  // (`dev-*` builds strip to an unparseable core and fail closed, same as
  // any other unparseable version — compareAgentVersions returns 0.)
  const core = version.split('-')[0] ?? version;
  return compareAgentVersions(core, AGENT_EDITION_CHECK_INTRODUCED) < 0;
}

// ============================================
// Dispatch gate (#4093)
// ============================================

/**
 * Command types that make a device DOWNLOAD and apply a new agent-family
 * binary. These are the dispatch-side equivalent of the heartbeat's
 * `upgradeTo` / `watchdogUpgradeTo` offers, and they are subject to the same
 * artifact-edition gate.
 *
 * Deliberately NOT including `dev_update` (routes/devPush.ts): that command
 * carries an explicit URL + checksum for a locally built binary and never
 * touches a signed release manifest, so `updater.editionAllowed` is never
 * consulted for it. Gating it would block dev-push for no benefit.
 */
export const AGENT_BINARY_UPDATE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'update_agent',
  'update_watchdog',
]);

export type EditionWithheldContext = {
  deviceId?: string;
  reportedEdition: string | null | undefined;
  agentVersion: string | null | undefined;
};

/**
 * The shared explanation for a withheld agent-binary update.
 *
 * The message states the OBSERVED facts and keeps every remediation
 * conditional — agentAcceptsServedEdition returns false for several distinct
 * states (silent post-cutover self-host build, hosted build on a self-host
 * server, unusable version) and asserting one cause for all of them sends an
 * operator down the wrong path.
 */
export function editionWithheldDetail(args: EditionWithheldContext): string {
  return (
    `this server serves ${getBinaryEdition()}-edition artifacts and the downloading build ` +
    `(reported edition=${args.reportedEdition ?? 'none'}, version=${args.agentVersion ?? 'unknown'}) ` +
    `cannot be confirmed to accept them — the agent-side edition check refuses a mismatched ` +
    `artifact AFTER download and retries every heartbeat forever, so the server withholds instead. ` +
    `If the build is a silent ≥0.105.0 self-host agent, recover it with a ` +
    `${getBinaryEdition()}-edition installer or an agent release that reports its edition; ` +
    `if it reports the other edition, it is enrolled against a server of the wrong edition.`
  );
}

/**
 * Should this dispatch of an agent-binary update command be refused (#4093)?
 *
 * Returns `null` to allow, or the operator-facing reason to refuse.
 *
 * WHY HERE and not at the caller: #4072/#4091 gated the automatic (heartbeat)
 * door, and the manual/AI door kept dispatching updates the agent refuses
 * after download — the same failure class as "manual Remediate ignores
 * enforceMode" (#3381). Gating the one known caller is how the third caller
 * ships ungated, so this runs at the dispatch chokepoint
 * (services/commandQueue.ts `executeCommand`) instead.
 *
 * DOWNLOADER IDENTITY. Both command types are executed by the breeze-watchdog
 * (agent/cmd/breeze-watchdog `handleFailoverCommand` -> `doUpdateAgent` /
 * `doUpdateWatchdog`), whose updater is what consults `editionAllowed`. The
 * main agent has no handler for either type, so a dispatch that does not
 * target the watchdog is rejected outright: it would be written with
 * target_role='agent', sent to the agent WS, and never picked up.
 *
 * VERSION. The watchdog is the downloader, so the version band is read from
 * `watchdogVersion` — written together with `watchdogLastSeen` on every
 * watchdog beat (routes/agents/heartbeat.ts), so a device fresh enough to
 * receive a watchdog command always has one. The `agentVersion` fallback
 * covers the pre-watchdog-telemetry rows only; agent and watchdog install and
 * upgrade from the same lane, so the main agent's version identifies the
 * watchdog's build era.
 *
 * EDITION. There is no `watchdogEdition` column; `agentEdition` (written from
 * every MAIN-agent beat) stands in for it, exactly as the heartbeat's failover
 * branch does. Same known imprecision, documented there: a device whose main
 * agent already reports an edition but whose watchdog is an older build can
 * still get a dispatch its watchdog refuses. That is a one-shot command
 * failure, not the permanent retry loop #4072 describes, and it self-heals
 * once the watchdog catches up.
 */
export function agentBinaryUpdateDispatchRefusal(args: {
  commandType: string;
  targetRole: 'agent' | 'watchdog';
  device: {
    agentEdition?: string | null;
    agentVersion?: string | null;
    watchdogVersion?: string | null;
  };
}): string | null {
  if (!AGENT_BINARY_UPDATE_COMMAND_TYPES.has(args.commandType)) return null;

  if (args.targetRole !== 'watchdog') {
    return (
      `${args.commandType} must be dispatched with targetRole 'watchdog' — the breeze-watchdog ` +
      `is the only consumer that handles it; an agent-targeted row is sent to the agent ` +
      `WebSocket and never picked up.`
    );
  }

  const downloaderVersion = args.device.watchdogVersion ?? args.device.agentVersion ?? null;
  const context: EditionWithheldContext = {
    reportedEdition: args.device.agentEdition ?? null,
    agentVersion: downloaderVersion,
  };
  if (agentAcceptsServedEdition(context)) return null;

  return `Agent update withheld (#4072): ${editionWithheldDetail(context)}`;
}
