import { describe, it, expect } from 'vitest';
import {
  findRoutesTouchingDevices,
  findRoutesTouchingDeviceData,
  findRoutesWithDeadPermsSiteGate,
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
  // ---- Agent / helper / viewer-token paths: authenticated by an AGENT or
  // helper/viewer token, NOT a user session, so there is no `permissions`
  // context and `allowedSiteIds` never applies. (Codex triage 2026-05-31.)
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
  'routes/desktopWs.ts:POST /connect/exchange',
  'routes/helper/index.ts:DELETE /chat/sessions/:id',
  'routes/helper/index.ts:GET /chat/sessions',
  'routes/helper/index.ts:GET /chat/sessions/:id/messages',
  'routes/helper/index.ts:POST /chat/sessions/:id/approve/:executionId',
  'routes/helper/index.ts:POST /chat/sessions/:id/flag',
  'routes/tunnels.ts:GET /desktop-access',
  'routes/tunnels.ts:POST /downgrade-to-vnc',
  'routes/tunnels.ts:POST /upgrade-to-webrtc',
  // ---- Not the bug class: platform-admin-only, portal-session auth, or a
  // mobile/OAuth device row (not an RMM device with a site).
  'routes/admin/abuse.ts:POST /partners/:id/suspend-for-abuse',
  'routes/lifecycle.ts:GET /admin/users/:userId/mobile-devices',
  'routes/lifecycle.ts:GET /me/mobile-devices',
  'routes/mobile.ts:POST /devices',
  'routes/mobile.ts:POST /notifications/register',
  'routes/portal/assets.ts:GET /assets',
  'routes/portal/assets.ts:POST /assets/:id/checkin',
  'routes/portal/assets.ts:POST /assets/:id/checkout',
  // ---- Genuinely site-gated via the cross-file `getDeviceWithOrgCheck`
  // helper (routes/remote/helpers.ts), which the file-local scanner can't see.
  'routes/remote/sessions.ts:POST /sessions',
  'routes/remote/transfers.ts:POST /transfers',
]);

