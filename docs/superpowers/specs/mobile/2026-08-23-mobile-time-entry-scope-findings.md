---
title: Mobile time entry — scope & permission findings (W02)
tracking_issue: LanternOps/breeze#3206
wave: W02 (#3896)
plan: docs/superpowers/plans/mobile/2026-08-23-mobile-time-entry.md
date: 2026-08-29
---

# Mobile time entry — scope & permission findings

**Plan status: GO_WITH_CAVEATS**

Proceed with the REST-client tasks in the plan. The feature needs a role-grant
decision before it is usable by default technicians, and it must not depend on
the AI Home-chat path. Every claim below is labelled **verified** (read in
source at `origin/main`), **inferred** (reasoned from source, not executed) or
**not-checked**.

## Q1. Does a mobile login mint the same scope as web? Is it `partner`?

**Answer: yes — same routes, same resolver; MSP technicians mint `partner`.**

- Mobile posts to the core `/api/v1/auth/login`, `/auth/mfa/verify`,
  `/auth/refresh` (`apps/mobile/src/services/api.ts:35-37`, `:430`, `:463`,
  `:534`); `apps/mobile/src/services/auth.ts` only stores tokens. **verified**
- Scope is chosen at mint time by `resolveCurrentUserTokenContext`
  (`apps/api/src/routes/auth/helpers.ts`):
  - a `partner_users` row wins first → scope `partner` (`:1309-1332`) **verified**
  - otherwise an `organization_users` row → scope `organization` (`:1343-1366`) **verified**
  - neither → `system` only if `users.is_platform_admin`, else
    `NoTenantMembershipError` (`:1373-1388`) **verified**
  - a platform admin who also has a `partner_users` row mints `partner`, not `system`. **verified**
- Called at password login (`apps/api/src/routes/auth/login.ts:459`) and
  re-resolved on every refresh (`login.ts:1034-1036`);
  `apps/api/src/services/userSession.ts:131-137` copies `identity.scope` into
  the JWT. Middleware uses `payload.scope` as-is (`apps/api/src/middleware/auth.ts:703`)
  and only live-validates `system` against `is_platform_admin` (`auth.ts:588-596`). **verified**
- `/api/v1/time-entries` requires `requireScope('partner','system')` plus
  `time_entries:read|write` (`apps/api/src/routes/timeEntries/timeEntries.ts:22-27`;
  `requireScope` 403 at `auth.ts:779-781`) and the table's RLS policy is
  partner-axis only (`apps/api/migrations/2026-06-12-a-ticketing-time-parts.sql:55-65`). **verified**
- Web uses the same auth routes (`apps/web/src/stores/auth.ts`, reported by
  codex). **not-checked** independently.

Consequence: org-only technicians (no `partner_users` row) are hard-blocked —
expected per the plan constraint.

## Q2. Do default technician roles hold `time_entries:write`?

**Answer: no.** Default `Partner Technician` has `time_entries:read` but NOT
`time_entries:write`.

- `TIME_ENTRIES_READ/WRITE` defined at `packages/shared/src/constants/permissions.ts:80-81`. **verified**
- Only grant path: `2026-06-12-a-ticketing-time-parts.sql:102-134` propagates
  `time_entries:read` to roles holding `tickets:read` (`:117-124`) and
  `time_entries:write` to roles holding `tickets:write` (`:126-134`). **verified**
- Seeded roles (`apps/api/src/db/seed.ts` `SYSTEM_ROLES`):
  - Partner Admin `*:*` (`:224-228`) → passes via wildcard
    (`apps/api/src/services/permissionMatching.ts:14-22`). **verified**
  - Partner Technician `tickets:read` only (`:231-246`, line 239) → no write. **verified**
    (seeded that way since ticketing Phase 1a, commit `71880377c`). **verified**
  - Partner Viewer `tickets:read` only (`:248-258`). **verified**
  - Org Admin `tickets:read/write/manage` (`:285-293`) → both time perms, but org-scoped. **verified**
  - Org Technician `tickets:read` only (`:314-321`). **verified**
- `seed.ts:98-106` deliberately omits `time_entries:*` from
  `DEFAULT_PERMISSIONS`/`SYSTEM_ROLES`, so roles seeded after the migration
  ran get neither permission (fresh self-hosted installs). **inferred** — not run
  against a fresh DB.
- `2026-06-19-billing-roles.sql:5-6` comments that Technician holds
  `tickets:write`; this contradicts the seed. Production `role_permissions`
  state is **not-checked**.

## Q3. Can the Home-chat AI path ("log 15 minutes") shrink the scope?

**Answer: no — statically BLOCKED, for web and mobile alike.**

- Mobile Home chat uses ordinary `/ai/sessions` with no client tool allowlist
  (`apps/mobile/src/services/aiChat.ts:140-144`,
  `apps/mobile/src/screens/chat/HomeScreen.tsx:129, 185-189`). **verified**
- Chat routes require all three scopes, `organizations:write` and MFA
  (`apps/api/src/routes/ai.ts:129, 146-151, 550-555`); Partner Technician has
  `organizations:read` only (`seed.ts:245`), so cannot open chat. **verified**
- `log_time_entry/start_timer/stop_timer` map to `time_entries:write` and
  Tier 2 (`apps/api/src/services/aiGuardrails.ts:51-60, 531-533`); approval
  mode defaults to `per_step` (`streamingSessionManager.ts:721`); tools run
  under the caller's real auth/RLS (`aiAgentSdkTools.ts:412-414`) and
  `log_time_entry` delegates to `createTimeEntry` (`aiToolsTicketing.ts:677-690`). **verified**
- **Hard blocker:** `manage_tickets` has no entry in `TOOL_TIERS`
  (`apps/api/src/services/aiAgentSdkTools.ts:115-285`); the pre-tool hook
  rejects untiered tools (`aiAgentSdk.ts:504-506`) and
  `aiAgentSdkTools.registryParity.contract.test.ts:33-40, 93` freezes
  `manage_tickets` as "registered but untiered, invisible to chat". **verified**
- The plan's premise that `manage_tickets` has been Tier 2 with no gating since
  2026-07-20 is contradicted by the `TOOL_TIERS` gap. Task 6 must not rely on
  the AI path.

## Caveats

1. Permission gap (verified): default Partner Technician/Viewer lack
   `time_entries:write`. Needs a migration granting `time_entries:write` (and
   probably `tickets:write`) to Partner Technician, or an explicit product
   decision that logging is admin/custom-role only.
2. Fresh installs (inferred): roles seeded after 2026-06-12 have no
   `time_entries:*` at all.
3. Org-only technicians mint `organization` and are hard-blocked; the mobile
   client must render a clear "not available for your account" state.
4. Scope is re-resolved on every refresh; the client must tolerate a 403 from
   time-entry routes after a refresh.
5. AI path blocked (verified) — see Q3.
6. Production `role_permissions` for real Partner Technician rows is
   not-checked; run a psql query before deciding on a grant migration.
7. Membership-less platform admin mints `system`, passes `requireScope`, but
   `requirePermission` (`auth.ts:830-841`, `permissions.ts:188-193`) resolves no
   role and returns 403. **inferred**

## Not checked

- On-device TestFlight Home-chat test (plan Task 1 Step 3): the outstanding
  manual step; could not be run in this environment.
- Production `role_permissions` contents (both regions).
- Fresh-DB seed ordering behaviour for `time_entries:*`.
- Web auth-route citation (`apps/web/src/stores/auth.ts`).
