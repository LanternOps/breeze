# Tenancy, RLS and partner-wide config — agent reference

Moved verbatim from `CLAUDE.md` (2026-10-07). CLAUDE.md keeps the short rules; this file holds the full contracts. Read it before adding a table, a column on an org-cascade table, or a config/policy table.

## Tenant Isolation / RLS
API connects to Postgres as unprivileged `breeze_app`. Every tenant-scoped table MUST have RLS enabled + forced + policies — no app-layer-only fallback. Contract test: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`.

**Six tenancy shapes:**

| # | Shape | Policy helper | Allowlist |
|---|---|---|---|
| 1 | Direct `org_id` column | `breeze_has_org_access(org_id)` | auto-discovered |
| 2 | Id-keyed (`organizations`) | `breeze_has_org_access(id)` | `ORG_ID_KEYED_TENANT_TABLES` |
| 3 | Partner-axis | `breeze_has_partner_access(partner_id)` (flat, never tree traversal) | `PARTNER_TENANT_TABLES` |
| 4 | Dual-axis (`users`) | partner OR org OR `breeze_current_user_id()`; enforced by composite FK `(org_id, partner_id) → organizations(id, partner_id)` | — |
| 5 | Device-id scoped | hot agent-write tables denormalize `org_id` (Phase 1-4); cold tables use `EXISTS` join policy (Phase 5) | `DEVICE_ID_JOIN_POLICY_TABLES` |
| 6 | User-id scoped | `breeze_current_user_id()` | `USER_ID_SCOPED_TABLES` |

**DB context helpers** (`apps/api/src/db/index.ts`): `withDbAccessContext` (request path), `withSystemDbAccessContext` (background/seeds — call `runOutsideDbContext` first if inside a request), bare pool is forbidden in request code.

**Intentionally system-scoped:** `device_commands` (agent WS path). Anything else flagged `INTENTIONAL_UNSCOPED` in a plan doc.

**Workflow for a new tenant-scoped table:**
1. Pick a shape; add policies in the same migration that creates the table — never defer.
   - **Every composite FK that references an `org_id` column (`(x, org_id) → parent(id, org_id)`) MUST be `DEFERRABLE INITIALLY IMMEDIATE`.** Org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements; a non-deferrable one aborts the merge with 23503. Enforced by `orgLifecycleFoundations.integration.test.ts` ("merge contract"), which only runs under **Integration Tests** (one of the 8 shards — which one shifted when the job went 4→8 shards, so don't assume a specific shard number) — a unit-green PR still goes red there (#4585 did).
2. Migration must be idempotent (`IF NOT EXISTS` / `DO $$`). Never edit a shipped migration.
3. Add to the relevant allowlist in `rls-coverage.integration.test.ts` in the same PR (shapes 2-6).
4. **Register the table in every cascade list that applies (see below). RLS coverage does NOT imply cascade coverage — they are separate contracts, and this step is the one that gets missed.** Adding a **column** to an already-registered table is not exempt: see the export-policy row.
5. Run the contract tests locally (needs real DB).
6. Verify as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and forge a cross-tenant insert — must fail with `new row violates row-level security policy`.

**Cascade registration (step 4) — a new `org_id` table is NOT done until it's in these:**

| If the table… | Add it to | Enforced by (CI job) |
|---|---|---|
| has an `org_id` column (**always**) | `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts` — alphabetical, `organizations` last | `tenantCascade.integration.test.ts` (**Integration Tests**) |
| has a `device_id` column | `CORE_DEVICE_CASCADE_DELETE_TABLES` in `routes/devices/core.ts` | `cascadeDelete.test.ts` (**Test API**) |
| has `device_id` **and** a denormalized `org_id` | also `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) | `moveOrg.coverage.test.ts` (**Test API**) |
| has a `ticket_id` column **and** a denormalized `org_id` (ticket-linked child table, e.g. `ticket_attachments`) | `TICKET_ORG_DENORMALIZED_TABLES` in `services/ticketOrgMoveLockOrder.ts` **and** `CUSTOM_ORG_REWRITE_TABLES` in `routes/devices/core.ts`, in the same relative order on both | `ticketOrgMoveLockOrder.test.ts` (**Test API**) checks the two lists agree with each other, not with the schema — **runtime only (no completeness test) — fails on the admin move action, not in CI** |
| has an `org_id` column (**always** — same trigger as the cascade list) | a merge policy in `services/orgMergeRegistry.ts` (`repoint` for plain rows; there is **no default**, a table without an entry is an error) | `orgMerge.test.ts` (**Test API** — the merge engine walks the cascade order and throws `no merge policy registered for '<table>'`; it reds only in the FULL unit suite, never in a touched-file run) + `orgMergeRegistry.integration.test.ts` (**Integration Tests**) |
| is append-only (REVOKE DELETE + immutability trigger) | also `AUDIT_ADMIN_REQUIRED_TABLES` in `tenantCascade.ts` | runtime `permission denied` during erasure |
| is in `CORE_ORG_CASCADE_DELETE_ORDER` — **including when you only add a COLUMN to one** | `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` | `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (**Integration Tests**) |

A table registered here must sit at the same relative position in both lists, or a concurrent ticket-move and device-move over a row they both reach (e.g. a `ticket_alert_links` row) can deadlock with 40P01 (`services/ticketOrgMoveLockOrder.ts`). If it also carries a `DEFERRABLE INITIALLY IMMEDIATE` composite `(ticket_id, org_id) → tickets(id, org_id)` FK — as only `time_entries` and `ticket_parts` do today — that constraint's name must be added to both movers' `SET CONSTRAINTS … DEFERRED` statements too, or the org-move's own `UPDATE tickets` aborts with 23503 the instant it commits. Neither gap shows up in CI: it surfaces only when an admin runs the move.

**The export-policy row is the only one that fires on a new column, not just a new table.** Every column of every org-cascade table must be classified, so `ADD COLUMN` on a long-registered table breaks it. Buckets, via `tablePolicy(orgKey, groups)`:

- `included` — ordinary customer data and tenant identifiers (`tenant_id`, `user_id`, monotonic counters).
- `reviewedIncluded` — the name matches `SUSPICIOUS_NAME_PARTS` (password, hash, token, secret, credential, refresh, …) but is reviewed non-secret.
- `excludedSensitive` — credential, private-key, or verifier material.
- `excludedOpen` — **any `json`/`jsonb`/`bytea` column.** Open containers may embed credentials or capabilities, so a jsonb column cannot go in `included` even when its contents look harmless. A scope or grant list *is* a capability list (`m365_connections.observed_grants`, `observed_delegated_scopes`).

A table with no `org_id` needs no entry. Both suites need a live database, so neither can fail in **Test API** — same blind spot as the org cascade list below.

Why this list exists: missing a cascade list is a **latent GDPR org-erasure bug** — the org delete either strands rows under a dead tenant or aborts on an FK violation. It has shipped or blocked CI five times (#1359, #1351, #1365, #2179, #2514). Code review has caught it **0/5**; the contract tests caught it **5/5**. Treat it as a mechanical grep (`grep -rn '<table>' apps/api/src/services/tenantCascade.ts`), not a judgement call.

**Check the FK direction, not just membership.** Ordering is children-before-parents. An FK declared without an explicit `ON DELETE` defaults to `NO ACTION`, so a referencing table must be deleted *first* or the cascade raises an FK violation. Alphabetical order often satisfies this by luck (`api_keys` < `service_principals`) — verify, don't assume. `tenantCascade.integration.test.ts` asserts five properties: alphabetised by `localeCompare` with `organizations` last; every `org_id` table present; no entry naming a non-existent table; every cascade table exactly once; FK children before parents.

Only the device-side lists fail in the **Test API** unit job (they read the Drizzle schema statically). The org cascade list and both export-policy suites only fail under **Integration Tests**, so a PR on a stale base can go green and then red main after merge. Worse for a **stacked** PR: `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a sibling branch runs *no* CI at all — only the two `smoke-binary-source-*` workflows, which makes `gh pr checks` read as green. Dispatch it per branch before merging: `gh workflow run CI --ref <branch>`.

