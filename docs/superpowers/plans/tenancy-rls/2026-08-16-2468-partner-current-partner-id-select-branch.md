---
tracking_issue: LanternOps/breeze#4673
---

# #2468 — Partner-wide reads via a `breeze_current_partner_id()` RLS SELECT branch

**Status:** approved; wave 1 in implementation. Plan branch: `plan/2468-partner-rls-select`.
**Tracking:** LanternOps/breeze#4673 (waves as sub-issues).
**Issue:** https://github.com/LanternOps/breeze/issues/2468 (refs #2417, #1105, #2822)
**Rigor:** high — multi-tenant RLS semantics, repo-wide read-visibility change.

## Context / goal

A partner-wide config row (`org_id NULL, partner_id = P`) is invisible to an org-scoped
token: `breeze_has_org_access(NULL)` is false and `breeze_has_partner_access(P)` is false
because org scope carries an empty `accessible_partner_ids`. Every request-path reader of a
partner-linkable feature therefore escalates via the sanctioned #1105 pattern
(`runOutsideDbContext(() => withSystemDbAccessContext(...))`), which:

1. **double-holds pooled connections** — the whole request already runs inside
   `withDbAccessContext` (request wrap opened by `authMiddleware`; re-entry helper at
   `apps/api/src/middleware/auth.ts:459`), so the nested system context opens a SECOND
   transaction on a SECOND connection while the first is held. postgres-js queues acquisitions
   with no timeout; at concurrency ≥ pool size (US ceiling ~25) that is a hang; and
