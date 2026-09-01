import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions } from '../db/schema';
import { getBinaryEdition } from './binaryEdition';

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

// A deployment that has never completed a binary sync has no isLatest row at
// all, and a self-hoster in that state would otherwise log once per download.
// Dedupe per (component, os, arch) so a persistent gap reports once per
// process rather than per request — same shape as warnedMissingPinBuilds in
// routes/agents/helpers.ts.
const warnedMissingPromotedRows = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedMissingPromotedRows.has(key)) return;
  warnedMissingPromotedRows.add(key);
  console.warn(message);
}

/** Test-only: clears the once-per-process warning dedupe. */
export function resetPromotedVersionWarningCache(): void {
  warnedMissingPromotedRows.clear();
}

/**
 * Resolve the promoted (`isLatest`) version for a component/os/arch, using the
 * exact row that `GET /agent-versions/latest` would serve a checksum from.
 *
 * Returns `null` when there is no such row, which tells the caller to fall
 * back to the historical env-resolved version. Returning `null` (rather than
 * throwing) on a DB fault is deliberate: it degrades to exactly the behavior
 * this route had before #3499 instead of turning a transient DB blip into a
 * failed install, and the client-side checksum verification remains the
 * backstop either way. The fault is logged, never swallowed silently.
 */
export async function getPromotedComponentVersion(
  component: PromotedComponent,
  routeOs: string,
  arch: string,
): Promise<string | null> {
  const platform = ROUTE_OS_TO_DB_PLATFORM[routeOs] ?? routeOs;
  const key = `${component}:${routeOs}:${arch}`;

  try {
    const [row] = await db
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
          eq(agentVersions.edition, getBinaryEdition()),
        ),
      )
      // Newest first if the single-isLatest invariant is ever violated (it is
      // maintained by demote-then-insert, not by a unique constraint).
      .orderBy(desc(agentVersions.createdAt))
      .limit(1);

    if (!row) {
      warnOnce(
        key,
        `[promotedAgentVersion] no promoted ${getBinaryEdition()}-edition ` +
          `agent_versions row for ${component} ${platform}/${arch}; serving the ` +
          `env-resolved release version instead. The checksum from ` +
          `/agent-versions/latest cannot be guaranteed to match these bytes (#3499).`,
      );
      return null;
    }

    return row.version;
  } catch (err) {
    console.error(
      `[promotedAgentVersion] lookup failed for ${component} ${platform}/${arch}; ` +
        `falling back to the env-resolved release version (#3499)`,
      err,
    );
    return null;
  }
}
