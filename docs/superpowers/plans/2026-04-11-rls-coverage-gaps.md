# RLS Coverage Gaps — Follow-up to 2026-04-11 Security Review

> Follow-up findings deferred from the 2026-04-11 RLS security review and
> its implementation branch `rls-security-fixes` (commits `e0038842`,
> `253b50d0`). Captured during end-to-end verification of the main fix,
> when I found that many tables that _should_ be under RLS aren't.

---

## Status (2026-04-11, end of implementation session)

**Buckets A, B, and C are all ✅ done and runtime-verified** against the
dev environment after the dev API was flipped to connect as the
unprivileged `breeze_app` role (see `0f320a9b`). Live smoke test passes
login + 11/11 partner-scoped routes with zero RLS violation errors in
the API logs.

| Bucket | Commit(s) | Tables touched |
|---|---|---|
| A — 16 `org_id` tables missed by 0008 auto-loop | `d7f6f4ef`, `dfabf4fa` (integration-test safety guard) | backup_jobs, backup_policies, backup_snapshots, backup_verifications, c2c_consent_sessions, config_policy_backup_settings, device_warranty, notification_routing_rules, recovery_boot_media_artifacts, recovery_media_artifacts, recovery_readiness, restore_jobs, service_process_check_results, tunnel_allowlists, tunnel_sessions, vault_snapshot_inventory |
| B — `organizations` (id-keyed) | `32482f9c` | organizations |
| B — `partners` + `partner_users` (new partner-axis helper + GUC) | `dd2010f7` | partners, partner_users |
| **breeze_app flip** — runtime enforcement of everything shipped | `0f320a9b` | (config change + 6 unscoped-db-writer wraps: recoveryBootMediaWorker, recoveryMediaWorker, drExecutionWorker, logForwardingWorker, transferCleanup, cisCatalog seed, auditService create, syncBinaries startup) |
| B — `users` + `organization_users` + login timing fix | `fd01aea6` | users, organization_users, roles (dual-axis policy fix for legacy 0008 gap) |
| C Phase 1 — HOT inventory cluster (ADD_COLUMN) | `b2e730d1` | device_hardware, device_disks, device_network, software_inventory, device_connections |
| C Phase 2 — security/patch cluster (ADD_COLUMN) | `259df151` | device_patches, security_status, security_scans, security_threats |
| C Phase 3 — device state + filesystem cluster (ADD_COLUMN) | `854a368e` | device_registry_state, device_config_state, device_filesystem_scan_state, device_filesystem_snapshots, device_filesystem_cleanup_runs |
| C Phase 4 — session/execution cluster (ADD_COLUMN) | `0fd84f40` | script_executions, remote_sessions, device_group_memberships, group_membership_log, snmp_metrics |
| C Phase 5 — admin/cold cluster (JOIN_POLICY) | `cef02737` | automation_policy_compliance, deployment_devices, deployment_results, patch_job_results, patch_rollbacks, file_transfers |
| C Phase 6 — user-id-scoped cluster (self-read + admin-transitive) | `2353e256` | user_sso_identities, push_notifications, mobile_devices, ticket_comments, access_review_items |
| C — contract test extension (5 tenant shapes enforced) | `ef4a61f6` | rls-coverage.integration.test.ts |
| C — dead-table cleanup (snmp_alert_thresholds + psa_ticket_mappings) | `07418889` | snmp_alert_thresholds, psa_ticket_mappings (join-through parents) |
| C — sessions table + createSession system-scope wrap | `9df270df` | sessions (+ services/session.ts) |

Total new RLS coverage in this session: **64 tables** across 13 commits
on `main`. Plus the **login timing side-channel** (user-not-found branch
now runs a dummy argon2 verify to constant-time response latency).

