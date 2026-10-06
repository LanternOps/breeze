---
tracking_issue: LanternOps/breeze#4477
spec: ../../specs/pam/2026-10-06-pam-ownership-epoch-design.md
---

# PAM Ownership Epochs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let PAM-touched devices move orgs and let PAM-touched orgs merge. Every
PAM evidence row stays at its original tenancy, never rewritten, while every
endpoint binding keeps resolving.

**Architecture:** Each org change on a device appends an immutable ownership
epoch, and the PAM chain's composite FKs point at that epoch, not at the live
device. Binding and result resolution go through a narrow `SECURITY DEFINER`
lineage lookup. Merges keep the loser's evidence under an evidence-hold shell,
and survivor users read it through a SELECT-only lineage RLS branch. The agent
gains a server-authored identity refresh and a `retired` ledger disposition.

**Tech Stack:** PostgreSQL (hand-written idempotent migrations), Hono + Drizzle (API), Vitest (unit + real-PG integration), Go agent (`go test -race`).

**Spec:** `docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md`. Read it first; section numbers below (§N) refer to it.

## Global Constraints

These apply to every task.

**Evidence and guards**
- `pam_actuation_results` stays append-only. No migration or code path may
  UPDATE it, and its revoke and trigger stay byte-for-byte unchanged.
- No PAM-chain row is ever repointed: `elevation_requests` that reached
  actuation, `elevation_audit`, `pam_actuations`, `pam_actuation_results`.
- The device-move guard and `blocks-merge` stay the live behavior until
  Wave 6 turns on `PAM_OWNERSHIP_EPOCH_TRANSFER`. Waves 1–5 must leave every
  existing PAM test green with unchanged expectations.

**Migrations**
- Migrations are idempotent and contain no inner `BEGIN`/`COMMIT`.
- Any migration that writes rows starts with
  `SELECT set_config('breeze.scope', 'system', true);`.
- Each migration filename must sort after the newest committed migration
  **at implementation time**. Check with `ls apps/api/migrations | sort | tail -1`.
  As of this plan the newest is `2026-12-13-110200-…`, so Wave 1 starts at
  `2026-12-14-100000-`. Re-check before every commit; the pre-push hook
  enforces it against `origin/main`.

**Tenancy contracts**
- Every new table with an `org_id` is registered in all of:
  `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`),
  `services/orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`
  (`services/tenantExportPolicyRegistry.ts`; jsonb columns go to
  `excludedOpen`), and the right allowlist in
  `__tests__/integration/rls-coverage.integration.test.ts`.
- Tables with a `device_id` column are also registered in
  `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`).
- New columns on already-registered tables need export-policy classification.

**Tests and copy**
- Run tests in the foreground with
  `cd apps/api && npx vitest run <files>`. Never use `pnpm … test -- --run`.
- Integration tests need the per-worktree stack: `pnpm test-stack up`, and
  `pnpm test-stack down` at the end.
- PR bodies and commit messages use neutral wording.

## Review Focus

These failure modes are not exercised by any single task's happy-path tests.
Each is pinned by a named test in the owning task.

1. **Source org erased while a moved device is offline, then the agent
   restarts.** The expected outcome is that the ledger entries retire and PAM
   admission reopens; there must be no permanent wedge. Pinned in Task 3.3
   (`retirement marker survives source erasure`).
2. **A → B → A: the device returns to its original org, then is deleted.**
   The expected outcome is that only epoch-3 rows are deleted and epoch-1 rows
   of org A survive. Pinned in Task 2.4 (`exact-epoch deletion on return trip`).
3. **The intermediate survivor of A → B → C is erased.** A's held history
   must still be readable by C, and nothing may be erased. Pinned in Task 5.2
   (`transitive hold`).
4. **A v1 agent on a moved device.** The resolver must never return
   `unresolved` for a pre-move ledger entry. Pinned in Task 3.2
   (`v1 historical candidate is stale`).
5. **A destination-org user lists PAM history.** The user must see none of
   the source epoch's rows or device snapshots. Pinned in Task 5.3
   (`target never sees source history`).

---

## Wave table

| Wave | Title | Depends on | Migrations | Blast radius | Implement / review tier |
|---|---|---|---|---|---|
| W1 | Epoch lineage foundation | — | 1 (`device_ownership_epochs`, closures, `devices.ownership_epoch`, epoch trigger, retirement markers) | High (tenancy, trigger on `devices`) | Sonnet implements, Opus reviews |
| W2 | Epoch-anchor the PAM chain | W1 | 1 (`device_epoch` columns, FK swaps, freeze and insert guards, closed predicate) + deletion/site-move code | High (FKs on evidence, deletion) | Opus implements, Opus reviews |
| W3 | Lineage binding and result path (server) | W2 | 1 (definer function) | High (agent-facing protocol, auth) | Opus implements, Opus reviews |
| W4 | Agent identity refresh and `retired` retirement | W3 (server surfaces) | 0 (API response fields only) | High (agent-shipped) | Opus implements, Opus reviews + Windows lab |
| W5 | Merge evidence holds and survivor read access | W2 | 1 (`org_evidence_holds`, lineage RLS branch) | High (erasure, RLS) | Opus implements, Opus reviews |
| W6 | Enablement behind flag + full matrix | W3, W4, W5 | 1 (trigger predicate reads GUC; registry kind) | High (flips the guards) | Opus implements, Opus reviews + owner sign-off |

Sequencing: W1 → W2 → (W3 ∥ W5) → W4 → W6. Waves 1–5 are behavior-neutral for
users, since no move or merge of a PAM-touched device becomes possible until W6.

---

## Wave 1 — Epoch lineage foundation

**Files:**
- Create: `apps/api/migrations/2026-12-14-100000-device-ownership-epochs.sql`
- Create: `apps/api/src/db/schema/deviceOwnershipEpochs.ts` (Drizzle defs; export from `db/schema/index.ts`)
- Modify: `apps/api/src/db/schema/devices.ts` (add `ownershipEpoch`)
- Modify: `apps/api/src/services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/core.ts` (registrations)
- Test: `apps/api/src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (allowlist for the system-only `pam_ledger_retirements`)

**Interfaces produced:**
- Tables `device_ownership_epochs`, `device_ownership_epoch_closures`, and `pam_ledger_retirements` (§4.1, §4.2, §4.5).
- Column `devices.ownership_epoch integer NOT NULL DEFAULT 1`.
- Trigger function `public.breeze_device_ownership_epoch_advance()`, `BEFORE UPDATE OF org_id ON devices`.
- Trigger function `public.breeze_device_ownership_epoch_init()`, `AFTER INSERT ON devices`.
- GUC `breeze.ownership_change_cause`, read by the trigger, default `'unspecified'`.

### Task 1.1: Epoch tables and backfill

- [ ] **Step 1: Write the failing test**

```ts
// deviceOwnershipEpochs.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite, createDevice } from './db-utils';

