# Plan: site-scope the AI-agent tool layer (`services/aiTools*.ts`)

**Status:** PROPOSED — separate PR, not started. Planning doc only.
**Date:** 2026-05-31
**Related:** `fix/browser-security-site-scope` (route-layer fixes for the same bug class).

## Problem

The route layer enforces the site-scope axis (`permissions.allowedSiteIds`), but the AI-agent
tool layer is a parallel path to the same device-scoped tables and enforces **only the org
axis**. Audit findings (verified on `origin/main`):

- `grep -r 'canAccessSite\|allowedSiteIds\|requireSiteAccess' apps/api/src/services/aiTools*.ts`
  → **zero matches** across ~40 files.
- `AuthContext` (`apps/api/src/middleware/auth.ts:9-33`) has **no site field** — only
  `orgId` / `accessibleOrgIds` / `orgCondition` / `canAccessOrg`. The tool layer is therefore
  structurally incapable of site-gating; the data it would need is never propagated.
- The shared device gate `verifyDeviceAccess` (`apps/api/src/services/aiTools.ts:80-92`) is
  `eq(devices.id, …)` + `orgCondition` only. Per-file copies in `aiToolsScripts.ts`,
  `aiToolsRemote.ts`, `aiToolsFilesystem.ts` are identical.

### Reachability (why it matters)

`allowedSiteIds` is set for org-scope users (`organizationUsers.siteIds`). The AI chat endpoint
`POST /sessions/:id/messages` (`routes/ai.ts`) requires `organizations:write` + MFA — orthogonal
to site restriction, so site-restricted users qualify. The `auth` (site-less `AuthContext`) is
passed to the streaming session manager → SDK tool wrapper → `executeTool` → tool handler →
`verifyDeviceAccess` (org-only). The MCP path (`routes/mcpServer.ts` `buildAuthFromApiKey`) is
the same and gates only on API-key scopes.

### Severity

Worse than the route reads, because the tool set includes **mutations on devices**:
`aiToolsScripts` (run scripts), `aiToolsRemote` (remote desktop / terminal), `aiToolsFilesystem`
(read/write/execute files). A site-restricted user could act on devices in forbidden sites —
privilege-escalation / RCE-class, not just information disclosure.

## Design

### 1. Thread a site axis onto `AuthContext`

Add `allowedSiteIds?: string[]` to the `AuthContext` interface (`middleware/auth.ts`). Populate
it at **every** construction site:
- Request path (`auth.ts` ~465) — `userPerms.allowedSiteIds` is already in hand there.
- MCP API-key path (`mcpServer.ts buildAuthFromApiKey`). **DECIDED (owner, 2026-05-31):** a key
  inherits the **creator's** access, including `allowedSiteIds` — a key is a principal scoped to
  one user with that user's exact access, never broader. So `buildAuthFromApiKey` must load the
  creating user's `allowedSiteIds` (via `getUserPermissions` for the key's org context) and attach
  it to the `AuthContext`. Key creation is likewise limited to the creator's own scope (a
  site-restricted user cannot mint a key with broader site access than they hold).
  - **Direction (idea, not this PR):** model an API key as a dedicated "service principal" /
    special user-account type that carries its own scope record, rather than re-deriving the
    creator's perms on each request. Tracked as a follow-up; for now, re-derive from the creator.
  - Add a test asserting a key created by a site-restricted user yields an `AuthContext` with that
    user's `allowedSiteIds` (and that the gated tools then deny out-of-scope devices through it).
- Streaming session manager passthrough (`streamingSessionManager.ts`) and the SDK tool DB-access
  context (`aiAgentSdkTools.ts`) — ensure the field survives each hop (currently they copy a
  whitelist of fields; add `allowedSiteIds`).

### 2. Gate the single chokepoint

Update `verifyDeviceAccess` (`aiTools.ts:80`): after resolving the device, if
`auth.allowedSiteIds` is set and the device's `siteId` is not accessible (reuse `canAccessSite`),
return `{ error: 'Device not found or access denied' }` (same opaque message as today's org miss
— don't leak existence). This one change covers the ~33 tools that route through it.

### 3. Collapse the per-file copies

`aiToolsScripts.ts:49`, `aiToolsRemote.ts:25`, `aiToolsFilesystem.ts:25` have their own
org-only device lookups. Refactor them to call the shared `verifyDeviceAccess` (preferred) or
apply the same site check inline. These are the high-privilege mutators — prioritize.

### 4. Direct-query tools

Tools that query device-scoped tables directly (not via `verifyDeviceAccess`):
- `aiToolsBrowser.ts` — `browserExtensions` / `browserPolicyViolations` reads + `browserPolicies`
  read/insert/update/apply. Mirror the route-layer fix (`resolveSiteAllowedDeviceIds` narrowing
  for reads; `policyWithinSiteWriteScope` for policy mutations).
- Sweep the remaining `aiTools*.ts` for list-style device reads and narrow by the allowed device
  set when `auth.allowedSiteIds` is present.

### 5. Tool exposure for site-restricted sessions

**DECIDED (owner, 2026-05-31): follow suit with the human RBAC model — allowed, but scoped.** A
site-restricted user may invoke the mutating AI tools, but only against devices within their site
allowlist; out-of-scope devices are denied at the gate (steps 2-4). No separate "AI cannot
mutate" guardrail is introduced — the site axis is enforced identically to the route layer.

## Testing (TDD)

- Unit test `verifyDeviceAccess`: site-restricted auth + device in a denied site → error;
  in-scope → ok; unrestricted → ok (no regression).
- Per-file: scripts/remote/filesystem device gates honor site scope.
- `aiToolsBrowser`: read narrowing + policy write scope.
- MCP path: assert the documented API-key site-scope decision.
- Add an `aiTools`-layer analogue of the route contract test, OR extend the input-sourced
  scanner (`2026-05-31-site-scope-input-scanner.md`) to also walk `services/aiTools*.ts`, so this
  layer can't silently regress.

## Risks

- Wide blast radius (AuthContext touched everywhere) — land behind thorough tests; the field is
  additive and optional, so unrestricted callers are unaffected.
- Field-passthrough hops are easy to miss — the contract/scanner test in the Testing section is
  the backstop.
