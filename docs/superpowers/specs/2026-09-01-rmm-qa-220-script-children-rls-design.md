# RMM-QA-220 Script Children RLS Design

**Finding:** RMM-QA-220 (S1, Core/Scripts/Database tenant isolation). `script_versions` and `script_to_tags` are tenant child tables without `org_id` that ship with RLS disabled and unforced while `breeze_app` holds blanket SELECT/INSERT/UPDATE/DELETE. `script_versions` carries customer script content and history; `script_to_tags` can pair a script with a tag across tenants. Neither table is in any allowlist of `rls-coverage.integration.test.ts`, so the contract suite is green while the CLAUDE.md invariant "every tenant-scoped table MUST have RLS enabled + forced + policies — no app-layer-only fallback" is violated.

**Goal:** Land forced parent-join RLS on both tables that mirrors the reviewed `scripts`/`script_tags` policy semantics exactly (system-script global read, partner-wide own-partner read branch, org-or-partner writes, no `is_system` in any write predicate); make the RLS coverage catalog exhaustive over every public base table so this class cannot recur silently; tighten the policy-shape assertions to command-specific USING/WITH CHECK with the helper applied to the right argument; and prove the enforcement behaviourally as `breeze_app` for Org A/B and Partner A/B. Every behaviour change is RED-first; every new control is proven to discriminate by mutation.

**Branch / worktree:** `fix/rmm-qa-220-script-children-rls` at `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-220`. Originally created from `origin/main` at `0fb5af40d`; **main moved by six commits during design** (`7ca3b8331` … `1b733cedb`) and the branch — which carried no commits of its own — was fast-forwarded to `1b733cedb` on 2026-09-01. Never push to `main`, never merge.

**Method note:** every claim below is labelled *verified* (read in the worktree at `1b733cedb` or executed against the local test database), *inferred*, or *not-checked*. The local database `breeze-postgres-test` (port 5433, `breeze_test/breeze_test`) is migrated through `2026-09-20-sso-verified-domains-dual-axis.sql` (`SELECT max(filename) FROM breeze_migrations`) — ten migrations behind the worktree's ceiling `2026-09-29-detach-ticket-runs-on-device-org-move.sql` — so every database-derived fact carries that caveat and must be re-established on a fresh migrated database during implementation.

## Non-goals and boundaries

- No change to `apps/api/src/db/ensureAppRole.ts`. The blanket grant (`:85,:87`, *verified*) is the platform-wide model for every table; RLS is the defense, not privilege withdrawal. Withdrawing DML from `breeze_app` on two tables would create a third tenancy mechanism no contract test understands.
- No edit to any shipped migration. `0001-baseline.sql` (tables at `:5200` and `:5210`, FKs at `:14304-14316`, *verified*) stays byte-identical.
- No app-layer changes in `services/scriptBundle/index.ts`, `services/aiToolsScripts.ts` or `routes/scripts.ts`; the existing callers already authorise the parent and must keep working unchanged under the new policies. If a caller breaks, the policy is wrong, not the caller.
- No new versions endpoint (web `ScriptVersionHistory.tsx:83-84` notes none exists — per the brief, *not re-checked*); out of scope.
- No cascade-list registration: neither table has `org_id` or `device_id`, so no `tenantCascade.ts` / `routes/devices/core.ts` / export-policy row applies (CLAUDE.md:74 "A table with no `org_id` needs no entry"; *verified* `tenantCascade.ts` names only `script_categories`, `script_execution_batches`, `script_executions`, `script_tags`, `scripts` at `:350-354`; `orgMergeRegistry.ts:609-613` likewise — children follow their parents by id).
- No change to the parent tables `scripts` / `script_tags` (no composite ownership FK, no `is_system ⇒ NULL axes` CHECK). The advisor quorum raised both as real parent-level gaps (§9); they are pre-existing, touch shipped parent schema and existing data, and are handed back as candidate findings, not folded under this S1.
- No change to the `NO ACTION` FKs or to org/partner erasure. The quorum confirmed a latent erasure `23503` (§9, §8.3); it is RLS-independent and unchanged by this work.
- The other tables the exhaustive classification test surfaces (D5) are NOT fixed here. They go into a shrink-only debt list and back to QA as candidate findings, never blessed as reviewed.
- The QA probe `docs/qa/probes/core-tenant-isolation-release-contract.test.ts` (breeze-rmm-qa repo) is not edited. Its RMM-QA-220 block at `:151-166` pins the PRE-fix state (`between(rlsCoverage, "const PARENT_FK_JOIN_POLICY_TABLES", "const USER_ID_SCOPED_TABLES")` must NOT contain the two names) and the next block at `:168-177` pins the org-axis test's helper-name-anywhere shape (*verified*). Both are expected to flip once this branch lands; the QA side owns the re-characterisation.

## 1. Verified facts (current main, worktree at 1b733cedb)