describe('device ownership epochs — foundation', () => {
  it('every device has epoch 1 on insert with a matching epoch row', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site.id });
    const [d] = await db.execute(sql`SELECT ownership_epoch FROM devices WHERE id = ${device.id}`) as any[];
    expect(d.ownership_epoch).toBe(1);
    const epochs = await db.execute(sql`
      SELECT epoch, org_id, cause FROM device_ownership_epochs WHERE device_id = ${device.id}`) as any[];
    expect(epochs).toEqual([{ epoch: 1, org_id: org.id, cause: 'enrollment' }]);
  });

  it('epoch rows reject UPDATE (append-only)', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const device = await createDevice({ orgId: org.id, siteId: (await createSite({ orgId: org.id })).id });
    await expect(db.execute(sql`
      UPDATE device_ownership_epochs SET cause = 'device_move' WHERE device_id = ${device.id}`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('caller-written ownership_epoch changes are rejected', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const device = await createDevice({ orgId: org.id, siteId: (await createSite({ orgId: org.id })).id });
    await expect(db.execute(sql`UPDATE devices SET ownership_epoch = 7 WHERE id = ${device.id}`))
      .rejects.toMatchObject({ code: '42501' });
  });
});
```

If `db-utils` has no `createDevice`, use the device-insert helper already used
by `pamDeviceMoveGuard.integration.test.ts`. Grep for `INSERT INTO devices` in
that file.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts`
Expected: FAIL with `column "ownership_epoch" does not exist`.

- [ ] **Step 3: Write the migration (tables, guards, init trigger, backfill)**

```sql
-- 2026-12-14-100000-device-ownership-epochs.sql
-- PAM ownership epochs W1 (spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md §4).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS ownership_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_ownership_epoch_chk;
ALTER TABLE devices ADD CONSTRAINT devices_ownership_epoch_chk CHECK (ownership_epoch >= 1);

CREATE TABLE IF NOT EXISTS device_ownership_epochs (
  device_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch >= 1),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id uuid,
  cause text NOT NULL CHECK (cause IN ('enrollment','backfill','device_move','org_merge','unspecified')),
  started_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_ownership_epochs_pkey PRIMARY KEY (device_id, epoch),
  CONSTRAINT device_ownership_epochs_device_org_epoch_key UNIQUE (device_id, org_id, epoch)
);
CREATE INDEX IF NOT EXISTS device_ownership_epochs_org_idx ON device_ownership_epochs (org_id);

CREATE TABLE IF NOT EXISTS device_ownership_epoch_closures (
  device_id uuid NOT NULL,
  epoch integer NOT NULL,
  org_id uuid NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  hostname_snapshot varchar(255),
  display_name_snapshot varchar(255),
  site_id_snapshot uuid,
  CONSTRAINT device_ownership_epoch_closures_pkey PRIMARY KEY (device_id, epoch),
  CONSTRAINT device_ownership_epoch_closures_epoch_fkey
    FOREIGN KEY (device_id, org_id, epoch)
    REFERENCES device_ownership_epochs(device_id, org_id, epoch) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_ownership_epoch_closures_org_idx ON device_ownership_epoch_closures (org_id);

CREATE TABLE IF NOT EXISTS pam_ledger_retirements (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  actuation_id uuid NOT NULL,
  retired_epoch integer NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pam_ledger_retirements_pkey PRIMARY KEY (device_id, actuation_id)
);

-- Append-only guards (UPDATE always refused; DELETE allowed — cascades only).
CREATE OR REPLACE FUNCTION public.breeze_ownership_epoch_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = TG_TABLE_NAME || ' is append-only';
END; $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['device_ownership_epochs','device_ownership_epoch_closures','pam_ledger_retirements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_block_update ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_block_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.breeze_ownership_epoch_immutable()', t, t);
  END LOOP;
END $$;

-- RLS: epochs + closures are Shape 1; retirements are system-only.
ALTER TABLE device_ownership_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_ownership_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE device_ownership_epoch_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_ownership_epoch_closures FORCE ROW LEVEL SECURITY;
ALTER TABLE pam_ledger_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pam_ledger_retirements FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['device_ownership_epochs','device_ownership_epoch_closures'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY breeze_org_isolation ON %I
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))$p$, t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS breeze_system_only ON pam_ledger_retirements;
CREATE POLICY breeze_system_only ON pam_ledger_retirements
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, INSERT, DELETE ON device_ownership_epochs, device_ownership_epoch_closures, pam_ledger_retirements TO breeze_app;

-- Caller-written ownership_epoch is refused; only the advance trigger (depth>1 / its own NEW) sets it.
CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_write_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ownership_epoch IS DISTINCT FROM OLD.ownership_epoch
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'devices.ownership_epoch is trigger-managed';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS devices_ownership_epoch_write_guard ON devices;
CREATE TRIGGER devices_ownership_epoch_write_guard BEFORE UPDATE OF ownership_epoch ON devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_ownership_epoch_write_guard();

CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_init()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
  VALUES (NEW.id, NEW.ownership_epoch, NEW.org_id, NEW.site_id, 'enrollment')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS devices_ownership_epoch_init ON devices;
CREATE TRIGGER devices_ownership_epoch_init AFTER INSERT ON devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_ownership_epoch_init();

-- Backfill epoch 1 for existing devices (batched; reports count).
DO $$ DECLARE n bigint := 0; b integer; BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    INSERT INTO device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
    SELECT d.id, d.ownership_epoch, d.org_id, d.site_id, 'backfill'
    FROM devices d
    WHERE NOT EXISTS (SELECT 1 FROM device_ownership_epochs e WHERE e.device_id = d.id)
    ORDER BY d.id LIMIT 5000;
    GET DIAGNOSTICS b = ROW_COUNT;
    n := n + b;
    EXIT WHEN b = 0;
  END LOOP;
  RAISE WARNING 'device ownership epochs backfilled: %', n;
END $$;
```

The `AFTER INSERT` trigger's `INSERT` runs under the inserting caller's RLS.
Every device insert path already runs with org access to `NEW.org_id`, so the
policy's `WITH CHECK` passes. Task 1.3 tests the enrollment path explicitly.

- [ ] **Step 4: Run the test and confirm it passes**

