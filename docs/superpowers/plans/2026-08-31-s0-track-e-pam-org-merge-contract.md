# S0 Track E — PAM Org-Merge Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pam_actuations` / `pam_actuation_results` an explicit, fail-closed org-merge policy (`blocks-merge`), repair the trigger-classification contract, harden actuation tenancy, and rewire the PAM worker lifecycle test — turning all 9 CI reds on PR #4105 green without touching any PAM evidence semantics.

**Architecture:** A new non-mutating registry policy class `blocks-merge` refuses any merge whose loser org holds protected rows, enforced at three points (preview verdict, pre-fence, in-transaction pre-walk). The trigger-review contract re-keys to `table.trigger` with a new conditionally-blocking category whose discharge is asserted against the registry. One migration makes `pam_actuations.org_id` directly immutable. The stale `index.ts` worker source-contract test is rewritten against the lazy `WORKER_REGISTRY`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, vitest (unit + real-Postgres integration via `docker-compose.test.yml`), plpgsql migrations, React (web modal).

**Spec:** `docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md` (committed in Task 0). Read it first; every task argues from it.

## Global Constraints

- Worktree: `/Users/toddhebebrand/breeze/.worktrees/s0-track-e-pam-actuation`, branch `fix/s0-pam-actuation-lifecycle` (PR #4105). All paths below are relative to `apps/api` unless prefixed.
- **No new grants, no RLS changes, no GUC changes, no bypass of any PAM protection.** `blocks-merge` must introduce zero SQL that writes any table.
- The refusal error is `OrgMergeBlockedError` with `code: 'ORG_MERGE_BLOCKED'`. It must never surface as the devices trigger's `23514`.
- Verdict precedence: `'blocked'` > `'too-large'` > `'ok'`.
- The registry keeps **no default** — do not add one.
- Unit tests: `cd apps/api && pnpm vitest run <file>`. Integration tests need the test DB: `pnpm test:docker:up` once, then `pnpm test:integration -- <file>`; leave the stack up between tasks (`pnpm test:docker:down` at the very end).
- Every RED step must actually be run and observed failing before its implementation step. Every commit message follows the repo's conventional style (`fix(pam): …`, `test(pam): …`).
- Do not modify: any file under `agent/`, any existing migration file, `pamDeviceMoveGuard.*`, `tenantCascade.ts`.

---

### Task 0: Commit the approved spec

**Files:**
- Add: `docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md` (already written, untracked)
- Add: `docs/superpowers/plans/2026-08-31-s0-track-e-pam-org-merge-contract.md` (this file)

- [ ] **Step 1: Commit both docs**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/s0-track-e-pam-actuation
git add docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md docs/superpowers/plans/2026-08-31-s0-track-e-pam-org-merge-contract.md
git commit -m "docs(pam): approved org-merge contract for durable PAM evidence"
```

---

### Task 1: `blocks-merge` policy class + registry entries

**Files:**
- Modify: `src/services/orgMergeRegistry.ts` (type union ~line 22-31; SPECIAL map — insert after the `ai_unattended_exposure` entry ~line 169)
- Modify: `src/services/orgMerge.ts` (new error + helper near `MergeValidationError` ~line 124; `runPolicy` switch ~line 631)
- Modify: `src/__tests__/integration/orgMergeRegistry.integration.test.ts` (`NON_MUTATING` set ~line 419)
- Modify: `src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts` (policy walk ~line 83-95: skip `blocks-merge` kinds before building statements)
- Modify: `src/services/orgMerge.test.ts` (mock-queue adjustment only, see Step 6)

**Interfaces (produced, later tasks rely on these exact names):**
- `export interface MergeBlocker { table: string; loserRows: number }` (orgMerge.ts)
- `export class OrgMergeBlockedError extends Error { readonly code = 'ORG_MERGE_BLOCKED'; readonly blockers: MergeBlocker[] }`
- `export function buildMergeBlockedMessage(blockers: MergeBlocker[]): string`
- `export async function collectMergeBlockers(loserOrgId: string): Promise<MergeBlocker[]>`
- Registry policy kind literal: `'blocks-merge'`

- [ ] **Step 1: Confirm the RED baseline**

```bash
cd apps/api && pnpm test:integration -- src/__tests__/integration/orgMergeRegistry.integration.test.ts -t "every required table"
```
Expected: FAIL with `missing` = `["pam_actuation_results", "pam_actuations"]`.

- [ ] **Step 2: Add the policy kind and registry entries**

In `orgMergeRegistry.ts`, extend the union (keep comment style):

```ts
  | { kind: 'blocks-merge'; note: string } // rows FORBID the merge outright; engine refuses pre-walk — see specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md
```

In `SPECIAL`, directly after the `ai_unattended_exposure` entry:

```ts
  // Durable PAM actuation evidence (Track E org-merge contract,
  // specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md): never
  // re-tenanted, never destroyed, never bypassed — a loser org holding ANY
  // row is refused outright. Repoint is physically unreachable
  // (pam_actuation_results: UPDATE revoked from breeze_app + unconditional
  // 42501 trigger; the composite (id, org_id) FK chain has no ON UPDATE
  // CASCADE), and leave-for-erasure would break
  // pam_actuations(device_id, org_id) -> devices(id, org_id) the moment the
  // devices repoint runs — which devices_pam_history_move_guard RAISEs 23514
  // on anyway. The engine refuses BEFORE the walk (collectMergeBlockers), so
  // neither trigger can fire mid-merge.
  pam_actuations: { kind: 'blocks-merge', note: 'durable PAM lifecycle evidence is source-frozen; any loser row refuses the merge — devices_pam_history_move_guard applied at org granularity' },
  pam_actuation_results: { kind: 'blocks-merge', note: 'append-only PAM evidence (UPDATE revoked + unconditional RAISE); cannot exist without a pam_actuations parent — listed for registry completeness and preview counting' },
```

- [ ] **Step 3: Add the error, message builder, blocker collector, and `runPolicy` case in `orgMerge.ts`**

Near `MergeValidationError`:

```ts
export interface MergeBlocker {
  table: string;
  loserRows: number;
}

/** Operator-facing refusal text; also embedded in previews and audits. */
export function buildMergeBlockedMessage(blockers: MergeBlocker[]): string {
  const counts = blockers.map((b) => `${b.loserRows} ${b.table} row(s)`).join(', ');
  return (
    `merge blocked: the merged-away organization holds durable PAM lifecycle evidence (${counts}). `
    + 'Privileged-access evidence is never re-tenanted, destroyed, or bypassed by a merge. '
    + 'If the surviving organization is the one without PAM evidence, merge in the opposite direction; '
    + 'otherwise these organizations cannot be merged. Audit-admin retention is not a merge mechanism.'
  );
}

/** Refusal for a loser org whose rows a `blocks-merge` policy protects — a 422 at the route, `org.merge.failed` from the engine. Never an engine bug. */
export class OrgMergeBlockedError extends Error {
  readonly code = 'ORG_MERGE_BLOCKED';
  constructor(readonly blockers: MergeBlocker[]) {
    super(buildMergeBlockedMessage(blockers));
    this.name = 'OrgMergeBlockedError';
  }
}

/**
 * Rows that FORBID the merge (policy kind 'blocks-merge'), counted per table.
 * Called fail-closed at three points: preview (verdict 'blocked'),
 * executeOrgMerge pre-fence (refuse without disrupting the loser), and inside
 * the Phase-B transaction (TOCTOU guard). MUST run before the registry walk:
 * the parents-first order repoints `devices` early, and
 * devices_pam_history_move_guard would RAISE a raw 23514 before the walk ever
 * reached pam_actuations — the typed refusal has to come first.
 */
export async function collectMergeBlockers(loserOrgId: string): Promise<MergeBlocker[]> {
  const blockers: MergeBlocker[] = [];
  for (const [table, policy] of getOrgMergePolicies()) {
    if (policy.kind !== 'blocks-merge') continue;
    const loserRows = await scalarCount(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
    );
    if (loserRows > 0) blockers.push({ table, loserRows });
  }
  return blockers.sort((a, b) => a.table.localeCompare(b.table));
}
```

In `runPolicy`, add a case above `default:`:

```ts
    case 'blocks-merge': {
      // Defense in depth only — executeOrgMerge refuses via
      // collectMergeBlockers before the fence and again before the walk, so
      // reaching this case with loser rows means that ordering broke.
      if (phase === 'resolve') {
        const rows = await scalarCount(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
        );
        if (rows > 0) throw new OrgMergeBlockedError([{ table, loserRows: rows }]);
      }
      return noOpOutcome();
    }
```

(`scalarCount`, `uuid`, `noOpOutcome` are existing module-locals in this file — if `scalarCount` is declared below `runPolicy`, that is fine, function declarations hoist; if it is a `const`, move `collectMergeBlockers` below it.)

- [ ] **Step 4: Teach the two integration harnesses the new kind**

`orgMergeRegistry.integration.test.ts` (~line 419): `const NON_MUTATING = new Set(['leave-for-erasure', 'derived', 'follows-parent', 'loser-shell', 'blocks-merge']);`

`orgMergeCustomExecutors.integration.test.ts` policy walk (~line 83-95): where the walk switches on `policy.kind` to build statements, add `if (policy.kind === 'blocks-merge') continue;` (mirroring however `leave-for-erasure` is skipped there — read the local pattern first).

- [ ] **Step 5: Run the registry contract suite**

```bash
pnpm test:integration -- src/__tests__/integration/orgMergeRegistry.integration.test.ts
```
Expected: "every required table has exactly one policy" and "no policy names an unrequired table" PASS. The trigger-classification test STAYS RED (fixed in Task 4) — failing list must now show ONLY the two PAM triggers, not a missing-policy error.

- [ ] **Step 6: Repair the unit-test mock queue**

```bash
pnpm vitest run src/services/orgMerge.test.ts
```
`executeOrgMerge` now issues one `SELECT count(*)` per blocks-merge table (alphabetical: `pam_actuation_results`, then `pam_actuations`) BEFORE the fence and again inside Phase B. The file drives `db.execute` from `mockState.executeResponses`; prepend `[{ n: 0 }]` responses at the positions the failures indicate (match by inspecting `mockState.executedSql` in the failure output — do not guess). Re-run until green, changing ONLY mock plumbing, never assertions about behavior that existed before this task.

- [ ] **Step 7: Run the customExecutors walk suite**

```bash
pnpm test:integration -- src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts
```
Expected: PASS ("no policy for pam_actuations" gone).

- [ ] **Step 8: Commit**

```bash
git add -A apps/api/src && git commit -m "fix(pam): give durable PAM evidence an explicit blocks-merge org-merge policy"
```

---

### Task 2: Engine refusal (pre-fence + in-tx), preview verdict, route 422

**Files:**
- Modify: `src/services/orgMerge.ts` (`OrgMergePreview` ~line 89-94; `executeOrgMerge` ~line 815-822 and ~line 850-856; `previewOrgMerge` table loop ~line 1105-1140 and return ~line 1180)
- Modify: `src/routes/orgMerge.ts` (merge POST handler, between confirmName check and the `too-large` refusal ~line 184-210)
- Test: `src/services/orgMerge.test.ts`, `src/routes/orgMerge.test.ts`

**Interfaces:**
- Consumes: `collectMergeBlockers`, `OrgMergeBlockedError`, `buildMergeBlockedMessage` (Task 1)
- Produces: `OrgMergePreview.verdict: 'ok' | 'too-large' | 'blocked'`; `OrgMergePreview.blockers: string[]`; route 422 body `{ error, code: 'ORG_MERGE_BLOCKED', blockers }`

- [ ] **Step 1: Write the failing unit tests**

In `src/services/orgMerge.test.ts` (reuse the file's existing hoisted-mock harness and imports; `orgMergeModule` is the `* as` self-import used by existing tests):

```ts
describe('blocks-merge refusal', () => {
  it('refuses before fencing and audits org.merge.failed', async () => {
    vi.spyOn(orgMergeModule, 'loadAndValidate').mockResolvedValue({
      loser: { id: 'a', partnerId: 'p', name: 'Loser', type: 'standard', status: 'active', deletedAt: null },
      survivor: { id: 'b', partnerId: 'p', name: 'Survivor', type: 'standard', status: 'active', deletedAt: null },
    } as never);
    const fence = vi.spyOn(orgMergeModule, 'fenceLoser').mockResolvedValue(undefined as never);
    vi.spyOn(orgMergeModule, 'collectMergeBlockers').mockResolvedValue([{ table: 'pam_actuations', loserRows: 3 }]);
    const audit = vi.spyOn(orgMergeModule, 'writeMergeAudit').mockResolvedValue(undefined as never);

    await expect(
      orgMergeModule.executeOrgMerge({ loserOrgId: 'a', survivorOrgId: 'b', partnerId: 'p', performedBy: 'u' }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED' });

    expect(fence).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'org.merge.failed' }));
  });

  it('builds the operator refusal text with per-table counts', () => {
    const msg = orgMergeModule.buildMergeBlockedMessage([
      { table: 'pam_actuation_results', loserRows: 2 },
      { table: 'pam_actuations', loserRows: 1 },
    ]);
    expect(msg).toContain('2 pam_actuation_results row(s), 1 pam_actuations row(s)');
    expect(msg).toContain('Audit-admin retention is not a merge mechanism');
  });
});
```

In `src/routes/orgMerge.test.ts` (follow the file's existing mocking pattern for `previewOrgMerge`):

```ts
it('refuses a blocked merge with 422 ORG_MERGE_BLOCKED and never enqueues', async () => {
  // mock previewOrgMerge -> { tables: [...], totalMovableRows: 0, verdict: 'blocked',
  //   warnings: [], blockers: ['merge blocked: ...'] }
  // POST /organizations/:id/merge with a correct confirmName
  // expect 422, body.code === 'ORG_MERGE_BLOCKED', body.blockers.length === 1
  // expect enqueueOrgMerge mock NOT called
});
```
(Fill the body using the file's established request-helper utilities — read the neighboring `too-large` test and mirror it exactly.)

- [ ] **Step 2: Run both files, confirm the new tests FAIL**

```bash
pnpm vitest run src/services/orgMerge.test.ts src/routes/orgMerge.test.ts
```

- [ ] **Step 3: Implement**

`OrgMergePreview`:

```ts
export interface OrgMergePreview {
  tables: OrgMergePreviewTable[];
  totalMovableRows: number;
  verdict: 'ok' | 'too-large' | 'blocked';
  warnings: string[];
  /** Non-empty iff verdict === 'blocked'; operator-facing refusal text. */
  blockers: string[];
}
```

`executeOrgMerge` — replace the opening two lines with:

```ts
  const { loser, survivor } = await self.loadAndValidate(input);

  // blocks-merge refusal BEFORE the fence: a merge that can never succeed
  // must not close agent sockets, bump auth epochs, or drain the loser. The
  // in-transaction recheck below is the authoritative copy of this check.
  const preFenceBlockers = await self.collectMergeBlockers(loser.id);
  if (preFenceBlockers.length > 0) {
    const blocked = new OrgMergeBlockedError(preFenceBlockers);
    await self.writeMergeAudit(input, {
      action: 'org.merge.failed',
      result: 'failure',
      details: {
        loserOrgId: loser.id,
        loserOrgName: loser.name,
        survivorOrgId: survivor.id,
        error: blocked.message,
        blockers: preFenceBlockers,
      },
    });
    throw blocked;
  }

  await self.fenceLoser(loser);