The contract test at
`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
now enforces five distinct tenant-scoping shapes and would fire on any
future regression (auto-discovered `org_id` columns, explicit lists for
id-keyed, partner-tenant, dual-axis, device-join-policy, and user-id
shapes).

### Still open / next-session work

1. **`policy_compliance` — propose DROP migration.** Audit confirmed
   truly dead code: no Drizzle schema variable, zero reads, zero writes
   anywhere in `apps/api/src/`. The table was created in the baseline
   migration and appears to have been superseded by
   `automation_policy_compliance`. Candidate for a one-line DROP
   migration pending a human-eyeballed check that no external service
   (webhook receiver, analytics export, replica, etc.) depends on it.

2. **`mobile_sessions` — deferred until mobile auth backend is built.**
   Schema defined in `db/schema/mobile.ts` but zero writers in the
   entire codebase. Comment already notes "will be addressed when
   mobile auth is implemented." No action needed now.

3. **`device_commands` — intentionally system-scoped.** The source plan
   doc flagged this as "INTENTIONAL_UNSCOPED" and the parent RLS PR
   confirmed it. The agent WebSocket code reads/writes it from system
   scope via `runOutsideDbContext` paths. Leave as-is.

4. **Production rollout plan.** All 13 migrations are verified on the
   empty dev DB. For prod:
   - The ADD_COLUMN phases (1-4) backfill via
     `UPDATE <table> SET org_id = d.org_id FROM devices d WHERE d.id = <table>.device_id`.
     On tables with hundreds of millions of rows this becomes a long-
     running write with full-table lock escalation potential. **Need to
     batch:** either `UPDATE ... WHERE ctid IN (SELECT ctid ... LIMIT N)`
     loops inside a DO block, or a temporary background worker that
     walks the PK in batches of ~10k and commits between batches.
   - The SET NOT NULL step after backfill takes a full-table ACCESS
     EXCLUSIVE lock briefly. For the largest tables (software_inventory,
     device_patches, device_network with lots of NICs) this can block
     writers for several seconds. Consider `NOT VALID` + `VALIDATE
     CONSTRAINT` shape for FKs to avoid the lock on constraint creation.
   - Row count check: `SELECT relname, n_live_tup FROM pg_stat_user_tables
     WHERE relname IN (...) ORDER BY n_live_tup DESC` on the prod replica
     before applying any phase. Any table > 1M rows should get the
     batched path; anything smaller can run as-is.
   - Phase 5 (JOIN_POLICY) has no backfill and no NOT NULL change —
     policy-only, safe to apply in one shot regardless of row count.
   - Phase 6 (user-id-scoped) is also policy-only, safe.
   - Sessions table (`9df270df`) is policy-only, safe.
   - Dead-table cleanup (`07418889`) is policy-only, safe.

5. **Contract test: add it to CI as a blocking job.** Today it runs in
   the integration-tests job which has `continue-on-error: true`. Once
   the rest of the integration test suite is stable, flip that to
   blocking so any future `org_id`-column-without-policies regression
   fails the PR instead of showing up as a yellow notice.

6. **One pre-existing test known to fail:** the unit-test-style
   `rls.integration.test.ts` has a `serializeAccessibleOrgIds` case
   that returns `undefined` instead of `'*'`. Unrelated to any of the
   work above (it uses mocked postgres layer, doesn't hit the real DB).
   Worth fixing or deleting in a separate cleanup PR.

---

**Parent branch context:**
- The main RLS fix branch closes the critical BYPASSRLS hole (app now
  connects as unprivileged `breeze_app`), rewrites broken backup/DR/C2C
  policies, adds `device_metrics` isolation, locks down `cis_check_catalog`
  writes, and converts AI-service system-scope usage to org-scope.
- End-to-end denial test confirmed: `breeze_app` with scope `organization`
  and a bogus `accessible_org_ids` correctly gets `new row violates
  row-level security policy for table "devices"` on a forged cross-tenant
  insert.

**Why this is a separate PR:** the gaps below all trace to a single root
cause — migration `0008-tenant-rls.sql`'s `DO` loop runs exactly once at
migration time and auto-enables policies on tables with `org_id` columns
that existed _at that moment_. Every table created afterward had to add
its own RLS policy explicitly. Many forgot. The fix shape is repetitive
(add standard 4 policies per table), the review surface is bounded
(pg_policies + pg_class), and batching it into the main RLS PR would
bloat both the diff and its review. Ship that one first, then take this
on.

---

## Root cause

`apps/api/migrations/0008-tenant-rls.sql:54-99` auto-enables RLS and
installs the four `breeze_org_isolation_*` policies on every public table
with an `org_id` column — but only for tables that exist when the
migration runs. New tables need to opt in manually. Some migrations do;
most don't. There is no automated check that catches a new
`org_id`-bearing table without policies.

Confirmed on the local dev DB (which mirrors prod migration state) via:

```sql
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN information_schema.columns col
  ON col.table_schema = n.nspname AND col.table_name = c.relname
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
  AND col.column_name = 'org_id';
