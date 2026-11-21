---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W10: retire `portal_users.entra_*` (identities release C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development). Steps use checkbox (`- [ ]`) syntax. Rigor: **high** (destructive DDL, auth, multi-tenant).

**Goal:** `portal_user_identities` has been the only source of external identity since v0.128 (identities release B). This wave removes the last legacy state: the `portal_users.entra_oid` / `entra_tenant_id` columns, their partial unique index `portal_users_entra_identity_uniq`, the W2 fill trigger `portal_users_browser_access_fill`, the W3 D4 writer fence and the W3 drift report.

**Architecture:** two PRs in two consecutive releases. Every destructive statement lands one release after the last code that touches the object (#6472 / AI model registry W08a/W08b precedent: `docs/superpowers/plans/ai-mcp/2026-10-02-ai-model-registry-w08-cleanup.md`).
- **PR-A (release N = v0.131, this branch `feature/11377-portal-registration/wave-11387`).** It removes every production read and write of the columns, and the fields leave the Drizzle schema, so tsc refuses any new access. The export policy moves both columns to `retiring`. The drift-report job is retired. Every `portal_users` insert names `browser_access`. It ships one **data-only** migration, the final identity backfill (D3). It also adds a read-only preflight (gates G1/G2). Nothing is dropped.
- **PR-B (release ≥ N+1, `feature/11377-portal-registration/wave-11387-b`, stacked on PR-A).** One migration reports drift counts and then drops the two columns, the index, the trigger and its function. It never refuses to boot and never repairs (D2). It also removes the `retiring` export entries.

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md` §5.2 (cutover release C), §6 invariants 4, 5, 9 and 10, and §7 (the "Identities release C" row). Index: `2026-11-08-portal-registration-options-index.md` (W3 D4 writer fence, W4 identity-removal rule). W02 plan D1 (the trigger is dropped with the columns). W03 plan D4 and D10. W08 plan D1 (the grep test).

## Releases and gates

| Release | Contains | Gate before merge | Gate after deploy |
|---|---|---|---|
| v0.130 (shipped) | dual-write (D4 fence), daily drift report | — | — |
| **N = v0.131** | **PR-A** | **G1**: preflight against v0.130 on US and EU. PASS = `drift_counts` all zero, and `sanity` not blind. Also no `portal_identity_drift` Sentry event since v0.128. | version parity on every service (runbook) |
| **≥ N+1** | **PR-B** | **G2**: preflight against N on US and EU. PASS = `fence_writes` shows no fence write after that region's N deploy, and `halfPopulated = 0`. The other buckets are informational under N (D1). Todd approves the drop. A fresh DB backup / PITR point exists. | version parity; `portal_users` has no `entra_*` columns |

PR-A and PR-B must not ship in the same release. G1 can only be met against v0.130. Once N runs, the buckets change meaning (D1).

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Under N the drift buckets are not evidence.** N links an identity without the columns, which counts as `orphanIdentity`. N's `removeDisabledPortalIdentity` no longer clears them, so the row counts as `missingIdentity` or `mismatched`. G1 therefore runs against v0.130. G2 instead proves that no pre-N binary still writes the columns: `fence_writes` = the newest Entra identity whose login carries the same pair, which only a fence writer can produce. | A gate that cannot pass under N, or that passes vacuously, is not a gate. |
| D2 | **PR-B precondition = report and drop**: `RAISE WARNING` per-bucket counts plus capped sample ids. It never refuses boot and never backfills. Rejected: **(a) abort.** Every N-era MSP removal leaves a complete pair with no identity, so a healthy install would refuse boot (#6472: never raise on tenant data). Rejected: **(b) backfill at the drop.** The migration cannot tell never-backfilled drift from an identity the MSP deliberately removed under N, so a backfill can resurrect a removed credential (inv. 5). Since v0.128 nothing finds an account through the columns, so the drop is behaviour-neutral relative to N. The forensic loss is accepted: backup/PITR is the recovery path. | Quorum: own position (c), and Codex `gpt-6.2-astra` xhigh independently chose (c). |
| D3 | **PR-A ships the final backfill (data-only migration) at the N boundary.** At that instant every v0.130 identity remover clears the columns (D4 fence), so a `missingIdentity` row can only be never-backfilled drift (a pre-v0.128 binary during the v0.128 rolling deploy). It cannot be a removal. Re-inserting it (`linked_via='migrated'`, `ON CONFLICT DO NOTHING`, same SQL as the W2 and W3 backfills) puts the legacy unique index's job back on the identity key. Without it, N's JIT exchange, which no longer writes the columns, would mint a **new active login** for that person, including when the original account is MSP-disabled (Codex Q3). Self-hosts never run G1, so this is their only protection. | The one point in time where a repair cannot resurrect anything. |
| D4 | **The drift report (job, script, schedule, worker entry) is retired in PR-A, not PR-B.** Under N it reads the columns, it would raise `portal_identity_drift` daily (D1), and an N worker would fail on it after the drop. A boot-time cleanup (`jobs/retiredQueues.ts`) removes the queue's repeatable and its delayed/waiting jobs. It stays through PR-B for upgrades that skip N. | Codex Q2. Removing a repeatable's code leaves its key in Redis. |
| D5 | **The fields leave the Drizzle schema in PR-A.** `db:check-drift` is ledger-only (`scripts/check-drift.ts` header), so a DB column with no schema field is not drift. `browserAccess` loses `.default('none')`, so tsc refuses every Drizzle insert that omits it. The trigger it relied on goes in PR-B. | tsc is the census. A source scan covers raw SQL. |
| D6 | **Export policy: `included` → `retiring` in PR-A, removed in PR-B.** `retiring` = excluded, may be absent, so an N+1 → N rollback keeps organization export working. Both columns stop being exported in N. The values remain in `portal_user_identities.subject` / `entra_tenant_id`, which are exported. | W08 D11. |
| D8 | **Fail closed on the one leftover that loses a refusal (security review, quorum round 2).** After the D3 insert, the migration `RAISE EXCEPTION`s when a complete legacy pair has no identity reserving its exact `(issuer, subject)`. The file then rolls back whole and retries at the next boot. That can only happen when the login already holds a *different* Entra identity, so the backfill cannot reserve the pair. Until now, the legacy index refused a JIT login for that subject. From N on, the exchange would mint a fresh active login, and contact linking by verified address could bind it to the same contact even when the MSP disabled the original. Which Entra object is the right owner is a human call: the HINT names the preflight query and the two remedies. The other leftovers are WARN only, because they lose nothing: **(a)** a pair whose key another login's identity holds (the subject resolves only to that login, since `(issuer, subject)` is unique, and JIT never runs for it); **(b)** a half-populated row (the partial index never covered `(NULL, oid)`). This is a deliberate exception to #6472's "never raise on tenant data": the set is expected to be empty, because the daily drift job has raised Sentry on any non-zero since v0.128, and G1 requires zero. The alternative is a silent loss of a fail-closed. PR-B stays report-only (D2), because after N the same shapes come from deliberate removals. | Codex xhigh round 2 agreed and narrowed the gate from "mismatched" to "unreserved complete pair". |
| D7 | **The legacy refusals go with the reads.** These are `signInProviders.legacyKeyHeld` (D11 pre-consumption refusal) and `linkPortalUserIdentity`'s legacy pre-check. The identity table's two unique keys still refuse every real conflict through `ON CONFLICT DO NOTHING`. Only a drifted holder lost its refusal, and D3 removes that class. | — |

## Global Constraints

- PR-A has no DDL. Its only migration writes rows (D3) and elects system scope first. `portal_user_identities` carries no partner-export triggers (`migrationPartnerExportLocks.test.ts` verifies).
- Migration names sort after the newest file on `origin/main` **at push time**. Re-check before every push and rename the file before merge if it has been overtaken. They are idempotent, have no inner `BEGIN`/`COMMIT`, and `RAISE NOTICE`/`WARNING` their counts. Run `pnpm db:check-drift` afterwards.
- Most `entraTenantId` / `entra_oid` grep hits are other tables' own columns and stay: `portal_user_identities`, `caller_verification_*`, `office_addin_user_bindings`, `client_ai_tenant_mappings`, `portal_access_requests`, `portal_scim_tokens`, `action_intents.target_*`.
- Keep `auth_method` and its CHECK. Keep the identity table's `entra_tenant_id` CHECKs and the deferrable `(portal_user_id, org_id)` FK. Org merge needs no change, because it repoints both tables plainly (`orgMergeRegistry.ts` ~L1241).
- Full API unit + Integration Tests before each PR. PR-B is stacked, so it gets no CI on its own: `gh workflow run CI --ref feature/11377-portal-registration/wave-11387-b`.

## Review Focus

1. **A person whose legacy pair has no identity row (never-backfilled drift).** Under N they must reach their original account, disabled or not, and never get a fresh login. When that cannot be repaired automatically, the upgrade must refuse (D8). Pinned by Task 2 `portalIdentityFinalBackfill.integration.test.ts` "backfills a never-backfilled pair onto the login …" and "FAILS CLOSED (plan D8) …".
2. **An MSP removal under N, then the drop.** It must not come back. Pinned by Task 6 "a removed identity is never resurrected by the drop" (D2).
3. **A rolling deploy.** A v0.130 instance must still work against N's data, and an N instance against N+1's schema. Pinned by the schema-field removal (tsc), the empty `LEGACY_ENTRA_COLUMN_USERS` scan, and Task 6 "re-apply is a no-op; the drop never raises".
4. **A writer that omits `browser_access` after the trigger is gone.** It must fail loudly (NOT NULL), never default to `granted`. Pinned by Task 6 "an insert without browser_access fails 23502".

## §6 invariants this wave touches (named tests)

| Inv. | Test |
|---|---|
| 4 — identity org = account org | `portalIdentityFinalBackfill.integration.test.ts` "a backfilled identity carries its login's org (composite FK)" |
| 5 — never link implicitly | `portalEntraColumnsDrop.integration.test.ts` "a removed identity is never resurrected by the drop" |
| 9 — add-in never grants browser access | `portalEntraColumnsDrop.integration.test.ts` "no default grants browser access: an insert without browser_access fails 23502" |
| 10 — every `status`/`browser_access` writer via the state module | `portalAccountWriters.contract.test.ts` (unchanged) + `portalUsersInsertBrowserAccess.contract.test.ts` |

## Tasks

### PR-A

**Task 1 — red: contracts that name the legacy state.**
- `__tests__/portalIdentityFacts.contract.test.ts`: `LEGACY_ENTRA_COLUMN_USERS` becomes `{}`. The scan widens to unaliased `INSERT/UPDATE/FROM portal_users … entra_*` and to the legacy index, with a non-vacuity case. Red: 3 files.
- New `__tests__/portalUsersInsertBrowserAccess.contract.test.ts`: every raw `INSERT INTO portal_users` under `apps/api/src` (tests included), `e2e-tests/*.sql` and `apps/api/src/db/seed*` names `browser_access`. The migration-replay fixtures that test the trigger itself are listed with a reason. Red: the raw sites.
- Schema: drop `entraOid` / `entraTenantId` from `portalUsers` and `.default('none')` from `browserAccess`. Red: tsc.

**Task 2 — the final backfill (D3).**
- Create `apps/api/migrations/2027-01-28-210000-portal-identity-final-backfill.sql`. It runs the W3 §4 insert, then `RAISE WARNING` counts for the left-over buckets (`mismatched`, `halfPopulated`, and a still-missing pair blocked by an identity key held elsewhere). Then it raises `RAISE EXCEPTION` for an unreserved complete pair (D8).
- Test `__tests__/integration/portalIdentityFinalBackfill.integration.test.ts` (rolled-back transaction, notices captured). It covers:
  - a never-backfilled pair is inserted `migrated`, and the identity lookup reaches the disabled original;
  - a pair whose `(issuer, subject)` is held elsewhere is skipped with a WARNING;
  - an unreserved pair refuses the file and nothing changes (D8);
  - mismatched-held-elsewhere and half rows only WARN;
  - re-apply inserts 0.

**Task 3 — remove reads and writes.** Each hit is classified in the PR body.
- `services/clientAiExchange.ts` JIT insert.
- `services/portalIdentityAccounts.ts` insert.
- `services/portalUserIdentities.ts`: the link pre-check and fence write; delete the drift report and `isDriftReportClean`.
- `services/portalOidc/signInProviders.ts` `legacyKeyHeld`, plus the interface member and the `accountResolution.ts` call.
- `services/portalDirectory/identityDisable.ts`: the clear-on-remove.
- `services/tenantExportPolicyRegistry.ts` → `retiring`.
- Comments in `portalUserDirectory.ts`, `orgMergeRegistry.ts` and the schema.
- Unit tests follow the code. Integration tests that seeded `entraOid` via Drizzle seed the identity instead. Where the legacy pair itself is under test, they use raw SQL.

**Task 4 — retire the drift report (D4).**
- Delete `jobs/portalIdentityReconcile.ts` (+ test) and `scripts/portal-identity-reconcile{,.lib,.lib.test}.ts`.
- Remove the schedule entry, the readiness `consumers('portalIdentityReconcile')` and the worker entry.
- Add `jobs/retiredQueues.ts` (remove repeatables, drain delayed/waiting; idempotent; logs counts) as a `global` worker entry, with a unit test.

**Task 5 — fixtures name `browser_access`.**
- Every Drizzle and raw `portal_users` insert in tests and in `e2e-tests/seed-fixtures.sql` names it, with the value the trigger would have derived (`password` → `granted`, else `none`). That keeps each test's meaning.
- Preflight `apps/api/migrations/preflight/2026-11-21-100000-portal-entra-columns-drop-preflight.sql`: `BEGIN READ ONLY`, system scope, then the `sanity` (blindness control counts), `schema_state`, `drift_counts`, `drift_samples` and `fence_writes` queries, then `ROLLBACK`.
- Test `__tests__/integration/portalEntraColumnsPreflight.integration.test.ts` runs each query on seeded rows. PR-B deletes it.
- Verify: targeted vitest, `tsc --build apps/api/tsconfig.tests.json` (12 GB heap, exit code checked), Integration Tests for the touched suites, `db:check-drift`.

### PR-B

**Task 6 — drop.**
- Create `apps/api/migrations/2027-01-28-220000-portal-users-drop-entra-columns.sql` (renamed at merge to sort last). It elects system scope. When the columns exist it reports the four buckets (`RAISE WARNING` with counts and up to 20 sample ids). Then it runs `DROP TRIGGER IF EXISTS` (trigger before function), `DROP FUNCTION IF EXISTS`, `DROP INDEX IF EXISTS portal_users_entra_identity_uniq` and `ALTER TABLE … DROP COLUMN IF EXISTS` ×2. A final `RAISE EXCEPTION` fires only if an object survived.
- Test `portalEntraColumnsDrop.integration.test.ts` (rolled-back transaction; legacy objects restored by `fixtures/portalUsersLegacyEntraColumns.ts`). It covers:
  - counts reported;
  - a removed identity is never resurrected;
  - re-apply is a no-op;
  - absent objects are not refused;
  - an insert without `browser_access` fails 23502;
  - as `breeze_app`, the counts see rows only because the file elects system scope.
- The W2/W3/W8 migration replay tests restore the columns with the same fixture inside their rolled-back transaction.
- Remove the `retiring` entries.
- Delete the preflight's integration test. The SQL file stays as history.

## Out of scope

- `portal_users.auth_method`: still the account's credential model.
- The `retiredQueues.ts` cleanup list stays after PR-B (skipped-N upgrades). Removing it later is a separate decision.
