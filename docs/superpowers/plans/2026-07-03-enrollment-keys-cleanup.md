# Enrollment Keys Cleanup — Implementation Plan

Issues: #2196 (auto-purge + delete-expired action), #2197 (dead KEY column).
Branch: `ToddHebebrand/Enrollment-Keys-Cleanup` (base `4a09d92d0`).

## Background

The Add Device flows and onboarding-token endpoint auto-create single-use enrollment keys
(60-min TTL parents, 24h TTL children) that linger forever after expiry. There is no cleanup
worker, no bulk delete, and the UI KEY column always renders "Hidden" because the list
endpoint strips the key (only a hash is stored; plaintext is shown once at create/rotate).

## Global Constraints

- **No schema changes, no migrations.** Hard delete of `enrollment_keys` rows is safe: the
  only FK references (`installer_bootstrap_tokens.enrollment_key_id`,
  `deployment_invites.enrollment_key_id`) are both `ON DELETE CASCADE`.
- Keys with `expires_at IS NULL` are NEVER deleted by any purge path.
- Background job DB access MUST use `withSystemDbAccessContext` (`apps/api/src/db/index.ts`).
  Bare pool is forbidden.
- BullMQ job IDs must not contain `:` — use `-` separators.
- Web mutation handlers MUST use `runAction` (`apps/web/src/lib/runAction.ts`) with the
  standard catch pattern (401 ActionError → return; non-ActionError → showToast error).
- Tests live alongside source files. Unit tests mock the db; any test needing real Postgres
  goes in the integration config lists (not needed for this plan — unit only).
- New interactive UI elements get `data-testid` attributes.
- The purge endpoint is MFA-gated and permission-gated exactly like the existing
  `DELETE /enrollment-keys/:id` (see `apps/api/src/routes/enrollmentKeys.ts:832-878`).

## Task 1 — API: `POST /enrollment-keys/purge-expired`

**Files:** `apps/api/src/routes/enrollmentKeys.ts` (add route),
`apps/api/src/routes/enrollmentKeys.test.ts` (or the existing sibling test file — find and
extend it; do not create a duplicate suite).

Add a `POST /purge-expired` route to `enrollmentKeysRoutes`:

- Auth/gates: mirror `DELETE /:id` exactly — same middleware chain (`requireMfa()`, same
  permission requirement, same rate limiter class as other enrollment-key writes).
- No request body. Scope: delete all enrollment keys **visible to the caller** (same
  org/partner/system scoping the `GET /` list route builds, see lines 530-608) where
  `expires_at IS NOT NULL AND expires_at < now()`. Reuse/extract the same condition the
  list route builds for `?expired=true` (`lt(enrollmentKeys.expiresAt, new Date())`,
  line ~575).
- Implementation: single `db.delete(enrollmentKeys).where(and(scopeCondition, expiredCondition)).returning({ id: enrollmentKeys.id })`.
- Response: `200 { success: true, deletedCount: n }`.
- Audit: if `DELETE /:id` writes an audit log entry, write one equivalent entry for the bulk
  purge (action e.g. `enrollment_keys.purge_expired`, details `{ deletedCount }`). Follow the
  existing audit call pattern in this file; do not invent a new helper.
- **Route ordering:** register `POST /purge-expired` BEFORE any `/:id`-parameterized POST
  routes so it is not captured as an id.

Tests (Vitest + Drizzle mock pattern per repo convention): purge deletes only expired keys
in caller scope; keys with null `expiresAt` survive; response contains count; MFA/permission
gates enforced (mirror the DELETE /:id test cases).

## Task 2 — API: scheduled auto-purge worker

**Files:** `apps/api/src/jobs/enrollmentKeyCleanup.ts` (new),
`apps/api/src/jobs/enrollmentKeyCleanup.test.ts` (new),
`apps/api/src/index.ts` (register in the worker init array, alongside
`['oauthCleanup', initializeOauthCleanupWorker]` at ~line 1157).

Model the worker file closely on `apps/api/src/jobs/oauthCleanup.ts` (same structure:
Queue + Worker, daily cron `'0 4 * * *'`, dedup jobId — use `-` separators, env kill
switch, `initialize*/shutdown*/schedule*` exports, `__testOnly` introspection).

- Env vars:
  - `ENROLLMENT_KEY_CLEANUP_ENABLED` — default ON (same parsing as `OAUTH_CLEANUP_ENABLED`).
  - `ENROLLMENT_KEY_PURGE_AFTER_DAYS` — integer, default `7`. Grace period past expiry.
- Job body: inside `withSystemDbAccessContext`, delete rows where
  `expires_at IS NOT NULL AND expires_at < now() - interval '<N> days'` (compute the cutoff
  Date in JS: `new Date(Date.now() - days * 86400_000)` and use `lt(enrollmentKeys.expiresAt, cutoff)`).
- Log the deleted count at info level (count = `.returning({id})` length or delete result
  count, matching how oauthCleanup reports counts).
- Unit tests: mock `../db` (the repo has a known green-local/red-CI trap when worker tests
  leave db context unmocked — mock it explicitly). Cover: cutoff math respects
  `ENROLLMENT_KEY_PURGE_AFTER_DAYS`; null-expiry rows are not matched (assert the where
  condition includes the not-null guard); kill switch prevents scheduling.

## Task 3 — Web UI: EnrollmentKeyManager changes

**Files:** `apps/web/src/components/settings/EnrollmentKeyManager.tsx`, plus its sibling
test file if one exists (extend, don't duplicate).

Three changes:

1. **KEY column → SHORT CODE** (#2197): remove the dead masked-key/"Hidden" cell
   (lines ~369-395; `key.key` is never populated on list rows). Replace the column header
   with `Short code` and render `key.shortCode` in monospace with the existing
   copy-to-clipboard affordance when present, else a dim `—`. Verify the list API returns
   `shortCode` (sanitize only strips `key`); if it doesn't, include it in the API response
   in this task. Keep the one-time creation banner untouched.
2. **Delete expired button** (#2196): a `Delete expired` button near the table header,
   visible/enabled when at least one listed key is expired (client-side `getKeyStatus`
   already computes this). ConfirmDialog ("Delete all expired enrollment keys? This cannot
   be undone."), then `runAction` POST to `/enrollment-keys/purge-expired`, success toast
   with the deleted count, then refetch page 1. `data-testid="delete-expired-keys"`.
3. **Hide-expired toggle**: a checkbox/toggle `Hide expired` (default OFF — current
   behavior unchanged) that refetches the list with `?expired=false` (the API already
   supports it). Persist nothing; plain component state. `data-testid="hide-expired-toggle"`.

Tests (Vitest + jsdom, per repo web conventions): purge button calls the endpoint via
runAction and refetches; toggle adds `expired=false` to the fetch; short-code cell renders
code when present and `—` when absent; no "Hidden" text remains.

## Out of Scope

- Checkbox multi-select / generic bulk delete.
- Changing how Add Device flows create keys.
- Purging exhausted-but-unexpired keys.
- Docs/release notes (handled at release time).