Run the Step 2 command. Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-12-14-100000-device-ownership-epochs.sql apps/api/src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts
git commit -m "feat(api): device ownership epoch tables and backfill (#4477)"
```

### Task 1.2: Epoch-advance trigger on org change

The existing `devices_pam_history_move_guard` stays and keeps refusing every
PAM-history move. This task only adds lineage for devices with no PAM history.

- [ ] **Step 1: Write the failing tests** (append to the same file)

```ts
it('org change appends a closure, a new epoch, and retirement markers atomically', async () => {
  const db = getTestDb();
  const partner = await createPartner();
  const a = await createOrganization({ partnerId: partner.id });
  const b = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: a.id });
  const siteB = await createSite({ orgId: b.id });
  const device = await createDevice({ orgId: a.id, siteId: siteA.id, hostname: 'host-a' });
  await db.execute(sql`SELECT set_config('breeze.ownership_change_cause', 'device_move', false)`);
  await db.execute(sql`UPDATE devices SET org_id = ${b.id}, site_id = ${siteB.id} WHERE id = ${device.id}`);
  const [d] = await db.execute(sql`SELECT ownership_epoch FROM devices WHERE id = ${device.id}`) as any[];
  expect(d.ownership_epoch).toBe(2);
  const epochs = await db.execute(sql`SELECT epoch, org_id, cause FROM device_ownership_epochs WHERE device_id = ${device.id} ORDER BY epoch`) as any[];
  expect(epochs).toEqual([
    { epoch: 1, org_id: a.id, cause: 'enrollment' },
    { epoch: 2, org_id: b.id, cause: 'device_move' },
  ]);
  const [c] = await db.execute(sql`SELECT epoch, org_id, hostname_snapshot, site_id_snapshot FROM device_ownership_epoch_closures WHERE device_id = ${device.id}`) as any[];
  expect(c).toEqual({ epoch: 1, org_id: a.id, hostname_snapshot: 'host-a', site_id_snapshot: siteA.id });
});

it('A → B → A produces three epochs, epoch 3 in A', async () => {
  // move twice; assert epochs [1:A, 2:B, 3:A] and two closures
});

it('a site-only change does not advance the epoch', async () => {
  // UPDATE devices SET site_id = <other site in same org>; assert ownership_epoch still 1, one epoch row
});

it('rolled-back org change leaves no epoch or closure rows', async () => {
  // BEGIN; UPDATE org; ROLLBACK (use postgres() client); assert counts unchanged
});
```

Write the three stubbed bodies in full, following the first test's pattern.

- [ ] **Step 2: Run and confirm they fail**

Expected: `ownership_epoch` is still 1, or no closure exists.

- [ ] **Step 3: Add the advance trigger to the W1 migration** (the file is unshipped, so it may still be edited)

```sql
CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_advance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cause text := coalesce(nullif(current_setting('breeze.ownership_change_cause', true), ''), 'unspecified');
BEGIN
  IF NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN RETURN NEW; END IF;
  INSERT INTO device_ownership_epoch_closures (device_id, epoch, org_id, hostname_snapshot, display_name_snapshot, site_id_snapshot)
  VALUES (OLD.id, OLD.ownership_epoch, OLD.org_id, OLD.hostname, OLD.display_name, OLD.site_id);
  INSERT INTO pam_ledger_retirements (device_id, actuation_id, retired_epoch)
  SELECT OLD.id, a.id, OLD.ownership_epoch FROM pam_actuations a
  WHERE a.device_id = OLD.id AND a.org_id = OLD.org_id
  ON CONFLICT DO NOTHING;
  NEW.ownership_epoch := OLD.ownership_epoch + 1;
  INSERT INTO device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
  VALUES (NEW.id, NEW.ownership_epoch, NEW.org_id, NEW.site_id,
          CASE WHEN cause IN ('device_move','org_merge') THEN cause ELSE 'unspecified' END);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS devices_ownership_epoch_advance ON devices;
