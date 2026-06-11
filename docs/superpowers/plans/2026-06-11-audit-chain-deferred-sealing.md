# Audit Chain Deferred Commit-Time Sealing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit hash-chain forks under concurrent writes (#1002) without the held-to-commit lock deadlock that killed draft PR #1240, by sealing the chain in a side table via a deferred commit-time trigger.

**Architecture:** `audit_logs` inserts compute a content-only hash (no lock, no predecessor read). A `DEFERRABLE INITIALLY DEFERRED` constraint trigger fires at commit, takes a per-org advisory lock for microseconds, and appends a linkage entry to a new append-only `audit_log_chain` side table ordered by `chain_seq bigserial`. `audit_log_verify_chain()` is redefined (same signature) to walk the side table. Full design + rationale: `docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md`.

**Tech Stack:** PostgreSQL (plpgsql triggers, hand-written idempotent migrations), Drizzle ORM (schema parity only), Vitest integration tests against the docker test DB (`breeze-postgres-test`, port 5433).

---

## Ground rules for the executing engineer

- **Workspace:** `/Users/toddhebebrand/bz-sec-cluster` (existing git worktree of this repo). All commands below assume you start there. Do NOT work in `/Users/toddhebebrand/breeze` (the user's main checkout).
- **Node env:** prefix EVERY pnpm/npx/vitest command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Shown explicitly in each Run line.
- **Migrations** (CLAUDE.md): idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$` + `pg_policies` checks), NO inner `BEGIN;`/`COMMIT;` (the runner wraps each file in a transaction), never edit a shipped migration. Filenames `2026-06-11-g-…` / `2026-06-11-h-…` — `-d-/-e-/-f-` are shipped today, `-a-/-b-` were burned by unmerged draft #1240 (never reuse those names: local DBs recorded their checksums; reuse with different content crashes `autoMigrate`).
- **Do not run the full `vitest run`** — known flaky in parallel. Run only the named test files.
- **Integration tests** auto-apply migrations on startup (setup.ts runs autoMigrate against `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test`).
- **Commit after every task** with the exact message given.

---

### Task 0: Branch + clean test DB

**Files:** none (setup)

- [ ] **Step 0.1: Create the branch off origin/main**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git fetch origin main
git checkout -b fix/audit-chain-deferred-sealing origin/main
```

Expected: `branch 'fix/audit-chain-deferred-sealing' set up to track 'origin/main'` (or plain "Switched to a new branch").

- [ ] **Step 0.2: Ensure deps are installed**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install --prefer-offline
```

Expected: `Done in …s`.

- [ ] **Step 0.3: Recreate the test DB from scratch** (the draft #1240 migrations were applied to it; fresh state avoids stale-trigger confusion)

```bash
cd apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:docker:down
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:docker:up
docker ps --format '{{.Names}}' | grep breeze-postgres-test
```

Expected: last command prints `breeze-postgres-test`. If `test:docker:down`/`up` scripts behave differently than expected, inspect `apps/api/package.json` scripts and use whatever brings up the 5433 test stack fresh (`down -v` semantics).

- [ ] **Step 0.4: Sanity baseline — the two suites this work must keep green**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts src/__tests__/integration/audit-logs-rls.integration.test.ts
```

Expected: both files PASS (audit-checksum ~6 tests, audit-logs-rls 5 tests). If audit-logs-rls is flaky on re-run (append-only accumulation — known), re-run once before concluding breakage.

---

### Task 1: Cherry-pick the verify-alerting cron from draft #1240

The daily `verify_chain` sweep (P1 incident + Sentry on breaks) was built and reviewed on the draft branch; it calls `audit_log_verify_chain(org)` whose signature we preserve, so it carries over unchanged.

**Files:**
- Cherry-picked: `apps/api/src/jobs/auditChainVerify.ts`, `apps/api/src/jobs/auditChainVerify.test.ts`, `apps/api/src/index.ts` (init + shutdown wiring)

- [ ] **Step 1.1: Cherry-pick the cron commit**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git cherry-pick e19ef4d5
```

Expected: clean pick, OR a conflict only in `apps/api/src/index.ts` (main moved since). If conflicted: keep BOTH sides — the cherry-pick adds (1) an import block for `initializeAuditChainVerifyWorker, shutdownAuditChainVerifyWorker` from `./jobs/auditChainVerify`, (2) an `['auditChainVerify', initializeAuditChainVerifyWorker]` entry in the workers init array, (3) `shutdownAuditChainVerifyWorker()` in the shutdown sequence. Then `git add apps/api/src/index.ts && git cherry-pick --continue`.

- [ ] **Step 1.2: Verify it compiles and its unit tests pass**

```bash
cd apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit 2>&1 | grep -vE "agents\.test\.ts|apiKeyAuth\.test\.ts"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/auditChainVerify.test.ts
```

Expected: tsc prints nothing (the two greps are known pre-existing failures); vitest `11 passed`.

(No commit needed — the cherry-pick IS the commit.)

---

### Task 2: Migration `-g-` — the `audit_log_chain` table

**Files:**
- Create: `apps/api/migrations/2026-06-11-g-audit-chain-table.sql`
- Modify: `apps/api/src/db/schema/audit.ts` (append `auditLogChain`)

- [ ] **Step 2.1: Write the migration**

Create `apps/api/migrations/2026-06-11-g-audit-chain-table.sql` with exactly:

```sql
-- Issue #1002 (part 1 of 2): side table for the audit tamper-evidence chain.
--
-- The in-row chain (checksum/prev_checksum on audit_logs, PR #900) forks under
-- concurrent same-org inserts, and the obvious fix — an advisory lock held in
-- the BEFORE INSERT trigger — deadlocks against the codebase's two-connection
-- audit-write pattern (caller-tx insert + logSessionAudit on a separate pooled
-- connection; see draft PR #1240 and
-- docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md).
--
-- Linkage moves into this append-only side table, written by a DEFERRED
-- commit-time trigger (the -h- migration). chain_seq (bigserial) is the chain
-- order; per-org subsequences are walked by org_id + chain_seq. The companion
-- -h- migration installs the seal trigger, backfills existing rows, and
-- redefines audit_log_verify_chain over this table.

CREATE TABLE IF NOT EXISTS audit_log_chain (
  chain_seq bigserial PRIMARY KEY,
  audit_id uuid NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  content_checksum varchar(128) NOT NULL,
  prev_chain_checksum varchar(128),
  chain_checksum varchar(128) NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now()
);

-- One seal per audit row; also serves the verify join and the unsealed-row sweep.
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_audit_id_uniq
  ON audit_log_chain (audit_id);

-- Head lookup in the seal function: WHERE org_id = $1 (or IS NULL) ORDER BY chain_seq DESC.
CREATE INDEX IF NOT EXISTS audit_log_chain_org_seq_idx
  ON audit_log_chain (org_id, chain_seq DESC);

-- Anti-fork hard guarantees (defense-in-depth — e.g. against a future
-- REPEATABLE READ caller whose commit-time head read could be stale):
-- (1) no two entries may chain off the same predecessor;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_prev_uniq
  ON audit_log_chain (prev_chain_checksum)
  WHERE prev_chain_checksum IS NOT NULL;
-- (2) one genesis (prev IS NULL) per org chain (NULL org = the system chain).
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_genesis_uniq
  ON audit_log_chain ((COALESCE(org_id::text, 'NULL')))
  WHERE prev_chain_checksum IS NULL;

-- RLS: tenancy shape 1 (direct org_id) — the standard four policies, exactly
-- what rls-coverage.integration.test.ts auto-discovery expects. NULL-org rows
-- (system chain) are reachable only by system scope, mirroring audit_logs.
ALTER TABLE audit_log_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_chain FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON public.audit_log_chain
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON public.audit_log_chain
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON public.audit_log_chain
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON public.audit_log_chain
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Privileges: breeze_app may read and append, never mutate. Retention/erasure
-- DELETE via breeze_audit_admin (post-#915 a separate login credential), gated
-- additionally by the append-only trigger below. Nobody gets UPDATE: the
-- design never rewrites a chain entry (verify treats the first surviving
-- entry's prev as the trusted anchor after retention pruning — see the spec).
GRANT SELECT, INSERT ON TABLE audit_log_chain TO breeze_app;
REVOKE UPDATE, DELETE ON TABLE audit_log_chain FROM breeze_app;
GRANT USAGE ON SEQUENCE audit_log_chain_chain_seq_seq TO breeze_app;
GRANT SELECT, DELETE ON TABLE audit_log_chain TO breeze_audit_admin;
REVOKE UPDATE ON TABLE audit_log_chain FROM breeze_audit_admin;

-- Append-only enforcement, mirroring audit_log_immutable on audit_logs:
-- DELETE only under the retention GUC; UPDATE is NEVER allowed (no re-anchor
-- exists in this design — rewriting a sealed entry is always tampering).
CREATE OR REPLACE FUNCTION audit_log_chain_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' AND allow_retention = '1' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log chain is append-only',
    HINT = 'audit_log_chain entries cannot be modified or deleted. Retention pruning and tenant erasure use breeze_audit_admin plus the breeze.allow_audit_retention GUC (DELETE only); see jobs/auditRetention.ts and services/tenantCascade.ts.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain_block_update ON audit_log_chain;
CREATE TRIGGER audit_log_chain_block_update BEFORE UPDATE ON audit_log_chain
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_immutable();

DROP TRIGGER IF EXISTS audit_log_chain_block_delete ON audit_log_chain;
CREATE TRIGGER audit_log_chain_block_delete BEFORE DELETE ON audit_log_chain
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_immutable();
```

- [ ] **Step 2.2: Add the Drizzle schema** (drift-check parity)

In `apps/api/src/db/schema/audit.ts`: add `bigserial` to the existing `drizzle-orm/pg-core` import line, then append after the `auditLogs` table definition:

```typescript
// Side table for the tamper-evidence chain (issue #1002). Written ONLY by the
// deferred commit-time seal trigger (see migration 2026-06-11-h) — application
// code never inserts here directly. chain_seq is the chain order; the legacy
// checksum/prev_checksum columns on audit_logs are vestigial (content-only /
// NULL for new rows).
export const auditLogChain = pgTable('audit_log_chain', {
  chainSeq: bigserial('chain_seq', { mode: 'number' }).primaryKey(),
  auditId: uuid('audit_id').notNull().references(() => auditLogs.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  contentChecksum: varchar('content_checksum', { length: 128 }).notNull(),
  prevChainChecksum: varchar('prev_chain_checksum', { length: 128 }),
  chainChecksum: varchar('chain_checksum', { length: 128 }).notNull(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

(`audit.ts` is already re-exported by `apps/api/src/db/schema/index.ts` via `export * from './audit'` — verify with `grep -n "audit" apps/api/src/db/schema/index.ts`; if it uses named exports instead, add `auditLogChain` there.)

- [ ] **Step 2.3: Apply + verify the migration is idempotent**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts 2>&1 | grep -E "auto-migrate|passed|failed"
```

Expected: log shows `[auto-migrate] Applying: 2026-06-11-g-audit-chain-table.sql`; existing tests still pass (behavior unchanged — old trigger still active). Then prove idempotency by re-applying by hand:

```bash
docker exec -i breeze-postgres-test psql -U breeze_test -d breeze_test < migrations/2026-06-11-g-audit-chain-table.sql
```

Expected: completes with only NOTICEs (`already exists, skipping`), zero errors.

- [ ] **Step 2.4: Verify tsc + commit**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit 2>&1 | grep -vE "agents\.test\.ts|apiKeyAuth\.test\.ts"
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/migrations/2026-06-11-g-audit-chain-table.sql apps/api/src/db/schema/audit.ts apps/api/src/db/schema/index.ts
git commit -m "feat(audit): audit_log_chain side table — RLS, grants, append-only (#1002 part 1)"
```

---

### Task 3: Lifecycle-contract registrations for the new table

A new `org_id`-columned table trips two contracts (learned the hard way on PR #1244): the GDPR cascade list and — because it's append-only — the cascade's audit-admin bypass set.

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (two edits)

- [ ] **Step 3.1: Register in `ORG_CASCADE_DELETE_ORDER`**

In `apps/api/src/services/tenantCascade.ts`, the alphabetical list at ~line 58, insert between `'audit_baselines'` and `'audit_logs'`:

```typescript
  'audit_baselines',
  'audit_log_chain',
  'audit_logs',
```

- [ ] **Step 3.2: Extend the audit-admin bypass set**

Same file, ~line 275:

```typescript
const AUDIT_ADMIN_REQUIRED_TABLES: ReadonlySet<string> = new Set<string>(['audit_logs', 'audit_log_chain']);
```

(Why: the cascade's FK topo-sort direct-DELETEs `audit_log_chain` *before* `audit_logs`; without the `SET LOCAL ROLE breeze_audit_admin` + `breeze.allow_audit_retention='1'` bypass, the new append-only trigger blocks it and the whole erasure aborts.)

- [ ] **Step 3.3: Run the contract + erasure integration tests**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts
```

Expected: both PASS (list contract sees the new entry; execution test erases an org incl. the empty chain table without trigger errors).

- [ ] **Step 3.4: Commit**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/src/services/tenantCascade.ts
git commit -m "feat(audit): register audit_log_chain in GDPR cascade + audit-admin bypass (#1002)"
```

---### Task 4: Failing tests first — concurrency, deadlock-regression, same-tx linkage

These go in `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts`, inside the existing top-level describe, after the existing tests. They reference the suite's existing `orgId` / `db` / `withSystemDbAccessContext` / `getTestDb` helpers — match the file's existing imports (add `runOutsideDbContext` and `withDbAccessContext` to the import from `'../../db'` if not present).

**Files:**
- Modify: `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts`

- [ ] **Step 4.1: Add the three tests**

```typescript
  // ——— issue #1002 regression suite ———

  // Fork regression: N independent transactions inserting same-org rows
  // concurrently. Pre-fix, each reads the same committed head as `prev` and
  // the chain forks → verify reports false breaks. Post-fix (-h- migration,
  // deferred commit-time sealing) the seal serializes at commit → 0 breaks.
  it('verify_chain returns no breaks under concurrent same-org inserts', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withSystemDbAccessContext(async () => {
          await db.execute(sql`
            INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
            VALUES (${orgId}, 'system', gen_random_uuid(), ${'concurrent-' + i}, 'test', 'success')
          `);
        })
      )
    );

    await withSystemDbAccessContext(async () => {
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Deadlock regression (the bug that killed draft PR #1240): an in-tx audit
  // insert followed — while that tx is still open — by a same-org insert on a
  // SEPARATE pooled connection. With any lock held from insert to commit, the
  // second insert blocks on the first while the first awaits the second: a
  // JS-level deadlock Postgres can't detect (30s test timeout). With deferred
  // sealing the first tx holds nothing until commit, so this completes fast.
  // Generous explicit timeout so a regression fails loudly as a timeout here,
  // not flakily elsewhere.
  it('in-tx insert + separate-connection same-org insert does not deadlock', { timeout: 20_000 }, async () => {
    await expect(
      withDbAccessContext(
        { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
        async () => {
          await db.execute(sql`
            INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
            VALUES (${orgId}, 'system', gen_random_uuid(), 'deadlock-caller-tx', 'test', 'success')
          `);
          // Escape the caller tx exactly like logSessionAudit does.
          await runOutsideDbContext(() =>
            withSystemDbAccessContext(async () => {
              await db.execute(sql`
                INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
                VALUES (${orgId}, 'system', gen_random_uuid(), 'deadlock-escaped', 'test', 'success')
              `);
            })
          );
          throw new Error('simulated caller rollback');
        }
      )
    ).rejects.toThrow('simulated caller rollback');

    await withSystemDbAccessContext(async () => {
      // The escaped row committed and sealed; the rolled-back row left no
      // orphan seal; the chain stayed clean.
      const rows = (await db.execute(sql`
        SELECT action FROM audit_logs WHERE org_id = ${orgId}::uuid AND action LIKE 'deadlock-%'
      `)) as unknown as Array<{ action: string }>;
      expect(rows.map((r) => r.action)).toEqual(['deadlock-escaped']);

      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });

  // Same-transaction multi-row batches were the OTHER documented limitation of
  // the in-row chain. Deferred seals fire per row at commit in insertion order
  // within one lock hold, so batches link correctly.
  it('multiple same-org inserts in ONE transaction seal in order with no breaks', async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'batch-1', 'test', 'success'),
               (${orgId}, 'system', gen_random_uuid(), 'batch-2', 'test', 'success'),
               (${orgId}, 'system', gen_random_uuid(), 'batch-3', 'test', 'success')
      `);
    });

    await withSystemDbAccessContext(async () => {
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });
```

- [ ] **Step 4.2: Run — confirm the concurrency test FAILS (fork) before the fix**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts -t "concurrent same-org inserts"
```

Expected: **FAIL** — `breaks` is non-empty (the old in-row trigger forks). This is the TDD red. (The deadlock + batch tests may pass or fail at this stage depending on old-verify semantics; only the concurrency test's red matters here.)

- [ ] **Step 4.3: Commit the red tests**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/src/__tests__/integration/audit-checksum.integration.test.ts
git commit -m "test(audit): #1002 regression suite — concurrency fork, deadlock, same-tx batch (red)"
```

---

### Task 5: Migration `-h-` — seal function, deferred trigger, backfill, verify v2

**Files:**
- Create: `apps/api/migrations/2026-06-11-h-audit-chain-seal-and-verify.sql`

- [ ] **Step 5.1: Write the migration**

Create `apps/api/migrations/2026-06-11-h-audit-chain-seal-and-verify.sql` with exactly:

```sql
-- Issue #1002 (part 2 of 2): deferred commit-time sealing + verify v2.
--
-- 1. audit_log_compute_checksum (BEFORE INSERT) becomes content-only: no
--    predecessor read, no lock, prev_checksum := NULL. Linkage moves to the
--    audit_log_chain side table (the -g- migration).
-- 2. audit_log_seal_one(row) appends a chain entry under a per-org advisory
--    lock; the DEFERRED constraint trigger calls it at COMMIT, so the lock is
--    held only through commit processing — never across application awaits.
--    (The held-to-commit variant deadlocks; see draft PR #1240 and the design
--    spec docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md.)
-- 3. Backfill seals every existing audit row per org in (timestamp, id) order,
--    ignoring the legacy (possibly forked) prev_checksum values entirely.
-- 4. audit_log_verify_chain keeps its signature but walks the side table.
--
-- Lock namespace 1000200 (from issue #1002) is reserved for this chain lock.

-- (1) Content-only BEFORE INSERT trigger. Reuses audit_log_canonical_payload
-- from 2026-05-25-c with prev := NULL. convert_to(...,'UTF8'), not ::bytea —
-- the cast throws on the backslash escapes jsonb details::text emits (#994).
CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.prev_checksum := NULL;
  NEW.checksum := encode(sha256(convert_to(audit_log_canonical_payload(NEW, NULL), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
-- The existing trigger audit_log_chain_checksum (BEFORE INSERT, from -b-)
-- already points at this function; CREATE OR REPLACE rebinds it in place.

-- (2) Seal one audit row into the chain. Shared by the commit-time trigger and
-- the backfill loop below. SECURITY INVOKER: runs under the inserting caller's
-- RLS context — the chain row's org matches the audit row's org, so the
-- standard shape-1 WITH CHECK passes for exactly the callers that could insert
-- the audit row in the first place.
CREATE OR REPLACE FUNCTION audit_log_seal_one(a audit_logs) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  prev_chain varchar(128);
  content varchar(128);
BEGIN
  -- Serialize same-org seals. At commit time this is held only through the
  -- remaining commit processing (sub-ms), so the #1240 two-connection deadlock
  -- cannot occur. Reentrant for multi-row same-org batches in one tx.
  PERFORM pg_advisory_xact_lock(1000200, hashtext(COALESCE(a.org_id::text, 'NULL')));

  -- Head lookup, branched on NULL so both arms are index-friendly
  -- (audit_log_chain_org_seq_idx; btree supports IS NULL scans).
  IF a.org_id IS NULL THEN
    SELECT chain_checksum INTO prev_chain
    FROM audit_log_chain WHERE org_id IS NULL
    ORDER BY chain_seq DESC LIMIT 1;
  ELSE
    SELECT chain_checksum INTO prev_chain
    FROM audit_log_chain WHERE org_id = a.org_id
    ORDER BY chain_seq DESC LIMIT 1;
  END IF;

  -- Content hash recomputed from the row (NOT read from a.checksum): uniform
  -- for backfilled legacy rows (whose stored checksum is the old chained
  -- value) and new rows alike, and keeps the chain independent of the
  -- vestigial in-row columns.
  content := encode(sha256(convert_to(audit_log_canonical_payload(a, NULL), 'UTF8')), 'hex');

  INSERT INTO audit_log_chain (audit_id, org_id, content_checksum, prev_chain_checksum, chain_checksum)
  VALUES (
    a.id,
    a.org_id,
    content,
    prev_chain,
    encode(sha256(convert_to(COALESCE(prev_chain, '') || '|' || content, 'UTF8')), 'hex')
  );
END;
$$;

-- Commit-time wrapper.
CREATE OR REPLACE FUNCTION audit_log_seal_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM audit_log_seal_one(NEW);
  RETURN NULL;
END;
$$;

-- Constraint triggers are the only trigger kind that can defer to COMMIT.
DROP TRIGGER IF EXISTS audit_log_chain_seal ON audit_logs;
CREATE CONSTRAINT TRIGGER audit_log_chain_seal
  AFTER INSERT ON audit_logs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION audit_log_seal_chain();

-- (3) Backfill: seal every not-yet-sealed audit row, per org, in (timestamp,
-- id) order. NOT EXISTS guard makes re-application a no-op, and also seals any
-- straggler rows written by a not-yet-migrated API instance between -g- and
-- -h- on a rolling deploy.
DO $$
DECLARE
  rec audit_logs;
BEGIN
  FOR rec IN
    SELECT a.* FROM audit_logs a
    WHERE NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
    ORDER BY a.org_id NULLS FIRST, a.timestamp, a.id
  LOOP
    PERFORM audit_log_seal_one(rec);
  END LOOP;
END $$;

-- (4) Verify v2 — SAME signature as -c- (cron + tests call it unchanged) —
-- but walks the side table. Flags, in chain_seq order:
--   linkage break, chain-hash mismatch, content tamper (recomputed from the
--   live audit row), dangling seal (audit row gone), and finally any UNSEALED
--   audit row (a deleted chain entry). The FIRST surviving entry's prev is the
--   trusted anchor: NULL for a virgin chain, or a reference to legitimately
--   retention-pruned history — there is deliberately no re-anchor rewrite
--   (rewriting the head's chain_checksum would invalidate its successor's
--   stored prev; see the design spec).
CREATE OR REPLACE FUNCTION audit_log_verify_chain(p_org_id uuid)
RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  a audit_logs;
  prev varchar(128) := NULL;
  is_first boolean := true;
  expected_hash varchar(128);
BEGIN
  FOR c IN
    SELECT ch.chain_seq, ch.audit_id, ch.content_checksum, ch.prev_chain_checksum, ch.chain_checksum
    FROM audit_log_chain ch
    WHERE ch.org_id IS NOT DISTINCT FROM p_org_id
    ORDER BY ch.chain_seq
  LOOP
    -- Linkage. The FIRST surviving entry's prev is the trusted anchor (NULL =
    -- virgin chain; non-NULL = retention pruned the prefix), so it is not
    -- compared. Every later entry must reference its immediate predecessor.
    IF NOT is_first AND c.prev_chain_checksum IS DISTINCT FROM prev THEN
      broken_id := c.audit_id; expected := prev; actual := c.prev_chain_checksum;
      RETURN NEXT;
    END IF;
    is_first := false;

    -- Chain-hash integrity.
    expected_hash := encode(sha256(convert_to(
      COALESCE(c.prev_chain_checksum, '') || '|' || c.content_checksum, 'UTF8')), 'hex');
    IF c.chain_checksum IS DISTINCT FROM expected_hash THEN
      broken_id := c.audit_id; expected := expected_hash; actual := c.chain_checksum;
      RETURN NEXT;
    END IF;

    -- Content integrity, recomputed from the live audit row.
    SELECT * INTO a FROM audit_logs WHERE id = c.audit_id;
    IF NOT FOUND THEN
      broken_id := c.audit_id; expected := c.content_checksum; actual := NULL;
      RETURN NEXT;
    ELSE
      expected_hash := encode(sha256(convert_to(audit_log_canonical_payload(a, NULL), 'UTF8')), 'hex');
      IF expected_hash IS DISTINCT FROM c.content_checksum THEN
        broken_id := c.audit_id; expected := expected_hash; actual := c.content_checksum;
        RETURN NEXT;
      END IF;
    END IF;

    prev := c.chain_checksum;
  END LOOP;

  -- Unsealed audit rows: every committed row gets a seal atomically, so a
  -- missing entry means the chain row was deleted (or the seal trigger was
  -- disabled) — flag it.
  FOR a IN
    SELECT al.* FROM audit_logs al
    WHERE al.org_id IS NOT DISTINCT FROM p_org_id
      AND NOT EXISTS (SELECT 1 FROM audit_log_chain ch WHERE ch.audit_id = al.id)
    ORDER BY al.timestamp, al.id
  LOOP
    broken_id := a.id;
    expected := 'sealed';
    actual := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;
```

- [ ] **Step 5.2: Run the #1002 regression suite — red turns green**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts
```

Expected: log shows `[auto-migrate] Applying: 2026-06-11-h-…`; ALL tests in the file pass — the three new ones AND the pre-existing ones (tamper-detect via UPDATE still flags `broken_id` because verify v2's content check catches it; insert/verify basics unchanged). If a pre-existing test asserts in-row `prev_checksum` linkage specifics, update that assertion to query `audit_log_chain` instead — the test's *intent* (linkage exists and verifies) is preserved by checking `verify_chain` returns empty.

- [ ] **Step 5.3: THE deadlock proof — run the suite that hung draft #1240**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-logs-rls.integration.test.ts
```

Expected: all 5 PASS, with the "transaction isolation: audit row persists even when caller request tx rolls back" test completing in normal time (**< 10 s**, not 30 s timeout). This is the go/no-go gate for the whole design.

- [ ] **Step 5.4: Idempotency re-apply check**

```bash
docker exec -i breeze-postgres-test psql -U breeze_test -d breeze_test < migrations/2026-06-11-h-audit-chain-seal-and-verify.sql
docker exec -i breeze-postgres-test psql -U breeze_test -d breeze_test -c "SELECT COUNT(*) AS dup FROM (SELECT audit_id FROM audit_log_chain GROUP BY audit_id HAVING COUNT(*) > 1) d;"
```

Expected: re-apply completes without error; `dup` = 0 (backfill NOT EXISTS guard held).

- [ ] **Step 5.5: Update the stale limitation comment + commit**

In `audit-checksum.integration.test.ts`, find the comment block (~lines 100-111) saying the same-transaction case "requires a chain_seq bigserial + per-org advisory lock — tracked as future-task hardening" and replace that sentence with: `Same-transaction batches are now handled by the deferred commit-time seal (migration 2026-06-11-h, issue #1002) — covered by the 'multiple same-org inserts in ONE transaction' test below.` If that block wraps a test that *asserts* the old limitation (e.g. expects a fork or skips), make it assert clean linkage instead (verify returns `[]`).

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/migrations/2026-06-11-h-audit-chain-seal-and-verify.sql apps/api/src/__tests__/integration/audit-checksum.integration.test.ts
git commit -m "feat(audit): deferred commit-time chain sealing + verify v2 (#1002 part 2)"
```

---

### Task 6: Retention prefix-cut (no re-anchor)

`chain_seq` (commit) order can disagree with `timestamp` order around long transactions, so a raw timestamp-cutoff DELETE could punch a mid-chain hole. Retention switches to deleting the maximal chain **prefix** that is entirely older than the cutoff. There is **no re-anchor step**: verify v2 treats the first surviving entry's prev as the trusted anchor, so retention never modifies a chain entry (or any `audit_logs` column) — it only deletes.

**Files:**
- Modify: `apps/api/src/jobs/auditRetention.ts` (replace `deleteAndReanchor` with `deleteChainPrefix`)
- Modify: `apps/api/src/__tests__/integration/auditRetentionPrivSep.integration.test.ts` (only if it asserts old re-anchor internals — check first)

- [ ] **Step 6.1: Replace `deleteAndReanchor` with `deleteChainPrefix`**

In `apps/api/src/jobs/auditRetention.ts`, replace the entire existing `deleteAndReanchor` function with:

```typescript
async function deleteChainPrefix(exec: SqlExecutor, policy: PolicyRow): Promise<number> {
  // Prefix-cut delete (issue #1002 redesign): chain_seq order is COMMIT order,
  // which can disagree with timestamp order around long transactions, so a raw
  // `timestamp < cutoff` delete could remove a mid-chain entry and leave a
  // permanent linkage hole. Instead delete the maximal chain PREFIX that is
  // entirely older than the cutoff — everything below the first "young" row in
  // chain order. Old stragglers sitting behind a young row survive one extra
  // nightly cycle and are caught as the prefix advances.
  //
  // No re-anchor follows: audit_log_verify_chain treats the first surviving
  // entry's prev_chain_checksum as the trusted anchor (it references the
  // legitimately pruned prefix), so retention never UPDATEs the chain — or
  // audit_logs — at all. The FK ON DELETE CASCADE removes the pruned rows'
  // chain entries; their BEFORE DELETE trigger passes because both call paths
  // set breeze.allow_audit_retention='1' SET LOCAL before calling this.
  const result = await exec.execute(sql`
    DELETE FROM audit_logs
    WHERE id IN (
      SELECT c.audit_id
      FROM audit_log_chain c
      WHERE c.org_id = ${policy.org_id}
        AND c.chain_seq < COALESCE(
          (
            SELECT MIN(c2.chain_seq)
            FROM audit_log_chain c2
            JOIN audit_logs a2 ON a2.id = c2.audit_id
            WHERE c2.org_id = ${policy.org_id}
              AND a2.timestamp >= (now() - (${policy.retention_days}::int * interval '1 day'))
          ),
          (
            SELECT MAX(c3.chain_seq) + 1
            FROM audit_log_chain c3
            WHERE c3.org_id = ${policy.org_id}
          )
        )
    )
  `);
  const count = extractRowCount(result);

  // Sweep any UNSEALED old rows too (shouldn't exist post-backfill; keeps
  // retention complete if one ever appears). The chain has no entry for them,
  // so deleting them can't affect linkage.
  await exec.execute(sql`
    DELETE FROM audit_logs a
    WHERE a.org_id = ${policy.org_id}
      AND a.timestamp < (now() - (${policy.retention_days}::int * interval '1 day'))
      AND NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
  `);

  return count;
}
```

Then update the two call sites in the same file (the dedicated-pool path and the legacy `SET ROLE` fallback — both currently call `deleteAndReanchor(tx …, policy)` / `deleteAndReanchor(dbModule.db …, policy)`): rename the call to `deleteChainPrefix(...)`, arguments unchanged. No other call-site changes — both paths already set `breeze.allow_audit_retention='1'` `SET LOCAL`, which is what authorizes the chain-entry cascade deletes.

- [ ] **Step 6.2: Add the retention round-trip test**

Append to `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts` (uses the suite's existing helpers; `getTestDb()` is the superuser client):

```typescript
  // Retention prefix-cut: prune old rows, then the chain must still verify
  // clean WITHOUT any re-anchor — the first surviving entry's prev is the
  // trusted anchor.
  it('retention prefix-cut prune leaves a clean chain with no re-anchor', async () => {
    // Three rows: two backdated past any cutoff, one current. Timestamps can
    // be set explicitly — the BEFORE trigger no longer rewrites them.
    for (const [action, ts] of [
      ['retain-old-1', "now() - interval '400 days'"],
      ['retain-old-2', "now() - interval '399 days'"],
      ['retain-new', 'now()'],
    ] as const) {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql.raw(`
          INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
          VALUES ('${orgId}', 'system', gen_random_uuid(), '${action}', 'test', 'success', ${ts})
        `));
      });
    }

    // Prune at 365 days as superuser with the retention GUC (mirrors the
    // audit-admin path; this test pins the SQL semantics, the privsep file
    // pins the role/pool wiring). MUST run inside ONE transaction — SET LOCAL
    // and the DELETE have to share a connection, and separate execute() calls
    // on the pooled client may not (use the drizzle transaction API, never
    // raw BEGIN/COMMIT executes).
    const sudo = getTestDb();
    await sudo.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await tx.execute(sql`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT c.audit_id FROM audit_log_chain c
          WHERE c.org_id = ${orgId}
            AND c.chain_seq < COALESCE(
              (SELECT MIN(c2.chain_seq) FROM audit_log_chain c2
               JOIN audit_logs a2 ON a2.id = c2.audit_id
               WHERE c2.org_id = ${orgId} AND a2.timestamp >= (now() - interval '365 days')),
              (SELECT MAX(c3.chain_seq) + 1 FROM audit_log_chain c3 WHERE c3.org_id = ${orgId})
            )
        )
      `);
    });

    await withSystemDbAccessContext(async () => {
      const old = (await db.execute(sql`
        SELECT 1 FROM audit_logs WHERE org_id = ${orgId}::uuid AND action LIKE 'retain-old-%'
      `)) as unknown as unknown[];
      expect(old).toHaveLength(0);

      // No re-anchor ran: the surviving head still carries a non-NULL prev
      // pointing at pruned history — and verify must accept it as the anchor.
      const breaks = (await db.execute(sql`
        SELECT broken_id FROM public.audit_log_verify_chain(${orgId}::uuid)
      `)) as unknown as Array<{ broken_id: string }>;
      expect(breaks).toEqual([]);
    });
  });
```

(If the suite's `orgId` has accumulated rows from earlier tests in the same file run, the prefix-cut may also prune other backdated rows — there are none; all other tests insert with default `now()` timestamps, so they sit above the cutoff and survive. The `retain-new` row plus all prior rows must still verify clean.)

- [ ] **Step 6.3: Run retention tests**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts src/__tests__/integration/auditRetentionPrivSep.integration.test.ts
```

Expected: both files PASS. If `auditRetentionPrivSep` asserts old re-anchor internals (grep it for `prev_checksum` and `deleteAndReanchor` first), update those assertions to: rows-older-than-cutoff deleted, AND `audit_log_verify_chain(org)` returns `[]` afterwards (no re-anchor exists to assert anymore).

- [ ] **Step 6.4: Commit**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/src/jobs/auditRetention.ts apps/api/src/__tests__/integration/audit-checksum.integration.test.ts apps/api/src/__tests__/integration/auditRetentionPrivSep.integration.test.ts
git commit -m "feat(audit): retention prefix-cut delete, no chain re-anchor needed (#1002)"
```

---

### Task 7: Tamper-detection coverage for the new attack surfaces

Verify v2 introduces two new detection paths that need pinning: chain-row deletion (unsealed-row sweep) and chain rewrite (hash mismatch).

**Files:**
- Modify: `apps/api/src/__tests__/integration/audit-checksum.integration.test.ts`

- [ ] **Step 7.1: Add the two tests**

```typescript
  // Deleting a chain entry (hiding a row from the chain) is flagged by the
  // unsealed-row sweep.
  it('verify_chain flags an audit row whose chain entry was deleted', async () => {
    let targetId = '';
    await withSystemDbAccessContext(async () => {
      const rows = (await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${orgId}, 'system', gen_random_uuid(), 'chain-delete-victim', 'test', 'success')
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      targetId = rows[0]!.id;
    });

    // Superuser + trigger disable simulates a DBA-level attacker (same pattern
    // as the existing UPDATE-tamper test).
    const sudo = getTestDb();
    await sudo.execute(sql`ALTER TABLE audit_log_chain DISABLE TRIGGER audit_log_chain_block_delete`);
    try {
      await sudo.execute(sql`DELETE FROM audit_log_chain WHERE audit_id = ${targetId}`);
    } finally {
      await sudo.execute(sql`ALTER TABLE audit_log_chain ENABLE TRIGGER audit_log_chain_block_delete`);
    }

    const breaks = (await sudo.execute(sql`
      SELECT broken_id, expected FROM public.audit_log_verify_chain(${orgId}::uuid)
    `)) as unknown as Array<{ broken_id: string; expected: string | null }>;
    // The victim is flagged unsealed; its successor (if any) is flagged for
    // linkage. At minimum the victim appears.
    expect(breaks.map((b) => b.broken_id)).toContain(targetId);
    // Restore chain consistency for subsequent tests in this file: re-seal.
    await sudo.execute(sql`SELECT audit_log_seal_one(a) FROM audit_logs a WHERE a.id = ${targetId}`);
  });

  // breeze_app cannot mutate the chain at all (append-only + REVOKE).
  it('chain table rejects UPDATE/DELETE from app-level SQL', async () => {
    await withSystemDbAccessContext(async () => {
      await expect(
        db.execute(sql`UPDATE audit_log_chain SET chain_checksum = 'forged' WHERE org_id = ${orgId}::uuid`)
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        db.execute(sql`DELETE FROM audit_log_chain WHERE org_id = ${orgId}::uuid`)
      ).rejects.toThrow(/append-only|permission denied/);
    });
  });
```

- [ ] **Step 7.2: Run + commit**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/audit-checksum.integration.test.ts
cd /Users/toddhebebrand/bz-sec-cluster
git add apps/api/src/__tests__/integration/audit-checksum.integration.test.ts
git commit -m "test(audit): pin chain-deletion and chain-mutation tamper detection (#1002)"
```

---

### Task 8: Full verification sweep

- [ ] **Step 8.1: Targeted test files (everything this change can touch)**

```bash
cd /Users/toddhebebrand/bz-sec-cluster/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/audit-checksum.integration.test.ts \
  src/__tests__/integration/audit-logs-rls.integration.test.ts \
  src/__tests__/integration/auditRetentionPrivSep.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenantCascadeExecution.integration.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.config.rls-coverage.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/auditChainVerify.test.ts src/db/autoMigrate.test.ts
```

Expected: all integration files PASS. rls-coverage: `audit_log_chain` auto-discovered as shape 1 and passing (3 pre-existing local failures on `approval_requests` Shape 6 are known-unrelated — confirm the failures, if any, do NOT mention `audit_log_chain`). Unit files PASS (autoMigrate ordering test validates the `-g-`/`-h-` names).

- [ ] **Step 8.2: Typecheck + drift**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit 2>&1 | grep -vE "agents\.test\.ts|apiKeyAuth\.test\.ts"
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: tsc clean; drift check reports no drift (the Drizzle `auditLogChain` definition matches migration `-g-`). If drift flags a `bigserial` vs identity or timestamptz mismatch, fix the **Drizzle schema** to match the migration (never the shipped migration).

- [ ] **Step 8.3: Commit any straggler fixes**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git status --short   # commit anything outstanding with a descriptive message
```

---

### Task 9: Ship

- [ ] **Step 9.1: Push and open the PR**

```bash
cd /Users/toddhebebrand/bz-sec-cluster
git push -u origin fix/audit-chain-deferred-sealing
gh pr create --repo LanternOps/breeze --base main --head fix/audit-chain-deferred-sealing \
  --title "fix(audit): deferred commit-time chain sealing — stops concurrent-write forks without the #1240 deadlock (#1002)" \
  --body-file - <<'EOF'
**Closes #1002.** Supersedes draft PR #1240.

Design spec: `docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md`.

**Problem:** the in-row audit hash chain forks under concurrent same-org inserts (false-positive `verify_chain` breaks in prod, US v0.68.2). The obvious fix — an advisory lock in the BEFORE INSERT trigger — deadlocks against the two-connection audit-write pattern (caller-tx insert + `logSessionAudit` escaping to a separate connection); proven deterministically on #1240.

**Fix:** linkage moves to an append-only `audit_log_chain` side table written by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger — the per-org advisory lock is held only through commit processing (sub-ms), never across application awaits. Inserts compute a content-only hash with no lock. `audit_log_verify_chain()` keeps its signature (the daily alerting cron from #1240 rides along unchanged) but walks the side table, detecting linkage breaks, chain-hash mismatches, content tamper, dangling seals, and deleted chain entries. Two partial unique indexes turn any residual fork into a loud constraint violation. Retention switches to prefix-cut deletes with NO re-anchor (the verifier trusts the first surviving link as the anchor), so neither `audit_logs` nor the chain is ever UPDATEd — both are strictly append-only. Same-transaction batches — the other documented limitation — now seal correctly too.

**Proof:** `audit-logs-rls.integration.test.ts` rollback-isolation test (the one that hung #1240 at 30 s) passes in normal time; 25-way concurrency test → 0 breaks; tamper/chain-deletion/retention round-trips pinned.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 9.2: Close the superseded draft + cross-link**

```bash
gh pr close 1240 --repo LanternOps/breeze --comment "Superseded by the deferred commit-time sealing redesign — see the new PR (fix/audit-chain-deferred-sealing) and docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md. The verify-alerting cron from this draft was cherry-picked into the new branch unchanged."
gh issue comment 1002 --repo LanternOps/breeze --body "Redesigned fix is up — deferred commit-time sealing into an append-only audit_log_chain side table (no held-to-commit lock, so the deadlock documented above cannot occur). See the new PR replacing draft #1240; design spec in docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md."
```

---

## Self-review notes (done at planning time)

- **Spec coverage:** fork fix (Tasks 4-5), deadlock proof (5.3), backfill/heal (5.1 §3), verify v2 incl. unsealed sweep + trusted-anchor first entry (5.1 §4), retention prefix-cut with no re-anchor (6), GDPR/contract registrations (3), RLS/grants/append-only (2), cron carry-over (1), anti-fork unique indexes (2.1). External anchor + telemetry-exclusion explicitly out of scope (spec).
- **Design fix found during self-review:** the original draft re-anchored the surviving head after retention (rewriting its `chain_checksum`) — that would invalidate the *successor's* stored `prev_chain_checksum`, a self-inflicted break. Replaced with the trusted-anchor rule; as a result the chain table is strictly append-only (UPDATE never allowed, no UPDATE grants) and retention only deletes.
- **Type consistency:** `audit_log_seal_one(a audit_logs)` used by trigger (5.1), backfill (5.1), and the re-seal in Task 7.1. Chain-hash formula `COALESCE(prev,'')||'|'||content_checksum` identical in seal and verify (both 5.1). GUC name `breeze.allow_audit_retention` everywhere. Verify signature `(broken_id uuid, expected varchar, actual varchar)` matches cron + existing tests. Renamed retention helper `deleteChainPrefix` with both call sites updated (6.1).
- **Test-correctness fix found during self-review:** raw `BEGIN`/`COMMIT` via separate `execute()` calls on the pooled superuser client can land on different connections (postgres.js pool) — `SET LOCAL` would not bind to the `DELETE`. Test 6.2 uses `sudo.transaction(...)` instead.
- **Known judgment calls left to the executor:** exact conflict resolution in 1.1; whether pre-existing tests assert in-row linkage internals (5.2, 6.3 — guidance given).