// SITE_SCOPE_INPUT_EXEMPT entries that ARE reached via the user `authMiddleware`
// (so they DO carry a `permissions` context) but are exempt for a reason other
// than "non-user auth": the `deviceId` is a mobile/OAuth device row (not an RMM
// device with a site), or the route is genuinely site-gated through a cross-file
// helper the file-local scanner can't see. Every other exempt MUST be backed by
// a non-user-session auth guard in its file (see the re-verification test) — this
// set enumerates the deliberate user-session exceptions so they can't hide a
// future regression where a non-user-auth file is migrated to plain user auth.
const SITE_SCOPE_INPUT_EXEMPT_USER_SESSION_OK: ReadonlySet<string> = new Set<string>([
  // Mobile/OAuth device rows keyed on the user — not RMM devices with a site.
  'routes/mobile.ts:POST /devices',
  'routes/mobile.ts:POST /notifications/register',
  'routes/lifecycle.ts:GET /admin/users/:userId/mobile-devices',
  'routes/lifecycle.ts:GET /me/mobile-devices',
  // Site-gated via the cross-file getDeviceWithOrgCheck resolver (remote/helpers.ts).
  'routes/remote/sessions.ts:POST /sessions',
  'routes/remote/transfers.ts:POST /transfers',
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
  'routes/alerts/alerts.ts:GET /',
  'routes/auditLogs.ts:GET /logs/:id',
  'routes/changes.ts:GET /',
  'routes/cisHardening.ts:GET /compliance',
  'routes/cisHardening.ts:GET /remediations',
  'routes/deployments.ts:GET /:id/devices',
  'routes/discovery.ts:GET /assets',
  'routes/groups.ts:GET /',
  'routes/groups.ts:GET /:id/devices',
  'routes/groups.ts:GET /:id/membership-log',
  'routes/huntress.ts:GET /status',
  'routes/metrics.ts:GET /',
  'routes/metrics.ts:GET /trends',
  'routes/networkBaselines.ts:GET /',
  'routes/networkChanges.ts:GET /',
  'routes/patches/compliance.ts:GET /compliance',
  'routes/playbooks.ts:GET /executions',
  'routes/playbooks.ts:GET /executions/:id',
  'routes/policyManagement/compliance.ts:GET /:id/compliance',
  'routes/psa.ts:GET /connections/:id/tickets',
  'routes/psa.ts:GET /tickets',
  'routes/remote/sessions.ts:GET /sessions',
  'routes/remote/sessions.ts:GET /sessions/history',
  'routes/remote/transfers.ts:GET /transfers',
  'routes/reports/data.ts:GET /data/compliance',
  'routes/sentinelOne.ts:GET /status',
  'routes/snmp.ts:GET /dashboard',
  'routes/softwareInventory.ts:GET /',
  'routes/softwareInventory.ts:GET /:name/devices',
  'routes/softwarePolicies.ts:GET /compliance/overview',
  'routes/softwarePolicies.ts:GET /violations',
  'routes/tunnels.ts:GET /allowlist',
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

  it('every input-exempt entry stays backed by a non-user-session auth guard', async () => {
    // Re-verification: the SITE_SCOPE_INPUT_EXEMPT entries are justified by the
    // route having no user `permissions` context (agent/helper/portal/viewer/
    // admin token auth). If such a file is later migrated to the plain user
    // `authMiddleware`, it WOULD carry a `permissions` context and become a real
    // site-scope gap, but the exempt entry would silently keep it green. Catch
    // that drift: each exempt must either reference a non-user auth guard in its
    // file, or be an explicitly-listed user-session exception.
    const routes = await findRoutesTouchingDeviceData();
    const byId = new Map(routes.map((r) => [r.id, r] as const));
    const unjustified: string[] = [];
    for (const id of SITE_SCOPE_INPUT_EXEMPT) {
      const route = byId.get(id);
      // A missing id is a stale entry — owned by the shrink-only test below.
      if (!route) continue;
      if (route.referencesNonUserAuthGuard) continue;
      if (SITE_SCOPE_INPUT_EXEMPT_USER_SESSION_OK.has(id)) continue;
      unjustified.push(id);
    }
    const message =
      unjustified.length === 0
        ? ''
        : `\nSITE_SCOPE_INPUT_EXEMPT entries reached via the user authMiddleware ` +
          `(they carry a \`permissions\` context) but no longer backed by a ` +
          `non-user-session auth guard in their file:\n` +
          unjustified.map((s) => `  - ${s}`).join('\n') +
          `\n\nThis exemption assumed no user permissions context. Either restore ` +
          `the non-user guard, fix the handler to site-scope, or — if it is a ` +
          `genuine user-session exception (mobile/OAuth device row, cross-file ` +
          `gate) — add it to SITE_SCOPE_INPUT_EXEMPT_USER_SESSION_OK with a reason.`;
    expect(unjustified, message).toEqual([]);
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

/**
 * Third detector: DEAD permissions-sourced site gates. This is the blind spot
 * the #1042 re-review uncovered. The two detectors above check whether a
 * site-scope gate is *present* in source. They do NOT check whether it ever
 * *runs*: the fail-open idiom
 *
 *     const perms = c.get('permissions');
 *     if (perms?.allowedSiteIds && !canAccessSite(perms, device.siteId)) deny();
 *
 * reads `permissions` from the request context — which is populated ONLY by
 * `requirePermission` middleware (`middleware/auth.ts` does
 * `c.set('permissions', …)`), NEVER by `authMiddleware`/`requireScope`. A route
 * carrying only `requireScope` leaves `perms` `undefined`, so `perms?.…` is
 * falsy, the guard is skipped, and a site-restricted partner user reads/writes
 * out-of-site devices. The gate text is present (so the detectors above pass),
 * but it is dead. The original scanner treated `canAccessSite`/`allowedSiteIds`
 * as proof of a gate; this detector additionally requires a LIVE source for the
 * `permissions` context.
 *
 * {@link findRoutesWithDeadPermsSiteGate} flags a route when its handler — or a
 * file-local helper it calls — gates on the `permissions` context with no live
 * source (`requirePermission(` in the chain, a `getUserPermissions(` fallback,
 * or self-resolving `requireSiteAccess`). Fail-closed helpers that THROW on a
 * missing context (`getDeviceWithOrgAndSiteCheck`) are excluded — they break
 * the request rather than leak.
 *
 * Routes that legitimately gate via `getUserPermissions` fallback are NOT
 * flagged — e.g. `routes/security/{posture,status,threats}.ts`, which fetch
 * permissions themselves (PR #900) and so stay live under plain `requireScope`.
 */
// Vetted-safe: confirmed NOT a dead gate despite matching the static shape.
// Each entry MUST carry a one-line justification.
const DEAD_PERMS_GATE_EXEMPT: ReadonlySet<string> = new Set<string>([
]);

// BASELINE RATCHET — routes whose perms-sourced site gate is dead RIGHT NOW,
// carried as frozen debt so this detector lands green and blocks NEW offenders.
// The "shrink-only" test makes the ratchet one-directional: as each entry gains
// a live perms source (and drops out of the flagged set), its line MUST be
// removed.
//
// History: the detector first flagged 5 dead gates (dnsSecurity GET /events+
// /stats, huntress GET /incidents, peripheralControl GET /activity, sentinelOne
// GET /threats) — all independently fixed in #1036's final revision (now in
// main), so they are NOT listed here.
//
// The 4 below were INTRODUCED by this PR (#1041): its mutation-gating added the
// fail-open `if (perms?.allowedSiteIds && …)` idiom reading `c.get('permissions')`
// but did NOT add the `requirePermission` that populates it — so on these routes
// the new site narrowing never runs (no regression: they had no site-scope
// before either). `remote/sessions.ts` has no `requirePermission` anywhere, so
// the correct gate is a router-level decision for the #1041 author. Tracked as
// FOLLOW-UP: add the appropriate `requirePermission(...)` to each chain (and
// de-mask the new tests, which populate `permissions` via the auth-middleware
// mock rather than a requirePermission mock). The detector keeps them visible
// and blocks any NEW offender.
const DEAD_PERMS_GATE_BASELINE: ReadonlySet<string> = new Set<string>([
  'routes/networkBaselines.ts:GET /:id',
  'routes/networkBaselines.ts:GET /:id/changes',
  'routes/remote/sessions.ts:DELETE /sessions/stale',
  'routes/remote/sessions.ts:POST /sessions/:id/offer',
]);

describe('site-scope coverage — dead permissions-sourced gate', () => {
  it('no route gates on the permissions context without a live source', async () => {
    const routes = await findRoutesWithDeadPermsSiteGate();
    const offenders = routes.filter(
      (r) =>
        !DEAD_PERMS_GATE_EXEMPT.has(r.id) && !DEAD_PERMS_GATE_BASELINE.has(r.id),
    );

    const message =
      offenders.length === 0
        ? ''
        : `\n${offenders.length} route(s) gate site access on the \`permissions\` ` +
          `context but have no live source for it (no requirePermission in the ` +
          `chain, no getUserPermissions fallback, no requireSiteAccess) — the ` +
          `site gate is present in source but NEVER runs:\n` +
          offenders.map(formatOffender).join('\n') +
          `\n\nFix by adding requirePermission(DEVICES_READ/…) to the middleware ` +
          `chain (populates c.get('permissions')), OR a getUserPermissions ` +
          `fallback in the handler. If genuinely safe, add the id to ` +
          `DEAD_PERMS_GATE_EXEMPT with a one-line reason. Do NOT extend ` +
          `DEAD_PERMS_GATE_BASELINE — that set is frozen and only shrinks.`;

    expect(offenders, message).toEqual([]);
  });

  it('the baseline/allowlist shrink-only (no stale entries)', async () => {
    const routes = await findRoutesWithDeadPermsSiteGate();
    const stillFlagged = new Set(routes.map((r) => r.id));
    const stale = [...DEAD_PERMS_GATE_BASELINE, ...DEAD_PERMS_GATE_EXEMPT].filter(
      (e) => !stillFlagged.has(e),
    );
    const message =
      stale.length === 0
        ? ''
        : `\nDead-perms-gate baseline/exempt entries no longer flagged (handler ` +
          `gained a live source or moved — remove them so the ratchet tightens):\n` +
          stale.map((s) => `  - ${s}`).join('\n');
    expect(stale, message).toEqual([]);
  });
});
