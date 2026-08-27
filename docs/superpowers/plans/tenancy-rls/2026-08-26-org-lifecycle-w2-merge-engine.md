---
tracking_issue: LanternOps/breeze#4074
wave: LanternOps/breeze#4076
---

# Org Lifecycle Wave 2: Merge Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge organization A (loser) into organization B (survivor) within one partner: preview → fenced single-transaction re-tenant driven by an exhaustive per-table policy registry → durable merge record → erasure of the empty loser shell — with sent-quote links surviving the move.

**Architecture:** A merge-policy registry (mirroring the export-policy registry contract) classifies every org-scoped table; a queued BullMQ job fences the loser (`merging` status), executes all re-points in one system-context transaction with `SET CONSTRAINTS ALL DEFERRED` (Wave 1 made the composite FKs deferrable — order between parent/child re-points no longer matters for FK correctness; both org rows exist throughout the tx, so plain `org_id → organizations(id)` FKs never break either), writes `org_merge_events` + org-less audit, marks the loser `deletedAt`, and enqueues the existing tenant erasure. Public quote routes gain a merge-mapping fallback.

**Tech Stack:** Drizzle + raw `sql` templates (`sql.identifier` pattern from `routes/devices/moveOrg.ts:143-217`), BullMQ (pattern from `jobs/tenantErasure.ts`), Hono routes, Vitest unit + integration.

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md`

## Global Constraints

- Depends on Wave 1 (enum values, deferrable FKs, `org_merge_events`). Branch off the Wave-1 branch if unmerged — **stacked PRs get NO CI**: dispatch `gh workflow run CI --ref <branch>` before merging.
- Same-partner only. `quick_support` orgs are refused as either loser or survivor (`internal` is an ordinary org type — allowed). Survivor must be `status IN ('active','trial')`; loser must be `status IN ('active','trial','suspended')`.
- All merge DB work under `withSystemDbAccessContext` — one call = one transaction (the context itself opens `baseDb.transaction`, `db/index.ts:436-488`); do NOT nest `db.transaction` inside it.
- Registry has NO default policy. The contract test partitions `getOrgCascadeDeleteOrder()` ∪ associated/system tables exactly.
- Unit tests asserting built SQL must compile via `PgDialect` (never assert mock-call shapes; SET vs WHERE column qualification differs — see repo memory on vacuous Drizzle assertions).
- Threshold: `ORG_MERGE_MAX_ROWS` env (default `500000`); preview verdict `too-large` blocks execute.
- Mutation endpoints: `requireScope('partner', 'system')`, `requireOrgWrite`, `requireMfa()` — copy the chain from `routes/orgs.ts:1865`. Merge execute additionally verifies `confirmName` equals the loser's exact name server-side.
- Run integration suites explicitly (`pnpm test:integration <paths>` — no `--`).

---

### Task 1: Merge-policy registry + completeness contract test

**Files:**
- Create: `apps/api/src/services/orgMergeRegistry.ts`
- Test: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OrgMergePolicy =
    | { kind: 'repoint' }
    | { kind: 'keep-survivor' }                                   // singleton config: survivor row wins, loser's dropped
    | { kind: 'repoint-dedupe'; key: readonly string[]; keyWhere?: string } // drop loser rows colliding on key (within optional partial predicate), repoint the rest
    | { kind: 'custom'; note: string }                            // executor implemented in orgMerge.ts CUSTOM_EXECUTORS
    | { kind: 'leave-for-erasure'; note: string }
    | { kind: 'derived'; note: string }                           // trigger-maintained; never written directly
    | { kind: 'follows-parent'; note: string }                    // no org_id column; rows travel with their parent
    | { kind: 'loser-shell' };                                    // organizations itself
  export function getOrgMergePolicies(): ReadonlyMap<string, OrgMergePolicy>;
  ```