```

Inside Phase B, immediately after `await dbModule.db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);` and before `const policies = getOrgMergePolicies();`:

```ts
        // TOCTOU recheck of the blocks-merge refusal, inside the transaction
        // and BEFORE the walk — parents-first order repoints `devices` early,
        // and devices_pam_history_move_guard would abort mid-walk with a raw
        // 23514 instead of this typed refusal.
        const txBlockers = await self.collectMergeBlockers(loser.id);
        if (txBlockers.length > 0) throw new OrgMergeBlockedError(txBlockers);
```

`previewOrgMerge` — declare `const mergeBlockers: MergeBlocker[] = [];` beside `destroyedRows`, and at the TOP of the per-table loop body (before the `isDestroyed` line, because the `DML_POLICY_KINDS` filter would `continue` past blocks-merge):

```ts
        if (policy.kind === 'blocks-merge') {
          const loserRows = await scalarCount(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
          );
          if (loserRows === 0) continue;
          tables.push({ table, policy: policy.kind, loserRows, wouldDrop: 0 });
          mergeBlockers.push({ table, loserRows });
          continue;
        }
```

Replace the return's verdict expression and add `blockers`:

```ts
      const verdict: OrgMergePreview['verdict'] =
        mergeBlockers.length > 0
          ? 'blocked'
          : totalMovableRows > getMaxMovableRows()
            ? 'too-large'
            : 'ok';
      return {
        tables,
        totalMovableRows,
        verdict,
        warnings,
        blockers: mergeBlockers.length > 0 ? [buildMergeBlockedMessage(mergeBlockers)] : [],
      };
