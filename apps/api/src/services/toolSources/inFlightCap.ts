/**
 * Per-source in-flight cap for tenant tool dispatch.
 *
 * `executeTenantToolDetailed` (./execute.ts) is the single chokepoint every
 * surface (chat bridge, MCP HTTP server, the tool-source test route) calls
 * through to run a BYO MCP tool. The external call it makes
 * (`McpClient.callTool`) can run for up to the client's own timeout against a
 * host the tenant configured — and on the MCP HTTP surface specifically, that
 * call currently still runs with the request's own pooled DB connection held
 * open by the caller's auth middleware (a separate, deeper fix). Regardless
 * of whether that connection is held, an unbounded number of concurrent calls
 * against the SAME slow/unresponsive source multiplies the blast radius:
 * enough concurrent MCP calls against one bad source can starve the shared
 * process's connection pool for every tenant.
 *
 * This is an in-memory, per-process bound — not a global/fleet-wide one (that
 * would need a shared store). It is intentionally simple: refusing fast once
 * a source is already at its concurrency ceiling is strictly better than
 * queuing (which would just move the pin from "held by an active call" to
 * "held by a queued one").
 */

import { envInt } from '../../utils/envInt';

const MAX_IN_FLIGHT_PER_SOURCE = 4;

const inFlightBySource = new Map<string, number>();

export function tryAcquireToolSourceSlot(sourceId: string, max = MAX_IN_FLIGHT_PER_SOURCE): boolean {
  const current = inFlightBySource.get(sourceId) ?? 0;
  if (current >= max) return false;
  inFlightBySource.set(sourceId, current + 1);
  return true;
}

export function releaseToolSourceSlot(sourceId: string): void {
  const current = inFlightBySource.get(sourceId) ?? 0;
  if (current <= 1) {
    inFlightBySource.delete(sourceId);
  } else {
    inFlightBySource.set(sourceId, current - 1);
  }
}

/** Test-only: reset all counters between specs. */
export function __resetToolSourceInFlightForTests(): void {
  inFlightBySource.clear();
}

export function currentToolSourceInFlightForTests(sourceId: string): number {
  return inFlightBySource.get(sourceId) ?? 0;
}

/**
 * Per-org (or per-partner, for a partner-owned tool) in-flight cap.
 *
 * The per-source cap above bounds how many concurrent calls hit any ONE
 * source, but places no ceiling on how many DIFFERENT sources a single org
 * can register and drive concurrently — an org with enough sources can still
 * exhaust the process's connection pool one source-cap-worth at a time
 * (`ceil(pool_max / MAX_IN_FLIGHT_PER_SOURCE)` sources is enough). This caps
 * the aggregate across all of an org's tenant-tool sources.
 */
const MAX_IN_FLIGHT_PER_ORG = envInt('TENANT_TOOL_MAX_IN_FLIGHT_PER_ORG', 8);

const inFlightByOrg = new Map<string, number>();

/** `orgKey` should uniquely identify the owning tenant (e.g. `org:<id>` or `partner:<id>`). */
export function tryAcquireOrgToolSlot(orgKey: string, max = MAX_IN_FLIGHT_PER_ORG): boolean {
  const current = inFlightByOrg.get(orgKey) ?? 0;
  if (current >= max) return false;
  inFlightByOrg.set(orgKey, current + 1);
  return true;
}

export function releaseOrgToolSlot(orgKey: string): void {
  const current = inFlightByOrg.get(orgKey) ?? 0;
  if (current <= 1) {
    inFlightByOrg.delete(orgKey);
  } else {
    inFlightByOrg.set(orgKey, current - 1);
  }
}

/** Test-only: reset all counters between specs. */
export function __resetOrgToolInFlightForTests(): void {
  inFlightByOrg.clear();
}

export function currentOrgToolInFlightForTests(orgKey: string): number {
  return inFlightByOrg.get(orgKey) ?? 0;
}