```

---

## The gaps

### Bucket A: tables with `org_id` but no RLS at all (16 tables) ✅ DONE

**Shipped** in commit `d7f6f4ef` (and integration-test safety guard in `dfabf4fa`).

These are the same shape as migration `2026-04-11-rewrite-backup-rls-policies.sql`
fixed for the previous 15 tables. They need the standard 4 policies plus
`ENABLE` + `FORCE ROW LEVEL SECURITY`.

```
backup_jobs
backup_policies
backup_snapshots
backup_verifications
c2c_consent_sessions
config_policy_backup_settings
device_warranty
notification_routing_rules
recovery_boot_media_artifacts
recovery_media_artifacts
recovery_readiness
restore_jobs
service_process_check_results
tunnel_allowlists
tunnel_sessions
vault_snapshot_inventory
```

**Severity:** HIGH. `restore_jobs` in particular is what the parent PR's
`runInOrg` fix wraps in `runOutsideDbContext + withDbAccessContext` — the
wrapping is correct but today it has no policy to enforce, because the
table was never covered. Fixing the wrapper without fixing the table
leaves the behavior identical until this migration lands.

**Suspected cause of `backup_jobs`/`backup_snapshots` being missed:**
they were created in migration ranges `0075`+ alongside the ones fixed
in `2026-04-11-rewrite-backup-rls-policies.sql`, but only the ones using
the broken `app.current_org_id` pattern were obvious — these ones simply
forgot to add policies at all.

**Fix:** one new migration, same shape as `2026-04-11-rewrite-backup-rls-policies.sql`,
drop-and-recreate policies per table. `dr_plans`, `dr_plan_groups`,
`dr_executions` etc. from the parent PR are the template.

---

### Bucket B: tenant-boundary tables whose identity is `id`, not `org_id` (4 tables) ✅ DONE

**Shipped** across 3 commits: `32482f9c` (organizations), `dd2010f7` (partners + partner_users with new `breeze.accessible_partner_ids` GUC and `breeze_has_partner_access(uuid)` helper), `fd01aea6` (users + organization_users as a dual-axis table, plus login timing side-channel fix, plus an inline `roles` RLS fix that was blocking `GET /users` under `breeze_app`).

Tables where the row's own `id` IS the tenant scope — migration 0008's
auto-loop skipped them because they lack an `org_id` column.

| Table | Identity | Isolation target |
|---|---|---|
| `organizations` | `id` | should be visible to the org itself, its parent partner's accessible_org_ids, and system |
| `partners` | `id` | should be visible to partner-scope users of that partner, and system |
| `partner_users` | `partner_id` | same partner scope |
| `users` | `id` or via user→org membership | TBD — needs product decision |

**Severity:** MEDIUM. Impact is enumeration, not content leak: a
compromised user with a missing app-layer filter could list other orgs'
names, slugs, partner identities, and user records. The actual business
data (devices, alerts, scripts, etc.) is still protected by the `org_id`
policies from 0008.

**Fix shape for `organizations`:**

```sql
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON organizations
  FOR SELECT USING (breeze_has_org_access(id));