- Consumes: `getOrgCascadeDeleteOrder()` and the `ASSOCIATED_SYSTEM_SCOPED_TABLES` names from `services/tenantCascade.ts` (re-exported via its namespace object at `tenantCascade.ts:1113` — import the names, don't copy the list).

- [ ] **Step 1: Write the failing contract test**

Create `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

const EXTRA_REQUIRED = [
  // no org_id, but a merge must account for them (follows-parent/derived):
  'device_commands', 'user_sso_identities', 'sso_sessions', 'psa_ticket_mappings',
  'deployment_results', 'software_deployments', 'software_versions',
  'partner_export_configuration_org_state', 'partner_export_device_material_state',
  'partner_export_site_material_state',
];

describe('Org merge policy registry contract', () => {
  const policies = getOrgMergePolicies();
  const required = new Set([...getOrgCascadeDeleteOrder(), ...EXTRA_REQUIRED]);

  it('every required table has exactly one policy', () => {
    const missing = [...required].filter(t => !policies.has(t));
    expect(missing).toEqual([]);
  });

  it('no policy names an unrequired table', () => {
    const extra = [...policies.keys()].filter(t => !required.has(t));
    expect(extra).toEqual([]);
  });

  it('organizations is loser-shell; the four append-only tables are leave-for-erasure', () => {
    expect(policies.get('organizations')).toEqual({ kind: 'loser-shell' });
    for (const t of ['audit_logs', 'audit_log_chain', 'audit_chain_anchors', 'ml_feedback_events']) {
      expect(policies.get(t)?.kind, t).toBe('leave-for-erasure');
    }
  });

  it('every repoint-dedupe key column exists on its table', async () => {
    for (const [table, policy] of policies) {
      if (policy.kind !== 'repoint-dedupe') continue;
      for (const col of policy.key) {
        if (col.includes('(')) continue; // expression keys (e.g. lower(name)) checked by the merge integration test
        const r = await db.execute(sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = ${table} AND column_name = ${col}`);
        expect((r as unknown as unknown[]).length, `${table}.${col}`).toBe(1);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && pnpm test:integration src/__tests__/integration/orgMergeRegistry.integration.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write the registry**

Create `apps/api/src/services/orgMergeRegistry.ts`. Explicit entries for the special tables below; then a `REPOINT_TABLES` array holding **every remaining** cascade table explicitly. Generate that list mechanically: write the special entries first, run the contract test, and paste its printed `missing` array as the `REPOINT_TABLES` literal — the test's failure output is the generator.

Key/`keyWhere` literals use `{col}` placeholders for column references inside expressions (`lower({name})`, `{source_ref} IS NOT NULL`); the Task-2 builders substitute the table alias. A bare string with no braces is a plain column name.

Special entries (rationale comments in the file, one line each):