-- Fires before devices_pam_history_move_guard (alphabetical: 'o' < 'p'). That is safe:
-- a guard refusal aborts the whole statement, rolling back the closure/epoch/marker
-- inserts. Task 1.2's "refused move writes no rows" assertion pins this.
CREATE TRIGGER devices_ownership_epoch_advance BEFORE UPDATE OF org_id ON devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_ownership_epoch_advance();
```

The trigger writes as the updating caller. The closure, epoch, and retirement
inserts need system scope or target-org access. Verify that the move route
(`routes/devices/moveOrg.ts`) and the merge engine already run under a context
that passes the closure policy for **both** orgs.

If either does not, make the function `SECURITY DEFINER` with
`SET search_path = public, pg_temp` and owner `breeze_migrator`. That role
bypasses RLS on these three tables only through policy, not ownership, so
also add `breeze_current_scope() = 'system'` coverage via
`set_config('breeze.scope','system',true)` inside the function. Record the
decision in the migration comment.

Also add the PAM epoch tables to the exclusion list of
`breeze_device_child_orgid_tables()`. Copy its full current body from
`2026-09-17-pam-device-move-guard.sql:39-` and add `'device_ownership_epochs'`,
`'device_ownership_epoch_closures'`, and `'pam_ledger_retirements'` to the
`NOT IN` list. Generic move rewriting must never touch lineage.

- [ ] **Step 4: Run the tests and confirm they pass**, then run the existing guard and move suites unchanged:

`npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceOwnershipEpochs.integration.test.ts src/__tests__/integration/pamDeviceMoveGuard.integration.test.ts src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts src/__tests__/integration/orgMerge.integration.test.ts`
Expected: all PASS. The guard suite's byte-identical assertions must show no
new rows for a refused move.

- [ ] **Step 5: Commit** — `feat(api): advance device ownership epoch on org change (#4477)`

### Task 1.3: Contract registrations

- [ ] **Step 1: Run the contract suites to see them RED**

```bash
cd apps/api
npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/orgMerge.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```

Expected: these fail, naming the three new tables.

- [ ] **Step 2: Register the tables**

- `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: add
  `device_ownership_epoch_closures` and `device_ownership_epochs`, in
  alphabetical position. The FK makes closures a child of epochs, and
  `device_ownership_epoch_closures` sorts before `device_ownership_epochs`, so
  the order is correct.
- `orgMergeRegistry.ts`: add both epoch tables as
  `{ kind: 'leave-for-erasure', note: 'ownership lineage is immutable; the loser epoch closes when the devices repoint opens a survivor epoch' }`.
  W5 revisits this for held shells.
- `tenantExportPolicyRegistry.ts`: classify every column as `included`. There
  are no jsonb columns.
- `routes/devices/core.ts` `CORE_DEVICE_CASCADE_DELETE_TABLES`: add all three.
  W2 adds the exact-epoch predicate. Until then, deletion by `device_id` is
  correct, because no device has more than one epoch while the guard blocks
  PAM moves. Non-PAM devices with several epochs carry no evidence.
- `rls-coverage.integration.test.ts`: add `pam_ledger_retirements` to the
  intentionally system-scoped allowlist, with a comment citing spec §4.5.

- [ ] **Step 3: Rerun the Step 1 commands** — expected: all PASS.

- [ ] **Step 4: Run `pnpm db:check-drift` and the API typecheck**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Check the exit code, not a piped tail.

- [ ] **Step 5: Commit** — `chore(api): register ownership epoch tables in tenancy contracts (#4477)`

---

## Wave 2 — Epoch-anchor the PAM chain

**Files:**
- Create: `apps/api/migrations/<next>-pam-chain-epoch-anchor.sql`
- Modify: `apps/api/src/db/schema/elevations.ts`, `db/schema/pam*.ts` (`deviceEpoch` columns)
- Modify: `apps/api/src/services/deviceDeletion.ts` (per-table predicate), `routes/devices/core.ts` (exact-epoch predicate registry, site-move filter), `services/pamActuationResult.ts` (device lock first, write `device_epoch`), `services/pamActuationLifecycle.ts` and the elevation-request creators (set `device_epoch`)
- Test: `apps/api/src/__tests__/integration/pamChainEpochAnchor.integration.test.ts`

**Interfaces produced:**
- Columns `device_epoch` on `elevation_requests`, `pam_actuations`, and `pam_actuation_results`.
- SQL function `public.pam_actuation_is_closed(a pam_actuations) RETURNS boolean` (§5), `STABLE`.
- TS: `export const DEVICE_CASCADE_DELETE_PREDICATES: ReadonlyMap<string, (deviceId: string) => SQL>` in `routes/devices/core.ts`.

### Task 2.1: Columns, FK swap, byte-identical evidence

- [ ] **Step 1: Write the failing test**

```ts
it('anchoring migration leaves pam_actuation_results byte-identical', async () => {
  const db = getTestDb();
  const fx = await seedPamChain(db); // request → actuation → cleaned result, in org A (copy the seeding SQL from pamDeviceMoveGuard.integration.test.ts)
  const before = await db.execute(sql`SELECT count(*)::int n, md5(string_agg(t::text, '|' ORDER BY id)) h
    FROM (SELECT id, observation_id, org_id, device_id, actuation_id, generation, result_kind, failure_code, evidence, observed_at, received_at FROM pam_actuation_results) t`);
  await replayMigration('<next>-pam-chain-epoch-anchor.sql');
  const after = await db.execute(sql`SELECT count(*)::int n, md5(string_agg(t::text, '|' ORDER BY id)) h
    FROM (SELECT id, observation_id, org_id, device_id, actuation_id, generation, result_kind, failure_code, evidence, observed_at, received_at FROM pam_actuation_results) t`);
  expect(after).toEqual(before);
  const [r] = await db.execute(sql`SELECT device_epoch FROM pam_actuation_results WHERE actuation_id = ${fx.actuationId}`) as any[];
  expect(r.device_epoch).toBe(1);
});

it('PAM chain FKs reference device_ownership_epochs, not devices', async () => {
  const rows = await getTestDb().execute(sql`
    SELECT conrelid::regclass::text tbl, confrelid::regclass::text ref
    FROM pg_constraint WHERE contype = 'f'
      AND conrelid::regclass::text IN ('elevation_requests','pam_actuations','pam_actuation_results')
      AND confrelid::regclass::text IN ('devices','device_ownership_epochs','pam_actuations')`) as any[];
  expect(rows.filter((r) => r.ref === 'devices')).toEqual([]);
  expect(rows).toEqual(expect.arrayContaining([
    { tbl: 'elevation_requests', ref: 'device_ownership_epochs' },
    { tbl: 'pam_actuations', ref: 'device_ownership_epochs' },
    { tbl: 'pam_actuation_results', ref: 'pam_actuations' },
  ]));
});
```

- [ ] **Step 2: Run and confirm it fails** (the migration file does not exist yet, and the FKs still point at `devices`).

- [ ] **Step 3: Write the migration**

```sql
SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE elevation_requests   ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE pam_actuations       ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE pam_actuation_results ADD COLUMN IF NOT EXISTS device_epoch integer NOT NULL DEFAULT 1;

ALTER TABLE pam_actuations DROP CONSTRAINT IF EXISTS pam_actuations_id_device_org_epoch_key;
ALTER TABLE pam_actuations ADD CONSTRAINT pam_actuations_id_device_org_epoch_key UNIQUE (id, device_id, org_id, device_epoch);

-- elevation_requests: device_id → devices(id)  ==>  (device_id, org_id, device_epoch) → epochs
ALTER TABLE elevation_requests DROP CONSTRAINT IF EXISTS elevation_requests_device_id_devices_id_fk;  -- verify exact name via \d first
ALTER TABLE elevation_requests DROP CONSTRAINT IF EXISTS elevation_requests_device_epoch_fkey;
ALTER TABLE elevation_requests ADD CONSTRAINT elevation_requests_device_epoch_fkey
  FOREIGN KEY (device_id, org_id, device_epoch) REFERENCES device_ownership_epochs(device_id, org_id, epoch)
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE elevation_requests VALIDATE CONSTRAINT elevation_requests_device_epoch_fkey;

ALTER TABLE pam_actuations DROP CONSTRAINT IF EXISTS pam_actuations_device_id_org_id_fkey;
ALTER TABLE pam_actuations DROP CONSTRAINT IF EXISTS pam_actuations_device_epoch_fkey;
ALTER TABLE pam_actuations ADD CONSTRAINT pam_actuations_device_epoch_fkey
  FOREIGN KEY (device_id, org_id, device_epoch) REFERENCES device_ownership_epochs(device_id, org_id, epoch)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE pam_actuations VALIDATE CONSTRAINT pam_actuations_device_epoch_fkey;

ALTER TABLE pam_actuation_results DROP CONSTRAINT IF EXISTS pam_actuation_results_device_id_org_id_fkey;
ALTER TABLE pam_actuation_results DROP CONSTRAINT IF EXISTS pam_actuation_results_actuation_epoch_fkey;
ALTER TABLE pam_actuation_results ADD CONSTRAINT pam_actuation_results_actuation_epoch_fkey
  FOREIGN KEY (actuation_id, device_id, org_id, device_epoch)
  REFERENCES pam_actuations(id, device_id, org_id, device_epoch)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
ALTER TABLE pam_actuation_results VALIDATE CONSTRAINT pam_actuation_results_actuation_epoch_fkey;

ALTER TABLE elevation_requests ALTER COLUMN device_epoch DROP DEFAULT;
ALTER TABLE pam_actuations     ALTER COLUMN device_epoch DROP DEFAULT;
```

The FKs that reference `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`, per the
CLAUDE.md merge-contract rule. The pre-existing PAM FKs were
`INITIALLY DEFERRED`. Keep the existing `(actuation_id, org_id)` and
`(elevation_request_id, org_id)` FKs unchanged.

**Before writing this file**, list the exact constraint names with:

```bash
docker exec … psql -c "\d elevation_requests"
```

- [ ] **Step 4: Run and confirm it passes.** Then run the full existing PAM integration set (every `pam*.integration.test.ts`) and `orgCascadeFkOnDelete.integration.test.ts`. Expected: green with no expectation edits.

- [ ] **Step 5: Commit** — `feat(api): anchor PAM chain FKs to device ownership epochs (#4477)`

### Task 2.2: Freeze and insert guards, and lock order

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['elevation_requests', 'pam_actuations'])('%s (device_id, org_id, device_epoch) is immutable', async (tbl) => {
  const fx = await seedPamChain(getTestDb());
  const id = tbl === 'pam_actuations' ? fx.actuationId : fx.requestId;
  await expect(getTestDb().execute(sql`UPDATE ${sql.identifier(tbl)} SET device_epoch = 2 WHERE id = ${id}`))
    .rejects.toMatchObject({ code: '42501' });
});

it('actuation insert with a non-current epoch is rejected', async () => {
  // seed device in epoch 1, attempt INSERT pam_actuations(..., device_epoch => 2) → 23514 'PAM chain must be created in the device current ownership epoch'
});

it('two-connection race: actuation insert vs org change — exactly one valid outcome', async () => {
  // Use two postgres() clients (pattern: pamDeviceMoveGuard.integration.test.ts race test with deferred()).
  // conn1: BEGIN; INSERT actuation (takes device FOR SHARE via trigger); wait
  // conn2: UPDATE devices SET org_id = B  (blocks)
  // conn1: COMMIT → conn2 proceeds and is refused by devices_pam_history_move_guard (W1–W5) / closed-check (W6).
  // Reverse order: conn2 commits first → conn1's insert raises 23514 (epoch/org mismatch).
});
```

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Add the guards to the W2 migration**

The two triggers below are `BEFORE UPDATE` freeze and `BEFORE INSERT` epoch
match, on `elevation_requests` and `pam_actuations`:

```sql
CREATE OR REPLACE FUNCTION public.breeze_pam_chain_epoch_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d_org uuid; d_epoch integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.device_id, NEW.org_id, NEW.device_epoch) IS DISTINCT FROM (OLD.device_id, OLD.org_id, OLD.device_epoch) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'PAM chain epoch ownership is immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT org_id, ownership_epoch INTO d_org, d_epoch FROM devices WHERE id = NEW.device_id FOR SHARE;
  IF d_org IS DISTINCT FROM NEW.org_id OR d_epoch IS DISTINCT FROM NEW.device_epoch THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAM chain must be created in the device current ownership epoch';
  END IF;
  RETURN NEW;