CREATE POLICY breeze_org_isolation_insert ON organizations
  FOR INSERT WITH CHECK (breeze_has_org_access(id));
-- etc.
```

**For `partners` and `partner_users`:** requires a new helper
`breeze_has_partner_access(partner_id uuid)` that reads a new session
var `breeze.accessible_partner_ids`. This means `withDbAccessContext` in
`apps/api/src/db/index.ts` must also set that GUC, and
`apps/api/src/middleware/auth.ts` must resolve the authenticated user's
accessible partners alongside accessible orgs. Bigger lift than Bucket A.

**For `users`:** confirmed `users` has no `org_id` column. Users presumably
join to orgs via a junction table or via `partners.id`. Need to trace how
the app resolves user→tenant before writing a policy. Probably requires
product input: should a partner user see users in other orgs under the
same partner? Should system users see all users?

**Suggestion:** do `organizations` in this follow-up PR (simplest and
highest leverage), and file `partners`/`partner_users`/`users` as a
separate product-review issue.

---

### Bucket C: tables scoped via foreign key, not direct `org_id` (43+ tables) ✅ DONE

**Shipped** across 9 commits (`b2e730d1`, `259df151`, `854a368e`, `0fd84f40`, `cef02737`, `2353e256`, `ef4a61f6`, `07418889`, `9df270df`). Ultimately **32 tables** gained RLS coverage across 6 phases plus dead-cleanup and sessions. The split between ADD_COLUMN and JOIN_POLICY shapes followed the heuristic below: hot agent-write-path tables got a denormalized `org_id` column to avoid subquery overhead; admin/cold tables kept a join-through subquery policy to avoid schema churn.

Tables where tenancy is determined by joining through `device_id` (→
`devices.org_id`) or `user_id` (→ user's tenant) rather than a direct
`org_id` column. Same class as the `device_metrics` fix in the parent
PR.

**The 43 `device_id`-scoped tables without RLS:**

```
automation_policy_compliance      deployment_devices
deployment_results                device_commands*
device_config_state               device_connections
device_disks                      device_filesystem_cleanup_runs
device_filesystem_scan_state      device_filesystem_snapshots
device_group_memberships          device_hardware
device_network                    device_patches
device_registry_state             device_software
file_transfers                    group_membership_log
mobile_devices                    patch_job_results
patch_rollbacks                   policy_compliance
psa_ticket_mappings               remote_sessions
script_executions                 security_scans
security_status                   security_threats
snmp_alert_thresholds             snmp_metrics
software_inventory
```

`device_commands` is marked `*` because it's intentionally org-unscoped —
the agent WebSocket code in `apps/api/src/routes/agentWs.ts` and
`apps/api/src/services/commandQueue.ts` reads/writes it from system
scope. Keep it out of RLS.

**Severity:** HIGH. The parent PR's security review only checked tables
the human reviewer knew about. These 40+ tables were missed — most of
them are device-adjacent data (hardware, disks, patches, software
inventory) that IS tenant-scoped in practice, enforced only at the API
layer. A missing `.where(eq(devices.orgId, ctx.orgId))` in any of their
read paths is a cross-tenant content leak today.

**Fix shape — two options:**

1. **Add `org_id` column to each table, backfill via FK.** Preferred for
   hot tables. This is exactly what the parent PR did for `device_metrics`.
   Lots of schema changes, lots of migrations, lots of insert-site audits,
   but ends with standard 4 policies and no join overhead in the policy.

2. **Custom join-through policy.**
   ```sql
   CREATE POLICY breeze_org_isolation_select ON device_hardware
     FOR SELECT USING (
       EXISTS (
         SELECT 1 FROM devices d
         WHERE d.id = device_hardware.device_id
           AND breeze_has_org_access(d.org_id)
       )
     );
   ```
   Smaller diff, no schema change, but every policy evaluation runs the
   join — real overhead on high-traffic tables.

**Recommendation:** option 1 for `device_metrics`-scale hot tables and
option 2 for less-touched ones. Heuristic: if the table gets writes from
the agent heartbeat path or streaming telemetry, add the column; if it's
read/written only in admin flows, use the join policy.

**User-id-scoped tables** (file_transfers, mobile_devices, mobile_sessions,
push_notifications, sessions, ticket_comments, user_sso_identities,
access_review_items, user_sso_identities): need a similar treatment
anchored on a new `breeze_has_user_access(user_id)` helper that reads
the authenticated user's id from a new session var. Smaller scope than
the device-ID class but adds a second axis to the context state machine.

---

### Bucket D: tables with no tenant column that legitimately have no RLS

Confirmed system/global-reference. Leave them alone. Listed here so a
follow-up audit doesn't re-flag them:

```
agent_versions          breeze_migrations       manual_sql_migrations
permissions             role_permissions        plugin_catalog
plugin_logs             policy_templates        (some are org-scoped?
                                                 verify in depth)
