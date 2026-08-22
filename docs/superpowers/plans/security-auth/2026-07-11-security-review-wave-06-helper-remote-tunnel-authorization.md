# Security Review Wave 6: Helper, Remote, and Tunnel Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Revalidate tenant lifecycle, device ownership, site scope, permission, and MFA at every helper, remote-session, and tunnel capability boundary.

**Architecture:** Extract a tenant/device lifecycle assertion shared by main-agent and helper authentication, then introduce a current-device capability gate used at session mint and close. Remote desktop keeps `remote:access`; tunnels receive exact `tunnels:access` permission.

**Tech Stack:** TypeScript, Hono, JWT/capability tokens, WebSocket/HTTP tunnel routes, Drizzle ORM, Vitest, PostgreSQL/OrbStack.

**Global Constraints:** Preserve wire formats and agent/helper compatibility; never authorize solely from a previously minted token; do not weaken MFA; close paths must recheck current authority; deny without cross-tenant existence disclosure.

**Findings:** SR1-15, SR1-16, SR1-17, SR1-27.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-06-helper-remote-tunnel-authorization-design.md`

## File map

- Create `apps/api/src/services/tenantDeviceLifecycle.ts` and adjacent test.
- Modify `apps/api/src/middleware/agentAuth.ts`, `routes/helper/index.ts`, and their tests.
- Create or extend `apps/api/src/services/deviceCapabilityAuthorization.ts` and test.
- Modify `routes/remote/helpers.ts`, `routes/remote/sessions.ts`, `routes/tunnels.ts`, `routes/tunnelHttp.ts`, `routes/tunnelWs.ts`, and focused tests.
- Add permission migration `apps/api/migrations/2026-07-11-b-tunnel-access-permission.sql`; update permission seed/registry.

## Task 1: Shared tenant/device lifecycle assertion (SR1-15)

- [ ] Add failing tests for active tenant/device, suspended organization, inactive partner, decommissioned device, moved device, mismatched agent id, and missing rows.
- [ ] Implement a query returning the device, organization, and partner lifecycle in one authoritative lookup and expose:

```ts
export async function assertActiveTenantDevice(
  db: RequestDb,
  identity: { deviceId: string; agentId?: string },
): Promise<ActiveTenantDevice>;
```

- [ ] Use the helper from `agentAuth.ts` without changing successful auth context shape.
- [ ] Run middleware tests; expect GREEN.
- [ ] Commit: `fix(agent-auth): centralize active tenant device validation`.

## Task 2: Bring helper authentication to parity (SR1-15)

- [ ] Add helper route tests for suspended org, inactive partner, decommissioned/moved device, expired helper role token, and valid helper.
- [ ] Replace helper-only ownership shortcuts in `routes/helper/index.ts` with the shared lifecycle assertion after token verification.
- [ ] Verify helper permissions still filter tools and that denials occur before tool metadata or device details are returned.
- [ ] Run `routes/helper/index.test.ts`, `services/helperToolFilter.test.ts`, and `middleware/agentAuth.test.ts`; expect GREEN.
- [ ] Commit: `fix(helper): enforce tenant lifecycle during authentication`.

## Task 3: Current-device capability gate

- [ ] Add failing tests for permission, MFA, ownership, active lifecycle, and current site scope, including authority revoked after an earlier successful check.
- [ ] Implement:

```ts
export async function authorizeCurrentDeviceCapability(
  auth: AuthContext,
  deviceId: string,
  capability: 'remote:access' | 'tunnels:access',
  options: { requireMfa: boolean },
): Promise<AuthorizedDeviceCapability>;
```

- [ ] Resolve the device under current database state and call `auth.canAccessSite` on the authoritative site.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `fix(authz): add current device capability gate`.

## Task 4: Remote-session mint and close (SR1-16, SR1-17)

- [ ] Extend `remote/sessions.test.ts` and deny tests for missing `remote:access`, missing MFA, hidden site, moved/decommissioned device, suspended tenant, and permission revoked before close.
- [ ] Call the current-device gate before every remote capability/session mint in `remote/helpers.ts` and `remote/sessions.ts`.
- [ ] On close/terminate, lock or reload session ownership and re-run the current gate; allow only documented system cleanup paths to bypass user checks.
- [ ] Keep payload and WebSocket negotiation formats unchanged and audit start/close denials and successes without tokens.
- [ ] Run all remote route/service tests; expect GREEN.
- [ ] Commit: `fix(remote): reauthorize session lifecycle operations`.

## Task 5: Tunnel permission and lifecycle (SR1-27)

- [ ] Add permission registry/seed tests and idempotent migration for `tunnels:access`, granting only the approved built-in roles; no custom-role auto grants.
- [ ] Add HTTP and WebSocket route tests for missing permission, missing MFA, hidden/moved device, suspended tenant, expired token, permission revocation, and authorized success.
- [ ] Gate every tunnel mint/open/close in `tunnels.ts`, `tunnelHttp.ts`, and `tunnelWs.ts`; bind claims to authorized user, device, partner/org, and short expiry while retaining the current wire schema.
- [ ] Revalidate current authority when exchanging the token and closing a session.
- [ ] Run tunnel tests and migration tests; expect GREEN.
- [ ] Commit: `fix(tunnels): require current tunnel access authority`.

## Task 6: OrbStack race and regression verification

- [ ] Add integration coverage that mints a remote/tunnel token, then moves or decommissions the device or revokes the permission before exchange/close; assert denial.
- [ ] Verify main agent and helper both reject suspended organizations using the same lifecycle fixture.
- [ ] Apply the permission migration twice against OrbStack and verify idempotence.
- [ ] Run focused helper/remote/tunnel tests, `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, `pnpm db:check-drift`, and `git diff --check`.
- [ ] Commit: `test(authz): prove helper remote and tunnel reauthorization`.