```ts
const SPECIAL: Record<string, OrgMergePolicy> = {
  organizations: { kind: 'loser-shell' },
  // Append-only (BEFORE UPDATE triggers RAISE unconditionally; per-org hash chain):
  audit_logs: { kind: 'leave-for-erasure', note: 'append-only + per-org hash chain; rows die with the loser shell' },
  audit_log_chain: { kind: 'leave-for-erasure', note: 'genesis-row unique per org' },
  audit_chain_anchors: { kind: 'leave-for-erasure', note: 'append-only' },
  ml_feedback_events: { kind: 'leave-for-erasure', note: 'append-only' },
  // Trigger-maintained; breeze_app has DML revoked:
  partner_export_configuration_org_state: { kind: 'derived', note: 'SECURITY DEFINER triggers regenerate as parents move' },
  partner_export_device_material_state: { kind: 'derived', note: 'same' },
  partner_export_site_material_state: { kind: 'derived', note: 'same' },
  // No org_id column — tenancy via parent rows, which we re-point:
  device_commands: { kind: 'follows-parent', note: 'device-keyed' },
  user_sso_identities: { kind: 'follows-parent', note: 'user-keyed' },
  sso_sessions: { kind: 'follows-parent', note: 'provider-keyed' },
  psa_ticket_mappings: { kind: 'follows-parent', note: 'connection/alert/device-keyed' },
  deployment_results: { kind: 'follows-parent', note: 'deployment-keyed' },
  software_deployments: { kind: 'follows-parent', note: 'parent-keyed' },
  software_versions: { kind: 'follows-parent', note: 'parent-keyed' },
  // Singleton config rows (UNIQUE(org_id)) — survivor's config wins:
  ai_budgets: { kind: 'keep-survivor' },
  portal_branding: { kind: 'keep-survivor' },
  org_ticket_settings: { kind: 'keep-survivor' },
  pam_org_config: { kind: 'keep-survivor' },
  client_ai_org_policies: { kind: 'keep-survivor' },
  client_ai_tenant_mappings: { kind: 'keep-survivor' }, // also UNIQUE(entra_tenant_id): two different tenants can't both map to survivor
  google_workspace_connections: { kind: 'keep-survivor' },
  user_risk_policies: { kind: 'keep-survivor' },
  // Unique-key tables — drop loser rows that would collide, move the rest:
  m365_connections: { kind: 'repoint-dedupe', key: ['profile'] },
  tenant_variables: { kind: 'repoint-dedupe', key: ['key'] },
  catalog_item_org_pricing: { kind: 'repoint-dedupe', key: ['catalog_item_id'] },
  ticket_form_org_links: { kind: 'repoint-dedupe', key: ['form_id'] },
  plugin_installations: { kind: 'repoint-dedupe', key: ['catalog_id'] },
  oauth_client_blocks: { kind: 'repoint-dedupe', key: ['client_id'] },
  pam_signer_groups: { kind: 'repoint-dedupe', key: ['name'] },
  playbook_definitions: { kind: 'repoint-dedupe', key: ['lower({name})'] },
  discovered_assets: { kind: 'repoint-dedupe', key: ['ip_address'] },
  sso_verified_domains: { kind: 'repoint-dedupe', key: ['domain'] },
  alert_correlation_groups: { kind: 'repoint-dedupe', key: ['group_key'] },
  ai_cost_usage: { kind: 'repoint-dedupe', key: ['period', 'period_key'] },
  client_ai_usage: { kind: 'repoint-dedupe', key: ['client_user_id', 'period', 'period_key'] },
  contact_external_links: { kind: 'repoint-dedupe', key: ['system', 'external_id'] },
  delegant_m365_connections: { kind: 'repoint-dedupe', key: ['customer_label'] },
  incidents: { kind: 'repoint-dedupe', key: ['source_type', 'source_ref'], keyWhere: '{source_ref} IS NOT NULL' },
  fleet_findings: { kind: 'repoint-dedupe', key: ['kind', 'semantic_key', 'algorithm_version'], keyWhere: '{resolved_at} IS NULL' },
  remediation_suggestions: { kind: 'repoint-dedupe', key: ['source_type', 'source_id'] }, // superset of its four partial uniques; derived rows, over-dropping is safe
  tunnel_allowlists: { kind: 'repoint-dedupe', key: ['direction', 'pattern', "COALESCE({site_id}, '00000000-0000-0000-0000-000000000000'::uuid)"] },
  action_intents: { kind: 'repoint-dedupe', key: ['idempotency_key'], keyWhere: "{status} IN ('pending','approved','executing')" }, // match the partial index predicate — read it from the migration that created it
  device_mtls_certificates: { kind: 'repoint-dedupe', key: ['serial_number'] },
  organization_users: { kind: 'repoint-dedupe', key: ['user_id', 'role_id'] }, // no unique constraint, but dup memberships accumulate
  // Hand-written executors (Task 3):
  contacts: { kind: 'custom', note: 'clear loser is_primary if survivor has one, then repoint (partial unique)' },
  backup_configs: { kind: 'custom', note: 'clear loser is_default if survivor has one, then repoint (org-owned storage creds must NOT be dropped)' },
  audit_baselines: { kind: 'custom', note: 'deactivate colliding active baselines, dedupe on (name, os_type, profile), repoint rest' },
  pax8_orders: { kind: 'custom', note: 'delete loser direct draft/awaiting orders colliding with survivor partial unique, repoint rest' },
};
export function getOrgMergePolicies(): ReadonlyMap<string, OrgMergePolicy> {
  const map = new Map<string, OrgMergePolicy>(Object.entries(SPECIAL));
  for (const t of REPOINT_TABLES) map.set(t, { kind: 'repoint' });
  return map;
}
```

Before finalizing, verify each `keep-survivor`/`repoint-dedupe` key against the actual unique index in `apps/api/src/db/schema/` or migrations (the `action_intents` predicate especially). `users` and `portal_users` are deliberately **plain `repoint`** (in `REPOINT_TABLES`): `users.email` is globally unique so a person has one row that simply moves; `portal_users` has no email unique so nothing can collide — duplicate portal emails are reported in the merge summary (Task 3), not deleted. `huntress_org_mappings`-style integration tables and `organization_external_links` are also plain `repoint` — many-to-one vendor mappings are representable; duplicates are surfaced in the summary.

- [ ] **Step 4: Iterate until the contract test passes** — use the `missing`-list output to fill `REPOINT_TABLES`; re-run until green.

- [ ] **Step 5: Commit** — `git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts && git commit -m "feat(api): org merge policy registry with completeness contract"`

---

### Task 2: Policy executors as SQL builders (unit-tested via compiled SQL)

**Files:**
- Create: `apps/api/src/services/orgMergeExecutors.ts`
- Test: `apps/api/src/services/orgMergeExecutors.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MergeStatements { statements: SQL[]; }  // executed in order; drizzle SQL objects
  export function buildRepoint(table: string, loser: string, survivor: string): SQL;
  export function buildKeepSurvivor(table: string, loser: string, survivor: string): SQL[]; // [deleteIfSurvivorHasRow, repointRemainder]
  export function buildRepointDedupe(table: string, key: readonly string[], keyWhere: string | undefined, loser: string, survivor: string): SQL[];
  ```