```

Route (`routes/orgMerge.ts`) — the handler currently destructures only `verdict`/`totalMovableRows` from the preview; keep the whole preview and insert BEFORE the `too-large` branch:

```ts
    if (preview.verdict === 'blocked') {
      return c.json(
        {
          error: preview.blockers[0] ?? 'merge blocked by durable evidence',
          code: 'ORG_MERGE_BLOCKED',
          blockers: preview.blockers,
        },
        422,
      );
    }
```

- [ ] **Step 4: Run the two unit files to green; re-run Task 1's Step 6 file for regressions**

```bash
pnpm vitest run src/services/orgMerge.test.ts src/routes/orgMerge.test.ts
```
(The pre-fence + in-tx count queries change the mock queue again — same repair rule as Task 1 Step 6: fix mock plumbing only.)

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src && git commit -m "fix(pam): refuse org merges over durable PAM evidence at preview, pre-fence, and in-transaction"
```

---

### Task 3: Migration — `pam_actuations.org_id` directly immutable

**Files:**
- Create: `apps/api/migrations/2026-08-31-pam-actuation-org-immutable.sql`
- Test: `src/__tests__/integration/pamActuationLifecycle.integration.test.ts`

> Note (post-hoc): this migration actually shipped as `2026-09-25-pam-actuation-org-immutable.sql`, not the `2026-08-31-` name planned below — the check-migration-naming gate requires each new migration's filename to sort after every already-committed migration, and by the time this task landed the `2026-08-31-` prefix was already taken. Do not "fix" the filename back to match this plan.

