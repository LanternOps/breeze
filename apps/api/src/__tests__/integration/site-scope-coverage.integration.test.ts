import { describe, it, expect } from 'vitest';
import { findRoutesTouchingDevices, type RouteInfo } from '../helpers/routeScan';

/**
 * Contract test: every per-device route under `apps/api/src/routes` must
 * apply a site-scope gate so that partner-scope users restricted to a
 * subset of sites within an org cannot read or mutate devices in other
 * sites. Site is an app-layer concept only — Postgres RLS does NOT defend
 * it — so any route handler that resolves `/:deviceId` from the URL without
 * checking `permissions.allowedSiteIds` is a cross-site escalation vector.
 *
 * The scanner ({@link findRoutesTouchingDevices}) walks every `.ts` file
 * under `routes/`, matches Hono route definitions whose URL pattern names
 * a device explicitly (`:deviceId` / `:deviceIds` / `:device_id`), and
 * checks that the handler body (or a file-local helper called from it)
 * references one of the canonical site-scope gates:
 *
 *   - `requireSiteAccess`             middleware (`middleware/auth.ts`)
 *   - `canAccessDeviceSite`           per-file helper convention
 *   - `getDeviceWithOrgAndSiteCheck`  canonical helper (`routes/devices/helpers.ts`)
 *   - `canAccessSite`                 underlying primitive (`services/permissions.ts`)
 *
 * The allowlist below captures the set of routes that were known to be
 * missing the gate as of the SP2 sweep that added this test (PR #864/#868
 * fixed the bulk; this PR closes the audit-found cisHardening + software
 * inventory routes). New entries to the allowlist must include a comment
 * explaining why the site-scope check is intentionally absent or being
 * deferred — the default action on a new failure is to fix the handler,
 * not extend the allowlist.
 *
 * NOTE: this test only catches per-device URL patterns. Handlers that take
 * a `deviceId` via query/body filter are still vulnerable to the same
 * class of bug; those are caught by route-level reviews and the targeted
 * tests under `__tests__/multi-tenant-isolation.test.ts`. The list-style
 * software inventory route (`GET /software/inventory?deviceId=…`) was
 * also fixed in this PR via direct audit rather than via this scanner.
 */

// Routes that the scanner flags but which are NOT site-scope bugs we're
// fixing in this PR. Each entry must be justified — the default action on
// a new offender is to fix the handler, not add it here.
//
// All entries below are PRE-EXISTING (as of Task 12 of the launch-readiness
// fixes) site-scope misses that are out of scope for this PR. They are
// tracked for a follow-up sweep; see the audit narrative referenced by the
// SP2 launch-readiness plan.
const SITE_SCOPE_EXEMPT_HANDLERS: ReadonlySet<string> = new Set<string>([
  // -- routes/snmp -----------------------------------------------------------
  // Deprecated SNMP metric/threshold endpoints — every handler is a 4-line
  // stub that returns the deprecation payload (HTTP 410) and never reaches a
  // device row, so a site-scope gate would be dead code. Kept here so the
  // contract test's static scanner stops flagging them. The new SNMP metrics
  // surface lives under `/monitoring/assets/:id` (which DOES apply org+site
  // gates via the standard chokepoint).
  'routes/snmp.ts:GET /metrics/:deviceId',
  'routes/snmp.ts:GET /metrics/:deviceId/:oid',
  'routes/snmp.ts:GET /metrics/:deviceId/history',
  'routes/snmp.ts:GET /thresholds/:deviceId',
]);

function formatOffender(o: RouteInfo): string {
  return `  - ${o.id}  (${o.file}:${o.line})`;
}

describe('site-scope coverage', () => {
  it('every per-device route applies a site-scope gate (or is allowlisted)', async () => {
    const routes = await findRoutesTouchingDevices();
    const offenders = routes.filter(
      (r) => !r.usesSiteScopeGate && !SITE_SCOPE_EXEMPT_HANDLERS.has(r.id),
    );

    const message =
      offenders.length === 0
        ? ''
        : `\nSite-scope misses (handler resolves :deviceId but never references ` +
          `requireSiteAccess / canAccessDeviceSite / canAccessSite / ` +
          `getDeviceWithOrgAndSiteCheck — and is not in the allowlist):\n` +
          offenders.map(formatOffender).join('\n') +
          `\n\nFix by calling one of the canonical gates above, OR — if this ` +
          `is genuinely safe — add the route id to SITE_SCOPE_EXEMPT_HANDLERS ` +
          `with a comment justifying the exemption.`;

    expect(offenders, message).toEqual([]);
  });

  it('the allowlist does not contain stale entries', async () => {
    // Guards against drift: if a route was fixed but the allowlist entry
    // wasn't removed, this catches it. Otherwise a future regression on the
    // same route would silently pass.
    const routes = await findRoutesTouchingDevices();
    const stillFlagged = new Set(
      routes.filter((r) => !r.usesSiteScopeGate).map((r) => r.id),
    );
    const stale: string[] = [];
    for (const entry of SITE_SCOPE_EXEMPT_HANDLERS) {
      if (!stillFlagged.has(entry)) stale.push(entry);
    }
    const message =
      stale.length === 0
        ? ''
        : `\nSITE_SCOPE_EXEMPT_HANDLERS entries that no longer match any ` +
          `flagged route (handler was fixed or moved; remove from the ` +
          `allowlist):\n` +
          stale.map((s) => `  - ${s}`).join('\n');
    expect(stale, message).toEqual([]);
  });
});