- Consumed by Task 3's engine.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/api/src/services/orgMergeExecutors.test.ts` — assert the **compiled** SQL text + params (PgDialect), per repo convention:

```ts
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildRepoint, buildKeepSurvivor, buildRepointDedupe } from './orgMergeExecutors';

const dialect = new PgDialect();
const L = '11111111-1111-1111-1111-111111111111';
const S = '22222222-2222-2222-2222-222222222222';
const compile = (q: import('drizzle-orm').SQL) => dialect.sqlToQuery(q);

describe('orgMergeExecutors', () => {
  it('repoint updates org_id for the loser only', () => {
    const { sql: text, params } = compile(buildRepoint('quotes', L, S));
    expect(text).toBe('UPDATE "quotes" SET org_id = $1::uuid WHERE org_id = $2::uuid');
    expect(params).toEqual([S, L]);
  });

  it('keep-survivor deletes loser rows only when survivor has one, then repoints', () => {
    const [del, repoint] = buildKeepSurvivor('portal_branding', L, S).map(compile);
    expect(del.sql).toBe(
      'DELETE FROM "portal_branding" WHERE org_id = $1::uuid AND EXISTS (SELECT 1 FROM "portal_branding" s WHERE s.org_id = $2::uuid)'
    );
    expect(del.params).toEqual([L, S]);
    expect(repoint.sql).toBe('UPDATE "portal_branding" SET org_id = $1::uuid WHERE org_id = $2::uuid');
  });

  it('repoint-dedupe deletes colliding loser rows on the key, honoring keyWhere on both sides', () => {
    const [del] = buildRepointDedupe('incidents', ['source_type', 'source_ref'], 'source_ref IS NOT NULL', L, S).map(compile);
    expect(del.sql).toBe(
      'DELETE FROM "incidents" t WHERE t.org_id = $1::uuid AND (source_ref IS NOT NULL) AND EXISTS (' +
        'SELECT 1 FROM "incidents" s WHERE s.org_id = $2::uuid AND (s.source_ref IS NOT NULL) ' +
        'AND s.source_type IS NOT DISTINCT FROM t.source_type AND s.source_ref IS NOT DISTINCT FROM t.source_ref)'
    );
  });

  it('expression keys substitute the alias into {col} placeholders', () => {
    const [del] = buildRepointDedupe('playbook_definitions', ['lower({name})'], undefined, L, S).map(compile);
    expect(del.sql).toContain('lower(s.name) IS NOT DISTINCT FROM lower(t.name)');
  });
});
```

**Note:** the exact compiled strings above are the *shape* to lock; adjust to what `sqlToQuery` actually emits for `sql.identifier` + `sql.raw` composition (identifier quoting may differ) — run once, read the real output, pin it. Compiled-SQL asserts alone have been wrong before (real Postgres is the arbiter), so every built statement also executes against the integration DB in Task 7.

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run src/services/orgMergeExecutors.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the builders**

```ts
import { sql, SQL } from 'drizzle-orm';

const uuid = (v: string) => sql`${v}::uuid`;
const keyExpr = (raw: string, alias: string): SQL =>
  sql.raw(raw.includes('{') ? raw.replace(/\{(\w+)\}/g, `${alias}.$1`) : `${alias}.${raw}`);

export function buildRepoint(table: string, loser: string, survivor: string): SQL {
  return sql`UPDATE ${sql.identifier(table)} SET org_id = ${uuid(survivor)} WHERE org_id = ${uuid(loser)}`;
}

export function buildKeepSurvivor(table: string, loser: string, survivor: string): SQL[] {
  return [
    sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loser)} AND EXISTS (SELECT 1 FROM ${sql.identifier(table)} s WHERE s.org_id = ${uuid(survivor)})`,
    buildRepoint(table, loser, survivor),
  ];
}

