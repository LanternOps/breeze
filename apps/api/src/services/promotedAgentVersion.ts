import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { getBinaryEdition } from './binaryEdition';
import { captureException, captureMessage } from './sentry';

/**
 * Which release the public component-download routes should actually serve.
 *
 * Issue #3499: the bytes and the checksum used to come from two independent
 * sources of truth. `GET /agent-versions/latest` reads the checksum from the
 * `agent_versions` row with `isLatest=true`; `GET /agents/download/:os/:arch`
 * built its GitHub redirect from `BINARY_VERSION || BREEZE_VERSION` resolved
 * from per-process env at request time. Those two can disagree — and did, one
 * full release apart, when the GitHub sync stalled and left `agent_versions`
 * frozen at 0.104.0 while the download route happily served 0.105.1. install.sh
 * then fetched a 0.104.0 checksum, downloaded 0.105.1 bytes, and aborted with
 * "Checksum verification failed for downloaded agent binary".
 *
 * The checksum check was not malfunctioning — it correctly refused a binary
 * that did not match the metadata it was handed. The defect is that the two
 * halves could disagree at all. This resolver is the single query both halves
 * now go through, so a stale sync yields a *consistent old version* instead of
 * an inconsistent pair.
 *
 * MUST STAY IN LOCKSTEP with two other readers of the promoted row:
 *   - `GET /agent-versions/latest` (routes/agentVersions.ts) — serves the
 *     checksum these bytes are verified against. Same five predicates and the
 *     same `ORDER BY created_at DESC` tiebreak: if one orders and the other
 *     does not, a duplicate `isLatest` row makes them select DIFFERENT rows
 *     and reintroduces #3499 with no signal at all.
 *   - `resolvePinnedUpgradeTarget({ pin: null })` (routes/agents/helpers.ts)
 *     — picks the version the heartbeat OFFERS the fleet. If it and this
 *     resolver disagree, agents are told to upgrade to a version whose bytes
 *     this server will not serve.
 *
 * `agent_versions` is a global (non-tenant) table with no RLS, so this is safe
 * to call from the public, unauthenticated download routes in any DB context —
 * the same reason `GET /agent-versions/latest` queries it with the bare `db`
 * handle.
 */

// Route paths use Go GOOS names ("darwin"); agent_versions stores "macos".
// Mirrors PLATFORM_MAP in routes/agentVersions.ts.
const ROUTE_OS_TO_DB_PLATFORM: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
  windows: 'windows',
};

/** The components registered in agent_versions that have a download route. */
export type PromotedComponent =
  | 'agent'
  | 'helper'
  | 'user-helper'
  | 'watchdog'
  | 'backup';

/**
 * The promoted row could not be read, so we do NOT know which bytes match the
 * checksum `/agent-versions/latest` is handing out.
 *
 * Deliberately NOT degraded into "serve the env-resolved version": that is the
 * pre-#3499 behavior, i.e. the bug. It would hand the client bytes that fail
 * the checksum it already holds, surfacing a server-side DB fault to an end
 * user as "Checksum verification failed for downloaded agent binary" — the
 * single most misleading message available, and the exact string this fix
 * exists to eliminate. It would also silently break the lockstep the
 * component=backup rewrite guard in routes/agentVersions.ts depends on.
 * Callers should fail the request (503) so the fault is reported where it is.
 */
export class PromotedVersionUnavailableError extends Error {
  constructor(component: string, platform: string, arch: string, cause: unknown) {
    super(
      `Could not resolve the promoted agent_versions row for ${component} ` +
        `${platform}/${arch}; refusing to serve a release that may not match ` +
        `the checksum clients were given (#3499)`,
    );
    this.name = 'PromotedVersionUnavailableError';
    this.cause = cause;
  }
}

// A deployment that has never completed a binary sync has no isLatest row at
// all. Log EVERY occurrence (an operator grepping needs to see it is ongoing,
// not one line from whenever the first download happened) but capture to
// Sentry only once per (component, os, arch) so a persistent gap does not
// burn the quota — the shape resolvePinnedUpgradeTarget uses in
// routes/agents/helpers.ts for the analogous fleet-wide freeze.
const capturedMissingPromotedRows = new Set<string>();