2. **bypasses RLS entirely**, so every escalated query must self-tenant or it is a
   cross-tenant hole (#2417 shipped exactly that class in an adjacent path).

Fix (precedent already shipped twice): add a **SELECT-only** own-partner branch

```sql
OR (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
```

to the config-policy chain, then delete the escalation wrappers. Writes stay unchanged.

## Current state (verified on origin/main, file:line)

### The helper function and GUC already exist — no new function needed

- `public.breeze_current_partner_id()` was created by
  `apps/api/migrations/2026-06-13-catalog-partner-read-branch.sql:36-60` (plpgsql, STABLE
  PARALLEL SAFE, best-effort LEAKPROOF, fail-closed → NULL on empty/malformed GUC). Wave 1
  does **not** recreate it.
- The GUC `breeze.current_partner_id` is SET LOCAL from `context.currentPartnerId` at
  `apps/api/src/db/index.ts:475` (transaction path) and `:571` (context re-application path).
- `currentPartnerId` is populated per auth path:
  - user/session auth: `buildDbAccessContext` sets `currentPartnerId: args.partnerId ?? null`
    (`apps/api/src/middleware/auth.ts:414`) — set for **every** scope, including org tokens
    (an org token's own partner), distinct from `accessiblePartnerIds` which stays `[]` for
    org scope (`computeAccessiblePartnerIds`).
  - OAuth bearers: org-scoped `currentPartnerId: payload.partner_id`
    (`apps/api/src/middleware/bearerTokenAuth.ts:474`), partner-scoped `:486`.
  - partner API bootstrap: `apps/api/src/middleware/partnerApiAuth.ts:370`.
  - **agent auth: `currentPartnerId: null`** — deliberate, with a comment saying the catalog
    branch is the only consumer (`apps/api/src/middleware/agentAuth.ts:652-663`). The device
    auth select (`agentAuth.ts:354-367`) loads only `devices` columns; the org's `partner_id`
    is not fetched. This is the blocker for dropping escalations on agent paths (Wave 2).

### Shipped precedents for the exact policy shape

- Catalog tables (scripts, alert_templates, script_categories, script_tags): branch appended
  to the existing dual-axis **FOR SELECT** policy —
  `2026-06-13-catalog-partner-read-branch.sql:69-104`.
- `cis_baselines`: table has a single FOR ALL policy, so the branch was added as a
  **separate permissive `FOR SELECT` policy** `cis_baselines_partner_wide_select`
  (`apps/api/migrations/2026-08-10-cis-baselines-partner-ownership.sql:112-116`), with the
  comment "permissive policies OR together, and the branch is FOR SELECT only" (`:30`).
  This is the template for Wave 1. Tenant variables did the same
  (`2026-08-11-tenant-variables.sql`).
- The rls-coverage suite already passes with `cis_baselines` carrying the extra SELECT
  policy, so an additional named `*_partner_wide_select` policy does not trip the contract
  test (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`;
  `DUAL_AXIS_TENANT_TABLES` at `:271`, `configuration_policies` `:297`, `backup_profiles`
  `:444`). No allowlist changes are needed — all target tables are already registered; we are
  changing policies, not adding tables or columns (no cascade/export-policy changes either).

### Live policies on the target tables — all are single FOR ALL policies

- `configuration_policies_org_isolation` — FOR ALL, `system OR org OR partner-axis`,
  `apps/api/migrations/2026-06-27-config-policies-partner-ownership.sql:62-73`.
- `config_policy_feature_links_org_isolation` — FOR ALL, EXISTS-join to
  `configuration_policies cp` (`:87-98`).
- `config_policy_assignments_org_isolation` — FOR ALL, same EXISTS shape (`:100-111`).
- Per-feature children with the same EXISTS-join shape, created in the same file:
  `config_policy_alert_rules` (`:115`), `config_policy_automations` (`:129`),
  `config_policy_compliance_rules` (`:143`), `config_policy_patch_settings` (`:157`),
  `config_policy_maintenance_settings` (`:171`), `config_policy_event_log_settings` (`:186`);
  plus per-command policies on `config_policy_sensitive_data_settings` (`:212-244`),
  `config_policy_monitoring_settings` (`:249-282`), `config_policy_monitoring_watches`
  (`:286-320`); `config_policy_remote_access_settings_isolation`
  (`2026-07-29-remote-access-settings-partner-rls.sql:25`);
  `config_policy_onedrive_settings` (`2026-06-19-b-onedrive-helper-settings.sql:29-…`,
  possibly superseded — implementer must take the LAST migration to touch each table's
  policies as authoritative, then confirm against a live DB via `pg_policies`).
- `backup_profiles_isolation` — FOR ALL (`2026-07-13-backup-profiles.sql:51-63`).
- `config_policy_backup_settings_isolation` — FOR ALL (`2026-07-13-backup-profiles.sql:148-…`).

Because every one of these is FOR ALL (or per-command with separate write policies), the
issue's caveat applies everywhere: **the branch must be a separate `FOR SELECT` policy —
never appended to a FOR ALL `USING`**, which would widen UPDATE/DELETE row targeting to
partner-wide rows. A separate permissive FOR SELECT policy ORs into SELECT only; Postgres
does not consult FOR SELECT policies when computing UPDATE/DELETE target rows.

### Escalation sites (the sweep inventory)

**Removable once the branch exists (Waves 2-3):**

- `withPartnerWideVisibility` — `apps/api/src/services/configPolicyOwnership.ts:83`
  (skip-if-already-system at `:82`). Call sites: 9 in
  `apps/api/src/services/featureConfigResolver.ts` (`:229, :297, :524, :609, :709, :768,
  :834, :1038, :1501`) and `apps/api/src/routes/agents/helpers.ts` (partner-wide policy
  resolution; unit suite `helpers.partnerWidePolicies.test.ts`).
- Direct wraps in `apps/api/src/services/configurationPolicy.ts`: `:2026`
  (`isBackupProfileReference` bare-id existence probe), `:2108` and `:2123`
  (`validateFeaturePolicyExists` profile/config lookups). All three are already
  self-tenanted by the owner axis in their WHERE clauses; after Wave 1 the caller's own
  context sees exactly the rows those conditions admit — and a *different* partner's rows
  become correctly invisible (a tightening, not a regression).
- `apps/api/src/routes/agents/helpers.ts:1183` — `cis_baselines` PK lookup, escalated
  *specifically because* the agent context has `breeze_current_partner_id()` NULL (its own
  comment, `:1176-1182`). Removable only after Wave 2.

**NOT removable — different problems, keep them (document why in the sweep PR):**

- `apps/api/src/db/partnerAxisRead.ts:56` (`readWithPartnerAxisVisibility`) — partner-AXIS
  tables (`partners`, `PARTNER_TENANT_TABLES`), gated by `breeze_has_partner_access`, not by
  an `org_id NULL` branch. Out of scope for #2468 (that is #2822's territory).
- `apps/api/src/services/vulnerabilityFleetQueries.ts:123, :183` — global `vulnerabilities`
  catalog, not a partner-wide-row read.
- `apps/api/src/services/ticketConfigService.ts:78-253` — cross-org worker reads of
  `org_ticket_settings` by arbitrary orgId; not this class.
- `apps/api/src/services/commandQueue.ts` — escapes for transaction-isolation semantics
  (`:503-517` failure-visibility insert), not visibility.
- `services/enrollmentDefaults.ts` (`getEnrollmentDefaultsForOrg`, #2818) — evaluate during
  the Wave 3 sweep; only convert if its target rows are the `org_id NULL AND partner_id=own`
  shape on tables that gained the branch.

The mechanical sweep commands, to be re-run at implementation time (the list above will
drift): `grep -rn "runOutsideDbContext(() =>\s*$" apps/api/src --include='*.ts' -A1 | grep -B1
withSystemDbAccessContext` and `grep -rn "withPartnerWideVisibility" apps/api/src`.

## Design decisions

1. **Separate `FOR SELECT` policy named `<table>_partner_wide_select`** on every target
   table, exact clone of the `cis_baselines_partner_wide_select` template. Never touch the
   existing FOR ALL policies — writes stay locked to org/partner-axis/system exactly as today.
2. **Direct-column tables** get `USING (org_id IS NULL AND partner_id =
   public.breeze_current_partner_id())`.
3. **EXISTS-join children** get `FOR SELECT USING (EXISTS (SELECT 1 FROM
   configuration_policies cp WHERE cp.id = <table>.config_policy_id AND cp.org_id IS NULL
   AND cp.partner_id = public.breeze_current_partner_id()))` (grandchildren route through
   `config_policy_feature_links fl` first, mirroring their existing FOR ALL join shape).
4. **Full chain, not just the issue's five tables.** The issue names
   `configuration_policies`, `config_policy_feature_links`, `config_policy_assignments`,
   `config_policy_backup_settings`, `backup_profiles`. But acceptance item 3 removes
   `withPartnerWideVisibility` from `featureConfigResolver.ts`, whose nine call sites read
   the per-feature settings children (patch, event-log, monitoring, maintenance,
   sensitive-data, remote-access, onedrive, alert-rules, automations, compliance). Granting
   the branch to only five tables would leave the resolver needing escalation for the rest,
   defeating the issue. Wave 1 therefore covers the entire chain enumerated above.
   (This is read-only widening to the caller's own partner's partner-wide rows — the same
   rows the system-context wrap shows them today, minus everyone else's.)
5. **Writes unchanged, by construction**: no INSERT/UPDATE/DELETE policy or `WITH CHECK`
   is touched; `accessiblePartnerIds` stays `[]` for org and agent scopes; route-level
   `canManagePartnerWidePolicies` guards are untouched.
6. **`breeze_current_partner_id()` set/cleared**: no request-path changes needed for user
   auth — it is already SET LOCAL per transaction (`db/index.ts:475`) and scoped to the
   transaction (`set_config(..., true)`), so it clears itself. The only producers changed
   are agent auth and any hand-built org contexts (Wave 2).

## Waves

Each wave is independently shippable and lands as its own PR, **sequentially merged to main**
(not stacked — see CI traps). Wave 1 is the security-semantics change the issue wants
reviewed in isolation.

### Wave 1 — migration + RLS integration proof

**Migration:** `apps/api/migrations/<TODAY>-2468-config-policy-partner-wide-select.sql`.
Naming per CLAUDE.md: date-prefixed, lexicographic order. Content-ordering dependencies are
only on `2026-06-27-…` and `2026-07-13-…` (the FOR ALL policies must exist first — though
`DROP POLICY IF EXISTS` + CREATE of a *new* name is order-safe even on a fresh replay since
we create, not extend). **Trap:** the tree already contains migrations dated later than the
wall clock (up to `2026-08-24-…`); that is fine — no later file touches these tables' policies
— but verify with `ls apps/api/migrations | sort | tail` and `grep` before picking the date,
never reuse a date inside the closed `2026-08-06` block, and let `autoMigrate.test.ts` +
`scripts/check-migration-naming.sh` confirm.

Migration content (idempotent; NO inner `BEGIN;`/`COMMIT;`):
- For each table in the chain: `DROP POLICY IF EXISTS <table>_partner_wide_select ON
  public.<table>;` then `CREATE POLICY <table>_partner_wide_select ON public.<table> FOR
  SELECT USING (…)` per design decisions 2-3.
- Tables: `configuration_policies`, `config_policy_feature_links`,
  `config_policy_assignments`, `config_policy_alert_rules`, `config_policy_automations`,
  `config_policy_compliance_rules`, `config_policy_patch_settings`,
  `config_policy_maintenance_settings`, `config_policy_event_log_settings`,
  `config_policy_sensitive_data_settings`, `config_policy_monitoring_settings`,
  `config_policy_monitoring_watches`, `config_policy_remote_access_settings`,
  `config_policy_onedrive_settings`, `config_policy_backup_settings`, `backup_profiles`.
  (Implementer: re-derive this list from the last-writer migrations + `pg_policies` on a
  live DB; anything with an `org_id XOR partner_id` owner or a cp-join in this chain is in.)
- Do NOT recreate `breeze_current_partner_id()` — it exists.

**Tests (new):** `apps/api/src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts`
modeled on `cisBaselinesPartnerRls.integration.test.ts` / `backupProfilesPartnerRls.integration.test.ts`:
- org token of partner P SELECTs a partner-wide policy of P, its feature links, assignments,
  and at least two per-feature settings children (one direct-column, one grandchild join) —
  rows visible;
- the same org token targeting those rows with UPDATE/DELETE affects **0 rows** (RLS hides
  the target from write commands — note: this is a silent no-op, not a 42501; only
  INSERT/`WITH CHECK` forges raise 42501). The issue's "UPDATE/DELETE still fail (42501)"
  is satisfied by asserting rowCount 0 plus a cross-tenant INSERT forge → 42501;
- a *different* partner's partner-wide rows remain invisible to both org and partner tokens;
- partner-scope and system-scope visibility unchanged;
- `backup_profiles` + `config_policy_backup_settings` same matrix.
- Existing suites must stay green: `rls-coverage.integration.test.ts`,
  `normalizedConfigPolicyRls.integration.test.ts`, `backupProfilesPartnerRls.integration.test.ts`,
  `agentPolicyResolversPartnerWide.integration.test.ts`, `partnerAxisSystemContext.integration.test.ts`.

**Manual verification:** as `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app
-d breeze`), SET the GUCs for an org context and confirm the partner-wide row appears under
SELECT and not under `UPDATE … RETURNING`; forge a cross-partner insert → RLS violation.

**Rollback:** one migration with 16 `DROP POLICY IF EXISTS <table>_partner_wide_select`
statements (never edit the shipped file). App code has not changed yet, so dropping the
policies restores exact pre-wave behavior.

### Wave 2 — populate `currentPartnerId` on agent + hand-built org contexts

- `apps/api/src/middleware/agentAuth.ts:354-367`: extend the device auth select with the
  org's `partner_id` (LEFT JOIN `organizations` on `devices.org_id` — PK join on an already
  hot path; if profiling objects, fall back to a cached org→partner lookup), and change
  `agentAuth.ts:661` from `currentPartnerId: null` to the resolved partner id, updating the
  now-false comment. `accessiblePartnerIds` stays `[]` — the GUC feeds only SELECT-only
  branches, so this widens agent reads to its own MSP's partner-wide rows and nothing else.
- Sweep every other producer: `grep -rn "currentPartnerId" apps/api/src` — hand-built
  `{scope: 'organization', …}` contexts in the `SELF_MANAGED_DB_CONTEXT_ACTIONS` route
  handlers (`apps/api/src/middleware/selfManagedDbContextRoutes.ts` documents which), portal
  auth, clientAiAuth, and any worker that re-enters an org context via `buildDbAccessContext`
  (that helper already passes partnerId through — verify callers supply it).
- **Tests:** agentAuth unit test asserting the context object carries the org's partner id;
  extend `agentPolicyResolversPartnerWide.integration.test.ts` with a real-Postgres proof
  that a query under the agent's org context (with the GUC set) sees a partner-wide policy
  row of its own partner and not a foreign partner's.
- **Rollback:** revert the PR — no schema involvement.

### Wave 3 — remove the nested system-context escalations

- Delete `withPartnerWideVisibility` (`configPolicyOwnership.ts:83`) and unwrap all call
  sites in `featureConfigResolver.ts` and `agents/helpers.ts`; unwrap
  `configurationPolicy.ts:2026/:2108/:2123`; unwrap `agents/helpers.ts:1183` (cis baseline —
  depends on Wave 2); update the stale comments that cite the escape
  (`partnerAxisRead.ts:36-38` names `withPartnerWideVisibility` as a sibling).
- Keep, with a one-line justification comment each: `partnerAxisRead.ts`,
  `vulnerabilityFleetQueries.ts`, `ticketConfigService.ts`, `commandQueue.ts` (reasons in
  the inventory above). Re-run the sweep greps to catch sites added since this plan.
- **Behavioral tightening to call out in the PR:** bare-id probes
  (`isBackupProfileReference`, the cis PK lookup) previously saw EVERY tenant's rows and
  relied on post-hoc self-tenanting; under the caller's context a foreign partner's row now
  reads as absent. Confirm each caller treats absent as reject/skip (they do today — the
  post-checks become dead-but-harmless and can stay as defense-in-depth).
- **Zero-row trap sweep:** any reader that *assumed* partner-wide rows were invisible under
  org context (dedup/name-uniqueness checks, counts shown in org-scoped UI) now sees them.
  Sweep `configurationPolicies.orgId`/`backupProfiles.orgId` call sites per playbook step 7
  and check list endpoints don't double-count.
- **Unit-test fallout:** suites that `vi.mock('../db')` with the named
  `runOutsideDbContext`/`withSystemDbAccessContext` factories (deliberately loud —
  `partnerAxisRead.ts:50-55`) will need their mocks trimmed; `helpers.partnerWidePolicies.test.ts`
  and `featureConfigResolver.backupAssignments.test.ts` likely rewritten to assert the
  query runs in the *caller's* context.
- **Regression gates (acceptance item 3):** `backupProfilesPartnerRls.integration.test.ts`
  org-scoped fan-out proof still passes; full RLS + integration suites green.
- **Payoff to state in the PR:** removes N second-connection acquisitions per affected
  request (the #1105 pool-starvation shape) and N RLS-bypass surfaces.
- **Rollback:** revert the PR; Wave 1 policies are additive so reverting code alone is safe.

### Wave 4 — docs + guardrails

- CLAUDE.md "Partner-Wide First" playbook step 3: replace "move them to a system context
  (heartbeat probe-config pattern, #1105)" with: prefer the `*_partner_wide_select` RLS
  branch (`breeze_current_partner_id()`); reserve the system-context escape for
  partner-AXIS tables (`readWithPartnerAxisVisibility`, #2822) and genuine cross-org worker
  reads. Add the FOR SELECT-only caveat.
- Add a contract assertion to `rls-coverage.integration.test.ts`: every table in
  `DUAL_AXIS_TENANT_TABLES` whose owner shape is `org_id XOR partner_id` must have a
  `FOR SELECT` policy referencing `breeze_current_partner_id()` (allowlist for intentional
  exceptions). This makes the *next* partner-wide table fail loud instead of shipping the
  #2417 blindness again. If the assertion turns up already-shipped dual-axis tables without
  the branch (e.g. `software_policies`, patch rings, tenant variables' siblings), file a
  follow-up issue per table rather than growing this change.
- Update `apps/api/migrations/README.md` only if it documents the read-branch pattern.

## Key risks

1. **Repo-wide read-visibility semantics change** (why #2417 deferred it): every
   partner-linkable feature's org-token reads widen to own-partner partner-wide rows at the
   DB layer. This is the intended product semantic (org users *should* see the MSP's shared
   policies; the app layer already emulates it via escalation), but Wave 1 must be reviewed
   as a standalone security PR.
2. **FOR ALL trap**: appending the branch to any existing FOR ALL `USING` exposes
   partner-wide rows to UPDATE/DELETE targeting. Mitigated by design decision 1 and the
   0-rows write assertions in the new suite.
3. **42501-vs-no-op nuance**: RLS hides rows from UPDATE/DELETE (silent 0 rows) rather than
   raising; tests must assert rowCount, or they are vacuous.
4. **Agent-path ordering**: unwrapping `helpers.ts:1183` or resolver agent paths before
   Wave 2 lands silently breaks partner-wide config delivery to agents (GUC NULL → branch
   never true → zero rows, no error). Waves must merge in order; Wave 3 asserts Wave 2's
   migration/behavior is on main first.
5. **CI traps**: the RLS/integration contract suites do NOT run via `pnpm test` — run
   `vitest.config.rls.ts` and `vitest.integration.config.ts` explicitly before each PR
   (needs real Postgres; locally use the fsync=off tmpfs setup). Stacked PRs based on a
   sibling branch get **no** CI (`pull_request: branches: [main]`) and read green from the
   smoke workflows alone — either target main sequentially (chosen here) or hand-dispatch
   `gh workflow run CI --ref <branch>`.
6. **Migration ordering**: tree contains future-dated migrations (through `2026-08-24`);
   pick the implementation-day date, verify sort position and the closed `2026-08-06` block
   rule, rely on `autoMigrate.test.ts` + `check-migration-naming.sh`.
7. **Policy-name drift**: some tables' policies have been dropped/recreated by multiple
   migrations; the migration must target the *current* live policy names only via the new
   `*_partner_wide_select` names (create-only), which is why it never drops/recreates the
   FOR ALL policies — immune to that drift.

## Acceptance mapping (from the issue)

- Migration adds SELECT-only partner-read branches → Wave 1.
- Integration test (own-partner SELECT ok; UPDATE/DELETE ineffective; cross-partner
  invisible) → Wave 1 suite.
- Remove `withPartnerWideVisibility` + `configurationPolicy.ts` wraps; backup fan-out proof
  still green → Wave 3 (enabled by Wave 2).
- Sweep other escalation sites → Wave 3 inventory + keep-list.
- CLAUDE.md playbook update → Wave 4.