export function buildRepointDedupe(table: string, key: readonly string[], keyWhere: string | undefined, loser: string, survivor: string): SQL[] {
  const t = sql.identifier(table);
  const matches = key.map(k => sql`${keyExpr(k, 's')} IS NOT DISTINCT FROM ${keyExpr(k, 't')}`);
  const matchAll = sql.join(matches, sql` AND `);
  const wherePart = (alias: string) => keyWhere ? sql` AND (${sql.raw(keyWhere.replace(/\{(\w+)\}/g, `${alias}.$1`))})` : sql``;
  return [
    sql`DELETE FROM ${t} t WHERE t.org_id = ${uuid(loser)}${wherePart('t')} AND EXISTS (SELECT 1 FROM ${t} s WHERE s.org_id = ${uuid(survivor)}${wherePart('s')} AND ${matchAll})`,
    buildRepoint(table, loser, survivor),
  ];
}
```


- [ ] **Step 4: Run tests, pin the actual compiled strings, verify green.**

- [ ] **Step 5: Commit** — `git commit -m "feat(api): org merge SQL executors with compiled-SQL unit tests"`

---

### Task 3: Merge engine service (fence → transaction → record → dispose)

**Files:**
- Create: `apps/api/src/services/orgMerge.ts`
- Test: `apps/api/src/services/orgMerge.test.ts` (unit: validation/fence logic with Drizzle mocks)

**Interfaces:**
- Consumes: registry (Task 1), executors (Task 2), `withSystemDbAccessContext`/`db` (`db/index.ts`), `topologicalCascadeOrder` (`tenantCascade.ts:538`), `enqueueTenantErasure` (`jobs/tenantErasure.ts:61`), `createAuditLog` (`services/auditService`), the WS force-close helper used at `routes/devices/moveOrg.ts:241` (read that file for the exact import), the auth-epoch bump helper (grep `permissions_epoch`/`auth_epoch` under `apps/api/src` and reuse; if none is callable directly, reuse whatever `revokeOrganizationTenantAccess` calls to invalidate sessions — read `services/tenantLifecycle.ts:253`).
- Produces:
  ```ts
  export interface OrgMergePreview {
    tables: Array<{ table: string; policy: string; loserRows: number; wouldDrop: number }>;
    totalMovableRows: number;
    verdict: 'ok' | 'too-large';
    warnings: string[];  // duplicate portal emails, duplicate external-link systems, pinned notes
  }
  export function previewOrgMerge(loserOrgId: string, survivorOrgId: string): Promise<OrgMergePreview>;
  export interface OrgMergeResult { summary: Record<string, { moved: number; dropped: number }>; mergeEventId: string; }
  export function executeOrgMerge(input: { loserOrgId: string; survivorOrgId: string; partnerId: string; performedBy: string; performedByEmail?: string }): Promise<OrgMergeResult>;
  export function validateMergePair(loser: OrgRow, survivor: OrgRow): string | null; // error message or null
  export function resolveMergedOrgIds(orgId: string, partnerId: string): Promise<string[]>; // [orgId, transitive survivors…], depth-capped at 5 — Task 6 consumes
  ```

- [ ] **Step 1: Write failing unit tests for validation + fence rules**

`apps/api/src/services/orgMerge.test.ts` (pure-function tests, no DB):

```ts
import { describe, it, expect } from 'vitest';
import { validateMergePair } from './orgMerge';

const org = (over: Partial<Record<string, unknown>>) => ({
  id: 'a', partnerId: 'p1', name: 'Acme', type: 'customer', status: 'active', deletedAt: null, ...over,
});