The brief's line references were re-read after the fast-forward. The six new commits touch `apps/web`, billing/quote services, `policyEvaluationService`, `automations` schema and one new migration `2026-09-29-100000-automation-policy-compliance-unique.sql` — none touches the two script children, `rls-coverage.integration.test.ts`, `scriptBundle`, or the parent policies (*verified* `git diff --name-only 0fb5af40d 1b733cedb`). The migration ceiling is unchanged: `2026-09-29-100000-…` sorts before `2026-09-29-detach-…` (`'1' < 'd'`).

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | Both tables exist only in `0001-baseline.sql`: `script_to_tags(script_id, tag_id)` `:5200-5203`; `script_versions(id, script_id, version, content, changelog, created_by, created_at)` `:5210-5218`; FKs `script_to_tags.script_id → scripts(id)` `:14303-14308` (constraint at `:14305`) and `.tag_id → script_tags(id)` `:14314-14319` (constraint at `:14316`), both default `NO ACTION`. No later migration names either table (`git grep -l -E 'script_versions|script_to_tags' origin/main -- apps/api/migrations` → only `0001-baseline.sql`). No `ENABLE`/`FORCE ROW LEVEL SECURITY`, no `CREATE POLICY`. | *verified*. |
| F2 | `breeze_app` receives `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public` plus matching `ALTER DEFAULT PRIVILEGES` (`ensureAppRole.ts:85,87`). | *verified*. |
| F3 | On the local DB both tables report `relrowsecurity=false, relforcerowsecurity=false` — the exact QA catalog proof (`docs/qa/evidence/2026-08-23-core-tenant-isolation.md:31-35`). | *verified* (2026-09-20 DB). |
| F4 | Parent `scripts` policies (`2026-06-13-catalog-partner-axis-rls.sql:55-77`, SELECT re-created by `2026-06-13-catalog-partner-read-branch.sql:69-76`): SELECT `USING (breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id) OR is_system OR (org_id IS NULL AND partner_id = breeze_current_partner_id()))`; INSERT `WITH CHECK (org OR partner)`; UPDATE `USING (org OR partner) WITH CHECK (org OR partner)`; DELETE `USING (org OR partner)`. The comment at `:62-68` forbids `is_system` in any write predicate (Discussion #633). | *verified*. |
| F5 | Parent `script_tags`: dual-axis per-command policies with the same write predicate; SELECT gained the read-only own-partner branch at `catalog-partner-read-branch.sql:97-104` (no system flag). Both parents are registered as `PARTNER_TENANT_TABLES` entries (`rls-coverage:210,212`). | *verified*. |
| F6 | Helper semantics: `breeze_has_org_access(uuid)` (`0008-tenant-rls.sql:42-52`) and `breeze_has_partner_access(uuid)` (`2026-04-11-partners-rls.sql:58-68`) both return TRUE under system scope, FALSE for NULL, else membership in the accessible-ids GUC arrays; `breeze_current_partner_id()` (`catalog-partner-read-branch.sql:36-60`) reads `breeze.current_partner_id`. Under `withSystemDbAccessContext` every write predicate is therefore TRUE. | *verified*. |
| F7 | A nested `EXISTS (SELECT 1 FROM scripts s …)` inside a child policy runs as `breeze_app`, so the parent's own SELECT policy applies to the subquery. Child visibility can never exceed parent visibility, whatever the child predicate says. | *inferred* from Postgres semantics; the D7 forge tests observe the combined effect. |
| F8 | Canonical child shape: `2026-05-30-fk-child-tables-rls.sql:1-60` — `DROP POLICY IF EXISTS` ×4, `ENABLE` + `FORCE`, four per-command policies named `breeze_org_isolation_{select,insert,update,delete}`, predicate `EXISTS (SELECT 1 FROM <parent> a WHERE a.id = <child>.<fk> AND breeze_has_org_access(a.org_id))`; file header states "no inner BEGIN/COMMIT". | *verified*. |
| F9 | Shipped precedent for a nested EXISTS with a system carve-out in SELECT: `role_permissions` (`2026-06-13-b-fk-child-rls-backstop.sql:120-127`) ORs `breeze_has_partner_access(r.partner_id)`, `breeze_has_org_access(r.org_id)` and an `r.is_system` branch; read with a bound `roleId` in `services/permissions.ts` (quorum-cited, *not re-checked*). | *verified* (policy), *inferred* (caller). |
| F10 | The bound-parameter caveat (`rls-coverage:588-591`; `2026-05-31-script-execution-batches-org-id.sql:4-17`) concerns an **INSERT** `WITH CHECK` containing `s.is_system` for a tenant creating a batch on a system script. | *verified*. |
| F11 | Every non-test reader/writer of the two tables (`grep -rn -E 'scriptVersions|script_versions|scriptToTags|script_to_tags' src --include='*.ts'` minus `__tests__`, `*.test.ts`, `schema/`): `aiToolsScripts.ts:728-740` SELECT versions by `scriptId` after the parent was authorised; `scriptBundle/index.ts:367-372` SELECT links for readable scripts; `:617-626` SELECT+INSERT links (`linkTags`); `:767-775` INSERT version (`new-version` mode, `createdBy: auth.user.id`) immediately followed by the parent UPDATE at `:776-791`. `routes/scripts.ts` has no version/tag DML. | *verified*. |
| F12 | The bundle importer can never write a child of a system script: `findConflictByName` (`scriptBundle/index.ts:469-494`) matches only the target scope or the caller's own partner-wide rows (a system script has `org_id IS NULL AND partner_id IS NULL` and matches neither); an org-scope import of a partner-wide conflict in `new-version` mode is refused at `:751-764` ("read-only for an organization import"); new parents are clamped non-system (`scriptWrite.ts`, `isSystem` clamp; `scriptBundle/index.ts:14-16`). So no request path INSERTs a `script_versions` row whose parent is `is_system`. | *verified*. |
| F13 | Existing catalog: `EXEMPT_TABLES` `:48-62`, `INTENTIONAL_UNSCOPED` `:78-109`, `ORG_AXIS_POLICY_EXCLUDED_TABLES` `:115`, `ORG_ID_KEYED_TENANT_TABLES` `:170`, `PARTNER_TENANT_TABLES` `:177`, `DUAL_AXIS_TENANT_TABLES` `:306`, `DEVICE_ID_JOIN_POLICY_TABLES` `:562`, `PARENT_FK_JOIN_POLICY_TABLES` `:584-647` (30 entries), `USER_ID_SCOPED_TABLES` `:649`. Neither script child appears anywhere. | *verified*. |
| F14 | Force test `:893-948` unions `org_id`-column tables with the explicit lists; parent-FK assertion `:1295-1358` accepts helper-name anywhere in `qual OR with_check` plus `LIKE '%FROM <parent>%'` with parents OR'd; org-axis assertion `:1057-1121` is the same helper-name-anywhere shape. Every `relkind='r'` query in the file is per-shape (`:911,919,1068,1079,1137,1193,1247,1316,1368,3841,3895`); nothing enumerates all public relations. | *verified*. |
| F15 | Behavioural forge precedent: `describe('scripts RLS — partner-wide cross-partner forge enforcement (dual-axis)')` `:3005-3168` — self-contained fixtures via `withSystemDbAccessContext`, `partnerContext(partnerId)` and `orgContext(orgId, ownPartnerId)` helpers (`:3044-3059`), `afterAll` cleanup by id, violations matched by `new row violates row-level security policy for table "scripts"`. | *verified*. |
| F16 | Simulating the D6 command-specific algorithm (`scratchpad/shape_check.py` over `pg_policies` exported to `parentfk-policies.tsv`) against all 30 current `PARENT_FK_JOIN_POLICY_TABLES` entries: 30/30 OK, including dual-axis-parent children (`automation_runs`, `role_permissions`, `config_policy_*`, `psa_ticket_mappings`, `ticket_form_org_links`). Deparsed predicates can contain newlines — normalise whitespace first. | *verified* (2026-09-20 DB); **re-run on a fresh DB** before committing D6. |
| F17 | Simulating the same per-command rule on org-axis tables (`org_id` column, helper `breeze_has_org_access([alias.]org_id)` in the command-appropriate predicate; SQL in §5): 285 tables, 16 fail on all four commands — 15 of them are `ORG_AXIS_POLICY_EXCLUDED_TABLES` members (partner-axis / user-axis tables that merely carry `org_id`) and the 16th, `m365_consent_sessions`, is `EXEMPT_TABLES`. Zero offenders among the tables the org-axis test actually asserts on. | *verified* (2026-09-20 DB); **re-run on a fresh DB**. |
| F18 | Public base tables with RLS off or unforced on the local DB (`relkind IN ('r','p') AND NOT relispartition`): `agent_versions, breeze_migrations, cis_check_catalog, device_commands, device_software, intent_outbox, llm_provider_catalog, llm_provider_catalog_revisions, llm_provider_verifications, mobile_sessions, patches, permissions, plugin_catalog, script_templates, script_to_tags, script_versions, software_compliance_status, third_party_package_catalog, third_party_release_tests` (19). Seven are `INTENTIONAL_UNSCOPED`; twelve are in no list. `metric_rollups` is the only `relkind='p'`; its six table partitions are all forced (the 18 other `relispartition` rows are index partitions). | *verified* (2026-09-20 DB); post-09-20 tables are *not-checked*. |
| F19 | Migration conventions: `localeCompare` order; a new file must sort strictly after the committed max (`scripts/check-migration-naming.sh:29-48`, `--staged`); preferred `YYYY-MM-DD-HHMMSS-<slug>.sql` (`migrations/README.md:140-146`); no inner `BEGIN;`/`COMMIT;` (`README.md:54-56`, CLAUDE.md). The verifier's note that "some recent migrations wrap in BEGIN/COMMIT" is **refuted**: `grep -l '^BEGIN;' apps/api/migrations/2026-09-*.sql` returns nothing. | *verified*. |
| F20 | Runners: unit `vitest.config.ts:15-16` includes `src/**/*.test.ts` and excludes `src/__tests__/integration/**`; integration `vitest.integration.config.ts:11-12` includes `src/__tests__/integration/**/*.test.ts`; `vitest.config.rls-coverage.ts:18` includes only `rls-coverage.integration.test.ts`; CI runs it on shard 1 with `DATABASE_URL_APP` and `DB_CONTEXTLESS_WRITE_STRICT=true` (`ci.yml:1997-2020`). `setup.ts` TRUNCATE CASCADE list includes `scripts` (`:236`). | *verified*. |
| F21 | `scripts` are soft-deleted (`schema/scripts.ts:50`); erasure runs under system scope (`tenantCascade.ts`); FK RI checks bypass RLS. FORCE RLS on the children therefore changes nothing about erasure/merge/move. | *verified* (RLS consequence); erasure's pre-existing FK gap is §8.3. |
| F22 | Drizzle carries no `pgPolicy` for any table (`grep -rl pgPolicy src/db/schema` → none) and `check-drift.ts` does not inspect policies (quorum-cited), so `db:check-drift` is unaffected. | *verified* (grep), *inferred* (check-drift). |

## 2. Decisions

### D1 — One new idempotent migration, canonical child shape, no `BEGIN/COMMIT`

File: `apps/api/migrations/2026-10-01-100000-script-children-rls.sql`. Re-verify the ceiling at commit time with `bash scripts/check-migration-naming.sh --staged` (pre-commit hook); if main has grown past `2026-09-30-100000-*`, pick the next `HHMMSS` that sorts strictly after the new max — never rename after commit. Content per table: `DROP POLICY IF EXISTS` ×4, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `ALTER TABLE … FORCE ROW LEVEL SECURITY`, four per-command `CREATE POLICY` named `breeze_org_isolation_{select,insert,update,delete}` (F8 convention). `DROP IF EXISTS` + `CREATE` converges, so no `DO $$` guard; no data cleanup, so no row-count `RAISE WARNING` obligation. Header comment states: threat (RMM-QA-220), shape, why `is_system` never appears in a write predicate (pointer to `catalog-partner-axis-rls.sql:62-68`, #633), the D3 tag-visibility asymmetry, the F10/F12 bound-parameter note, and F7 (nested EXISTS is additionally filtered by the parents' own policies).

Cost if wrong: a mis-sorted filename replays before its parents on a fresh DB — caught by the pre-commit hook and `autoMigrate.test.ts`.

### D2 — `script_versions`: SELECT mirrors the parent's full read predicate; writes mirror the parent's write predicate

```sql
-- R(s): identical to scripts.breeze_dual_axis_select
EXISTS (SELECT 1 FROM scripts s
        WHERE s.id = script_versions.script_id
          AND (public.breeze_has_org_access(s.org_id)
               OR public.breeze_has_partner_access(s.partner_id)
               OR s.is_system
               OR (s.org_id IS NULL AND s.partner_id = public.breeze_current_partner_id())))
-- W(s): identical to scripts.breeze_dual_axis_insert/update/delete
EXISTS (SELECT 1 FROM scripts s
        WHERE s.id = script_versions.script_id
          AND (public.breeze_has_org_access(s.org_id)
               OR public.breeze_has_partner_access(s.partner_id)))
```

SELECT `USING R(s)`; INSERT `WITH CHECK W(s)`; UPDATE `USING W(s) WITH CHECK W(s)`; DELETE `USING W(s)`.

- **Open decision 1 (an `is_system` branch on INSERT) is rejected outright**, as the verifier requires: `catalog-partner-axis-rls.sql:62-68` forbids `is_system` in any write predicate, and F12 shows no code path writes `script_versions` for a system script, so the batches precedent (F10) has no INSERT to protect. System seeding runs under system scope where `W(s)` is already TRUE (F6).
- **`OR s.is_system` stays in SELECT** (verifier concern 2, decided): it mirrors the parent's global-read rule and today governs zero rows (F12). Dropping it would make `aiToolsScripts.ts` `includeVersionHistory` silently return `[]` for a system script whose parent is readable — a divergence that fails invisibly. If a future feature versions system scripts, the product rule that makes the current content world-readable governs its history. Cost if wrong: a later system-script revision containing removed material is readable by every tenant — the same exposure class as the parent row, reversible with a one-line policy change.
- **Bound-parameter concern (F10) refuted for this design**: the write predicates contain no `is_system` branch; the only `is_system` is in a SELECT predicate whose nested-EXISTS shape is in production on `role_permissions` (F9). The D7 suite runs through Drizzle's extended protocol (bound parameters) and test 13 SELECTs a system script's version by bound `script_id`, so the suite is itself the proof. The quorum concurred (§9).
- The predicates are spelled out rather than reduced to `EXISTS (SELECT 1 FROM scripts s WHERE s.id = script_id)` (which F7 would make equivalent today) so that the structural checks (D6) can read them and so that a future loosening of the parent's SELECT policy does not silently widen the child.

### D3 — `script_to_tags`: read requires both parents visible; INSERT requires script WRITE and tag READ; UPDATE/DELETE require script WRITE only

```sql
-- T_read(t): identical to script_tags.breeze_dual_axis_select
EXISTS (SELECT 1 FROM script_tags t
        WHERE t.id = script_to_tags.tag_id
          AND (public.breeze_has_org_access(t.org_id)
               OR public.breeze_has_partner_access(t.partner_id)
               OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())))
```

SELECT `USING (R(s) AND T_read(t))`; INSERT `WITH CHECK (W(s) AND T_read(t))`; UPDATE `USING W(s) WITH CHECK (W(s) AND T_read(t))`; DELETE `USING W(s)` — with `R(s)`/`W(s)` re-targeted at `script_to_tags.script_id`.

- Cross-tenant pairing is impossible by construction: inserting `(script, tag)` requires writing the script AND seeing the tag. An org user sees only its own org's tags and its partner's partner-wide tags (F5), so `(own script, other org's tag)` and `(other org's script, own tag)` both fail `WITH CHECK`; cross-partner pairing fails on both legs.
- **Open decision 2 (strict org equality vs. mirroring) resolved as mirror, not tighten**, per the verifier: a partner-scope technician whose `accessibleOrgIds` covers orgs A and B may link A's script to B's tag exactly as the parents permit today; org-scope users cannot. Strict `s.org_id = t.org_id` would break the partner-wide-first model (partner-wide tags exist to be applied across an MSP's orgs) and would forbid `(org script, partner-wide tag)` — the one cross-scope pairing the product advertises. Cost if wrong: same-partner cross-org pairing by partner technicians, which the parents already allow.
- **Verifier concern 3 satisfied**: unlink authority (DELETE / UPDATE `USING`) derives from the script's write predicate only; a user who can merely read a partner-wide tag cannot unlink it from another org's script because `W(s)` fails there. UPDATE `WITH CHECK` re-applies the INSERT predicate so an UPDATE cannot re-point `tag_id` at an invisible tag (the quorum flagged exactly this hole in a weaker variant and confirmed this form closes it — §9).
- INSERT gates on tag **READ**, not tag WRITE, deliberately: an org user attaching its own script to its MSP's partner-wide tag is the partner-wide-first use case; requiring tag WRITE would forbid it while the parent SELECT policy advertises the tag as usable. Precedent: `2026-09-25-a-automation-resource-bindings.sql:397-409` lets org-owned bindings reference system or same-partner shared scripts (*verified*). Cost if wrong: an org user can reference (not modify) a partner-wide tag it can already see.

### D4 — Catalog registration is the RED for the existing contract

Add to `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage:584`), replacing nothing:

```ts
  // RMM-QA-220: script_versions (script content history) and script_to_tags
  // (script↔tag join) shipped in the baseline with NO rls and reach their
  // tenant only through scripts (dual-axis, nullable org_id, is_system) and
  // script_tags (dual-axis). See 2026-10-01-100000-script-children-rls.sql.
  ['script_versions', ['scripts']],
  ['script_to_tags', ['scripts', 'script_tags']],
```

On main this alone turns two existing tests red: the force test (`:893`) reports both names with `force_rls_on=false`, and the parent-FK assertion (`:1295`) reports `rls_on=false, missing_cmds=[SELECT,INSERT,UPDATE,DELETE]`. That failure output is the retained RED for the migration. The existing looser assertion is kept as-is; D6 adds the command-specific ones beside it rather than replacing it, so a future loosening of either is a visible diff.

### D5 — Exhaustive classification of every public base table, with an explicit shrink-only debt bucket

New test in the `RLS coverage contract` describe: `every public base table is classified by exactly one tenancy bucket`. Enumerate `pg_class` rows in `public` with `relkind IN ('r','p') AND NOT relispartition` (verifier concern 4: `metric_rollups` partitions are created at runtime by `breeze_ensure_metric_rollup_partition` and would make the test non-deterministic; the partitioned parent is classified once via its `org_id` column — F18). A table is *classified* when it satisfies at least one of:

1. has an `org_id` column (shape 1 auto-discovery — the same predicate the org-axis test uses at `:1060-1068`), or
2. is a key of `ORG_ID_KEYED_TENANT_TABLES`, `PARTNER_TENANT_TABLES`, `DUAL_AXIS_TENANT_TABLES`, `DEVICE_ID_JOIN_POLICY_TABLES`, `PARENT_FK_JOIN_POLICY_TABLES`, `USER_ID_SCOPED_TABLES`, `INTENTIONAL_UNSCOPED` or `EXEMPT_TABLES`, or
3. is in the new `PLATFORM_INFRASTRUCTURE_TABLES` — exactly `breeze_migrations` (the runner's bookkeeping; no tenant data; documented in-line), or
4. is in the new `UNREVIEWED_RLS_CLASSIFICATION_DEBT` — tables that have neither RLS nor a tenancy classification and were NOT reviewed by RMM-QA-220.

"Exactly one" is enforced where it is meaningful: buckets 3 and 4 must be disjoint from every other bucket and from each other, and every name in buckets 3 and 4 must exist in the database (a stale entry fails the test — shrink-only ratchet). Overlaps among the pre-existing shape lists (e.g. `EXEMPT_TABLES ⊂ INTENTIONAL_UNSCOPED`, dual-axis tables that also carry `org_id`) are pre-existing and not re-litigated. The failure message lists unclassified names and points at the shape table in CLAUDE.md.

Expected RED on main (F18): `agent_versions, breeze_migrations, cis_check_catalog, device_software, mobile_sessions, patches, permissions, plugin_catalog, script_templates, script_to_tags, script_versions, software_compliance_status`. The authoritative list is whatever a fresh migrated DB reports at implementation time (captured verbatim in the commit message). After the fix: the two script children leave via D4; `breeze_migrations` goes to bucket 3; the rest go to bucket 4 with a one-line description per name (`device_software` — `device_id`-keyed, no RLS, candidate shape-5; `mobile_sessions` — `user_id`/refresh-token rows, candidate shape-6; `software_compliance_status` — `device_id`+`policy_id`, candidate shape-5; `agent_versions`, `cis_check_catalog`, `patches`, `permissions`, `plugin_catalog`, `script_templates` — global reference data, candidates for `INTENTIONAL_UNSCOPED` after review). The bucket's doc comment states that inclusion is a tracking fact, not a security review, and that entries may only be removed by moving the table into a real bucket.

Why not fix them here: the exit contract is the two script children; each other name is a separate blast-radius decision (three look like genuine tenant tables) and folding them in would either delay this S1 or ship unreviewed policies under its cover. Cost if wrong: the debt list reads as a blessing — mitigated by its name, its comment, and the QA hand-off in §8.

### D6 — Command-specific USING/WITH CHECK shape checks: parent-FK tables (with both-parent overlay) and org-axis tables, rolled out at once

Two new tests beside `:1295` and `:1057`, sharing one pure module `apps/api/src/db/rlsPolicyShape.ts` (under `src/db/`, not `src/__tests__/integration/`, because the unit runner excludes that directory wholesale while the integration runner includes every `*.test.ts` there — F20; a unit test for a pure function must live where the **Test API** job sees it and the real-DB setup does not):

```ts
export type PolicyRow = { policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null };
export type Cmd = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export type ParentRule =
  | { kind: 'any-of'; parents: readonly string[] }                       // default: helper on ANY declared parent alias
  | { kind: 'all-of'; parents: readonly string[] };                      // overlay: helper on EVERY listed parent alias
/** Parent-FK: true when `pred` satisfies `rule` — for each required parent, a
 *  `FROM <parent> [AS] [alias]` join plus breeze_has_org_access(<alias>.org_id)
 *  or breeze_has_partner_access(<alias>.partner_id). */
export function predicateCoversParents(pred: string | null, rule: ParentRule): boolean;
/** Org-axis: true when `pred` calls breeze_has_org_access([<table>.]org_id)
 *  (or breeze_has_org_access(id) when `idKeyed`). */
export function predicateCoversOrgAxis(pred: string | null, table: string, idKeyed: boolean): boolean;
/** Commands covered by `policies` under a per-predicate matcher: SELECT/DELETE from
 *  qual, INSERT from with_check, UPDATE only when BOTH qual and with_check match;
 *  cmd='ALL' expands; only PERMISSIVE rows count. */
export function coveredCommands(policies: readonly PolicyRow[], matches: (pred: string | null, cmd: Cmd, slot: 'qual' | 'with_check') => boolean): Set<Cmd>;
```

Rules: normalise whitespace (`/\s+/g → ' '`) before matching (F16); alias regex `\bFROM\s+<parent>(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?` with the bare parent name as fallback alias; helper regex `breeze_has_(?:org|partner)_access\(<alias>\.(?:org_id|partner_id)\)`; a helper on the child's own column or on a non-parent alias does not count. Accepting either helper on the parent alias is what makes dual-axis parents fit (verifier concern 5, first half).

**D6a — parent-FK test** iterates `PARENT_FK_JOIN_POLICY_TABLES` with the `any-of` rule (automation_runs legitimately ORs two alternative parents), overlaid by a new `PARENT_FK_REQUIRED_PARENTS_PER_COMMAND` map for tables whose semantics need more than one parent — initially exactly `script_to_tags`: `SELECT` and `INSERT` `all-of ['scripts','script_tags']`; `UPDATE` `qual` `any-of ['scripts']`, `with_check` `all-of ['scripts','script_tags']`; `DELETE` `any-of ['scripts']`. This answers the quorum's "the assertion accepts any one listed parent, so `script_to_tags` could pass without validating `script_tags`" (§9).

**D6b — org-axis test** iterates the same `org_id_tables ∪ id_keyed_tables` set as `:1057` (minus `ORG_AXIS_POLICY_EXCLUDED_TABLES`, minus `EXEMPT_TABLES`) and requires `breeze_has_org_access([<table>.]org_id)` — or `(id)` for `ORG_ID_KEYED_TENANT_TABLES` — in the command-appropriate slot. This closes the blind spot the QA probe pins at `:168-177` (helper name in either predicate; no UPDATE `qual`+`with_check` pairing).

**Open decision 3 resolved: all tables at once**, because F16 (30/30) and F17 (0 offenders among asserted org-axis tables) show every existing entry already passes on the 2026-09-20 DB — the verifier's red-main concern is refuted with evidence rather than deferred. Guard: the plan re-runs both simulations on a fresh DB before committing D6; if a post-09-20 migration reshaped a policy so that it fails, implementation stops and triages that table (fix the policy, or record it in a named `RLS_SHAPE_TRIAGE` exception list with the owning migration) — the assertion is never loosened back to helper-name-anywhere. Cost if wrong: one extra triage step; never a weaker check.

RED-first for this control does not come from the DB (on main the two new entries fail only because they have no policies, which D4 already proves). The discriminating proof is a unit test `apps/api/src/db/rlsPolicyShape.test.ts` (unit runner, no DB) written before the module, with fixtures: helper on parent alias in `qual` → SELECT/DELETE covered; helper only in `with_check` → SELECT NOT covered (the exact blind spot QA named); INSERT with helper only in `qual` → NOT covered; UPDATE with `qual` only → NOT covered; `FROM parent p … breeze_has_org_access(other.org_id)` → NOT covered; helper on the child's own `org_id` → NOT covered; `all-of` with one parent missing → NOT covered; `cmd='ALL'` expands to four; predicate with embedded newlines → covered; RESTRICTIVE policy ignored; org-axis `breeze_has_org_access(id)` accepted only when `idKeyed`. Each assertion is mutated once during implementation (e.g. drop the whitespace normalisation; swap `with_check` for `qual` in the INSERT branch; make `all-of` behave as `any-of`) to watch it fail, then reverted.

### D7 — Behavioural forge suite as `breeze_app`: Org A/B and Partner A/B on both tables

New `describe('script_versions / script_to_tags RLS — parent-join forge enforcement (Org A/B, Partner A/B)')` in `rls-coverage.integration.test.ts`, modelled on F15 (self-contained, no `setup.ts`, fixtures under `withSystemDbAccessContext`, `afterAll` deletes children → scripts → tags → orgs → partners by id).

Fixtures: partners A, B; orgs A1 ∈ A, B1 ∈ B; scripts `sA1` (org A1, partner A), `sB1` (org B1, partner B), `sPA` (partner-wide: org NULL, partner A), `sSys` (`is_system`, org NULL, partner NULL); tags `tA1` (org A1, partner A), `tB1` (org B1, partner B), `tPA` (org NULL, partner A); one `script_versions` row on `sSys` and one on `sPA` seeded under system context; `created_by` left NULL (nullable — F1 — so no `users` rows are needed here). Contexts: `orgContext(A1, A)`, `orgContext(B1, B)`, `orgContext(A1, B)` (mis-set own partner), `partnerContext(A)`, `partnerContext(B)`.

| # | Actor | Action | Expected | Red on main? |
| --- | --- | --- | --- | --- |
| 1 | org A1 | INSERT version on `sA1`; SELECT it | 1 row / 1 row | no (positive path) |
| 2 | org A1 | INSERT link `(sA1, tA1)`; SELECT it | ok / 1 row | no |
| 3 | org B1 | SELECT `sA1` versions and links | `[]` / `[]` | **yes** |
| 4 | org B1 | INSERT version on `sA1` | RLS violation `"script_versions"` | **yes** |
| 5 | org B1 | INSERT `(sB1, tA1)` and `(sA1, tB1)` | RLS violation `"script_to_tags"` ×2 | **yes** |
| 6 | org B1 | UPDATE changelog / DELETE on A's version; DELETE A's link | 0 rows each; rows intact under system read | **yes** |
| 7 | partner B | SELECT A's version; INSERT version on `sPA` | `[]`; violation | **yes** |
| 8 | partner A | INSERT version on `sPA`; INSERT link `(sPA, tPA)` | ok; ok | no |
| 9 | org A1 | SELECT `sPA` version (read branch); INSERT version on `sPA` | 1 row; violation | INSERT half **yes** |
| 10 | org A1 with own partner = B | SELECT `sPA` version | `[]` | **yes** |
| 11 | org A1 | INSERT link `(sA1, tPA)` | ok (tag read branch) | no |
| 12 | org B1 | INSERT link `(sB1, tPA)` | violation (tag belongs to partner A) | **yes** |
| 13 | org A1 | SELECT `sSys` version by bound `script_id` | 1 row (`is_system` branch, extended protocol) | no |
| 14 | org A1 / partner A | INSERT version on `sSys` | violation / violation | **yes** |
| 15 | org A1 | DELETE own link `(sA1, tA1)`; DELETE `(sPA, tPA)` | 1 row; 0 rows (unlink needs script WRITE) | second half **yes** |
| 16 | org A1 | UPDATE own link `(sA1, tA1)` SET `tag_id = tB1` | violation (UPDATE `WITH CHECK` tag leg) | **yes** |

Rows marked "no" pass on main because there is no policy to reject anything; they are the same-tenant success half of the exit contract and guard against an over-tight policy. The RED evidence retained in the commit message is the failing set (3–7, 9b, 10, 12, 14, 15b, 16). Violation messages are matched exactly as in F15.

### D8 — Bundle-import regression under real RLS, for org, partner-wide and system callers

New `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts` (integration runner; `setup.ts` truncation is fine — `scripts` is in its list and TRUNCATE CASCADE takes the children — F20). It calls `importBundle` directly with a real `BundleAuth` (`scope`, `orgId`, `partnerId`, `accessibleOrgIds`, `canAccessOrg`, `user`) inside `withDbAccessContext(buildDbAccessContext(...))`; because `new-version` sets `createdBy: auth.user.id` (F11) the fixture seeds one real `users` row per partner. It imports a two-entry bundle with tags, then the same bundle with changed content in `new-version` mode, and reads back under system context:

- (a) organization-scope caller → org-owned script (`org_id` set, `partner_id` set): one `script_versions` row (version-1 content), two `script_to_tags` rows — verifier concern 7 (org-axis parent).
- (b) partner-scope caller with `availability: 'partner'` and the partner-wide capability → partner-wide script (`org_id NULL`): same assertions (partner-axis parent).
- (c) system-scope caller with an explicit `orgId` → org-owned script: same assertions (system short-circuit).

These pass on main (no policy) and are regression guards, not RED. Their discriminating power is proven once by mutation during implementation: re-create `script_versions`' INSERT policy without the `breeze_has_partner_access` branch on the test DB, watch (b) fail with the RLS violation, then re-apply the migration file. Recorded in the commit message.

### D9 — Advisor quorum: convened, returned, and resolved (§9)

Per CLAUDE.md:149-157 a read-only Codex review (`codex exec … -s read-only -m gpt-5.6-sol -C <worktree> < /dev/null`; prompt `scratchpad/codex-prompt.txt`, output `scratchpad/codex-out.txt`) of D2/D3 was run with five pointed questions. It returned no disagreement with SELECT-only `is_system`, tag READ on INSERT, or the canonical parent-join split, and raised four concrete points; each is resolved in §9 and none changes D1–D3.

## 3. Contracts per file

| File | Change | Guard |
| --- | --- | --- |
| `apps/api/migrations/2026-10-01-100000-script-children-rls.sql` (new) | D1–D3 DDL; idempotent; no transaction block; header as D1. | `autoMigrate.test.ts`; `check-migration-naming.sh --staged`; re-apply on a migrated DB is a no-op (run twice, `pg_policies` unchanged). |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | D4 two catalog entries; D5 new test + `PLATFORM_INFRASTRUCTURE_TABLES` + `UNREVIEWED_RLS_CLASSIFICATION_DEBT`; D6a/D6b new tests + `PARENT_FK_REQUIRED_PARENTS_PER_COMMAND` (+ `RLS_SHAPE_TRIAGE` only if the fresh-DB simulation demands it); D7 forge describe; schema imports (`scripts`, `scriptTags`, `scriptToTags`, `scriptVersions`). No existing assertion is weakened or removed. | `pnpm --filter=@breeze/api test:rls-coverage` on a fresh migrated DB with `DATABASE_URL_APP` and `DB_CONTEXTLESS_WRITE_STRICT=true`. |
| `apps/api/src/db/rlsPolicyShape.ts` (new) | D6 pure matchers; no DB import; imported by the contract test as `../../db/rlsPolicyShape`. | `rlsPolicyShape.test.ts`. |
| `apps/api/src/db/rlsPolicyShape.test.ts` (new) | D6 fixture-driven unit test; runs in **Test API** only (F20). | Test API job. |
| `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts` (new) | D8 regression suite. | Integration Tests job. |
| `docs/superpowers/specs/2026-09-01-rmm-qa-220-script-children-rls-design.md` (this file) and the plan it precedes | Design + plan. | — |

Files deliberately untouched: `0001-baseline.sql`, `ensureAppRole.ts`, `scriptBundle/index.ts`, `aiToolsScripts.ts`, `routes/scripts.ts`, `routes/scriptBundle.ts`, `tenantCascade.ts`, `orgMergeRegistry.ts`, `routes/devices/core.ts`, `tenantExportPolicyRegistry.ts`, `db/schema/scripts.ts`.

## 4. RED test list (write first, watch fail, keep the output)

1. **D4 registration** → force test (`:893`) and parent-FK assertion (`:1295`) fail on main naming `script_versions` and `script_to_tags` (`rls_on=false`, four commands missing). Output retained in the migration commit.
2. **D5 exhaustive classification** → fails on main listing the unclassified set (expected ≥ the 12 names in F18; authoritative list from a fresh DB). Output retained in the test commit; the debt bucket is populated from that output and nothing else.
3. **D6 unit fixtures** (`rlsPolicyShape.test.ts`) → fail before the module exists; each fixture then mutated once against the implementation (list in D6) and the failure observed, then reverted.
4. **D6a/D6b DB assertions** → on main, D6a fails only for the two new entries (missing policies) and passes for the 30 existing ones; D6b passes (F16/F17 re-confirmed on a fresh DB, or the triage path runs).
5. **D7 forge block** → the "yes" rows fail on main; the full failing set is retained in the migration commit message.
6. **D8 bundle regression** → green before and after; discriminated once by the D8 mutation, recorded in the commit message.

Order of commits: (1) spec + plan docs; (2) `rlsPolicyShape` module + unit test (RED→GREEN, mutation proofs); (3) rls-coverage catalog entries + D5 + D6a/D6b + D7 tests — committed RED with the captured failure output (the retained RED for the migration; CI on that intermediate commit is expected red); (4) migration → all green; (5) D8 regression suite + mutation proof. The PR head must be green; intermediate commits need not be.

## 5. Verification battery

- **Fresh DB**: re-create the disposable test stack (`pnpm --filter=@breeze/api test:docker:up` from scratch, or `docker compose -f docker-compose.test.yml down -v` first), run `pnpm --filter=@breeze/api test:integration` (globalSetup migrates), then `pnpm --filter=@breeze/api test:rls-coverage` with the `ci.yml:2006-2020` environment. Apply the migration twice to prove idempotency.
- **Shape simulations before D6 commit** (both must be clean or triaged): parent-FK — export `pg_policies` for the 32 catalog tables and run `scratchpad/shape_check.py` (or the new module against the same rows); org-axis — the F17 SQL:

  ```sql
  WITH org_tables AS (
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN information_schema.columns col ON col.table_schema=n.nspname AND col.table_name=c.relname
    WHERE n.nspname='public' AND c.relkind='r' AND col.column_name='org_id'),
  cmds AS (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd),
  cov AS (
    SELECT t.relname, x.cmd, bool_or(CASE x.cmd
      WHEN 'SELECT' THEN regexp_replace(coalesce(pp.qual,''),'\s+',' ','g') ~ 'breeze_has_org_access\(([a-z_]+\.)?org_id\)'
      WHEN 'DELETE' THEN regexp_replace(coalesce(pp.qual,''),'\s+',' ','g') ~ 'breeze_has_org_access\(([a-z_]+\.)?org_id\)'
      WHEN 'INSERT' THEN regexp_replace(coalesce(pp.with_check,''),'\s+',' ','g') ~ 'breeze_has_org_access\(([a-z_]+\.)?org_id\)'
      WHEN 'UPDATE' THEN regexp_replace(coalesce(pp.qual,''),'\s+',' ','g') ~ 'breeze_has_org_access\(([a-z_]+\.)?org_id\)'
                     AND regexp_replace(coalesce(pp.with_check,''),'\s+',' ','g') ~ 'breeze_has_org_access\(([a-z_]+\.)?org_id\)' END) AS ok
    FROM org_tables t CROSS JOIN cmds x
    LEFT JOIN pg_policies pp ON pp.schemaname='public' AND pp.tablename=t.relname AND pp.permissive='PERMISSIVE' AND (pp.cmd='ALL' OR pp.cmd=x.cmd)
    GROUP BY t.relname, x.cmd)
  SELECT relname, cmd FROM cov WHERE NOT ok ORDER BY 1,2;
  ```

  On the 2026-09-20 DB the only rows are the 15 `ORG_AXIS_POLICY_EXCLUDED_TABLES` members and `m365_consent_sessions` (EXEMPT), i.e. zero asserted offenders.
- **Manual forge as `breeze_app`** (CLAUDE.md step 6): `psql` as `breeze_app` with `set_config('breeze.scope','organization',true)` and a foreign org id; `INSERT INTO script_versions …` for another org's script → `new row violates row-level security policy for table "script_versions"`; same for `script_to_tags` with a foreign tag.
- **Catalog proof re-run**: the QA query from `docs/qa/evidence/2026-08-23-core-tenant-isolation.md:31-35` must return `rls_enabled=true, force_rls=true` for both tables (privileges unchanged, by design).
- **Unit**: `pnpm --filter=@breeze/api test -- rlsPolicyShape autoMigrate scriptBundle` (the mocked `scriptBundle/index.test.ts` stays green — no service code changes).
- **Integration**: `scriptBundleRls.integration.test.ts`, `scripts-system-rls.integration.test.ts`, `scripts-soft-delete.integration.test.ts`, `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `tenant-export-policy.integration.test.ts` (all expected unchanged-green: no registry touched).
- **Drift**: `pnpm db:check-drift` (policies are not part of the Drizzle schema — F22; expected clean).
- **Migration hygiene**: `bash scripts/check-migration-naming.sh --staged` on the commit that adds the file; `autoMigrate.test.ts`.
- **Typecheck** for `apps/api`.
- **Post-push**: confirm CI runs attached to the head (branch targets `main`, so `ci.yml` triggers; no stacked-PR blind spot), Integration Tests shard 1 shows the rls-coverage step green, then one independent review round before merge (rigor cap).

## 6. Risk register

| Risk | Mitigation |
| --- | --- |
| A post-09-20 migration reshaped a parent-FK or org-axis policy so D6 reds an unrelated table | Re-run both simulations on a fresh DB before committing D6; triage per D6; never loosen. |
| An unseen writer of the children runs under a context that fails `W(s)` | F11 grep found none outside `scriptBundle`; F12 proves no system-script child writes; D8 covers all three caller scopes; `DB_CONTEXTLESS_WRITE_STRICT` in the rls-coverage job catches context-less writes. |
| The debt bucket is read as a review | Name, doc comment, and the explicit QA hand-off in §8. |
| `rlsPolicyShape.test.ts` is swallowed by the integration include glob and never runs in the unit job | Placement under `src/db/` (F20, contract table row 4). |
| Forge fixtures leak between shards | The rls-coverage runner is single-file and shard-1-only (F20); cleanup by id in `afterAll`, as in F15. |
| D6b broadens the finding's blast radius into a test that guards ~270 tables | Test-only; zero offenders with evidence (F17); a named triage list is the only escape hatch and it names its owner. |

## 7. Non-claims

- This design does not claim a request-path exploit existed; F11/F12 show every caller authorises the parent first. It closes the database invariant and the catalog blind spot.
- It does not claim `INTENTIONAL_UNSCOPED` tables carry forced RLS. F18 shows seven of them (`device_commands`, `intent_outbox`, `llm_provider_catalog`, `llm_provider_catalog_revisions`, `llm_provider_verifications`, `third_party_package_catalog`, `third_party_release_tests`) have RLS entirely off on the 2026-09-20 DB although the list's comments for some say "Forced RLS". D5 classifies membership only; it does not assert their RLS state. Reported to QA (§8), not fixed here.
- It does not claim the F18 debt tables are safe. Three (`device_software`, `mobile_sessions`, `software_compliance_status`) carry `device_id`/`user_id` and no RLS and look like tenant tables.
- It does not claim the parents' own policies are sound: the quorum showed `scripts`/`script_tags` accept `(org_id=A, partner_id=B)` and `(org_id=A, is_system=true)` rows at the RLS layer (route-layer clamps prevent both today). Children can never be tighter than their parents (F7); those are parent findings (§8.1).
- It does not claim org erasure of an org owning versioned or tagged scripts succeeds today (§8.3); FORCE RLS changes nothing about that path because erasure runs under system scope and FK checks bypass RLS (F21).
- It does not claim parity between the child policies and the app-layer `canReadScript` (`scriptBundle/index.ts:339-347`); RLS is stricter than the app layer by design and the app layer is not the security boundary.
- It does not extend the command-specific shape check to partner-axis, dual-axis, device-join or user-id shapes; those assertions keep their current form and are named as follow-up candidates (§8.5).
- The migration filename `2026-09-30-100000-…` is a proposal pinned to the worktree's current ceiling; the committed name is whatever satisfies `check-migration-naming.sh --staged` at commit time.

## 8. Hand-offs recorded for QA / backlog (not part of this branch)

1. **Parent-level invariants (quorum finding)**: `scripts` and `script_tags` have independent `org_id`/`partner_id` FKs with no `(org_id, partner_id) → organizations(id, partner_id)` composite (precedent `2026-04-11-users-rls.sql:183-201`, quorum-cited), so an org-scope INSERT can set a foreign `partner_id` and expose the row to that partner; and nothing at the DB layer enforces `is_system ⇒ org_id IS NULL AND partner_id IS NULL`, so an org-scope INSERT with `is_system=true` passes the org branch and becomes globally readable. Route-layer clamps (`scriptWrite.ts`) prevent both today. Candidate S1 findings on the parents; requires data audit before adding constraints.
2. Candidate new findings from the D5 RED list: `device_software`, `mobile_sessions`, `software_compliance_status` (tenant-bearing, no RLS); `agent_versions`, `cis_check_catalog`, `patches`, `permissions`, `plugin_catalog`, `script_templates` (likely global reference data; need an `INTENTIONAL_UNSCOPED` review with a plan-doc entry per CLAUDE.md:47); plus any post-09-20 table the fresh-DB run adds.
3. **Erasure FK gap (quorum-confirmed)**: `CORE_ORG_CASCADE_DELETE_ORDER` deletes `script_tags` and `scripts` (`tenantCascade.ts:353-354`) but never `script_to_tags`/`script_versions`, whose FKs are `NO ACTION` (F1) — a deterministic `23503` for any org that owns a versioned or tagged script. Fix options: `ON DELETE CASCADE` on the two script/tag FKs plus `SET NULL` on `script_versions.created_by`, or explicit pre-clears in the cascade. Independent of RLS.
4. Seven `INTENTIONAL_UNSCOPED` tables have RLS off, contradicting their in-list comments (§7).
5. Command-specific shape checks for the partner-axis, dual-axis, device-join and user-id assertions (same module, same rollout discipline as D6).
6. The QA probe's RMM-QA-220 blocks (`core-tenant-isolation-release-contract.test.ts:151-177`) will invert once the catalog entries and D6b land; the QA side owns that re-characterisation.

## 9. Advisor quorum record

Codex (`gpt-5.6-sol`, read-only, `scratchpad/codex-out.txt`, exit 0) reviewed the D2/D3 predicates and the F10 concern against the worktree. Verbatim positions and resolutions:

| # | Codex position | Resolution |
| --- | --- | --- |
| 1 | Normal org/partner/system scopes behave correctly under the proposed predicates; but the *parents* accept `(org_id=A, partner_id=B)` and `(org_id=A, is_system=true)` rows at the RLS layer, so children inherit that exposure. Recommends composite ownership FK and an `is_system ⇒ NULL axes` invariant on `scripts`/`script_tags`. | **Agreed as a finding, declined as scope.** Parent-schema changes with data-audit blast radius; recorded as §8.1. Child policies cannot be tighter than the parent (F7), so nothing in D2/D3 changes. |
| 2 | A `script_to_tags` UPDATE `WITH CHECK` that validates only script WRITE lets an owner re-point `tag_id` at a hidden tag. | **Already satisfied**: D3 uses `USING W(s) WITH CHECK (W(s) AND T_read(t))`; Codex noted the workspace design already had this form. D7 row 16 proves it behaviourally. |
| 3 | Tag READ on INSERT is acceptable; tag WRITE would be a valid stricter product rule but is not required for tenant isolation. Precedent `automation-resource-bindings.sql:397-409`. | **Agreed**; D3 unchanged. |
| 4 | The 2026-05-31 bound-parameter failure was specifically an INSERT `WITH CHECK` on the `is_system` branch; the proposed child writes carry no such branch; `role_permissions` is valid SELECT counter-evidence; keep the bound-parameter functional test. | **Agreed**; D2 unchanged; D7 row 13 retained. |
| 5 | FORCE RLS does not break soft delete, org merge, device move or seeds; but org/partner hard erasure is a latent deterministic `23503` because the cascade never deletes these children and their FKs are `NO ACTION`. | **Agreed as a finding, declined as scope** (RLS-independent); recorded as §8.3. |
| 6 | The existing parent-FK assertion ORs parents, so `script_to_tags` could pass without validating `script_tags`; require both parents for SELECT and INSERT/UPDATE `WITH CHECK`, `scripts` only for UPDATE `USING` and DELETE. | **Adopted**: D6a gains `PARENT_FK_REQUIRED_PARENTS_PER_COMMAND` with exactly that rule for `script_to_tags`. |
| 7 | `db:check-drift` does not inspect RLS/policies. | **Agreed** (F22); no action. |

No disagreement remains on D1–D3. Points 1 and 5 are surfaced to the orchestrator as new candidate findings rather than silently absorbed.
