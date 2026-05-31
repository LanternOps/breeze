import { describe, it, expect } from 'vitest';
import {
  findRoutesTouchingDevices,
  findRoutesTouchingDeviceData,
  type RouteInfo,
} from '../helpers/routeScan';

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

/**
 * Second detector: the INPUT-SOURCED / list-style class the `:deviceId`-URL
 * scan above cannot see. A handler is flagged when its body reads/writes
 * device-scoped data (a Drizzle condition on a device/site column of a
 * schema-derived device-scoped table, or a join to `devices`) AND references no
 * site-scope gate. This is the exact blind spot the original scanner's header
 * note documented; the 2026-05 sweep fixed the first 6 offenders
 * (browserSecurity/sentinelOne/peripheralControl/huntress/dnsSecurity/analytics)
 * — see docs/superpowers/plans/2026-05-31-site-scope-input-scanner.md.
 *
 * The allowlist below captures handlers that touch device-scoped data but do
 * NOT need a site gate. Each entry MUST carry a one-line justification. The
 * default action on a new offender is to FIX the handler (narrow by the
 * caller's accessible devices), not extend the allowlist.
 */
// Vetted-safe handlers: confirmed NOT to need a site gate. Each entry MUST
// carry a one-line justification. (Empty for now — the initial rollout uses the
// baseline ratchet below rather than pre-vetting all 93 pre-existing hits.)
const SITE_SCOPE_INPUT_EXEMPT: ReadonlySet<string> = new Set<string>([
]);

// BASELINE RATCHET — pre-existing handlers flagged at the time this detector
// landed (2026-05-31). These are NOT vetted as safe; they are untriaged debt.
// The test below gates against NEW offenders only — any handler added/edited
// after this date that touches device-scoped data without a site gate must be
// fixed (or, if genuinely safe, moved to SITE_SCOPE_INPUT_EXEMPT with a reason).
//
// Burn-down: each entry is either (a) a real site-scope gap to fix by narrowing
// to the caller's accessible devices (see resolveSiteAllowedDeviceIds from the
// 2026-05 sweep), or (b) genuinely exempt — an agent/system token path with no
// user `permissions` context (e.g. routes/agents/*), or an org-wide aggregate
// taking no device input. When triaged, REMOVE the entry here and either fix the
// handler or add it to SITE_SCOPE_INPUT_EXEMPT. The "no stale entries" test makes
// the ratchet one-directional — a fixed handler's baseline entry must be removed.
// Full plan + triage guidance: docs/superpowers/plans/2026-05-31-site-scope-input-scanner.md
const SITE_SCOPE_INPUT_BASELINE: ReadonlySet<string> = new Set<string>([
  'routes/admin/abuse.ts:POST /partners/:id/suspend-for-abuse',
  'routes/agents/bootPerformance.ts:POST /:id/boot-performance',
  'routes/agents/changes.ts:PUT /:id/changes',
  'routes/agents/commands.ts:POST /:id/commands/:commandId/result',
  'routes/agents/connections.ts:PUT /:id/connections',
  'routes/agents/elevationRequests.ts:POST /:id/elevation-requests',
  'routes/agents/enrollment.ts:POST /enroll',
  'routes/agents/inventory.ts:PUT /:id/disks',
  'routes/agents/inventory.ts:PUT /:id/hardware',
  'routes/agents/inventory.ts:PUT /:id/network',
  'routes/agents/inventory.ts:PUT /:id/software',
  'routes/agents/inventory.ts:PUT /:id/warranty-info',
  'routes/agents/patches.ts:PUT /:id/patches',
  'routes/agents/sessions.ts:PUT /:id/sessions',
  'routes/agents/state.ts:PUT /:id/config-state',
  'routes/agents/state.ts:PUT /:id/registry-state',
  'routes/alerts/alerts.ts:GET /',
  'routes/auditLogs.ts:GET /logs/:id',
  'routes/backup/bmr.ts:GET /bmr/tokens',
  'routes/backup/dashboard.ts:GET /dashboard',
  'routes/backup/jobs.ts:GET /jobs',
  'routes/backup/jobs.ts:GET /jobs/:id',
  'routes/backup/restore.ts:GET /restore',
  'routes/backup/sla.ts:GET /events',
  'routes/backup/snapshots.ts:GET /snapshots',
  'routes/backup/vault.ts:GET /',
  'routes/changes.ts:GET /',
  'routes/cisHardening.ts:GET /compliance',
  'routes/cisHardening.ts:GET /remediations',
  'routes/deployments.ts:GET /:id/devices',
  'routes/desktopWs.ts:POST /connect/exchange',
  'routes/devices/provision.ts:POST /provision',
  'routes/discovery.ts:DELETE /assets/:id',
  'routes/discovery.ts:GET /assets',
  'routes/discovery.ts:POST /assets/:id/link',
  'routes/groups.ts:GET /',
  'routes/groups.ts:GET /:id/devices',
  'routes/groups.ts:GET /:id/membership-log',
  'routes/helper/index.ts:DELETE /chat/sessions/:id',
  'routes/helper/index.ts:GET /chat/sessions',
  'routes/helper/index.ts:GET /chat/sessions/:id/messages',
  'routes/helper/index.ts:POST /chat/sessions/:id/approve/:executionId',
  'routes/helper/index.ts:POST /chat/sessions/:id/flag',
  'routes/huntress.ts:GET /status',
  'routes/lifecycle.ts:GET /admin/users/:userId/mobile-devices',
  'routes/lifecycle.ts:GET /me/mobile-devices',
  'routes/metrics.ts:GET /',
  'routes/metrics.ts:GET /trends',
  'routes/mobile.ts:GET /alerts/inbox',
  'routes/mobile.ts:GET /devices',
  'routes/mobile.ts:GET /search',
  'routes/mobile.ts:POST /devices',
  'routes/mobile.ts:POST /notifications/register',
  'routes/monitoring.ts:GET /assets',
  'routes/monitoring.ts:GET /assets/:id',
  'routes/monitoring.ts:GET /results',
  'routes/networkBaselines.ts:GET /',
  'routes/networkBaselines.ts:POST /',
  'routes/networkChanges.ts:GET /',
  'routes/patches/compliance.ts:GET /compliance',
  'routes/playbooks.ts:GET /executions',
  'routes/playbooks.ts:GET /executions/:id',
  'routes/policyManagement/compliance.ts:GET /:id/compliance',
  'routes/portal/assets.ts:GET /assets',
  'routes/portal/assets.ts:POST /assets/:id/checkin',
  'routes/portal/assets.ts:POST /assets/:id/checkout',
  'routes/psa.ts:GET /connections/:id/tickets',
  'routes/psa.ts:GET /tickets',
  'routes/remote/sessions.ts:DELETE /sessions/stale',
  'routes/remote/sessions.ts:GET /sessions',
  'routes/remote/sessions.ts:GET /sessions/history',
  'routes/remote/sessions.ts:POST /sessions',
  'routes/remote/sessions.ts:POST /sessions/:id/offer',
  'routes/remote/transfers.ts:GET /transfers',
  'routes/remote/transfers.ts:POST /transfers',
  'routes/reports/data.ts:GET /data/compliance',
  'routes/reports/data.ts:GET /data/device-inventory',
  'routes/reports/data.ts:GET /data/metrics',
  'routes/reports/data.ts:GET /data/software-inventory',
  'routes/reports/generate.ts:POST /generate',
  'routes/scripts.ts:POST /executions/:id/cancel',
  'routes/sentinelOne.ts:GET /status',
  'routes/snmp.ts:GET /dashboard',
  'routes/softwareInventory.ts:GET /',
  'routes/softwareInventory.ts:GET /:name/devices',
  'routes/softwarePolicies.ts:GET /compliance/overview',
  'routes/softwarePolicies.ts:GET /violations',
  'routes/softwarePolicies.ts:POST /:id/remediate',
  'routes/tunnels.ts:GET /allowlist',
  'routes/tunnels.ts:GET /desktop-access',
  'routes/tunnels.ts:POST /downgrade-to-vnc',
  'routes/tunnels.ts:POST /upgrade-to-webrtc',
  'routes/updateRings.ts:GET /:id/compliance',
]);