/** Test-only: clears the once-per-process Sentry capture dedupe. */
export function __resetPromotedVersionCaptureCacheForTests(): void {
  capturedMissingPromotedRows.clear();
}

/**
 * Resolve the promoted (`isLatest`) version for a component/os/arch, using the
 * exact row that `GET /agent-versions/latest` would serve a checksum from.
 *
 * Returns `null` only when there is genuinely no such row — the expected
 * cold-start state of a deployment that has never synced — which tells the
 * caller to fall back to the historical env-resolved version so those
 * deployments keep working exactly as before.
 *
 * @throws {PromotedVersionUnavailableError} if the lookup itself fails.
 */
export async function getPromotedComponentVersion(
  component: PromotedComponent,
  routeOs: string,
  arch: string,
): Promise<string | null> {
  const platform = ROUTE_OS_TO_DB_PLATFORM[routeOs];
  if (!platform) {
    // Unreachable while VALID_OS gates the routes, but that invariant lives in
    // another file. Report it distinctly instead of letting an unmapped OS
    // match no row and masquerade as a never-synced deployment.
    throw new PromotedVersionUnavailableError(
      component,
      routeOs,
      arch,
      new Error(`Unmapped route OS "${routeOs}"`),
    );
  }

  // Outside the try: a fail-closed edition misconfiguration is a defect to
  // surface, not a transient fault to fall back from.
  const edition = getBinaryEdition();
  const key = `${component}:${platform}:${arch}`;

  let row: { version: string } | undefined;
  try {
    [row] = await db
      .select({ version: agentVersions.version })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.platform, platform),
          eq(agentVersions.architecture, arch),
          eq(agentVersions.component, component),
          eq(agentVersions.isLatest, true),
          // Each server only serves its own build edition (#4072) — same
          // scoping as /agent-versions/latest, so the checksum route and this
          // one can never land on different editions of the same version.
          eq(agentVersions.edition, edition),
        ),
      )
      // Newest first if the single-isLatest invariant is ever violated (it is
      // maintained by demote-then-insert, not by a unique constraint).
      // /agent-versions/latest applies the SAME tiebreak — see the lockstep
      // note above; ordering only here would itself cause a divergence.
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);
  } catch (err) {
    console.error(
      `[promotedAgentVersion] lookup failed for ${component} ${platform}/${arch} ` +
        `(edition ${edition})`,
      err,
    );
    const unavailable = new PromotedVersionUnavailableError(
      component,
      platform,
      arch,
      err,
    );
    captureException(unavailable);
    throw unavailable;
  }

  // binarySync's local-registration path stores the literal "unknown" when
  // BINARY_VERSION_FILE is unset (services/binarySync.ts, registerLocalBinaries),
  // and registers it with isLatest=true under the default AGENT_AUTO_PROMOTE.
  // A deployment that later switches to BINARY_SOURCE=github would otherwise
  // build ".../releases/download/vunknown/..." and 404 every download, where
  // before #3499 it served the env version. Treat the sentinel as "no usable
  // promoted row" so that fallback still applies.
  if (row?.version === 'unknown') {
    row = undefined;
  }

  if (!row) {
    console.warn(
      `[promotedAgentVersion] no promoted ${edition}-edition agent_versions row ` +
        `for ${component} ${platform}/${arch}; serving the env-resolved release ` +
        `version instead. The checksum from /agent-versions/latest cannot be ` +
        `guaranteed to match these bytes (#3499).`,
    );
    if (!capturedMissingPromotedRows.has(key)) {
      capturedMissingPromotedRows.add(key);
      captureMessage(
        `No promoted agent_versions row for ${component} ${platform}/${arch} ` +
          `(edition ${edition}); every download of this component falls back to ` +
          `the env-resolved release and may fail client-side checksum ` +
          `verification (#3499).`,
        { eventCode: 'agent_promoted_version_missing', level: 'warning' },
      );
    }
    return null;
  }

  return row.version;
}