describe('validateMergePair', () => {
  it('accepts same-partner active pair', () =>
    expect(validateMergePair(org({ id: 'l' }) as never, org({ id: 's' }) as never)).toBeNull());
  it('rejects cross-partner', () =>
    expect(validateMergePair(org({ id: 'l', partnerId: 'p2' }) as never, org({ id: 's' }) as never)).toMatch(/partner/i));
  it('rejects self-merge', () =>
    expect(validateMergePair(org({ id: 'x' }) as never, org({ id: 'x' }) as never)).toMatch(/itself/i));
  it('rejects quick_support loser', () =>
    expect(validateMergePair(org({ id: 'l', type: 'quick_support' }) as never, org({ id: 's' }) as never)).toMatch(/quick.support/i));
  it('rejects archived/merging loser', () => {
    for (const status of ['archived', 'merging', 'purging', 'churned', 'offboarding']) {
      expect(validateMergePair(org({ id: 'l', status }) as never, org({ id: 's' }) as never)).not.toBeNull();
    }
  });
  it('rejects non-usable survivor', () =>
    expect(validateMergePair(org({ id: 'l' }) as never, org({ id: 's', status: 'suspended' }) as never)).not.toBeNull());
  it('accepts suspended loser (merging away a suspended duplicate is legal)', () =>
    expect(validateMergePair(org({ id: 'l', status: 'suspended' }) as never, org({ id: 's' }) as never)).toBeNull());
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: implement** `orgMerge.ts`:

Skeleton (implement fully — key parts shown; behavior of every phase is normative):

```ts
// Phase A — fence (runs before the tx, its writes are separate small system contexts):
//   1. re-validate pair; CAS loser status -> 'merging' (WHERE status = prior), storing
//      settings.mergePriorStatus = prior via jsonb_set so the sweeper can unfence.
//   2. force-close loser agents' WS (same helper moveOrg.ts:241 uses, applied per
//      loser device id) + bump auth epochs for users with org_id = loser.
//   3. wait ORG_MERGE_FENCE_DRAIN_MS (default 30_000, env-overridable; 0 in tests).
export async function executeOrgMerge(input: ExecuteInput): Promise<OrgMergeResult> {
  const { loser, survivor } = await loadAndValidate(input);      // throws MergeValidationError
  await fenceLoser(loser);                                        // Phase A
  try {
    return await withSystemDbAccessContext(async () => {          // Phase B — ONE transaction
      await db.execute(sql`SELECT breeze_partner_export_lock_orgs_exclusive(${sql`ARRAY[${loser.id}, ${survivor.id}]::uuid[]`})`); // check exact fn signature in migrations/2026-07-23-partner-export-material-state-hardening.sql
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const order = [...(await topologicalCascadeOrder())].reverse();   // parents-first; organizations first (skipped as loser-shell)
      const summary: Record<string, { moved: number; dropped: number }> = {};
      for (const table of order) {
        const policy = getOrgMergePolicies().get(table)!;
        summary[table] = await runPolicy(table, policy, loser.id, survivor.id); // executes Task-2 builders / CUSTOM_EXECUTORS; extracts row counts
      }
      await runPostPassFixups(loser, survivor, summary);           // see below
      const [event] = await db.insert(orgMergeEvents).values({
        partnerId: input.partnerId, loserOrgId: loser.id, loserOrgName: loser.name,
        survivorOrgId: survivor.id, actorUserId: input.performedBy, summary,
      }).returning({ id: orgMergeEvents.id });
      await db.update(organizations).set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(organizations.id, loser.id));                    // stays status='merging' — terminal shell
      return { summary, mergeEventId: event.id };
    });
  } catch (err) {
    await unfenceLoser(loser);                                     // restore settings.mergePriorStatus
    await writeMergeAudit('org.merge.failed', input, { error: String(err) });  // orgId: null
    throw err;
  }
}
```

`runPostPassFixups` (all inside the same tx):
- `UPDATE partner_users SET org_ids = (SELECT array_agg(DISTINCT x) FROM unnest(array_replace(org_ids, loser, survivor)) AS u(x)) WHERE partner_id = :p AND loser = ANY(org_ids)`
- `config_policy_assignments`: `DELETE` loser-target rows where an identical `(level, policy…, target_id=survivor)` row exists, else `UPDATE … SET target_id = survivor WHERE level = 'organization' AND target_id = loser` — read `db/schema/configurationPolicies.ts:115` for the real columns and the correct duplicate key first.
- Warnings for the summary: duplicate `portal_users` emails now under survivor (`SELECT lower(email) … GROUP BY 1 HAVING count(*) > 1`), duplicate `organization_external_links` `(system)` pairs.

CUSTOM_EXECUTORS (per Task 1's `custom` notes — each a small function of `(loserId, survivorId)` returning `{ moved, dropped }`): `contacts` (clear loser `is_primary` where survivor has a primary with `site_id IS NULL`, then repoint), `backup_configs` (clear loser `is_default` where survivor has a default, then repoint — never delete), `audit_baselines`, `pax8_orders` (verify each partial-unique predicate against its migration before writing the SQL).

Phase C (in the job, Task 4, after `executeOrgMerge` returns): audit `org.merge.completed` with `orgId: null` + counts; `enqueueTenantErasure({ orgId: loser.id, performedBy, performedByEmail })`; audit `org.merge.erasure_enqueued`. Post-commit cosmetic: remove loser from the partner's org-ordering (read `services/orgOrdering.ts` for the helper).

`previewOrgMerge`: same registry walk, read-only, one `SELECT count(*)` per table (+ collision-count variants of the dedupe DELETEs as `SELECT count(*)`), `verdict = total > Number(process.env.ORG_MERGE_MAX_ROWS ?? 500000) ? 'too-large' : 'ok'`.

`resolveMergedOrgIds(orgId, partnerId)`: loop ≤5: `SELECT survivor_org_id FROM org_merge_events WHERE loser_org_id = $current AND partner_id = $p ORDER BY created_at DESC LIMIT 1`; collect chain.

- [ ] **Step 4: Unit tests green** — `pnpm vitest run src/services/orgMerge.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): org merge engine (fence, single-tx registry walk, fixups, merge record)"`

---

### Task 4: BullMQ job + sweeper backstop

**Files:**
- Create: `apps/api/src/jobs/orgMerge.ts`
- Modify: `apps/api/src/index.ts` (worker tuple array ~line 1439: add `['orgMerge', initializeOrgMergeWorker]`; shutdown list ~line 1666: add `shutdownOrgMergeWorker,`)
- Modify: `apps/api/src/services/tenantOffboarding.ts` (`sweepOffboardingTenants`, ~line 713)
- Test: `apps/api/src/jobs/orgMerge.test.ts`

**Interfaces:**
- Produces: `enqueueOrgMerge(payload: { loserOrgId; survivorOrgId; partnerId; performedBy; performedByEmail? }): Promise<{ id: string }>` with `jobId = 'org-merge-' + loserOrgId`, `attempts: 1`; `initializeOrgMergeWorker` / `shutdownOrgMergeWorker`; `getOrgMergeQueue()`.

- [ ] **Step 1: Write failing tests** — mirror `jobs/tenantErasure.ts`'s existing test file if one exists (grep `tenantErasure.test`); otherwise test: enqueue builds the dedup jobId and options; the worker processor calls `executeOrgMerge` then `enqueueTenantErasure` then writes the two audit events (spy via `vi.mock` of `../services/orgMerge`, `./tenantErasure`, `../services/auditService`).
- [ ] **Step 2: Implement** — copy the `tenantErasure.ts` module shape verbatim (queue singleton `QUEUE_NAME = 'org-merge'`, worker `concurrency: 1`, `removeOnComplete/Fail {count: 50}`, `initialize…`/`shutdown…` with the same error-handler wiring), processor = Phase C sequence from Task 3.
- [ ] **Step 3: Sweeper backstop** — in `sweepOffboardingTenants` add two queries:
  - `status = 'merging' AND deleted_at IS NOT NULL AND updated_at < now() - interval '1 hour'` → `enqueueTenantErasure` (idempotent via jobId) — merge committed but Phase C died.
  - `status = 'merging' AND deleted_at IS NULL AND updated_at < now() - interval '2 hours'` → unfence: restore `settings.mergePriorStatus` (default `'suspended'` if absent) + audit `org.merge.unfenced_by_sweeper` — fence set but job died pre-commit.
  Add both cases to the sweeper's existing test file (grep `sweepOffboarding` for it).
- [ ] **Step 4: Green + commit** — `git commit -m "feat(api): org-merge job with erasure handoff and sweeper backstop"`

---

### Task 5: Routes — preview / execute / run status

**Files:**
- Create: `apps/api/src/routes/orgMerge.ts`
- Modify: `apps/api/src/index.ts` (mount after `api.route('/orgs', orgRoutes)` at ~line 986: `api.route('/orgs', orgMergeRoutes)`)
- Test: `apps/api/src/routes/orgMerge.test.ts`

**Interfaces:**
- Produces routes (under the existing `/orgs` mount, so full paths are `/api/v1/orgs/organizations/:id/…`):
  - `POST /organizations/:id/merge-preview` body `{ survivorId: uuid }` → `OrgMergePreview`
  - `POST /organizations/:id/merge` body `{ survivorId: uuid, confirmName: string }` → 202 `{ jobId }`
  - `GET /organizations/merge-runs/:jobId` → `{ state: 'waiting'|'active'|'completed'|'failed', result?, failedReason? }` via `getOrgMergeQueue().getJob()`

- [ ] **Step 1: Write failing route tests** — copy the harness style of the nearest existing route test (`grep -l "orgRoutes" apps/api/src/routes/*.test.ts`; note the repo's Drizzle-mock patterns from the breeze-testing skill). Cases: 404 when loser not accessible to partner scope; 403 cross-partner survivor; 400 `confirmName` mismatch (exact string compare against the loser's `name`); 422 when preview verdict is `too-large`; 202 + `enqueueOrgMerge` called with the auth identity; org-scope token → 403 (requireScope); no-MFA → the requireMfa failure the middleware emits.
- [ ] **Step 2: Implement** — middleware chain exactly as `orgs.ts:1865`: `requireScope('partner', 'system'), requireOrgWrite, requireMfa()`. Body validation with `zValidator('json', z.object({ survivorId: z.string().uuid(), confirmName: z.string().min(1) }))`. Load both orgs, `validateMergePair`, partner-scope `auth.canAccessOrg` on BOTH ids, then `previewOrgMerge` / re-check verdict server-side before `enqueueOrgMerge`. Audit `org.merge.requested` via `writeRouteAudit` (survivor's orgId).
- [ ] **Step 3: Green + commit** — `git commit -m "feat(api): org merge preview/execute/status endpoints"`

---

### Task 6: Sent-quote continuity across merges

**Files:**
- Modify: `apps/api/src/routes/quotesPublic.ts` (the `resolve` helper at :43 and every `eq(quotes.orgId, claims.orgId)` in the file — sweep all handlers)
- Test: `apps/api/src/__tests__/integration/orgMergeQuoteContinuity.integration.test.ts` (create)

**Interfaces:**
- Consumes: `resolveMergedOrgIds(orgId, partnerId)` (Task 3).

- [ ] **Step 1: Write the failing integration test** — seed partner, orgs A and B, a quote under B (as if merged), an `org_merge_events` row `{loser: A, survivor: B}`; sign a token for the quote with **A's** orgId via `signQuoteAcceptToken` (read `quoteAcceptToken.ts:46` for the exact signature); GET the public view route with that token → expect 200 and the quote body. Also: token with an unrelated org C and no merge event → 401/404 (unchanged behavior), and a two-hop chain A→B→C resolves.
- [ ] **Step 2: Implement** — in each public handler, replace `eq(quotes.orgId, claims.orgId)` with `inArray(quotes.orgId, orgIds)` where `const orgIds = await resolveMergedOrgIds(claims.orgId, claims.partnerId)` is computed once in `resolve()` and returned alongside the claims (extend `resolve`'s return type; the DB lookup runs inside the route's existing `withSystemDbAccessContext` block). Partner binding: `resolveMergedOrgIds` filters `org_merge_events.partner_id = claims.partnerId`, preserving the token's partner claim as the trust anchor.
- [ ] **Step 3: Green + commit** — `git commit -m "feat(api): public quote links survive org merges via org_merge_events fallback"`

---

### Task 7: End-to-end merge integration test (the collision gauntlet)

**Files:**
- Test: `apps/api/src/__tests__/integration/orgMerge.integration.test.ts` (create)

- [ ] **Step 1: Write the test (it is the deliverable; expect it to drive fixes in Tasks 2–3).** Seed one partner, orgs A (loser) + B (survivor), fixtures covering every policy class:
  - `repoint` + composite-FK chain: a quote under A with `quote_recipients` + a `quote_order` + `quote_order_lines`; an invoice with `invoice_lines`.
  - `keep-survivor`: `portal_branding` + `org_ticket_settings` rows in BOTH orgs.
  - `repoint-dedupe`: `tenant_variables` — same `key` in both (collide) plus one A-only key (moves); `discovered_assets` with the same `ip_address` in both.
  - `custom`: contacts with `is_primary` in both; `audit_baselines` active for the same `os_type` in both.
  - `users`/memberships: one A-org user; one shared partner staffer with `organization_users` grants in both orgs (same role → deduped).
  - Devices: a site + device + a few device-scoped rows (e.g. `device_group_memberships`) under A.
  - Append-only: insert an `audit_logs` row for A via the normal audit service — must remain under A post-merge.
  Then call `executeOrgMerge` directly (fence drain 0 via env; no queue involved — erasure enqueue is Phase C in the job, not the engine) and assert:
  - every fixture row's `org_id` is B except the collision-dropped ones and audit rows;
  - loser has zero rows across a spot-check list of ~15 tables (`SELECT count(*) … WHERE org_id = A`) and `organizations` row has `status='merging' AND deleted_at IS NOT NULL`;
  - summary counts match (moved/dropped per fixture table);
  - `org_merge_events` row exists with the right names/ids;
  - re-running `executeOrgMerge` on the same pair now fails validation (loser deleted).
  Also one **failure-atomicity** case: make one table's policy throw mid-walk (spy `runPolicy` via the module namespace, or temporarily register a bogus policy) → expect throw, loser unfenced back to prior status, and ALL fixture rows still under A (transaction rolled back).
- [ ] **Step 2: Run, fix the engine/executors until green.** This is where partial-unique predicates and trigger surprises surface — fix in `orgMergeExecutors.ts`/`CUSTOM_EXECUTORS`, keeping their unit tests in sync.
- [ ] **Step 3: Commit** — `git commit -m "test(api): org merge end-to-end integration gauntlet"`

---

### Task 8: Wave wrap — full verification + PR

- [ ] **Step 1:** `pnpm db:check-drift`; `cd apps/api && pnpm test`; `pnpm test:integration` (full — tenancy touched); rls-coverage config run.
- [ ] **Step 2:** Push, open PR titled `feat(api): org lifecycle wave 2 — merge engine`, body linking spec + this plan, `Closes #<wave-2 sub-issue>`, the standard generated-with footer. If stacked on Wave 1, dispatch `gh workflow run CI --ref <branch>`.
- [ ] **Step 3: Stop at the open, reviewed PR.** Do not merge. Flag in the PR description: merge UI ships in Wave 3; until then the endpoints are API-only (same precedent as device move-org).