For production backfills of `org_id` on hot tables (>1M rows), batch via `UPDATE ... WHERE ctid IN (... LIMIT N)` loops before `SET NOT NULL`. Full narrative and rationale: `docs/superpowers/plans/tenancy-rls/2026-04-11-rls-coverage-gaps.md`.


## Partner-Wide First (config/policy tables) — epic #2135

Breeze is an MSP tool: techs define one policy and apply it to ALL their orgs. **Every new config-ish table (policies, templates, rules, windows, baselines) defaults to dual-ownership: `org_id` XOR `partner_id`, both nullable, exactly one set.** `org_id NOT NULL` on a new config table needs an explicit justification in the PR (e.g. `backup_configs` — org-owned storage credentials). Org-first designs have required painful retrofits every time (#1724, #2126–#2129).

The playbook (copy a `2026-07-01-*-partner-ownership.sql` migration as the reference):
1. **Migration**: `partner_id` FK + `org_id` nullable + `<table>_one_owner_chk` CHECK `((org_id IS NULL) <> (partner_id IS NULL))` + partner index + ONE dual-axis RLS policy (`system OR org-access OR partner-access`), replacing any per-command org-only policies.
2. **Writes**: gate partner-wide create/update/delete on `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts` — the single source of truth). Create routes take an `ownerScope: 'organization' | 'partner'` field; update schemas derived via `.partial()` must `.omit({ ownerScope: true })`.
3. **Reads**: app-layer dual-axis conditions (`orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)`) must be gated on `auth.scope === 'partner'` — org tokens carry a partnerId but never pass `breeze_has_partner_access`; RLS is stricter than the app layer, never claim parity. An org-scoped RLS context is otherwise blind to partner-wide rows (`breeze_has_org_access(NULL)` and `breeze_has_partner_access(P)` are both false for an org token) — give the table its own read branch instead of escalating: add a `FOR SELECT`-only policy `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())` (template: `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`; helper shipped in `2026-06-13-catalog-partner-read-branch.sql`). Never append this branch to an existing `FOR ALL` policy — that would also widen UPDATE/DELETE row targeting to partner-wide rows; always a separate, additive, SELECT-only policy. `breeze_current_partner_id()` is populated on the agent-auth path too (`middleware/agentAuth.ts` sets `currentPartnerId: device.partnerId`, #4673 W02) — the branch is LOAD-BEARING there: dropping it silently stops partner-wide config (event-log, monitoring, PAM, patch-source, CIS baselines, …) from reaching agents at all, with no error. Reserve the old system-context escalation (`runOutsideDbContext(() => withSystemDbAccessContext(...))`, the heartbeat probe-config pattern, #1105) for partner-AXIS tables (`readWithPartnerAxisVisibility`, #2822) and genuine cross-org worker reads — for a plain org-XOR-partner config table it is no longer the sanctioned pattern: it double-holds a pooled connection under the request's own `withDbAccessContext` transaction (a hang at concurrency ≥ pool size) and bypasses RLS entirely (#2417 shipped a cross-tenant hole through exactly this path). `rls-coverage.integration.test.ts` asserts every `DUAL_AXIS_TENANT_TABLES` entry with an org_id-XOR-partner_id shape carries this branch, with `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` as the allowlist for tables that don't have it yet (each entry there is a filed follow-up issue, not a design choice).
4. **Config-policy linkage**: add the feature type to `PARTNER_LINKABLE_FEATURE_TYPES` and the dual-axis branch of `validateFeaturePolicyExists` (`services/configurationPolicy.ts`); remove it from the org-only `FEATURE_TABLE_MAP`.
5. **Evaluation/enforcement**: if a worker/scheduler evaluates the table against devices, partner-wide rows MUST fan out by the device org's partner (never `eq(table.orgId, device.orgId)` alone — that silently no-ops on `org_id NULL`). Worker-created child rows (results, alerts, findings) always take the DEVICE's org. One integration test must prove the fan-out fires against real Postgres.
6. **Tests + UI**: register in `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts`), add a `<table>PartnerRls.integration.test.ts` suite (cross-partner forge 42501, XOR 23514, org isolation, fan-out), create-only ownerScope selector + "All orgs" badge in the web UI (pattern: `apps/web/src/components/software/PolicyForm.tsx`).
7. **Sweep ALL `<table>.orgId` call sites repo-wide** before calling it done — hidden second routes/readers (agent config delivery, AI tools, alert bridges, stats endpoints) are how features get missed.