END; $$;
```

Create the triggers `<tbl>_epoch_guard` with `BEFORE INSERT OR UPDATE` on both
tables. This guard must not fire on `elevation_requests` UPDATEs that change
other columns, such as status. The `IS DISTINCT FROM` tuple check already
ensures that.

Then update the writers so that each sets `device_epoch` from the device row
it already reads:

- `pamActuationLifecycle.ts`
- the elevation-request creators. Grep for `INSERT INTO elevation_requests`
  and `db.insert(elevationRequests)`.
- `pamActuationResult.ts`. Add `SELECT 1 FROM devices WHERE id = $device FOR SHARE`
  **before** the actuation `FOR UPDATE`, and insert results with
  `device_epoch = current.device_epoch`.

- [ ] **Step 4: Run and confirm everything passes**, plus the full PAM integration set.

- [ ] **Step 5: Commit** — `feat(api): freeze PAM chain epoch ownership and serialize against org changes (#4477)`

### Task 2.3: Closed predicate

- [ ] **Step 1: Write the failing test**

Create `pamActuationClosed.integration.test.ts`. It is table-driven over every
`observed_state` × `desired_state` × with/without a cleaned result at the
current generation × `cleaned_at` null or set. Only the `(cleanup, cleaned,
cleaned_at set, cleaned result at current generation)` row returns `true`. It
also asserts that `UPDATE pam_actuations SET observed_state = 'failed'` on a
cleaned row raises `23514`.

- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement**

```sql
CREATE OR REPLACE FUNCTION public.pam_actuation_is_closed(a pam_actuations)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT a.desired_state = 'cleanup' AND a.observed_state = 'cleaned' AND a.cleaned_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM pam_actuation_results r
                 WHERE r.actuation_id = a.id AND r.org_id = a.org_id
                   AND r.generation = a.generation AND r.result_kind = 'cleaned');
$$;
```

Next, extend `pam_actuations_transition_guard()`. Use `CREATE OR REPLACE` with
the full current body from `2026-09-25-pam-actuation-org-immutable.sql`, plus:

```sql
IF OLD.observed_state = 'cleaned' AND NEW.observed_state <> 'cleaned' THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PAM cleaned state is terminal';
END IF;
```

Before adding the check, confirm that no lifecycle path moves a row out of
`cleaned`. Grep `observed_state` in `pamActuationLifecycle.ts` and
`pamActuationResult.ts`. If one exists, stop and raise it as a spec question.

- [ ] **Step 4: Run and confirm it passes**, plus `pamActuationTransitions.integration.test.ts`.
- [ ] **Step 5: Commit** — `feat(api): single closed-actuation predicate for ownership transfer (#4477)`

### Task 2.4: Exact-epoch device deletion and site-move filter

- [ ] **Step 1: Write the failing tests** in `pamChainEpochAnchor.integration.test.ts`

```ts
it('exact-epoch deletion on return trip (A → B → A)', async () => {
  // Build epochs 1:A (with closed PAM chain), 2:B, 3:A directly via system-scope SQL with the W6 GUC
  // OR, before W6, by inserting epoch/closure rows and PAM rows explicitly under system scope.
  // Delete the device via services/deviceDeletion.ts.
  // Expect: epoch-1 PAM chain rows for org A still present (md5 unchanged); epoch 3 rows gone; epochs 1 and 2 rows present; devices row gone.
});

it('site move within org rewrites only current-epoch elevation_requests', async () => {
  // epoch-1 request (historical, org A) and epoch-3 request (current, org A); move device site; only epoch-3 site_id changes.
});
```

- [ ] **Step 2: Run and confirm they fail** (today's deletion removes by `device_id`).

- [ ] **Step 3: Implement**

In `routes/devices/core.ts`, add:

```ts
export const DEVICE_CASCADE_DELETE_PREDICATES: ReadonlyMap<string, (deviceId: string) => SQL> = new Map([
  ...['elevation_requests', 'pam_actuations', 'pam_actuation_results', 'device_ownership_epoch_closures', 'device_ownership_epochs']
    .map((t) => [t, (deviceId: string) => sql`(device_id, org_id, ${sql.identifier(t === 'device_ownership_epochs' || t === 'device_ownership_epoch_closures' ? 'epoch' : 'device_epoch')}) =
      (SELECT d.id, d.org_id, d.ownership_epoch FROM devices d WHERE d.id = ${deviceId})`] as const),
]);
```

`elevation_audit` is deleted through its request FK cascade. In
`services/deviceDeletion.ts:339`, the loop uses
`DEVICE_CASCADE_DELETE_PREDICATES.get(table)?.(deviceId) ?? sql\`device_id = ${deviceId}\``.

Deletion order: delete the device's current-epoch rows. Earlier epochs
survive, because `device_ownership_epochs` has no FK to `devices`. In the
site-move rewriter (`core.ts` near `:1919`), add
`AND device_epoch = (SELECT ownership_epoch FROM devices WHERE id = $device)`
for `elevation_requests`.

`cascadeDelete.test.ts` gains an assertion that every table in
`DEVICE_CASCADE_DELETE_PREDICATES` is also in
`CORE_DEVICE_CASCADE_DELETE_TABLES`.

- [ ] **Step 4: Run and confirm everything passes**, plus `cascadeDelete.test.ts`, `removedDevicePurge.integration.test.ts`, and the PAM set.
- [ ] **Step 5: Commit** — `feat(api): scope PAM-chain device deletion and site moves to the current epoch (#4477)`

---

## Wave 3 — Lineage binding and result path (server)

**Files:** a migration (definer function);
`services/pamReconciliationBinding.ts`; `routes/agents/pamReconciliation.ts`;
`routes/agents/schemas.ts` (v2 schema); `services/pamActuationResult.ts`;
the reconciliation-binding spec amendment
(`docs/superpowers/specs/2026-08-26-s0-track-e-pam-reconciliation-binding-design.md`,
appended §"2026-10 amendment"). Tests: `pamReconciliationBinding.integration.test.ts`
(extend) and `pamEpochBinding.integration.test.ts` (new).

**Interfaces produced:**
- SQL `public.breeze_pam_epoch_binding(p_agent_id text, p_device_id uuid, p_candidates jsonb) RETURNS TABLE(ordinal int, observation_id uuid, status text, command_id uuid)` — `SECURITY DEFINER`, `STABLE`, `SET search_path = public, pg_temp`, `EXECUTE` to `breeze_app` only.
- v2 request and response: `{ protocolVersion: 2, candidates }` → dispositions plus `{ status: 'retired'; observationId }`.
- `PamActuationResultClassification` gains `'retired'`. The REST acknowledgement for v1 agents maps `retired` to `stale`.

### Task 3.1: Definer lookup with byte-identical current-epoch behavior

- [ ] **Step 1: RED.** Parametrize every existing case in
  `pamReconciliationBinding.integration.test.ts` to run through both the old
  service and the new function. Assert identical dispositions. Add a test that
  calls the function under an org-scoped context for a **different** org's
  device and expects every candidate `unresolved`, with no rows leaked (the
  function returns only `ordinal`/`status`/`command_id`).
- [ ] **Step 2: Implement.** The function body is the existing resolver SQL
  with two changes:
  1. The `owned_actuations` join becomes
     `actuation.device_id = device.id AND EXISTS (SELECT 1 FROM device_ownership_epochs e WHERE e.device_id = device.id AND e.org_id = actuation.org_id AND e.epoch = actuation.device_epoch)`.
     The device row is still matched on `id` and `agent_id`; the live
     `org_id` is no longer used as an ownership proof.
  2. A new first `CASE` arm:
     `WHEN actuation.device_epoch < device.ownership_epoch THEN CASE WHEN pam_actuation_is_closed(actuation) OR EXISTS (retirement marker) THEN 'retired' ELSE 'unresolved' END`.

  Then there is a retirement-marker-only arm. When the actuation row no
  longer exists (the source org was erased) but
  `pam_ledger_retirements(device_id, candidate.actuation_id)` exists, the
  disposition is `retired`. The service calls the function, then maps
  `retired` to `stale` for `protocolVersion: 1`.
- [ ] **Step 3: GREEN** — run both files. **Commit.**

### Task 3.2: v2 protocol and v1 compatibility

- [ ] **RED tests**
  - `v1 historical candidate is stale`: a device moved A → B (seeded
    directly under system scope with W1/W2 rows); a v1 request for the
    epoch-1 cleaned actuation returns `stale`, never `unresolved`.
  - `v2 historical candidate is retired`.
  - `v2 historical non-closed candidate is unresolved`.
  - `protocolVersion 3 rejected 400`.
  - The schema rejects a `retired` disposition appearing in a v1 response
    (a contract test on the serializer).
- [ ] **Implement** the zod union in `routes/agents/schemas.ts`, with version
  negotiation in the route. Keep the rate limits and size caps unchanged.
- [ ] **GREEN + commit.**

### Task 3.3: Result transaction for historical epochs, and retirement after source erasure

- [ ] **RED tests**
  - A structured `cleaned` result for a historical-epoch actuation
    acknowledges `stale` (v1) or `retired` (v2) and inserts **zero** rows.
    The md5 of the source chain is unchanged.
  - **`retirement marker survives source erasure`**: move A → B, erase org A
    through `tenantCascade` (audit-admin path), then resolve the epoch-1
    candidate with v2. Expected: `retired`. With v1: `stale`. There must be
    no `unresolved`.
- [ ] **Implement** in `recordPamActuationResult`. After the device
  `FOR SHARE`, look up the actuation via the lineage predicate. If
  `device_epoch < device.ownership_epoch`, return `retired` without writing.
  The REST acknowledgement maps it for v1.
- [ ] **GREEN + commit.**

### Task 3.4: Spec amendment

- [ ] Append to the reconciliation-binding spec a dated amendment. It records
  the widened v1 `stale` meaning, the v2 `retired` disposition, and the
  definer-function authority. It must link this spec. Docs only. **Commit.**

---

## Wave 4 — Agent identity refresh and `retired` retirement (agent-shipped)

**Files (Go):**
- `agent/internal/config/config.go`: identity snapshot type, plus a persist
  function that reuses `saveToLocked`.
- New `agent/internal/identity/snapshot.go`: a synchronized holder with
  `Get()` and a `Subscribe()` hook.
- `agent/internal/heartbeat/handlers_actuate.go:130`: compare against the
  snapshot.
- `agent/internal/peripheral/v2.go:66` and
  `agent/internal/heartbeat/handlers_rollback_backend.go:179`: read through
  the snapshot (rebuild the rollback engine on epoch change).
- `agent/internal/heartbeat/pam_reconciliation.go`: v2 negotiation, plus
  `retired` handling that calls `Store.Retire`.
- `agent/internal/pamlifetime/store.go`: `Retire(actuationID string) error`,
  which deletes the entry and persists with fsync before returning.

**Files (API):**
- The heartbeat response and the WS connect frame gain
  `identity: { deviceId, orgId, siteId, ownershipEpoch }`.
- `devices` gains `agent_identity_epoch_ack integer`, which records the epoch
  the agent last reported. PAM dispatch (`jobs/pamActuationWorker.ts`) skips a
  device until `agent_identity_epoch_ack = ownership_epoch`.

### Task 4.1: Store.Retire

- [ ] **RED (Go):** `TestRetireRemovesEntryDurably` writes an entry, retires
  it, then reloads the store from disk and expects the entry to be absent.
  `TestRetireUnknownIsNoop`. `TestRetirePersistFailureKeepsEntry` uses an
  injected persist error and expects the entry still present and an error
  returned.

  Run: `cd agent && go test -race ./internal/pamlifetime/...` — expect FAIL
  (`Retire` is undefined).
- [ ] **Implement** under `s.mu`. Use `delete` and then `persistLocked`; on
  error, restore the entry.
- [ ] **GREEN + commit.**

### Task 4.2: Identity snapshot

- [ ] **RED (Go)**, table-driven `TestIdentitySnapshotApply`:
  - Accept when the epoch is greater.
  - Reject when the epoch is lower.
  - Accept a same-epoch site change only when the `orgId` is unchanged.
  - Reject a same-epoch `orgId` change.
  - Persist before publishing. A persist failure means nothing is published.

  `TestPamLocalIdentityUsesSnapshot` applies a snapshot with a new org; a PAM
  apply payload with the new org is accepted and one with the old org is
  rejected.

  `TestRollbackEngineRebuiltOnEpochChange`. A race test runs concurrent
  `Apply` and PAM command validation under `-race`.
- [ ] **Implement.** **GREEN + commit.**

### Task 4.3: `retired` handling and v2 negotiation

- [ ] **RED (Go):**
  - `retired` → `Store.Retire` is called, and the entry is no longer
    reconciled on the next startup.
  - A server answering 400 to v2 makes the agent fall back to v1 for that
    process lifetime.
  - `stale` (v1) leaves the ledger entry in place and opens admission.
  - Existing startup-barrier tests are unchanged.
- [ ] **Implement. GREEN + commit.**

### Task 4.4: Server identity delivery and dispatch gate

- [ ] **RED (API unit + integration):**
  - The heartbeat response carries the identity of the live row.
  - The agent-reported `ownershipEpoch` updates `agent_identity_epoch_ack`
    only monotonically.
  - The PAM worker does not dispatch to a device whose ack lags.
  - The ack update is rate-limited with the heartbeat.
- [ ] **Implement. GREEN + commit.**

### Task 4.5: Gates

```bash
cd agent && go test -race ./internal/pamlifetime/... ./internal/heartbeat/... ./internal/identity/... ./internal/peripheral/... ./internal/agentapp/...
GOOS=windows GOARCH=amd64 go build ./...
```

Windows lab (per the `devpush_to_remote_vm_gotchas` recipe):

1. Move a lab device between two orgs on a wt-stack.
2. Confirm identity refresh happens.
3. Confirm the old ledger entries retire.
4. Confirm a new-epoch elevation applies and cleans.

Repeat with a v1 agent build: there must be no wedge (admission opens via
`stale`). Record the lab evidence in the PR.

---

## Wave 5 — Merge evidence holds and survivor read access

**Files:** a migration (`org_evidence_holds` and the lineage function +
policies); `services/orgMerge.ts` (Phase B hold write, depth check);
`jobs/orgMerge.ts:201` and `services/tenantOffboarding.ts:1706` (skip held
shells, `tenant.erasure.deferred_evidence_hold` audit);
`services/tenantCascade.ts` (survivor erasure erases its held shells first;
release on empty chain); `routes/pam.ts`, `services/pamAuditExport.ts`, and
the PAM AI tools (read-path sweep).

Tests: `orgEvidenceHold.integration.test.ts`,
`pamLineageRls.integration.test.ts`, and the static test
`pamReadPathScoping.test.ts`.

**Interfaces produced:**
- Table `org_evidence_holds`: Shape 3, registered in `PARTNER_TENANT_TABLES`,
  the partner cascade, and the export policy.
- `public.breeze_has_merged_lineage_access(p_org uuid) RETURNS boolean` —
  `SECURITY DEFINER`, `STABLE`, depth 5, partner-pinned.
- A `FOR SELECT` policy `breeze_merged_lineage_select` on `pam_actuations`,
  `pam_actuation_results`, `elevation_requests`, `elevation_audit`,
  `device_ownership_epochs`, and `device_ownership_epoch_closures`.
- TS `export async function assertMergeLineageDepth(tx, loserOrgId, survivorOrgId): Promise<void>`
  throws `OrgMergeBlockedError` with the reason `lineage_depth`.

### Task 5.1: Hold written in Phase B; Phase C and the sweeper skip held shells

- [ ] **RED:** a merge whose loser holds a *closed* PAM chain. Phase B and C
  are invoked through the engine test hook, which bypasses the still-live
  `blocks-merge` with the W6 GUC set **only inside the test transaction**.
  Assertions:
  - A hold row exists.
  - The job's erasure enqueue is skipped and the audit is written.
  - A sweeper run does not erase the shell.
  - The shell keeps `deleted_at` set.
  - The chain md5 is unchanged.
- [ ] **Implement. GREEN + commit.**

### Task 5.2: Transitive holds, depth cap, and release

- [ ] **RED:**
  - **`transitive hold`**: A → B (A held), then B → C. A hold is written for
    B, and erasing nothing removes A's events.
  - A merge that would make the lineage depth exceed 5 while holds exist is
    refused with reason `lineage_depth`.
  - Survivor erasure erases its held shells first and then itself; the cascade
    integration test passes.
  - Retention expiry empties the chain → the hold is released → the sweeper
    erases the shell.
- [ ] **Implement. GREEN + commit.**

### Task 5.3: Lineage RLS branch and read-path sweep

- [ ] **RED:**
  - An org-scoped survivor user selects the loser's PAM rows and sees them.
  - An org-scoped user of an unrelated org in the same partner sees nothing.
  - A forged `org_merge_events` row across partners grants nothing.
  - **`target never sees source history`**: device moved A → B. An org-B user
    calls the PAM history list and detail routes and the audit export, and
    gets zero epoch-1 rows and no closure snapshot.
  - Static test: no SQL in `apps/api/src` (excluding tests and migrations)
    joins `pam_actuations`/`pam_actuation_results`/`elevation_requests` to
    `devices` on `device_id` without also matching `org_id`. Implement it as a
    regex over the files listed by `grep -rl`, with an explicit allowlist that
    has a reason for each entry.
- [ ] **Implement:**
  - The function and the policies (SELECT-only, never `FOR ALL`).
  - The route and export fixes. Historical rows render `hostname` from
    `device_ownership_epoch_closures` via `(device_id, device_epoch)`.
  - Register in `DUAL_AXIS`/allowlists as `rls-coverage` requires.
- [ ] **GREEN.** Then run `test:rls-coverage`, `tenantCascade*`, and
  `orgMerge*` integration. **Commit.**

---

## Wave 6 — Enablement behind a flag, plus the full matrix

**Files:**
- A migration. `breeze_guard_pam_device_org_move()` is replaced (full body)
  so that when
  `current_setting('breeze.pam_epoch_transfer', true) = 'on'` it refuses only
  if `EXISTS (… AND NOT pam_actuation_is_closed(a))`. Otherwise it keeps
  today's state-blind refusal.
- `services/pamDeviceMoveGuard.ts`: on that path the error is
  `PAM_DEVICE_MOVE_ACTIVE`. Pending un-actuated requests are expired with
  reason `ownership_changed` (OD4).
- `routes/devices/moveOrg.ts`: sets both GUCs per transaction from env flag
  `PAM_OWNERSHIP_EPOCH_TRANSFER`.
- `services/orgMergeRegistry.ts`: the new kind `epoch-frozen`, added to the
  `NON_MUTATING` set; `elevation_requests` → `custom`.
- `services/orgMerge.ts`: the pre-walk predicate is "any non-closed loser
  actuation"; the GUC is set when the flag is on.
- `orgMergeRegistry.integration.test.ts`: trigger maps re-keyed so the
  discharge points at `epoch-frozen`.
- Web: `MergeOrgModal` and the device-move dialog copy for the "open PAM
  session" refusal (wrap in `runAction`).

### Task 6.1: Flag-off parity

- [ ] **RED → GREEN:** with the flag off, every existing
  `pamDeviceMoveGuard` and merge PAM test passes unchanged. Add an explicit
  test that, with the flag off and the GUC forged on by a non-route caller
  (direct SQL as `breeze_app`), the trigger **still** refuses.

  The GUC alone is not authority. The trigger additionally requires
  `breeze.ownership_change_cause IN ('device_move','org_merge')`, which only
  the route and engine set, *and* the session role to be `breeze_app` under a
  request context.

  Decide the exact binding during implementation. If no GUC binding can be
  made non-forgeable by a direct-SQL writer, fall back to a
  `SECURITY DEFINER` function, `breeze_pam_epoch_transfer_enabled()`, that
  reads a one-row system config table the app cannot write. **Record the
  choice in the PR.**

### Task 6.2: The two-org matrix (real PostgreSQL)

Create `pamOwnershipEpochMatrix.integration.test.ts`. It is table-driven, and
each row asserts all of the following:

- the HTTP or engine outcome;
- the chain md5 for both orgs (byte-identical);
- the epoch/closure/retirement rows;
- resolver dispositions over a generated ledger covering every lifecycle
  state, where **no pre-operation valid binding becomes `unresolved`**.

Matrix rows:

- **Move:**
  - no PAM;
  - closed-only → 200;
  - one open → 409 `PAM_DEVICE_MOVE_ACTIVE`;
  - A → B → A;
  - move, then delete;
  - move, then site move;
  - move, then erase the source org, then resolve.
- **Merge:**
  - survivor-only history → proceeds;
  - loser-only closed → proceeds, held;
  - loser open → 422;
  - both sides closed → proceeds;
  - A → B → C;
  - depth overflow → 422;
  - forged lineage.
- **Races (two connections):**
  - insert vs move;
  - result vs move;
  - dispatch vs move;
  - merge vs actuation insert.
  - One SERIALIZABLE smoke test.

### Task 6.3: Gates, then the owner decision

Run the following, all foreground with exit codes checked:

- the full API unit suite;
- every integration file touched by W1–W6;
- `test:rls-coverage`;
- `db:check-drift`;
- the migration-naming check;
- `tsc`;
- the Go race gates and the Windows cross-compile.

The flag stays **off** in shipped config. Turning it on for any region is an
owner decision outside this plan (#4060 governs rollout).

---

## Self-review notes

- **Spec coverage.** Every spec section maps to a task:
  §4.1–4.2 → 1.1–1.2; §4.3 → 2.1–2.2; §4.4 → 2.4; §4.5 → 1.2 (writes) and
  3.3 (reads); §5 → 2.3; §6 → W3 and W4; §7 → W5; §8 → W6; §9 → 2.2, 6.2;
  §10 → wave order and 6.1; §11 → 6.2 and 4.5.
- **Deliberately deferred to implementation time:**
  - exact pre-existing FK constraint names (Task 2.1 says to read them from
    `\d`);
  - the non-forgeable flag binding (Task 6.1 names both options and requires
    the choice to be recorded).
- **Type names** are consistent across tasks: `device_epoch`,
  `ownership_epoch`, `pam_actuation_is_closed`, `breeze_pam_epoch_binding`,
  `retired`, `epoch-frozen`, `PAM_DEVICE_MOVE_ACTIVE`.