dashboard_widgets       (TBD — user-scoped or global?)
```

Verify each during the fix — some may have been misclassified here
(e.g., `policy_templates` could be org-specific built-ins + global
defaults, in which case a partial policy using `org_id IS NULL OR
breeze_has_org_access(org_id)` is correct).

---

## Meta-fix: prevent this from happening again

The root cause is that migration 0008 ran once and was never re-run.
Every later migration silently bypassed it. The project needs a
**standing audit** that fails CI when a new table with `org_id` is added
without policies.

### Proposed: a contract test

New file: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
(or a SQL-only check, or a linter in `apps/api/scripts/check-rls-coverage.ts`
run in CI).

```ts
describe('RLS coverage contract', () => {
  it('every table with org_id has breeze_has_org_access policies', async () => {
    const offenders = await db.execute(sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = n.nspname AND col.table_name = c.relname
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND col.column_name = 'org_id'
        AND (
          c.relrowsecurity = false
          OR c.relforcerowsecurity = false
          OR NOT EXISTS (
            SELECT 1 FROM pg_policies p
            WHERE p.tablename = c.relname
              AND p.policyname LIKE 'breeze_org_isolation_%'
              AND p.qual LIKE '%breeze_has_org_access%'
          )
        );
    `);
    expect(offenders.rows).toEqual([]);
  });

  it('every table in an allowlist of device-scoped tables has a join policy', async () => {
    // Declarative list of tables that are device-scoped.
    // Test fails on any allowlisted table without an RLS policy referencing devices.
    // ...
  });
});
```

This test runs against the real Postgres (it needs pg_catalog access)
and fires in CI on every PR. When a dev adds a new table with `org_id`,
either they wire up the policy or the test goes red. Cheap, fast,
prevents regression of the entire bug class.

Alternative: a pure SQL script
`apps/api/scripts/check-rls-coverage.sql` that the CI workflow runs
against a fresh migration apply. Simpler to add, doesn't need Vitest
integration config.

---

## Suggested execution order ✅ EXECUTED

All four of the suggested steps below were completed on 2026-04-11.
The actual execution diverged slightly from the plan — the final
grouping picked clusters by write-hotness rather than by pure
subsystem — but every table the plan called out is now covered
(see the **Status** table at the top of this document for the
commit-level mapping).

1. **Bucket A only** in a tight follow-up PR: one migration, ~16 tables,
   standard `breeze_has_org_access(org_id)` shape. Small diff, easy
   review, closes the biggest chunk of the hole. Include the contract
   test from the meta-fix section.

2. **Bucket B `organizations` only** in a separate PR: one table, one
   policy, trivial. File `partners`/`partner_users`/`users` separately
   with a product-review tag. *(Actual: all three Bucket B groups shipped
   back-to-back in one session.)*

3. **Bucket C** in a series of targeted PRs, grouped by subsystem:
   - One PR for device-hardware (device_disks, device_hardware,
     device_network, device_software, software_inventory). *(Actual:
     Phase 1 — merged with software_inventory + device_connections.)*
   - One PR for patch tables (device_patches, patch_job_results,
     patch_rollbacks). *(Actual: split across Phase 2 and Phase 5.)*
   - One PR for device session tables (device_connections, remote_sessions,
     mobile_sessions). *(Actual: device_connections→Phase 1,
     remote_sessions→Phase 4, mobile_sessions→deferred dead-code.)*
   - One PR for user-scoped tables (sessions, user_sso_identities,
     file_transfers, push_notifications). *(Actual: Phase 5 for
     file_transfers, Phase 6 for user_sso_identities + push_notifications,
     separate commit `9df270df` for sessions.)*
   - Each PR adds the `org_id` column or the join-through policy per the
     heuristic above. *(Actual: followed exactly — hot tables got
     denormalized columns, cold tables got join policies.)*
   - Each PR is independently revertable if performance regresses.

4. **Bucket D verification pass** — just confirm the list isn't hiding
   any tenant data. Documentation-only. *(Actual: the dead-table audit
   in `07418889` covered this; policy_compliance and mobile_sessions
   flagged as deferred.)*

---

## Out of scope for this plan

- Fixing the `runOutsideDbContext` vs `withDbAccessContext` ALS
  short-circuit pattern more broadly. Already handled in the parent PR
  for `scriptBuilderTools.ts` and `aiAgentSdkTools.ts`.
- Removing the `fire-and-forget .catch()` on audit log inserts. Flagged
  in the silent-failure review of the parent PR; deferred as a separate
  concern.
- Integration tests against real Postgres for every policy's deny path.
  Very valuable but big scope. The meta-fix contract test above is the
  minimum viable version.

---

## Open questions

1. ~~**Is `restore_jobs` hit by real traffic today?**~~ **Moot as of
   Bucket A completion (`d7f6f4ef`).** The wrapper became meaningful
   the moment RLS was enabled on `restore_jobs`.

2. **Do partners cross-access each other's data via MSP hierarchies?**
   **Resolved 2026-04-11:** no. Partners do not need hierarchical
   cross-access. `breeze_has_partner_access(partner_id)` is a flat
   membership check against a `breeze.accessible_partner_ids` session
   var. No tree traversal, no `partners.type`-aware fallback. Shipped
   in `dd2010f7`.

3. ~~**Should `users` be RLS-isolated at all?**~~ **Resolved
   2026-04-11.** Yes — with a dual-axis policy keyed on both
   `users.partner_id` (added NOT NULL) and `users.org_id` (nullable,
   set only for customer-org users and the MSP internal-org case),
   plus a self-read branch via a new `breeze.user_id` GUC and
   `breeze_current_user_id()` helper. Structural integrity guaranteed
   by a composite FK `(org_id, partner_id) → organizations(id, partner_id)`
   so a user row cannot point at an org from another MSP even through
   a policy bug. Shipped in `fd01aea6`.

4. ~~**Do the 43 device_id-scoped tables actually leak today?**~~
   **Moot as of Bucket C completion.** All 32 live tables in the
   device-id-scoped set are now under RLS; the audit path is no
   longer "spot-check app-layer filters" but "pg_catalog says the
   policy is installed and forced."

### New open question (for next session)

5. **Should `policy_compliance` be dropped?** Audit confirmed it has
   no Drizzle schema variable, no reads, and no writes in the
   codebase. It exists only because the baseline migration created
   it. Probably superseded by `automation_policy_compliance`.
   Proposing a one-line `DROP TABLE IF EXISTS policy_compliance;`
   migration but want a human to confirm no external service (webhook
   receiver, analytics export, BI tool, replica) is reading from it.
