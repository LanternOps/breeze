---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC Scanning W03: Rule sets, pre-check, delivery and built-in pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partners and orgs can own YARA rule sets (org XOR partner, plus one read-only built-in
pack), every change is pre-checked with the agent's own compiler and published as an immutable
source bundle, devices fetch those bundles through an agent-authenticated route, and a policy's
`ruleSetIds` turn a `security_scan` into a YARA scan on every agent new enough to run one.

**Architecture:** Two new tenant tables, `yara_rule_sets` and `yara_rules`, shaped like
`security_policies` (org XOR partner, one `FOR ALL` dual-axis policy, a separate SELECT-only
partner-wide branch) plus a SELECT-only built-in branch on the `alert_templates` precedent. Every rule
mutation calls one service, `publishRuleSet`, which builds the W02 canonical bundle, runs
`breeze-yarac validate` (the agent's compiler, built into the API image from `agent/cmd/breeze-yarac`)
as a pre-check, stores per-rule errors, and — only when the whole set passes — snapshots the bundle
bytes + sha256 as the set's **published** version. Devices never see unpublished text. The scan
payload builder resolves `ruleSetIds` → W02 `ruleSets` refs behind a min-agent-version gate and
records an explicit degraded/legacy outcome when it cannot. The built-in pack (Part B) is a filtered
YARA Forge core build, shipped in the release and upserted at boot.

**Tech Stack:** PostgreSQL + Drizzle (schema only; hand-written SQL migration), Hono, Zod, Vitest
(unit + Integration Tests), Go (`breeze-yarac`, built in a Docker stage), bash/Go for the pack pipeline.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` (§3 D2/D3/D7,
§4, §5, §7, §9, **§14 owner decision**). **W02 plan — the format contract §C1–C5 is binding here:**
`docs/superpowers/plans/security-auth/2026-10-13-yara-ioc-scanning-w02-agent-engine.md`. Tenancy:
`docs/agents/tenancy-rls.md` (mandatory). Migrations: `apps/api/migrations/README.md` (mandatory).


**Open Decisions:** numbered list with recommendations in the plan index
(`2026-09-18-yara-ioc-scanning.md` → "Open Decisions for W02/W03"). This plan is written to the
recommendations.

---

## Global Constraints

- **Starts only after W02 is merged** (needs `agent/cmd/breeze-yarac`, the golden bundle fixture, and
  the `breeze` provider). Branch `feature/6263-yara-ioc-scanning/wave-6266` from `origin/main`. If it is
  ever stacked on an unmerged branch, CI does not run — `gh workflow run CI --ref <branch>`.
- **The server never compiles to bytecode and never ships bytecode.** It stores and serves the
  published **source bundle** (W02 §C2) byte for byte; its only compile step is the pre-check.
- **Bundle bytes are reproduced exactly as W02 §C2 specifies.** The TS builder is tested against
  `agent/internal/yarascan/testdata/bundle-v1.golden.json` (+ `.sha256`).
- **One migration for Part A** (two tables + RLS + security_scans columns), named to sort after the
  newest file in `apps/api/migrations/` at implementation time; idempotent; no inner `BEGIN/COMMIT`;
  any row write preceded by `SELECT set_config('breeze.scope', 'system', true);`. Then
  `pnpm db:check-drift`.
- **RLS in the same migration that creates each table.** Both tables: `ENABLE` + `FORCE`.
- **Registration is not optional** (tenancy-rls.md step 4) — Task 3 lists every list and its CI job.
  `pnpm test` runs **none** of the cascade/export/RLS contract suites; they run only in the
  **Integration Tests** job (or locally via the commands in `docs/agents/testing.md`).
- **Partner-wide writes** go through `canManagePartnerWidePolicies(auth)`; create takes
  `ownerScope: 'organization' | 'partner'`; update schemas `.omit({ ownerScope: true })`; app-layer
  partner-wide reads are gated on `auth.scope === 'partner'`.
- **Built-in rows** (`is_builtin = true`, both owner columns NULL) are written only under
  `withSystemDbAccessContext` (boot upsert), never by a route.
- **Caps (spec §5.3):** 500 rules/set, 64 KiB source/rule, 10 000 strings/set (enforced by
  `breeze-yarac`), **20 sets per policy** (enforced here, in `parseSecurityScanSettings` and the
  feature-link write gate).
- **Copy rule (spec §11):** "detection rules", "IOC scan"; never "EDR"/"antivirus".
- Agent-shipped code is not touched in Part A except the Docker build of `breeze-yarac`; Part B's pack
  pipeline runs `go test -race` on anything Go it adds.

---

## Review Focus

1. **An org-scoped user lists rule sets** — must see own-org sets, its partner's partner-wide sets,
   and the built-in pack; must not see another org's sets or edit partner-wide/built-in ones.
   Pinned by `yaraRuleSetsPartnerRls.integration.test.ts` (Task 2) and route tests (Task 6).
2. **A device fetches a set it is not attached to** (valid agent token, guessed set id from its own
   partner). Expected 404. Pinned in Task 7 (`returns 404 for a set not attached to the device`).
3. **A rule edit breaks compilation while scans are in flight.** Expected: the set stays on its last
   published bundle, `stale = true`, the failing rule carries `compile_error`, in-flight fetches of the
   still-current published version succeed. Pinned in Task 5.
4. **An old agent gets a policy with rule sets.** Expected: payload has no `ruleSets`, the scan row
   records `engine = 'legacy'` and `rule_set_errors = [{id:'*', code:'agent_too_old'}]` — never a
   silent legacy scan presented as a YARA scan. Pinned in Task 8.
5. **Org merge / org delete with custom rule sets.** Expected: merged rows are repointed, deleted rows
   cascade; built-in untouched. Pinned by the cascade/merge integration suites after Task 3.

---

## Decisions this plan makes

- **DECISION W03-a — published snapshot columns replace the spec's `compiled bytea`.** `yara_rule_sets`
  stores `published_bundle bytea` + `published_sha256` + `published_version` (the last fully-valid
  bundle) and `current_version` (bumped on every edit). This is the source-model equivalent of spec
  §5.2's "keeps its last good bytecode and flags the set as stale".
- **DECISION W03-b — no version history table.** A fetch for a `version` other than `published_version`
  returns **409**; the agent reports `http_409` for that set and the next scan picks up the new version.
- **DECISION W03-c — `yara_rules` keeps denormalized `org_id`/`partner_id`/`is_builtin`, kept equal to
  the parent by a `BEFORE INSERT OR UPDATE` trigger** (`yara_rules_inherit_owner`). Rule source is
  customer IP and must ride the org export/erasure path, which keys on `org_id`.
- **DECISION W03-d — the fetch route additionally requires the set to be attached** to the device's
  effective security policy (or be the built-in pack). RLS alone would let a device read any
  partner-wide set of its partner.
- **DECISION W03-e — empty `ruleSetIds` = legacy scan.** Nothing switches to YARA until a policy
  attaches a set. (Whether new policies default to the built-in pack is a W04 UI call — Open Decision.)

---

## File structure

| Path | C/M | Responsibility |
|---|---|---|
| `apps/api/migrations/<newest+1>-yara-rule-sets.sql` | C | tables, CHECKs, trigger, RLS, security_scans columns |
| `apps/api/src/db/schema/yara.ts`, `schema/index.ts` | C/M | Drizzle schema |
| `apps/api/src/db/schema/security.ts` | M | `securityScans.engine`, `securityScans.ruleSetErrors` |
| `apps/api/src/services/tenantCascade.ts` | M | `CORE_ORG_CASCADE_DELETE_ORDER` += both |
| `apps/api/src/services/orgMergeRegistry.ts` | M | `repoint` both |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | M | both tables + 2 new security_scans columns |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | M | `DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` |
| `apps/api/src/__tests__/integration/yaraRuleSetsPartnerRls.integration.test.ts` | C | forge 42501, XOR/built-in 23514, isolation, built-in read, agent path |
| `packages/shared/src/types/yara.ts`, `packages/shared/src/utils/yaraBundle.ts` (+ test) | C | constants, `buildYaraBundle`, `YARA_BUILTIN_RULE_SET_ID` |
| `packages/shared/src/types/securityScan.ts`, `utils/securityScanSettings.ts` (+ test) | M | `ruleSetIds` (the only allowed widening) |
| `apps/api/src/services/yaraPrecheck.ts` (+ test) | C | spawn `breeze-yarac validate` |
| `apps/api/src/services/yaraRuleSetPublisher.ts` (+ test) | C | `publishRuleSet` |
| `apps/api/src/routes/security/yara.ts` (+ test), `routes/security/index.ts` | C/M | CRUD |
| `apps/api/src/routes/agents/yaraRuleSets.ts` (+ test), `routes/agents/index.ts` | C/M | agent fetch |
| `apps/api/src/services/yaraScanRefs.ts` (+ test) | C | `resolveYaraRuleSetRefs`, `agentSupportsYaraScan` |
| `apps/api/src/jobs/securityScanJobs.ts`, `routes/security/scans.ts` | M | payload `ruleSets`, dispatch outcome |
| `apps/api/src/routes/configurationPolicies/securityRuleSetGate.ts` (+ test) | C | policy may only attach visible sets |
| `apps/api/src/routes/agents/helpers.ts` | M | ingest `engine`, `ruleSetErrors` |
| `apps/api/Dockerfile`, `.dockerignore` | M | Go stage building `breeze-yarac` |
| **Part B** `scripts/security/yara-pack/*`, `.github/workflows/{ci,release}.yml`, `apps/api/src/services/yaraBuiltinPack.ts`, `index.ts` boot | C/M | pack pipeline + boot upsert |

---

## Part A — tables, pre-check, CRUD, delivery (independently shippable)

### Task 1: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/<YYYY-MM-DD-HHMMSS>-yara-rule-sets.sql`
- Create: `apps/api/src/db/schema/yara.ts`; Modify: `apps/api/src/db/schema/index.ts`, `apps/api/src/db/schema/security.ts`

**Interfaces:**
- Produces: tables `yara_rule_sets`, `yara_rules`; Drizzle `yaraRuleSets`, `yaraRules`;
  `securityScans.engine` (`varchar(16)` null), `securityScans.ruleSetErrors` (`jsonb` null).

- [ ] **Step 1: Name the file** — `ls apps/api/migrations/*.sql | sort | tail -1`; pick a timestamp
  strictly after it (newest at plan time: `2026-12-27-120000-…`).

- [ ] **Step 2: Write the migration**

```sql
-- #6263 W03: YARA rule sets (org XOR partner, plus one read-only built-in
-- pack) and their rules. Source bundles are published snapshots served to
-- agents, which compile on-device (owner decision 2026-10-13, spec §14).
-- Idempotent. RLS ships with the tables (tenancy-rls.md step 1).

CREATE TABLE IF NOT EXISTS public.yara_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  description text NULL,
  source varchar(50) NOT NULL DEFAULT 'custom',
  is_builtin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  auto_quarantine boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 0,
  published_version integer NOT NULL DEFAULT 0,
  published_bundle bytea NULL,
  published_sha256 char(64) NULL,
  published_at timestamptz NULL,
  published_engine varchar(64) NULL,
  published_policy integer NULL,
  stale boolean NOT NULL DEFAULT false,
  rule_count integer NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yara_rule_sets_source_chk CHECK (source IN ('builtin', 'custom', 'import')),
  -- Built-in ⇔ both owners NULL; otherwise exactly one owner (quorum finding:
  -- `is_builtin OR XOR` would let a tenant mint a globally readable "built-in").
  CONSTRAINT yara_rule_sets_one_owner_chk CHECK (
    (is_builtin AND org_id IS NULL AND partner_id IS NULL)
    OR (NOT is_builtin AND ((org_id IS NULL) <> (partner_id IS NULL)))
  ),
  CONSTRAINT yara_rule_sets_published_chk CHECK (
    (published_version = 0 AND published_bundle IS NULL AND published_sha256 IS NULL)
    OR (published_version > 0 AND published_bundle IS NOT NULL AND published_sha256 ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX IF NOT EXISTS yara_rule_sets_org_idx ON public.yara_rule_sets (org_id);
CREATE INDEX IF NOT EXISTS yara_rule_sets_partner_idx ON public.yara_rule_sets (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS yara_rule_sets_single_builtin_idx ON public.yara_rule_sets ((true)) WHERE is_builtin;

CREATE TABLE IF NOT EXISTS public.yara_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES public.yara_rule_sets(id) ON DELETE CASCADE,
  org_id uuid NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  is_builtin boolean NOT NULL DEFAULT false,
  name varchar(128) NOT NULL,
  source text NOT NULL,
  severity threat_severity NOT NULL DEFAULT 'high',
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb NULL,
  enabled boolean NOT NULL DEFAULT true,
  compile_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yara_rules_name_chk CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  CONSTRAINT yara_rules_source_len_chk CHECK (octet_length(source) <= 65536),
  CONSTRAINT yara_rules_one_owner_chk CHECK (
    (is_builtin AND org_id IS NULL AND partner_id IS NULL)
    OR (NOT is_builtin AND ((org_id IS NULL) <> (partner_id IS NULL)))
  ),
  CONSTRAINT yara_rules_set_name_uniq UNIQUE (rule_set_id, name)
);
CREATE INDEX IF NOT EXISTS yara_rules_org_idx ON public.yara_rules (org_id);
CREATE INDEX IF NOT EXISTS yara_rules_partner_idx ON public.yara_rules (partner_id);

-- DECISION W03-c: the child's owner columns always equal the parent's.
CREATE OR REPLACE FUNCTION public.yara_rules_inherit_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  SELECT org_id, partner_id, is_builtin INTO p FROM public.yara_rule_sets WHERE id = NEW.rule_set_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'yara_rules.rule_set_id % not visible or missing', NEW.rule_set_id USING ERRCODE = '23503';
  END IF;
  NEW.org_id := p.org_id; NEW.partner_id := p.partner_id; NEW.is_builtin := p.is_builtin;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS yara_rules_inherit_owner_trg ON public.yara_rules;
CREATE TRIGGER yara_rules_inherit_owner_trg BEFORE INSERT OR UPDATE ON public.yara_rules
  FOR EACH ROW EXECUTE FUNCTION public.yara_rules_inherit_owner();

-- Org merge repoints yara_rule_sets.org_id; keep children in step.
CREATE OR REPLACE FUNCTION public.yara_rule_sets_propagate_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
    UPDATE public.yara_rules SET org_id = NEW.org_id, partner_id = NEW.partner_id WHERE rule_set_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS yara_rule_sets_propagate_owner_trg ON public.yara_rule_sets;
CREATE TRIGGER yara_rule_sets_propagate_owner_trg AFTER UPDATE OF org_id, partner_id ON public.yara_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.yara_rule_sets_propagate_owner();

ALTER TABLE public.yara_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rule_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rules FORCE ROW LEVEL SECURITY;

-- Dual-axis FOR ALL (security_policies shape, 2026-07-01). Built-in rows have
-- both owners NULL, so only system scope can write them.
DROP POLICY IF EXISTS yara_rule_sets_isolation ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_isolation ON public.yara_rule_sets
  USING (public.breeze_current_scope() = 'system'
         OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
         OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)))
  WITH CHECK (public.breeze_current_scope() = 'system'
         OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
         OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)));
-- Partner-wide SELECT branch: separate, SELECT-only (never appended to FOR ALL).
DROP POLICY IF EXISTS yara_rule_sets_partner_wide_select ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_partner_wide_select ON public.yara_rule_sets
  FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
-- Built-in SELECT branch (alert_templates precedent, 2026-04-22).
DROP POLICY IF EXISTS yara_rule_sets_builtin_select ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_builtin_select ON public.yara_rule_sets
  FOR SELECT USING (is_builtin);

DROP POLICY IF EXISTS yara_rules_isolation ON public.yara_rules;
CREATE POLICY yara_rules_isolation ON public.yara_rules
  USING (public.breeze_current_scope() = 'system'
         OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
         OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)))
  WITH CHECK (public.breeze_current_scope() = 'system'
         OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
         OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)));
DROP POLICY IF EXISTS yara_rules_partner_wide_select ON public.yara_rules;
CREATE POLICY yara_rules_partner_wide_select ON public.yara_rules
  FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
DROP POLICY IF EXISTS yara_rules_builtin_select ON public.yara_rules;
CREATE POLICY yara_rules_builtin_select ON public.yara_rules
  FOR SELECT USING (is_builtin);

-- Scan outcome (quorum finding: degraded coverage must be explicit).
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS engine varchar(16) NULL;
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS rule_set_errors jsonb NULL;
```

The trigger's `SELECT` from `yara_rule_sets` runs under the caller's RLS — a caller who cannot see the
parent gets `23503`, which is the behaviour we want (no writing children under someone else's set).

- [ ] **Step 3: Drizzle schema** `apps/api/src/db/schema/yara.ts` mirroring every column above
  (`bytea` via the repo's existing custom type — `grep -rn "customType<.*Buffer" apps/api/src/db/schema | head -1`),
  export from `schema/index.ts`; add `engine: varchar('engine', { length: 16 })` and
  `ruleSetErrors: jsonb('rule_set_errors')` to `securityScans`.

- [ ] **Step 4: Apply + drift**

```bash
pnpm test-stack up   # or a worktree stack; see docs/agents/local-stacks.md
export DATABASE_URL=postgresql://breeze:breeze@localhost:<port>/breeze
pnpm db:migrate && pnpm db:migrate   # second run proves idempotency
pnpm db:check-drift
```

Expected: both runs succeed; drift clean.

- [ ] **Step 5: Commit** — `feat(db): yara_rule_sets + yara_rules with dual-axis + built-in RLS (#6266)`.

---

### Task 2: RLS functional proof (Integration Tests)

**Files:**
- Create: `apps/api/src/__tests__/integration/yaraRuleSetsPartnerRls.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Write the suite** (copy the harness from an existing `*PartnerRls.integration.test.ts`,
  e.g. `customFieldDefinitionsPartnerRls.integration.test.ts`: two partners P1/P2, orgs O1a/O1b under
  P1, O2 under P2). Cases, each a separate `it`:

```ts
it('org O1a sees own-org, P1 partner-wide and built-in sets; not O1b or P2 sets', async () => {
  const ids = await asOrg(O1a, (db) => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets));
  expect(new Set(ids.map((r) => r.id))).toEqual(new Set([setO1a, setP1, builtinId]));
});
it('org O1a cannot UPDATE a P1 partner-wide set (SELECT-only branch)', async () => {
  const n = await asOrg(O1a, (db) => db.update(yaraRuleSets).set({ name: 'x' }).where(eq(yaraRuleSets.id, setP1)).returning());
  expect(n).toHaveLength(0);
});
it('nobody but system can UPDATE the built-in set', async () => {
  for (const ctx of [asOrg(O1a), asPartner(P1)]) {
    const n = await ctx((db) => db.update(yaraRuleSets).set({ enabled: false }).where(eq(yaraRuleSets.id, builtinId)).returning());
    expect(n).toHaveLength(0);
  }
});
it('partner P1 cannot forge a P2-owned set (42501)', async () => {
  await expect(asPartner(P1, (db) => db.insert(yaraRuleSets).values({ partnerId: P2, name: 'f' }))).rejects.toMatchObject({ code: '42501' });
});
it('a tenant cannot mint a built-in (23514)', async () => {
  await expect(asPartner(P1, (db) => db.insert(yaraRuleSets).values({ partnerId: P1, isBuiltin: true, name: 'f' }))).rejects.toMatchObject({ code: '23514' });
});
it('both owners set is rejected (23514)', async () => {
  await expect(asSystem((db) => db.insert(yaraRuleSets).values({ orgId: O1a, partnerId: P1, name: 'f' }))).rejects.toMatchObject({ code: '23514' });
});
it('yara_rules inherits owner from the parent even if the caller lies', async () => {
  const [row] = await asPartner(P1, (db) => db.insert(yaraRules).values({ ruleSetId: setP1, orgId: O1a, name: 'r', source: 'rule r { condition: true }' }).returning());
  expect(row.orgId).toBeNull();
  expect(row.partnerId).toBe(P1);
});
it('org O1a cannot insert a rule into a P1 partner-wide set', async () => {
  await expect(asOrg(O1a, (db) => db.insert(yaraRules).values({ ruleSetId: setP1, name: 'r', source: 'rule r { condition: true }' }))).rejects.toBeTruthy();
});
it('agent-auth context of a device in O1a sees O1a, P1-wide and built-in sets only', async () => {
  // Use the same context helper middleware/agentAuth.ts uses (orgId = device org, currentPartnerId = device partner).
  const ids = await asAgent({ orgId: O1a, partnerId: P1 }, (db) => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets));
  expect(new Set(ids.map((r) => r.id))).toEqual(new Set([setO1a, setP1, builtinId]));
});
// Partner-Wide First step 5 — converted to a real case in Task 8 (needs resolveYaraRuleSetRefs).
it.todo('fan-out: a P1 partner-wide set attached to a P1 partner policy resolves for devices in BOTH O1a and O1b');
```

The last case is filled in at Task 8 (it needs the resolver); add it here as `it.todo` and convert it
in Task 8 — the suite must not ship with the todo.

- [ ] **Step 2: Register in `rls-coverage.integration.test.ts`** — add both tables to
  `DUAL_AXIS_TENANT_TABLES` and to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (with a comment naming the built-in
  carve-out and this suite). If the XOR assertion parses the CHECK text and rejects the built-in
  disjunct, **do not** loosen the assertion: add a narrowly-named
  `XOR_WITH_BUILTIN_CARVE_OUT = new Set(['yara_rule_sets', 'yara_rules'])` that the assertion accepts
  only with the exact `(is_builtin AND org_id IS NULL AND partner_id IS NULL) OR (NOT is_builtin AND …)`
  shape, and say so in the PR.
- [ ] **Step 3: Run** — the Integration Tests command for one file from `docs/agents/testing.md`
  (never `pnpm --filter … test -- --run <path>`). Expected: PASS after Task 1, FAIL on a scratch copy of
  the migration with the built-in SELECT policy removed (prove the suite discriminates; revert).
- [ ] **Step 4: Commit** — `test(api): yara rule set RLS proof incl. built-in and agent path (#6266)`.

---

### Task 3: Every registration list

**Files (all Modify):** `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`,
`apps/api/src/services/tenantExportPolicyRegistry.ts`.

- [ ] **Step 1: Run the contract suites first and watch them fail** (they discover new `org_id` tables):
  `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `orgMerge.test.ts` (full
  unit suite — it reds only in the full run), `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`. Expected: FAIL naming `yara_rule_sets`,
  `yara_rules`, and the two new `security_scans` columns.
- [ ] **Step 2: `CORE_ORG_CASCADE_DELETE_ORDER`** — insert alphabetically before `'organizations'`
  (after `'webhooks'`): `'yara_rule_sets'`, `'yara_rules'`. If the cascade suite reports an FK-order
  violation, child first is the fix (`'yara_rules'` then `'yara_rule_sets'`), with a one-line comment.
- [ ] **Step 3: `orgMergeRegistry.ts`** — add both to the plain `repoint` list (alphabetical). The
  `yara_rule_sets_propagate_owner` trigger also rewrites children; repointing `yara_rules` directly is
  harmless and keeps the registry total.
- [ ] **Step 4: `CORE_TENANT_EXPORT_POLICY`**

```ts
  "yara_rule_sets": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","description","source","is_builtin","enabled","auto_quarantine","current_version","published_version","published_sha256","published_at","published_engine","published_policy","stale","rule_count","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["published_bundle"]}),
  "yara_rules": tablePolicy("org_id", {"included":["id","rule_set_id","org_id","partner_id","is_builtin","name","source","severity","tags","enabled","compile_error","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["meta"]}),
```

  and on the existing `security_scans` entry: `engine` → `included`, `rule_set_errors` → `excludedOpen`
  (jsonb rule from CLAUDE.md).
- [ ] **Step 5: Device/ticket lists** — neither table has `device_id` or `ticket_id`; record "N/A,
  checked" in the PR. `security_scans` is already registered in the device lists.
- [ ] **Step 6: Re-run Step 1's suites** → PASS. Commit
  `feat(api): register yara tables in cascade, merge and export contracts (#6266)`.

---

### Task 4: Shared contract — bundle builder and `ruleSetIds`

**Files:**
- Create: `packages/shared/src/types/yara.ts`, `packages/shared/src/utils/yaraBundle.ts`, `packages/shared/src/utils/yaraBundle.test.ts`
- Modify: `packages/shared/src/types/securityScan.ts`, `packages/shared/src/utils/securityScanSettings.ts`, `securityScanSettings.test.ts`, barrel exports

**Interfaces:**
- Produces:
  - `YARA_BUNDLE_FORMAT = 'breeze-yara-bundle'`, `YARA_BUNDLE_FORMAT_VERSION = 1`, `YARA_MAX_RULE_SETS_PER_POLICY = 20`, `YARA_BUILTIN_RULE_SET_ID = '00000000-0000-4000-8000-00000000b001'`
  - `interface YaraBundleRuleInput { id: string; name: string; severity: 'low'|'medium'|'high'|'critical'; source: string }`
  - `function buildYaraBundle(input: { ruleSetId: string; version: number; autoQuarantine: boolean; rules: YaraBundleRuleInput[] }): { bytes: Uint8Array; sha256: string }` (sha256 via `node:crypto` in the API; the shared util takes a hasher param so web can import types without node — `buildYaraBundleJson()` returns the string; the API wraps hashing)
  - `interface YaraRuleSetRef { id: string; version: number; sha256: string; url: string }`
  - `SecurityScanSettings.ruleSetIds: string[]`, default `[]`; parser keeps unique lowercase UUIDs, max 20, order preserved.

- [ ] **Step 1: Failing golden test**

```ts
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildYaraBundleJson } from './yaraBundle';

const fixtureDir = resolve(__dirname, '../../../../agent/internal/yarascan/testdata');

it('reproduces the W02 golden bundle byte for byte', () => {
  const golden = readFileSync(resolve(fixtureDir, 'bundle-v1.golden.json'));
  const sum = readFileSync(resolve(fixtureDir, 'bundle-v1.golden.json.sha256'), 'utf8').trim();
  const json = buildYaraBundleJson({
    ruleSetId: '00000000-0000-4000-8000-000000000001', version: 3, autoQuarantine: false,
    rules: [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'fixture_marker', severity: 'high',
      source: 'rule fixture_marker : fixture { meta: threat_type = "pup" strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }' }],
  });
  expect(Buffer.from(json, 'utf8').equals(golden)).toBe(true);
  expect(createHash('sha256').update(json, 'utf8').digest('hex')).toBe(sum);
});

it('sorts rules by id regardless of input order', () => {
  const a = buildYaraBundleJson({ ruleSetId: 's', version: 1, autoQuarantine: false, rules: [
    { id: 'b', name: 'rb', severity: 'low', source: 'rule rb { condition: true }' },
    { id: 'a', name: 'ra', severity: 'low', source: 'rule ra { condition: true }' }] });
  expect(a.indexOf('"id":"a"')).toBeLessThan(a.indexOf('"id":"b"'));
});
```

plus `securityScanSettings.test.ts` cases: `ruleSetIds` defaults to `[]`; drops non-UUIDs and
duplicates; truncates to 20; lower-cases.

- [ ] **Step 2: Run to fail** — `cd packages/shared && npx vitest run src/utils/yaraBundle src/utils/securityScanSettings`.
- [ ] **Step 3: Implement**

```ts
export function buildYaraBundleJson(input: {
  ruleSetId: string; version: number; autoQuarantine: boolean; rules: YaraBundleRuleInput[];
}): string {
  const rules = [...input.rules].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  // Key order is part of the contract (W02 §C2): build objects literally, never spread.
  return JSON.stringify({
    format: YARA_BUNDLE_FORMAT,
    v: YARA_BUNDLE_FORMAT_VERSION,
    ruleSetId: input.ruleSetId,
    version: input.version,
    autoQuarantine: input.autoQuarantine,
    rules: rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity, source: r.source })),
  });
}
```

  Widen `SecurityScanSettings`, `SECURITY_SCAN_SETTINGS_DEFAULTS` and `parseSecurityScanSettings` **in
  the same commit** (plan index rule).
- [ ] **Step 4: Run to pass**; also `cd apps/web && npx tsc --noEmit -p .` (the Security tab spreads the
  settings type — confirm it still compiles; no UI change in W03).
- [ ] **Step 5: Commit** — `feat(shared): YARA bundle builder (W02 golden) + ruleSetIds setting (#6266)`.

---

### Task 5: Pre-check service and publisher; `breeze-yarac` in the API image

**Files:**
- Create: `apps/api/src/services/yaraPrecheck.ts` (+ `.test.ts`), `apps/api/src/services/yaraRuleSetPublisher.ts` (+ `.test.ts`)
- Modify: `apps/api/Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: `buildYaraBundleJson` (Task 4); `breeze-yarac validate` (W02 Task 10, C5 output JSON).
- Produces:
  - `type YaraPrecheckResult = { ok: true } | { ok: false; errors: Array<{ ruleId: string; name: string; code: string; message: string; line?: number }> } | { ok: false; unavailable: string }`
  - `function precheckYaraBundle(json: string): Promise<YaraPrecheckResult>` — spawns `process.env.BREEZE_YARAC_PATH ?? '/usr/local/bin/breeze-yarac'`, args `['validate']`, stdin = bundle, 30 s timeout, stdout ≤ 1 MiB, at most 2 concurrent (module-level semaphore)
  - `function publishRuleSet(tx: DbTx, ruleSetId: string): Promise<{ published: boolean; version: number; stale: boolean }>` — must be called inside the caller's `withDbAccessContext` transaction

- [ ] **Step 1: Failing tests** — `yaraPrecheck.test.ts` mocks `node:child_process.spawn`:
  ok exit 0 → `{ok:true}`; exit 1 with C5 JSON → errors parsed; ENOENT → `{ok:false, unavailable}`;
  timeout → `unavailable: 'timeout'` and the child is killed; stdout over 1 MiB → `unavailable`.
  `yaraRuleSetPublisher.test.ts` (mock db + `precheckYaraBundle`):

  Each case seeds a mock set `{ id: 'S', currentVersion: 3, publishedVersion: 3, autoQuarantine: false }`
  and rules `R1` (enabled), `R2` (enabled), `R3` (disabled), using the mock-db capture pattern of
  `apps/api/src/services/*Policy*.test.ts`, and asserts on the captured `update(...).set(...)` calls:

| Test | `precheckYaraBundle` mock | Expected set update | Expected rule updates | Return |
|---|---|---|---|---|
| clean publish | `{ok:true}` | `currentVersion 4, publishedVersion 4, publishedBundle = Buffer(buildYaraBundleJson({ruleSetId:'S',version:4,…R1,R2}))`, `publishedSha256 = sha256(that)`, `stale false`, `ruleCount 2` | `R1,R2 compileError null` | `{published:true,version:4,stale:false}` |
| one rule fails | `{ok:false, errors:[{ruleId:'R2',code:'compile',message:'x'}]}` | `currentVersion 4, stale true`, **no** `published*` keys | `R1 null`, `R2 'compile: x'` | `{published:false,version:3,stale:true}` |
| disabled excluded | `{ok:true}` | the JSON passed to the mock contains `"R1"` and `"R2"`, not `"R3"` | — | — |
| unavailable in production | `{ok:false, unavailable:'ENOENT'}`, `NODE_ENV=production` | `stale true`, no `published*` | — | `{published:false,…}` |
| lint-only in dev | same, `NODE_ENV=test`, `BREEZE_YARA_LINT_ONLY=1` | `publishedEngine 'lint-only'`, `publishedPolicy null` | — | `{published:true,…}` |
| empty set | `{ok:true}`, no rules | bundle JSON ends with `"rules":[]}`, `ruleCount 0` | — | `{published:true,…}` |
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement `publishRuleSet`**

```ts
export async function publishRuleSet(tx: DbTx, ruleSetId: string) {
  const [set] = await tx.select().from(yaraRuleSets).where(eq(yaraRuleSets.id, ruleSetId)).for('update');
  if (!set) throw new NotFoundError('rule set');
  const rules = await tx.select().from(yaraRules)
    .where(and(eq(yaraRules.ruleSetId, ruleSetId), eq(yaraRules.enabled, true)));
  const version = set.currentVersion + 1;
  const json = buildYaraBundleJson({
    ruleSetId, version, autoQuarantine: set.autoQuarantine,
    rules: rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity, source: r.source })),
  });
  const check = await precheckYaraBundle(json);
  const errorsByRule = new Map<string, string>();
  if (!check.ok && 'errors' in check) for (const e of check.errors) errorsByRule.set(e.ruleId, `${e.code}: ${e.message}`.slice(0, 2000));
  await Promise.all(rules.map((r) => tx.update(yaraRules)
    .set({ compileError: errorsByRule.get(r.id) ?? null }).where(eq(yaraRules.id, r.id))));
  const usable = check.ok || ('unavailable' in check && process.env.NODE_ENV !== 'production' && process.env.BREEZE_YARA_LINT_ONLY === '1');
  if (!usable) {
    await tx.update(yaraRuleSets).set({ currentVersion: version, stale: true, ruleCount: rules.length, updatedAt: new Date() })
      .where(eq(yaraRuleSets.id, ruleSetId));
    return { published: false, version: set.publishedVersion, stale: true };
  }
  const bytes = Buffer.from(json, 'utf8');
  await tx.update(yaraRuleSets).set({
    currentVersion: version, publishedVersion: version, publishedBundle: bytes,
    publishedSha256: createHash('sha256').update(bytes).digest('hex'), publishedAt: new Date(),
    publishedEngine: check.ok ? await yaracEngineVersion() : 'lint-only', publishedPolicy: check.ok ? YARAC_POLICY_VERSION : null,
    stale: false, ruleCount: rules.length, updatedAt: new Date(),
  }).where(eq(yaraRuleSets.id, ruleSetId));
  return { published: true, version, stale: false };
}
```

  `yaracEngineVersion()` runs `breeze-yarac version` once and memoizes `{engine, policy}`;
  `YARAC_POLICY_VERSION` is that memoized `policy`.
- [ ] **Step 4: Dockerfile** — `.dockerignore` currently excludes `agent`. Add exceptions so only what
  the build needs enters the context: `!agent/go.mod`, `!agent/go.sum`, `!agent/cmd/breeze-yarac/**`,
  `!agent/internal/**` (Go needs the transitive internal packages; confirm with
  `go list -deps ./cmd/breeze-yarac | grep breeze-rmm`), and keep `agent/**/testdata` excluded. Add a
  stage before `runner`:

```dockerfile
FROM golang:1.26-alpine@sha256:<pin current digest> AS yarac
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/breeze-yarac ./cmd/breeze-yarac
```

  and in `runner`: `COPY --from=yarac /out/breeze-yarac /usr/local/bin/breeze-yarac`. Pin the digest
  (`scripts/security/check-supply-chain-hardening.sh` and `check-go-version-pins.sh` must stay green).
  Run `scripts/security/check-agent-binary-signatures.sh` against the extracted binary in the API image
  CI job.
- [ ] **Step 5: Run** — unit tests PASS; `docker build -f apps/api/Dockerfile .` succeeds;
  `docker run --rm <img> breeze-yarac version` prints the engine + policy.
- [ ] **Step 6: Commit** — `feat(api): YARA pre-check via breeze-yarac and last-good publishing (#6266)`.

---

### Task 6: CRUD routes `routes/security/yara.ts`

**Files:** Create `apps/api/src/routes/security/yara.ts`, `yara.test.ts`; Modify `routes/security/index.ts`, `routes/security/schemas.ts`.

**Interfaces:**
- Produces (all under `/security/yara`, `requireScope('organization','partner','system')` + the same
  role permission as `routes/security/policies.ts:100-105`):
  - `GET /rule-sets` → `{ data: RuleSetSummary[] }` (no `source`, no bundle)
  - `POST /rule-sets` body `{ name, description?, ownerScope, orgId?, autoQuarantine? }` → created set
  - `GET /rule-sets/:id` → set + rules (with `compileError`)
  - `PATCH /rule-sets/:id` (schema `.omit({ ownerScope: true })`), `DELETE /rule-sets/:id`
  - `POST /rule-sets/:id/rules` body `{ name, source, severity?, tags?, enabled? }`
  - `PATCH /rules/:ruleId`, `DELETE /rules/:ruleId`
  - Every rule mutation and every `autoQuarantine`/`enabled` change runs `publishRuleSet` in the same
    transaction and returns `{ published, version, stale }`.
  - Built-in set: every mutation → 403 `builtin rule set is read-only`.
  - Partner-wide create/update/delete → `canManagePartnerWidePolicies(auth)` else 403.
  - Each mutation writes an audit event (`writeAuditEvent`, action `security.yara_rule_set.*` /
    `security.yara_rule.*`), with names/ids only — never rule source.
- [ ] **Step 1: Failing tests** covering: org user creates org set; org user cannot create
  partner-wide (403); partner admin without partner-wide permission → 403; PATCH ignores
  `ownerScope`; built-in mutation 403; adding a rule calls `publishRuleSet` and returns its result;
  rule name/length validation 400 (Zod mirrors the DB CHECKs); org user listing does not include another
  org's set (app-layer filter gated on `auth.scope === 'partner'` for partner-wide rows).
- [ ] **Step 2: Run to fail.** **Step 3: Implement** following `routes/security/policies.ts` for
  scope/permission/ownerScope handling. **Step 4: Run to pass**, plus
  `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo EXIT=$?`.
- [ ] **Step 5: Commit** — `feat(api): YARA rule set CRUD with pre-check publishing (#6266)`.

---

### Task 7: Agent fetch route

**Files:** Create `apps/api/src/routes/agents/yaraRuleSets.ts`, `yaraRuleSets.test.ts`; Modify `apps/api/src/routes/agents/index.ts` (mount next to `agentSecurityRoutes`).

**Interfaces:**
- Produces: `GET /api/v1/agents/:id/yara/rule-sets/:ruleSetId/:version` (`:id` is the **agent id**,
  as every agent route — quorum finding). `requireAgentRole`. Responses per W02 §C2:
  200 + `Content-Type: application/vnd.breeze.yara-bundle+json` + `ETag: "<published_sha256>"` +
  body = `published_bundle`; 404 (not visible, disabled, never published, or not attached — W03-d);
  409 (`version !== published_version`).
- [ ] **Step 1: Failing tests**

  Fixture: device `D` (agent id `A`), policy settings `ruleSetIds = ['S']`, set `S`
  `{ publishedVersion: 4, publishedBundle: Buffer.from(GOLDEN_JSON), publishedSha256: GOLDEN_SHA, enabled: true }`,
  partner-wide set `P` visible but not attached, built-in `B` published at version 2.

| Request | Expected |
|---|---|
| `GET /api/v1/agents/A/yara/rule-sets/S/4` | 200; `await res.arrayBuffer()` equals `GOLDEN_JSON` bytes; `ETag === '"' + GOLDEN_SHA + '"'`; `Content-Type` = `application/vnd.breeze.yara-bundle+json` |
| `…/S/3` | 409 |
| `…/P/1` | 404 (W03-d) |
| `…/B/2` with `ruleSetIds = []` | 200 |
| `…/S/4` with `enabled: false` | 404 |
| `…/S/4` with a watchdog-role token | 403 (from `requireAgentRole`) |
| any of the above | `vi.spyOn(db, 'withSystemDbAccessContext')` never called |

- [ ] **Step 2: Run to fail.** **Step 3: Implement** — resolve the device by `agentId` (same query as
  `routes/agents/security.ts:72`), `resolveSecurityScanPolicyForDevice(device.id)` →
  `settings.ruleSetIds`; allow when `ruleSetId === YARA_BUILTIN_RULE_SET_ID` or it is in that list;
  read the set under the request's existing agent DB context (RLS gives the partner-wide and built-in
  branches — no `withSystemDbAccessContext`). Return `c.body(bundle, 200, headers)`.
- [ ] **Step 4: Run to pass.** **Step 5: Commit** — `feat(api): agent-authenticated YARA bundle fetch (#6266)`.

---

### Task 8: Payload `ruleSets`, version gate, explicit outcome; policy write gate

**Files:**
- Create: `apps/api/src/services/yaraScanRefs.ts` (+ test), `apps/api/src/routes/configurationPolicies/securityRuleSetGate.ts` (+ test)
- Modify: `apps/api/src/jobs/securityScanJobs.ts`, `apps/api/src/routes/security/scans.ts`, `apps/api/src/routes/configurationPolicies/featureLinks.ts` (wire the gate next to `securityQuarantineGate`), `apps/api/src/routes/agents/helpers.ts`, the Task 2 integration suite (convert the `it.todo`)

**Interfaces:**
- Produces:
  - `MIN_AGENT_VERSION_YARA_SCAN` = the first release tag containing W02's merge commit
    (`git tag --contains <W02 merge sha> | sort -V | head -1`); `agentSupportsYaraScan(agentVersion)`
    copied from the core-semver pattern in `services/systemCleanup.ts:53`.
  - `resolveYaraRuleSetRefs(input: { agentId: string; ruleSetIds: string[] }): Promise<{ refs: YaraRuleSetRef[]; errors: Array<{ id: string; code: 'not_found'|'disabled'|'not_published' }> }>` — reads under the caller's DB context; keeps `ruleSetIds` order; url = `/api/v1/agents/${agentId}/yara/rule-sets/${id}/${published_version}`.
  - `buildSecurityScanPayload(scanRecordId, scanType, settings, paths?, ruleSets?)` — 5th param
    optional; key emitted only when non-empty (W02 C1).
  - Dispatch writes `security_scans.engine` = `'yara'` (refs sent) or `'legacy'`, and
    `rule_set_errors` = resolver errors plus `{id:'*', code:'agent_too_old'}` when gated.
- [ ] **Step 1: Failing tests** — resolver: order kept, disabled/unpublished/missing reported,
  built-in included when listed; gate: old agent → no `ruleSets`, `engine='legacy'`,
  `agent_too_old` recorded; payload builder: no key when empty (snapshot of the W01 payload shape
  unchanged); policy gate: an org policy may attach own-org, its partner's partner-wide and built-in
  sets; a partner policy may attach partner-wide and built-in only (never an org set); > 20 ids → 400;
  ingest: agent result `engine` + `ruleSetErrors` overwrite the dispatch values on the scan row
  (agent-reported fetch/compile failures appended to dispatch-time ones).
- [ ] **Step 2: Run to fail.** **Step 3: Implement**; convert the Task 2 fan-out `it.todo` into a real
  integration case: a P1 partner policy with `ruleSetIds=[setP1]` assigned partner-wide resolves refs
  for one device in O1a **and** one in O1b (Partner-Wide First step 5).
- [ ] **Step 4: Run** unit + the integration suite. **Step 5: Commit** —
  `feat(api): security scans carry YARA rule-set refs behind an agent-version gate (#6266)`.

---

### Task 9: Part A sweep and PR

- [ ] Repo-wide sweep (Partner-Wide First step 7): `grep -rn "yaraRuleSets\.\(orgId\|partnerId\)" apps/api/src`
  — every read path is either RLS-scoped or gated on `auth.scope === 'partner'`; AI tools / MCP: none
  read these tables in W03 (W05 adds them) — confirm with `grep -rn yara apps/api/src/services/aiTools*`.
- [ ] Full matrix: `cd apps/api && npx vitest run src/routes/security src/routes/agents src/jobs/securityScanJobs src/services/yara*`;
  `packages/shared` tests; `tsc` (exit code checked); Integration Tests suites from Tasks 2–3 and 8.
- [ ] PR from `feature/6263-yara-ioc-scanning/wave-6266` (or `…/wave-<W03a sub-issue>` if split), body
  `Closes #6266` (or the W03a sub-issue), listing W03-a…e, the registration table (each list → done),
  and "migration: 1 file, RLS same file". The settings rule-9 checkbox: `ruleSetIds` home = Security
  tab (Config Policy `security` feature link), level = policy, resolver =
  `resolveSecurityScanPolicyForDevice`, configured in 1 place before and after.

---

## Part B — built-in pack pipeline (independently shippable after Part A)

### Task 10: Pack builder + license filter

**Files:** Create `scripts/security/yara-pack/build-pack.sh`, `scripts/security/yara-pack/filter.go` (+ `filter_test.go`), `scripts/security/yara-pack/LICENSES.allow`, `scripts/security/yara-pack/README.md` (operator notes only; required by the pipeline, not a doc page).

- [ ] **Step 1: Failing `filter_test.go`** — given fixture rules with `meta: license = "…"` /
  `author`/`reference`: Apache-2.0, MIT, BSD-2/3, CC0-1.0 kept; `Elastic License 2.0`, `DRL`, any
  `GPL`, missing license → dropped; rules importing a module Task 1 of W02 found missing → dropped;
  output is a W02 §C2 bundle with `ruleSetId = YARA_BUILTIN_RULE_SET_ID`, deterministic `rules[].id`
  = UUIDv5(namespace = builtin id, name = rule name).
- [ ] **Step 2: Implement** `filter.go` (Go, `go test -race`), invoking `breeze-yarac validate` on the
  result and dropping rules it rejects (each drop logged with the reason in `pack-report.json`).
- [ ] **Step 3: `build-pack.sh <forge-release-tag>`** downloads the pinned YARA Forge **core** release
  zip, verifies its sha256 against `scripts/security/yara-pack/forge.sha256`, runs the filter, writes
  `dist/breeze-yara-builtin-<version>.json` + `.sha256` + `pack-report.json`.
- [ ] **Step 4: Commit** — `feat(security): built-in YARA pack builder with license filter (#6266)`.

### Task 11: Clean-corpus false-positive CI

- [ ] Add a CI job `yara-pack-fp` (runs when `scripts/security/yara-pack/**` or the pinned tag
  changes, and nightly): build the pack, run `breeze-yarac scan --bundle <pack> <corpus>` over a
  clean corpus (a fresh `ubuntu-latest` runner's `/usr`, plus the Windows runner's
  `C:\Windows\System32` in a `windows-latest` job). **Any match fails the job** and prints the rule
  name; the fix is to add the rule to `scripts/security/yara-pack/denylist.txt` with a reason.
- [ ] Commit — `ci(security): clean-corpus false-positive gate for the built-in YARA pack (#6266)`.

### Task 12: Ship the pack and upsert it at boot

**Files:** Modify `.github/workflows/release.yml` (build + attach pack + add to the signed release
manifest the agent binaries already use — follow how `binarySync` resolves artifacts:
`grep -n "manifest" apps/api/src/services/binarySync.ts | head`); Create
`apps/api/src/services/yaraBuiltinPack.ts` (+ test); Modify `apps/api/src/index.ts` (after
`syncBinaries()`).

**Interfaces:**
- Produces: `syncBuiltinYaraPack(): Promise<'unchanged'|'updated'|'skipped'>` — under
  `runOutsideDbContext(() => withSystemDbAccessContext(...))`; verifies the pack sha256 from the signed
  manifest; upserts the single built-in `yara_rule_sets` row (`id = YARA_BUILTIN_RULE_SET_ID`,
  `is_builtin = true`, `auto_quarantine = true` per D7, `source = 'builtin'`) and its `yara_rules`;
  publishes with the bundle bytes **exactly as shipped** (no rebuild — the release artifact is the
  published bundle); `published_version` = pack's monotonically increasing integer version.
- [ ] Tests: idempotent second boot → `'unchanged'`; tampered sha → `'skipped'` + error log, existing
  row untouched; newer version → `'updated'` and old rules removed; never runs in request context.
- [ ] Commit — `feat(api): ship and upsert the built-in YARA pack at boot (#6266)`.

### Task 13: Part B PR

- [ ] Benchmark sanity on the lab rig with the real built pack (reuse W02 Task 11 harness); record in
  spec §14. PR body `Closes #<W03b sub-issue>` if split, else part of #6266's PR series.

---

## Self-review

- Spec §12 W03 row: tables + RLS + every registration list (T1–T3) ✔; `breeze-yarac` (now pre-check
  only, in the API image — T5) ✔; CRUD (T6) ✔; YARA Forge pipeline + license filter + clean-corpus CI
  (T10–T11) ✔; binarySync insert (T12) ✔; `provider = 'breeze'` — already shipped in W02 ✔.
- §4 data model: changed per owner decision (`compiled bytea` → published bundle snapshot; W03-a),
  quorum built-in CHECK correction, denormalized child owner kept with a trigger (W03-c).
- §5.2 last-good + stale ✔ (T5). §5.3 caps ✔ (yarac + T4/T8 for 20/policy). §5.4 delivery ✔ (T7–T8).
- §9: device-authenticated, sha256-pinned ✔; partner sets editable only by partner admins ✔ (T6);
  built-in read-only ✔ (T1 RLS + T6); `meta` and bundle `excludedOpen` ✔ (T3).
- Out of W03 by design: test-upload route, IOC importer, UI (W04); sweep, AI tool, audit-event UI (W05).