**Interfaces:**
- Produces: `pam_actuations_transition_guard()` now RAISEs `42501` `'PAM actuation tenancy is immutable'` on any `org_id` change. Task 4's BLOCKING classification of this trigger depends on this task.

- [ ] **Step 1: Write the failing integration test**

In `pamActuationLifecycle.integration.test.ts`, alongside the existing append-only tests (reuse that suite's org-A/org-B fixtures and its db-context helpers exactly as neighboring tests do):

```ts
  it('keeps actuation tenancy immutable even under system scope', async () => {
    // seed one actuation for orgA via this suite's existing seed path, then:
    await expect(
      runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
          await db.execute(
            sql`UPDATE pam_actuations SET org_id = ${orgB.id}::uuid WHERE id = ${actuationId}::uuid`,
          );
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
```
`SET CONSTRAINTS ALL DEFERRED` is load-bearing: without it the composite FKs may reject first and the test would pass vacuously against the wrong guard. RLS is not in play under system scope, so before the migration this UPDATE succeeds.

- [ ] **Step 2: Run it, confirm FAIL**

```bash
pnpm test:integration -- src/__tests__/integration/pamActuationLifecycle.integration.test.ts -t "tenancy immutable"
```
Expected: FAIL (the UPDATE succeeds — resolved, not rejected). If it instead fails with a different SQLSTATE, STOP and re-read what refused it before touching the migration.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-08-31-pam-actuation-org-immutable.sql`:

```sql
-- Track E org-merge contract
-- (docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md):
-- make pam_actuations tenancy DIRECTLY immutable. The composite
-- (device_id, org_id) / (elevation_request_id, org_id) FKs already force
-- lockstep at COMMIT; this makes the refusal immediate and per-row, closes
-- the parent-mutable/child-immutable asymmetry, and lets the org-merge
-- trigger classification list this guard as BLOCKING truthfully.
-- Replaces the function body only; the trigger from
-- 2026-09-16-pam-actuation-lifecycle.sql keeps pointing at it. Idempotent.
CREATE OR REPLACE FUNCTION pam_actuations_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'PAM actuation tenancy is immutable';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM actuation generation cannot decrease';
  END IF;
  IF OLD.desired_state = 'cleanup' AND NEW.desired_state <> 'cleanup' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM cleanup tombstone is irreversible';
  END IF;
  RETURN NEW;
END;
$$;
```

- [ ] **Step 4: Apply and verify**

```bash
pnpm check:migrations
pnpm test:integration -- src/__tests__/integration/pamActuationLifecycle.integration.test.ts
```
Expected: new test PASS, every pre-existing test in the file PASS (no app code updates `pam_actuations.org_id`; if anything else reds here, STOP — that is a real writer the design says must not exist).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-08-31-pam-actuation-org-immutable.sql apps/api/src/__tests__/integration/pamActuationLifecycle.integration.test.ts
git commit -m "fix(pam): make pam_actuations tenancy directly immutable at the trigger"
```

---

### Task 4: Trigger-classification contract — re-key by `table.trigger`, classify PAM triggers, conditionally-blocking category

**Files:**
- Modify: `src/__tests__/integration/orgMergeRegistry.integration.test.ts` (maps ~line 187-238; test body ~line 416-485)

**Interfaces:**
- Consumes: `blocks-merge` policy kind on `pam_actuations` (Task 1); the hardened guard (Task 3).

- [ ] **Step 1: Re-key the discovery filters (mechanical, makes the test RED with the authoritative list)**

In the trigger test body, change every `r.table_name in <MAP>` membership check to key on `` `${r.table_name}.${r.trigger_name}` ``, change the `stale` computation to compare map keys against the live `` `${table}.${trigger}` `` set, and derive `violations`' table name as `key.split('.')[0]` (dedupe tables that appear via multiple triggers with a `Set`). Run:

```bash
pnpm test:integration -- src/__tests__/integration/orgMergeRegistry.integration.test.ts -t "trigger"
```
Expected: FAIL — the `unreviewed` assertion now prints the complete live `table.trigger` inventory. That failure output is the authoritative source for Step 2's key names. Do not guess trigger names.

- [ ] **Step 2: Rebuild both maps from the failure list**

Re-key every existing entry by matching its table name in the printed inventory, carrying its current classification and reason over verbatim (one live trigger per table today, except `devices`, which has two). Then add the three new classifications:

```ts
  // In ORG_ID_BLOCKING_TRIGGERS:
  'pam_actuations.pam_actuations_transition_guard':
    'RAISEs 42501 iff org_id changed (2026-08-31-pam-actuation-org-immutable.sql); generation/tombstone checks otherwise',
  'pam_actuation_results.pam_actuation_results_block_mutation':
    'unconditional append-only RAISE (42501) on UPDATE — no bypass exists for any app role',
```

New third map, beside the other two, plus its discharge test:

```ts
/**
 * BLOCKING in isolation, but unreachable during a merge: a `blocks-merge`
 * policy refuses the merge before the guarded write can run. The discharge
 * assertion keeps this honest — weaken the named policy and this
 * classification reds with it.
 */
const ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS: Readonly<
  Record<string, { dischargedBy: string; requiredPolicyKind: 'blocks-merge'; note: string }>
> = {
  'devices.devices_pam_history_move_guard': {
    dischargedBy: 'pam_actuations',
    requiredPolicyKind: 'blocks-merge',
    note: 'RAISEs 23514 on any devices.org_id change while the device has a pam_actuations row; a loser org with such rows is refused by the blocks-merge policy before the devices repoint',
  },
};
```

```ts
  it('every conditionally-blocking trigger is discharged by a live blocks-merge policy', () => {
    for (const [key, cfg] of Object.entries(ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS)) {
      expect(policies.get(cfg.dischargedBy)?.kind, `${key} dischargedBy ${cfg.dischargedBy}`).toBe(cfg.requiredPolicyKind);
    }
  });
```

Include the third map's keys in the `unreviewed` filter and the `stale` scan. Conditionally-blocking tables are exempt from the `violations` check (that is the point of the category — document it with the one-line comment `// discharged: see ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS`).

- [ ] **Step 3: Run the whole contract suite to green**

```bash
pnpm test:integration -- src/__tests__/integration/orgMergeRegistry.integration.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts
git commit -m "test(pam): key org-merge trigger classifications by table.trigger; classify PAM guards"
```

---

### Task 5: Merge gauntlet — PAM fixtures and end-to-end refusal

**Files:**
- Modify: `src/__tests__/integration/orgMerge.integration.test.ts` (fixture `seedFixture` at ~line 266; new `describe` block at the end)

**Interfaces:**
- Consumes: everything from Tasks 1-3. `orgMergeModule` is this file's existing `* as` import of `services/orgMerge`.

- [ ] **Step 1: Add a PAM seed helper (new function beside `seedFixture` — do NOT change `seedFixture` itself; every existing gauntlet test must keep running against a PAM-free loser)**

```ts
/**
 * Seeds one elevation_request -> pam_actuation -> pam_actuation_result chain
 * under `orgId` against `deviceId`. Copy the elevation-request INSERT columns
 * from pamDeviceMoveGuard.integration.test.ts's seed (~line 140-200) — that
 * suite is the authoritative example of a minimal valid request row.
 */
async function seedPamEvidence(orgId: string, siteId: string, deviceId: string): Promise<void> {
  const requestId = /* INSERT INTO elevation_requests ... RETURNING id — per the move-guard suite's pattern, bound to orgId/siteId/deviceId */;
  const actuationId = crypto.randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO pam_actuations (
      id, org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username
    ) VALUES (
      ${actuationId}::uuid, ${orgId}::uuid, ${deviceId}::uuid, ${requestId}::uuid, 1, 1,
      'active', 'verified_active', 'C:\\Program Files\\Fixture\\fixture.exe',
      ${'a'.repeat(64)}, 'fixture-user'
    )`);
  await getTestDb().execute(sql`
    INSERT INTO pam_actuation_results (
      observation_id, org_id, device_id, actuation_id, generation,
      result_kind, evidence, observed_at
    ) VALUES (
      gen_random_uuid(), ${orgId}::uuid, ${deviceId}::uuid, ${actuationId}::uuid, 1,
      'received', '{}'::jsonb, now()
    )`);
}
```

- [ ] **Step 2: Write the failing end-to-end tests**

```ts
describe('blocks-merge: durable PAM evidence refuses the merge', () => {
  let f: Fixture;
  beforeEach(async () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    f = await seedFixture();
  });
  afterEach(() => vi.restoreAllMocks());

  it('preview verdict is blocked with per-table counts and the refusal text', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    const preview = await orgMergeModule.previewOrgMerge(f.loser, f.survivor, f.partner);
    expect(preview.verdict).toBe('blocked');
    expect(preview.tables).toEqual(
      expect.arrayContaining([
        { table: 'pam_actuations', policy: 'blocks-merge', loserRows: 1, wouldDrop: 0 },
        { table: 'pam_actuation_results', policy: 'blocks-merge', loserRows: 1, wouldDrop: 0 },
      ]),
    );
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]).toContain('durable PAM lifecycle evidence');
    expect(preview.blockers[0]).toContain('Audit-admin retention is not a merge mechanism');
  });

  it('executeOrgMerge refuses pre-fence: typed error, loser undisturbed, nothing merged', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    const before = await snapshotOrgState(f.loser); // jsonb snapshot: org row status/settings + pam row counts; write this tiny helper inline with two SELECTs
    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
        performedBy: f.actor, performedByEmail: f.actorEmail,
      }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED', name: 'OrgMergeBlockedError' });
    expect(await snapshotOrgState(f.loser)).toEqual(before); // status NOT 'merging' — never fenced
    const events = await getTestDb().execute(sql`SELECT 1 FROM org_merge_events WHERE loser_org_id = ${f.loser}::uuid`);
    expect(rows(events)).toHaveLength(0);
  });

  it('in-transaction recheck refuses, rolls back, and unfences (TOCTOU path)', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    // Let the pre-fence check pass so Phase B runs and the tx-internal copy refuses:
    vi.spyOn(orgMergeModule, 'collectMergeBlockers').mockResolvedValueOnce([]);
    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
        performedBy: f.actor, performedByEmail: f.actorEmail,
      }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED' });
    // rollback + unfence: status restored, no merge event, survivor untouched
    const org = rows(await getTestDb().execute(sql`SELECT status FROM organizations WHERE id = ${f.loser}::uuid`))[0];
    expect(org?.status).toBe('active');
    expect(rows(await getTestDb().execute(sql`SELECT 1 FROM org_merge_events WHERE loser_org_id = ${f.loser}::uuid`))).toHaveLength(0);
  });

  it('survivor-side PAM evidence never blocks and is never touched', async () => {
    await seedPamEvidence(f.survivor, f.siteS, f.deviceS); // use seedFixture's survivor site/device fields; read the Fixture type for the exact names
    const pamBefore = rows(await getTestDb().execute(sql`
      SELECT id, org_id, device_id FROM pam_actuations WHERE org_id = ${f.survivor}::uuid ORDER BY id`));
    const result = await orgMergeModule.executeOrgMerge({
      loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
      performedBy: f.actor, performedByEmail: f.actorEmail,
    });
    expect(result.mergeEventId).toBeTruthy();
    const pamAfter = rows(await getTestDb().execute(sql`
      SELECT id, org_id, device_id FROM pam_actuations WHERE org_id = ${f.survivor}::uuid ORDER BY id`));
    expect(pamAfter).toEqual(pamBefore);
  });
});
```
Notes for the implementer: `rows(...)`, `getTestDb()`, and the `Fixture` field names are this file's existing helpers/types — read them before writing; adjust field names (`siteL`/`deviceL`/`siteS`/`deviceS`) to what `Fixture` actually declares. The survivor-side test's PAM device is a SURVIVOR device, so `devices_pam_history_move_guard` never sees an org change for it.

- [ ] **Step 3: Run RED, then fix only what the failures name**

```bash
pnpm test:integration -- src/__tests__/integration/orgMerge.integration.test.ts
```
The four new tests must fail before Tasks 1-2's code is present (they are not, at this point in the sequence — so here they should PASS immediately if Tasks 1-2 were done right; a failure here is a real defect in those tasks, not in the tests. Investigate the implementation, do not weaken the assertions). Every pre-existing gauntlet test must still pass (PAM-free fixture).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/orgMerge.integration.test.ts
git commit -m "test(pam): merge gauntlet covers durable-PAM blocked, TOCTOU, and survivor-side paths"
```