describe('site-scope coverage — input-sourced / list-style', () => {
  it('no NEW handler touches device-scoped data without a site-scope gate', async () => {
    const routes = await findRoutesTouchingDeviceData();
    const offenders = routes.filter(
      (r) =>
        !r.usesSiteScopeGate &&
        !SITE_SCOPE_INPUT_EXEMPT.has(r.id) &&
        !SITE_SCOPE_INPUT_BASELINE.has(r.id),
    );

    const message =
      offenders.length === 0
        ? ''
        : `\n${offenders.length} NEW handler(s) read/write device-scoped data ` +
          `(device/site column condition or devices join) without a site-scope ` +
          `gate:\n` +
          offenders.map(formatOffender).join('\n') +
          `\n\nFix by narrowing to the caller's accessible devices (see ` +
          `resolveSiteAllowedDeviceIds in the 2026-05 sweep). If genuinely safe ` +
          `(agent/system token path, or an org-wide aggregate with no device ` +
          `input), add the id to SITE_SCOPE_INPUT_EXEMPT with a one-line reason. ` +
          `Do NOT add to SITE_SCOPE_INPUT_BASELINE — that set is frozen and only ` +
          `shrinks.`;

    expect(offenders, message).toEqual([]);
  });

  it('the baseline/allowlist shrink-only (no stale entries)', async () => {
    // Ratchet: once a baseline handler is fixed (gains a gate) or removed, its
    // entry must be deleted here. This prevents the baseline from masking a
    // future regression on a handler that was fixed in the meantime.
    const routes = await findRoutesTouchingDeviceData();
    const stillFlagged = new Set(
      routes.filter((r) => !r.usesSiteScopeGate).map((r) => r.id),
    );
    const stale = [...SITE_SCOPE_INPUT_BASELINE, ...SITE_SCOPE_INPUT_EXEMPT].filter(
      (e) => !stillFlagged.has(e),
    );
    const message =
      stale.length === 0
        ? ''
        : `\nBaseline/exempt entries no longer flagged (handler fixed or moved — ` +
          `remove them so the ratchet tightens):\n` +
          stale.map((s) => `  - ${s}`).join('\n');
    expect(stale, message).toEqual([]);
  });
});