---

### Task 6: Web modal — render blockers, gate the confirm

**Files:**
- Modify: `apps/web/src/components/settings/MergeOrgModal.tsx` (preview type ~line 19-24; preview render + confirm gating — read the existing `too-large` handling and mirror it)
- Test: `apps/web/src/components/settings/MergeOrgModal.test.tsx`

**Interfaces:**
- Consumes: `OrgMergePreview` with `verdict: 'ok' | 'too-large' | 'blocked'` and `blockers: string[]` (Task 2's API shape; the modal keeps its own mirrored interface).

- [ ] **Step 1: Write the failing test** (follow the file's existing preview-phase test pattern for mocking `fetchWithAuth`):

```tsx
it('renders blockers and refuses to proceed when the preview verdict is blocked', async () => {
  // preview fixture: { tables: [{ table: 'pam_actuations', policy: 'blocks-merge', loserRows: 3, wouldDrop: 0 }],
  //   totalMovableRows: 0, verdict: 'blocked', warnings: [],
  //   blockers: ['merge blocked: the merged-away organization holds durable PAM lifecycle evidence (3 pam_actuations row(s)). ...'] }
  // render modal, advance past survivor pick to the preview phase
  // expect: the blocker text visible (role="alert"), and the confirm/typed-name
  // step unreachable or its submit disabled — mirror how the existing
  // too-large test asserts refusal.
});
```

- [ ] **Step 2: Run RED** — `cd apps/web && pnpm vitest run src/components/settings/MergeOrgModal.test.tsx`

- [ ] **Step 3: Implement** — extend the mirrored `OrgMergePreview` interface (`verdict: 'ok' | 'too-large' | 'blocked'; blockers: string[];`), render:

```tsx
{preview.verdict === 'blocked' && (
  <div role="alert" className={/* reuse the modal's existing destructive/warning panel classes */}>
    {preview.blockers.map((b) => (
      <p key={b}>{b}</p>
    ))}
  </div>
)}
```
and gate progression to the typed-name confirm step on `preview.verdict === 'ok' || preview.verdict === 'too-large'` — exactly the existing too-large UX minus its retry guidance (blocked is not operator-retryable; the panel text says why).

- [ ] **Step 4: Run GREEN; run the whole modal test file**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings && git commit -m "fix(web): surface blocked org-merge verdict and refuse to proceed"
```

---

### Task 7: PAM worker lifecycle test — rewrite against the worker registry

**Files:**
- Rewrite: `src/index.pam-actuation-worker.test.ts` (whole file)

Background (why rewrite rather than wire): the branch's runtime wiring is DONE — `services/workerRegistry.ts` (~line 899) registers `pamActuationWorker` with `init: initializePamActuationWorker, shutdown: shutdownPamActuationWorker`, `startRegisteredWorkers` feeds readiness via `onResult`, and `buildWorkerShutdownTasks` runs in the `workers` shutdown phase, which precedes the `redis` phase structurally. The old test asserts the pre-#4086 static-array mechanism in `index.ts`, which no longer exists. The intent (readiness-tracked init; shutdown before Redis teardown) is preserved; the mechanism assertion moves to the registry.

- [ ] **Step 1: Replace the file's content**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_REGISTRY } from './services/workerRegistry';
import { initializePamActuationWorker, shutdownPamActuationWorker } from './jobs/pamActuationWorker';

describe('PAM actuation worker runtime lifecycle', () => {
  it('is registered in the lazy worker registry with readiness-tracked init and shutdown symmetry', async () => {
    const entry = WORKER_REGISTRY.find((w) => w.name === 'pamActuationWorker');
    expect(entry).toBeDefined();
    expect(entry!.placement).toBe('global');
    const mod = await entry!.load();
    expect(mod.init).toBe(initializePamActuationWorker);
    expect(mod.shutdown).toBe(shutdownPamActuationWorker);
  });

  it('the workers shutdown phase precedes Redis teardown in the shutdown plan', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const workersPhase = indexSource.indexOf("{ name: 'workers', tasks: workerShutdownTasks }");
    const redisPhase = indexSource.indexOf("{ name: 'redis', tasks: [closeRedis] }");
    expect(workersPhase).toBeGreaterThan(-1);
    expect(redisPhase).toBeGreaterThan(workersPhase);
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm vitest run src/index.pam-actuation-worker.test.ts
```
Expected: PASS. If the registry import drags in heavy side effects and the test hangs, load the entry via the registry's `load()` thunk only (as written) — do not import `index.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.pam-actuation-worker.test.ts
git commit -m "test(pam): assert actuation worker lifecycle via the lazy worker registry"
```

---

### Task 8: Full verification, push, CI, merge

- [ ] **Step 1: Full affected-suite pass**

```bash
cd apps/api
pnpm vitest run src/services/orgMerge.test.ts src/routes/orgMerge.test.ts src/index.pam-actuation-worker.test.ts
pnpm test:integration -- src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMerge.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/pamActuationLifecycle.integration.test.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts
pnpm lint
cd ../web && pnpm vitest run src/components/settings/MergeOrgModal.test.tsx && pnpm lint
cd ../.. && pnpm build --filter=@breeze/api --filter=web 2>/dev/null || pnpm build
pnpm --dir apps/api test:docker:down
```

- [ ] **Step 2: Push and watch CI**

```bash
git push origin fix/s0-pam-actuation-lifecycle
gh pr checks 4105 -R LanternOps/breeze --watch
```
Required green: `CI Success` (the ruleset's only required check). Cloudflare Pages is not required.

- [ ] **Step 3: Merge (only with CI Success green on the HEAD SHA — assert the SHA, per the #4159 lesson)**

```bash
gh pr view 4105 -R LanternOps/breeze --json headRefOid -q .headRefOid   # must equal the pushed SHA
gh pr merge 4105 -R LanternOps/breeze --squash --admin
gh workflow run drift-detector.yml -R LanternOps/breeze   # ancestry check, schedule-only otherwise
```
(#4196 closes automatically via the PR body.)

---

## Post-plan follow-ups (not part of this plan)

- File the roadmap issue for the ownership-epoch / PAM evidence-continuity model (spec §Out of scope) once #4105 merges.
- Track B port (12 semantic conflicts), Track C readiness port onto the worker registry, QA evidence PR — per the standing program order.
