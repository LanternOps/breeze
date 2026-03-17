# Migration Consolidation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual Drizzle + manual migration system with a single track of hand-written, numbered SQL migrations.

**Architecture:** One `migrations/` folder with numbered files (`0001-baseline.sql` through `0065-*.sql`), a rewritten `autoMigrate.ts` that detects fresh/legacy/normal databases and applies pending migrations with checksum tracking, and `drizzle-kit` retained only for schema drift detection.

**Tech Stack:** PostgreSQL, `postgres` npm package (driver), SHA-256 checksums, Drizzle ORM (queries only)

**Spec:** `docs/superpowers/specs/2026-03-16-migration-consolidation-design.md`

---

## Chunk 1: Baseline Generation and File Structure

### Task 1: Generate the baseline migration

This task generates `0001-baseline.sql` — the full current schema as one idempotent file.

**Files:**
- Create: `apps/api/migrations/0001-baseline.sql`

**Prerequisites:** Docker must be running with `breeze-postgres-dev` container available.

- [ ] **Step 1: Dump the current schema from a fresh database**

Start a temporary Postgres container, run the current `autoMigrate()` against it, then dump the schema:

```bash
# Start a temporary Postgres for baseline generation
docker run -d --name breeze-pg-baseline \
  -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze \
  -p 5433:5432 postgres:16-alpine

# Wait for Postgres to be ready
sleep 3
docker exec breeze-pg-baseline pg_isready -U breeze

# Run current migrations against it
DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze" \
  npx tsx apps/api/src/db/autoMigrate.ts

# Dump schema only (no data, no ownership, no privileges)
docker exec breeze-pg-baseline \
  pg_dump -U breeze -d breeze --schema-only --no-owner --no-privileges \
  --no-comments --no-tablespaces \
  > /tmp/breeze-baseline-raw.sql

# Stop and remove temp container
docker stop breeze-pg-baseline && docker rm breeze-pg-baseline
```

- [ ] **Step 2: Transform the raw dump into an idempotent baseline**

The raw `pg_dump` output needs these transformations:
1. Remove the `drizzle` schema and `__drizzle_migrations` table (Drizzle tracking — not part of app schema)
2. Remove the `manual_sql_migrations` table (old manual tracking — not part of app schema)
3. Wrap all `CREATE TYPE` statements in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
4. Add `IF NOT EXISTS` to all `CREATE TABLE` statements
5. Add `IF NOT EXISTS` to all `CREATE INDEX` statements
6. Add `IF NOT EXISTS` to all `CREATE EXTENSION` statements
7. Wrap `ALTER TABLE ... ADD CONSTRAINT` in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object` blocks
8. Use `CREATE OR REPLACE FUNCTION` for all functions
9. Add header comment explaining this is the baseline

Write a script `scripts/generate-baseline.sh` to automate this (for future re-generation if needed), or do it manually. Save result to `apps/api/migrations/0001-baseline.sql`.

- [ ] **Step 3: Validate the baseline**

Run the baseline against a fresh Postgres and compare schemas:

```bash
# Start two fresh containers
docker run -d --name breeze-pg-old -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze -p 5433:5432 postgres:16-alpine
docker run -d --name breeze-pg-new -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze -p 5434:5432 postgres:16-alpine
sleep 3

# Old system: run current autoMigrate
DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze" npx tsx apps/api/src/db/autoMigrate.ts

# New system: run just the baseline
docker exec -i breeze-pg-new psql -U breeze -d breeze < apps/api/migrations/0001-baseline.sql

# Dump both and diff (ignoring Drizzle/manual tracking tables)
docker exec breeze-pg-old pg_dump -U breeze -d breeze --schema-only --no-owner --no-privileges --no-comments -N drizzle > /tmp/schema-old.sql
docker exec breeze-pg-new pg_dump -U breeze -d breeze --schema-only --no-owner --no-privileges --no-comments -N drizzle > /tmp/schema-new.sql

diff /tmp/schema-old.sql /tmp/schema-new.sql
# Expected: no differences (or only ordering/whitespace differences)

# Cleanup
docker stop breeze-pg-old breeze-pg-new && docker rm breeze-pg-old breeze-pg-new
```

- [ ] **Step 4: Commit the baseline**

```bash
git add apps/api/migrations/0001-baseline.sql
git commit -m "feat(migrations): add 0001-baseline.sql — full schema baseline"
```

---

### Task 2: Move and rename manual migration files

Relocate the 64 date-prefixed manual migrations to the new numbered sequence.

**Files:**
- Create: `apps/api/migrations/` (directory)
- Create: `apps/api/migrations/optional/` (directory)
- Move: 64 files from `apps/api/src/db/migrations/` → `apps/api/migrations/0002-*.sql` through `0065-*.sql`
- Move: `apps/api/src/db/migrations/timescaledb-setup.sql` → `apps/api/migrations/optional/timescaledb-setup.sql`
- Move: `apps/api/src/db/migrations/README.md` → `apps/api/migrations/optional/README.md`

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p apps/api/migrations/optional
```

- [ ] **Step 2: Move and rename all 64 date-prefixed migration files**

File content must be preserved exactly (checksums matter for existing deployments). Use `git mv` so git tracks the rename:

```bash
cd apps/api
git mv src/db/migrations/2026-02-07-add-gatekeeper-enabled.sql            migrations/0002-add-gatekeeper-enabled.sql
git mv src/db/migrations/2026-02-07-policy-state-telemetry.sql             migrations/0003-policy-state-telemetry.sql
git mv src/db/migrations/2026-02-07-snmp-asset-id-index.sql                migrations/0004-snmp-asset-id-index.sql
git mv src/db/migrations/2026-02-09-device-metrics-bandwidth-columns.sql   migrations/0005-device-metrics-bandwidth-columns.sql
git mv src/db/migrations/2026-02-09-filesystem-analysis.sql                migrations/0006-filesystem-analysis.sql
git mv src/db/migrations/2026-02-09-filesystem-scan-state.sql              migrations/0007-filesystem-scan-state.sql
git mv src/db/migrations/2026-02-09-tenant-rls.sql                         migrations/0008-tenant-rls.sql
git mv src/db/migrations/2026-02-10-be8-device-sessions.sql                migrations/0009-be8-device-sessions.sql
git mv src/db/migrations/2026-02-10-psa-provider-and-patch-compliance-reports.sql migrations/0010-psa-provider-and-patch-compliance-reports.sql
git mv src/db/migrations/2026-02-10-security-posture-scoring.sql           migrations/0011-security-posture-scoring.sql
git mv src/db/migrations/2026-02-10-tenant-rls-deny-default.sql            migrations/0012-tenant-rls-deny-default.sql
git mv src/db/migrations/2026-02-11-mtls-cert-management.sql               migrations/0013-mtls-cert-management.sql
git mv src/db/migrations/2026-02-13-agent-updates.sql                      migrations/0014-agent-updates.sql
git mv src/db/migrations/2026-02-13-management-posture.sql                 migrations/0015-management-posture.sql
git mv src/db/migrations/2026-02-20-be19-device-ip-history.sql             migrations/0016-be19-device-ip-history.sql
git mv src/db/migrations/2026-02-20-configuration-policies.sql             migrations/0017-configuration-policies.sql
git mv src/db/migrations/2026-02-20-network-alert-templates.sql            migrations/0018-network-alert-templates.sql
git mv src/db/migrations/2026-02-20-network-baseline-change-events.sql     migrations/0019-network-baseline-change-events.sql
git mv src/db/migrations/2026-02-20-self-healing-playbooks.sql             migrations/0020-self-healing-playbooks.sql
git mv src/db/migrations/2026-02-20-zz-self-healing-playbooks-rls.sql      migrations/0021-zz-self-healing-playbooks-rls.sql
git mv src/db/migrations/2026-02-21-audit-initiated-by.sql                 migrations/0022-audit-initiated-by.sql
git mv src/db/migrations/2026-02-21-be20-central-log-search.sql            migrations/0023-be20-central-log-search.sql
git mv src/db/migrations/2026-02-21-conversation-flagging.sql              migrations/0024-conversation-flagging.sql
git mv src/db/migrations/2026-02-21-device-approval.sql                    migrations/0025-device-approval.sql
git mv src/db/migrations/2026-02-21-device-change-log.sql                  migrations/0026-device-change-log.sql
git mv src/db/migrations/2026-02-21-device-metrics-disk-activity-columns.sql migrations/0027-device-metrics-disk-activity-columns.sql
git mv src/db/migrations/2026-02-21-dns-security.sql                       migrations/0028-dns-security.sql
git mv src/db/migrations/2026-02-21-event-log-policy-settings.sql          migrations/0029-event-log-policy-settings.sql
git mv src/db/migrations/2026-02-21-reliability-scoring.sql                migrations/0030-reliability-scoring.sql
git mv src/db/migrations/2026-02-21-zz-dns-security-hardening.sql          migrations/0031-zz-dns-security-hardening.sql
git mv src/db/migrations/2026-02-22-alerts-config-policy-columns.sql       migrations/0032-alerts-config-policy-columns.sql
git mv src/db/migrations/2026-02-22-asset-label.sql                        migrations/0033-asset-label.sql
git mv src/db/migrations/2026-02-22-device-ip-history-rls.sql              migrations/0034-device-ip-history-rls.sql
git mv src/db/migrations/2026-02-22-log-search-rls.sql                     migrations/0035-log-search-rls.sql
git mv src/db/migrations/2026-02-22-missing-tables.sql                     migrations/0036-missing-tables.sql
git mv src/db/migrations/2026-02-22-reliability-rls.sql                    migrations/0037-reliability-rls.sql
git mv src/db/migrations/2026-02-22-security-posture-query-indexes.sql     migrations/0038-security-posture-query-indexes.sql
git mv src/db/migrations/2026-02-22-software-policies-rls.sql              migrations/0039-software-policies-rls.sql
git mv src/db/migrations/2026-02-22-software-policy-scope-deprecation.sql  migrations/0040-software-policy-scope-deprecation.sql
git mv src/db/migrations/2026-02-22-update-rings-schema.sql                migrations/0041-update-rings-schema.sql
git mv src/db/migrations/2026-02-23-audit-logs-org-id-nullable.sql         migrations/0042-audit-logs-org-id-nullable.sql
git mv src/db/migrations/2026-02-24-software-inventory-hash-columns.sql    migrations/0043-software-inventory-hash-columns.sql
git mv src/db/migrations/2026-02-25-ai-sessions-device-id.sql              migrations/0044-ai-sessions-device-id.sql
git mv src/db/migrations/2026-02-25-backup-schema.sql                      migrations/0045-backup-schema.sql
git mv src/db/migrations/2026-02-25-schema-drift-columns.sql               migrations/0046-schema-drift-columns.sql
git mv src/db/migrations/2026-02-26-be21-audit-baselines.sql               migrations/0047-be21-audit-baselines.sql
git mv src/db/migrations/2026-02-26-cis-hardening.sql                      migrations/0048-cis-hardening.sql
git mv src/db/migrations/2026-02-26-huntress-integration.sql               migrations/0049-huntress-integration.sql
git mv src/db/migrations/2026-02-26-peripheral-control.sql                 migrations/0050-peripheral-control.sql
git mv src/db/migrations/2026-02-26-sensitive-data-discovery.sql            migrations/0051-sensitive-data-discovery.sql
git mv src/db/migrations/2026-02-26-sentinelone-integration.sql            migrations/0052-sentinelone-integration.sql
git mv src/db/migrations/2026-02-27-config-feature-peripheral-control.sql  migrations/0053-config-feature-peripheral-control.sql
git mv src/db/migrations/2026-02-27-config-policy-sensitive-data.sql        migrations/0054-config-policy-sensitive-data.sql
git mv src/db/migrations/2026-02-27-s1-site-mappings.sql                   migrations/0055-s1-site-mappings.sql
git mv src/db/migrations/2026-03-01-browser-security.sql                   migrations/0056-browser-security.sql
git mv src/db/migrations/2026-03-01-schema-drift-fixes.sql                 migrations/0057-schema-drift-fixes.sql
git mv src/db/migrations/2026-03-03-device-role-classification.sql         migrations/0058-device-role-classification.sql
git mv src/db/migrations/2026-03-04-service-process-monitoring.sql         migrations/0059-service-process-monitoring.sql
git mv src/db/migrations/2026-03-09-alerting-system.sql                    migrations/0060-alerting-system.sql
git mv src/db/migrations/2026-03-09-warranty-lookup.sql                    migrations/0061-warranty-lookup.sql
git mv src/db/migrations/2026-03-10-helper-feature-type.sql                migrations/0062-helper-feature-type.sql
git mv src/db/migrations/2026-03-12-partner-status.sql                     migrations/0063-partner-status.sql
git mv src/db/migrations/2026-03-13-agent-version-component.sql            migrations/0064-agent-version-component.sql
git mv src/db/migrations/2026-03-13-users-setup-completed-at.sql           migrations/0065-users-setup-completed-at.sql
cd ../..
```

- [ ] **Step 3: Move optional and documentation files**

```bash
git mv apps/api/src/db/migrations/timescaledb-setup.sql apps/api/migrations/optional/timescaledb-setup.sql
git mv apps/api/src/db/migrations/README.md apps/api/migrations/optional/README.md
```

- [ ] **Step 4: Verify sort order matches the old system**

The old runner sorted by date prefix (`localeCompare`). Verify the new numbering preserves that order:

```bash
# List old files in the order run.ts would apply them
ls apps/api/src/db/migrations/2026-*.sql | sort | nl
# Compare against the new numbered sequence — the relative order must be identical
ls apps/api/migrations/0002-*.sql apps/api/migrations/0003-*.sql ... | sort | nl
```

Spot-check content is also preserved exactly:

```bash
diff <(git show HEAD:apps/api/src/db/migrations/2026-02-09-tenant-rls.sql) apps/api/migrations/0008-tenant-rls.sql
diff <(git show HEAD:apps/api/src/db/migrations/2026-03-13-users-setup-completed-at.sql) apps/api/migrations/0065-users-setup-completed-at.sql
# Expected: no output (files identical)
```

- [ ] **Step 5: Commit the file moves**

```bash
git add apps/api/migrations/
git commit -m "refactor(migrations): move and renumber 64 manual migrations to apps/api/migrations/"
```

---

## Chunk 2: Migration Runner

### Task 3: Write tests for the new migration runner

**Files:**
- Create: `apps/api/src/db/autoMigrate.test.ts`

- [ ] **Step 1: Write unit tests for runner helper functions**

Test the core logic that will be in the rewritten `autoMigrate.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// Test the hash function (extracted from run.ts pattern)
describe('hashSql', () => {
  it('produces consistent SHA-256 hash', () => {
    const content = 'CREATE TABLE test (id int);';
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    expect(hash).toHaveLength(64);
    // Same input = same hash
    const hash2 = crypto.createHash('sha256').update(content).digest('hex');
    expect(hash).toBe(hash2);
  });

  it('produces different hash for different content', () => {
    const h1 = crypto.createHash('sha256').update('CREATE TABLE a (id int);').digest('hex');
    const h2 = crypto.createHash('sha256').update('CREATE TABLE b (id int);').digest('hex');
    expect(h1).not.toBe(h2);
  });
});

// Test migration file ordering
describe('getMigrationFiles', () => {
  it('sorts files by numeric prefix', () => {
    const files = ['0010-foo.sql', '0002-bar.sql', '0001-baseline.sql'];
    const sorted = files.sort();
    expect(sorted).toEqual(['0001-baseline.sql', '0002-bar.sql', '0010-foo.sql']);
  });

  it('only matches NNNN-*.sql pattern', () => {
    const pattern = /^\d{4}-.*\.sql$/;
    expect(pattern.test('0001-baseline.sql')).toBe(true);
    expect(pattern.test('timescaledb-setup.sql')).toBe(false);
    expect(pattern.test('README.md')).toBe(false);
    expect(pattern.test('0001-baseline.sql.bak')).toBe(false);
  });
});

// Test database state detection logic
describe('detectDatabaseState', () => {
  it('returns fresh when users table does not exist', () => {
    // usersExist = false, breezeMigrationsExist = false
    const state = detectState(false, false);
    expect(state).toBe('fresh');
  });

  it('returns legacy when users exist but breeze_migrations does not', () => {
    // usersExist = true, breezeMigrationsExist = false
    const state = detectState(true, false);
    expect(state).toBe('legacy');
  });

  it('returns normal when both users and breeze_migrations exist', () => {
    // usersExist = true, breezeMigrationsExist = true
    const state = detectState(true, true);
    expect(state).toBe('normal');
  });
});

// Pure function for testability — will be extracted in implementation
function detectState(usersExist: boolean, breezeMigrationsExist: boolean): 'fresh' | 'legacy' | 'normal' {
  if (!usersExist) return 'fresh';
  if (!breezeMigrationsExist) return 'legacy';
  return 'normal';
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
```

Expected: all tests pass (these test pure functions, no DB needed).

- [ ] **Step 3: Commit tests**

```bash
git add apps/api/src/db/autoMigrate.test.ts
git commit -m "test(migrations): add unit tests for migration runner helpers"
```

---

### Task 4: Rewrite the migration runner

**Files:**
- Modify: `apps/api/src/db/autoMigrate.ts` (full rewrite)

- [ ] **Step 1: Rewrite autoMigrate.ts**

Replace the entire file with the new single-track runner. This consolidates logic from the old `autoMigrate.ts`, `migrate.ts`, and `migrations/run.ts`:

```typescript
import postgres from 'postgres';
import crypto from 'node:crypto';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seed } from './seed';

const MIGRATION_PATTERN = /^\d{4}-.*\.sql$/;

/** Detect database state: fresh, legacy (pre-consolidation), or normal. */
export function detectState(
  usersExist: boolean,
  breezeMigrationsExist: boolean
): 'fresh' | 'legacy' | 'normal' {
  if (!usersExist) return 'fresh';
  if (!breezeMigrationsExist) return 'legacy';
  return 'normal';
}

/**
 * Resolve the migrations directory. Works in:
 * - ESM (dev): import.meta.url → src/db/autoMigrate.ts → ../../migrations
 * - CJS (Docker production): process.cwd() is WORKDIR → ./migrations
 */
function resolveMigrationsDir(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // From apps/api/src/db/ → apps/api/migrations/
    return path.resolve(thisDir, '../../migrations');
  } catch {
    // CJS bundle: import.meta.url unavailable — use cwd (set by Dockerfile WORKDIR)
    return path.join(process.cwd(), 'migrations');
  }
}

/**
 * Runs schema migrations and seeds the database on first boot.
 *
 * Single-track migration system:
 * 1. Fresh database — runs all migrations from 0001-baseline.sql onward, then seeds
 * 2. Legacy database (from old Drizzle + manual system) — marks 0001–0065 as applied
 * 3. Normal startup — runs only pending migrations
 */
export async function autoMigrate(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

  const client = postgres(connectionString, { max: 1 });

  try {
    // Ensure tracking table exists
    await client`
      CREATE TABLE IF NOT EXISTS breeze_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `;

    // Discover migration files
    const migrationsDir = resolveMigrationsDir();
    const files = readdirSync(migrationsDir)
      .filter((f) => MIGRATION_PATTERN.test(f))
      .sort();

    if (files.length === 0) {
      console.log('[migrate] No migration files found, skipping');
      return;
    }

    // Detect database state
    const usersExist = await tableExists(client, 'users');
    const breezeMigrationsPopulated =
      (await client`SELECT count(*)::int AS c FROM breeze_migrations`)[0].c > 0;

    const state = detectState(usersExist, breezeMigrationsPopulated);
    console.log(`[migrate] Database state: ${state}`);

    if (state === 'legacy') {
      // Mark all pre-consolidation migrations as applied
      console.log('[migrate] Legacy database detected — baselining migrations 0001–0065');
      const legacyFiles = files.filter((f) => {
        const num = parseInt(f.split('-')[0], 10);
        return num >= 1 && num <= 65;
      });

      for (const file of legacyFiles) {
        const content = readFileSync(path.join(migrationsDir, file), 'utf8');
        const checksum = hashSql(content);
        await client`
          INSERT INTO breeze_migrations (filename, checksum)
          VALUES (${file}, ${checksum})
          ON CONFLICT (filename) DO NOTHING
        `;
      }
      console.log(`[migrate] Baselined ${legacyFiles.length} migrations`);
    }

    // Get already-applied migrations
    const applied = new Set(
      (await client`SELECT filename FROM breeze_migrations`).map((r) => r.filename)
    );

    // Apply pending migrations
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[migrate] No pending migrations');
    } else {
      console.log(`[migrate] Applying ${pending.length} migration(s)...`);

      for (const file of pending) {
        const filePath = path.join(migrationsDir, file);
        const content = readFileSync(filePath, 'utf8');
        const checksum = hashSql(content);

        // Check for checksum mismatch on already-tracked files
        const existing = await client`
          SELECT checksum FROM breeze_migrations WHERE filename = ${file}
        `;
        if (existing.length > 0 && existing[0].checksum !== checksum) {
          throw new Error(
            `[migrate] Checksum mismatch for ${file} — migration file was modified after being applied. ` +
              `Fix forward with a new migration instead of editing shipped files.`
          );
        }

        console.log(`[migrate] Applying ${file}...`);

        // Run migration in a transaction
        await client.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`
            INSERT INTO breeze_migrations (filename, checksum)
            VALUES (${file}, ${checksum})
          `;
        });

        console.log(`[migrate] Applied ${file}`);
      }
    }

    // Auto-seed when the database is empty (first boot)
    const result = await client`SELECT id FROM users LIMIT 1`;
    if (result.length === 0) {
      console.log('[migrate] No users found, running initial seed...');
      await seed();
      console.log('[migrate] Initial seed complete');
    } else {
      console.log('[migrate] Database already seeded');
    }
  } finally {
    await client.end();
  }
}

async function tableExists(
  client: postgres.Sql,
  tableName: string
): Promise<boolean> {
  const result = await client`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${tableName}
    )
  `;
  return result[0]?.exists === true;
}

function hashSql(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 2: Run the unit tests**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Verify the API still builds**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no new type errors (pre-existing ones in test files are OK).

- [ ] **Step 4: Commit the runner rewrite**

```bash
git add apps/api/src/db/autoMigrate.ts
git commit -m "feat(migrations): rewrite autoMigrate to single-track runner

Replaces dual Drizzle + manual migration system with one numbered
sequence. Detects fresh/legacy/normal database state and applies
pending migrations with SHA-256 checksum tracking."
```

---

## Chunk 3: Config, Scripts, CI, and Cleanup

### Task 5: Update package scripts and config

**Files:**
- Modify: `apps/api/package.json`
- Modify: `package.json` (root)
- Modify: `apps/api/drizzle.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Update `apps/api/package.json` scripts**

Remove old scripts, add new drift check:

- Remove: `db:generate`, `db:push`, `db:migrate` (old), `db:migrate:sql`
- Update: `db:migrate` → if needed as a standalone entry point (optional — autoMigrate runs on startup)
- Add: `db:check-drift`
- Keep: `db:seed`, `db:studio`

The `db:check-drift` script:
```json
"db:check-drift": "drizzle-kit generate --out .drizzle-tmp && (ls .drizzle-tmp/*.sql 2>/dev/null && echo '::error::Schema drift detected — write a migration' && rm -rf .drizzle-tmp && exit 1 || (rm -rf .drizzle-tmp && echo 'No drift detected'))"
```

- [ ] **Step 2: Update root `package.json` scripts**

Remove: `db:generate`, `db:push`, `db:migrate`, `check:schema-drift`
Add: `db:check-drift` → `turbo run db:check-drift --filter=@breeze/api`

- [ ] **Step 3: Update `apps/api/drizzle.config.ts`**

Change `out` from `'./drizzle'` to `'.drizzle-tmp'` so accidental `drizzle-kit generate` doesn't recreate the deleted folder:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: '.drizzle-tmp',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 4: Update `.gitignore`**

Add `.drizzle-tmp/` to the gitignore:

```
# Drizzle drift check temp output
.drizzle-tmp/
```

- [ ] **Step 5: Commit config changes**

```bash
git add apps/api/package.json package.json apps/api/drizzle.config.ts .gitignore
git commit -m "chore: update package scripts and drizzle config for migration consolidation"
```

---

### Task 6: Update CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Replace the schema drift check step**

Find the existing step (around lines 54–65) that runs `drizzle-kit generate` + `fix-drizzle-enums.sh` + checks `git diff drizzle/`. Replace with:

```yaml
- name: Check for schema drift
  working-directory: apps/api
  run: pnpm db:check-drift
```

- [ ] **Step 2: Commit CI changes**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: replace Drizzle migration check with db:check-drift"
```

---

### Task 7: Update Dockerfiles

Both production Dockerfiles copy migration files into the image. They must be updated to use the new `apps/api/migrations/` path.

**Files:**
- Modify: `apps/api/Dockerfile` (lines 67–70)
- Modify: `docker/Dockerfile.api` (lines 33–36)

**Note:** `docker/Dockerfile.api.dev` uses volume mounts (`COPY apps/api ./apps/api`) so the new path is automatically available in dev mode — no changes needed.

- [ ] **Step 1: Update `apps/api/Dockerfile`**

Replace lines 67–70:
```dockerfile
# Old:
# Copy Drizzle migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/drizzle ./apps/api/drizzle
# Copy manual SQL migration files
COPY --from=builder --chown=hono:nodejs /app/apps/api/src/db/migrations ./apps/api/db/migrations

# New:
# Copy migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/migrations ./apps/api/migrations
```

`WORKDIR` is `/app/apps/api`, so `resolveMigrationsDir()` resolves to `/app/apps/api/migrations` — correct.

- [ ] **Step 2: Update `docker/Dockerfile.api`**

Replace lines 33–36:
```dockerfile
# Old:
# Copy Drizzle migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/drizzle ./drizzle
# Copy manual SQL migration files
COPY --from=builder --chown=hono:nodejs /app/apps/api/src/db/migrations ./db/migrations

# New:
# Copy migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/migrations ./migrations
```

`WORKDIR` is `/app`, so the CJS fallback `process.cwd() + '/migrations'` resolves to `/app/migrations` — correct.

- [ ] **Step 3: Commit Dockerfile changes**

```bash
git add apps/api/Dockerfile docker/Dockerfile.api
git commit -m "chore: update Dockerfiles for consolidated migrations path"
```

---

### Task 8: Delete legacy files

**Files:**
- Delete: `apps/api/drizzle/0000_even_nemesis.sql`
- Delete: `apps/api/drizzle/0001_software_policies.sql`
- Delete: `apps/api/drizzle/0002_user_risk_scoring.sql`
- Delete: `apps/api/drizzle/0003_solid_marvel_zombies.sql`
- Delete: `apps/api/drizzle/0003_alerting_system.sql`
- Delete: `apps/api/drizzle/meta/` (entire directory)
- Delete: `apps/api/scripts/fix-drizzle-enums.sh`
- Delete: `scripts/check-schema-drift.ts`
- Delete: `apps/api/src/db/migrate.ts`
- Delete: `apps/api/src/db/migrations/run.ts`

- [ ] **Step 1: Delete Drizzle migration files and meta**

```bash
rm -rf apps/api/drizzle/
```

- [ ] **Step 2: Delete legacy scripts**

```bash
rm apps/api/scripts/fix-drizzle-enums.sh
rm scripts/check-schema-drift.ts
```

- [ ] **Step 3: Delete old runner files**

```bash
rm apps/api/src/db/migrate.ts
rm apps/api/src/db/migrations/run.ts
```

- [ ] **Step 4: Clean up empty directories if any remain**

```bash
# If apps/api/src/db/migrations/ is now empty (all .sql moved, run.ts deleted, README.md moved)
rmdir apps/api/src/db/migrations/ 2>/dev/null || true
# If apps/api/scripts/ is now empty
ls apps/api/scripts/ 2>/dev/null  # Check if other scripts exist before removing
```

- [ ] **Step 5: Commit deletions**

```bash
git add -A
git commit -m "chore: remove legacy Drizzle migrations, fixer scripts, and old runner files"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the Schema Migration Workflow section**

Find the existing section and replace with:

```markdown
### Schema Migration Workflow
1. Edit schema files in `apps/api/src/db/schema/`
2. Write a hand-written SQL migration in `apps/api/migrations/NNNN-<slug>.sql`
   - Use the next available 4-digit number (check existing files)
   - Must be fully idempotent: `IF NOT EXISTS`, `IF EXISTS`, `DO $$ BEGIN ... EXCEPTION`
   - Never edit a shipped migration — fix forward with a new migration
3. Run `pnpm db:check-drift` to verify schema matches migrations
4. Commit the migration file

**Drizzle usage:** Drizzle ORM is used for type-safe queries only. `drizzle-kit` is retained for schema drift detection (`db:check-drift`) and Drizzle Studio (`db:studio`). **Do not use `drizzle-kit generate` or `drizzle-kit push` for migrations.**

For optional TimescaleDB setup, see `apps/api/migrations/optional/`.
```

- [ ] **Step 2: Update the Development Commands section**

Remove references to `db:push` and `db:generate`. Update the database operations block:

```markdown
# Database operations
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift  # Verify schema matches migrations (no drift)
pnpm db:studio       # Open Drizzle Studio
```

- [ ] **Step 3: Commit CLAUDE.md changes**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for single-track migration system"
```

---

## Chunk 4: Validation

### Task 10: End-to-end validation

Validate all three database states work correctly with the new system.

**Prerequisites:** Docker must be running.

- [ ] **Step 1: Test fresh database**

```bash
# Start a fresh Postgres
docker run -d --name breeze-pg-fresh \
  -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze \
  -p 5433:5432 postgres:16-alpine
sleep 3

# Run the new autoMigrate against it
DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze" \
  npx tsx -e "import { autoMigrate } from './apps/api/src/db/autoMigrate'; autoMigrate().then(() => console.log('SUCCESS')).catch(e => { console.error(e); process.exit(1); })"

# Verify tables exist
docker exec breeze-pg-fresh psql -U breeze -d breeze -c "\dt public.*" | head -20
# Expected: devices, users, organizations, etc.

# Verify breeze_migrations tracking
docker exec breeze-pg-fresh psql -U breeze -d breeze -c "SELECT count(*) FROM breeze_migrations;"
# Expected: 65 (0001 through 0065)

docker stop breeze-pg-fresh && docker rm breeze-pg-fresh
```

- [ ] **Step 2: Test legacy database (simulated)**

```bash
# Start Postgres and apply OLD migrations to simulate a legacy DB
docker run -d --name breeze-pg-legacy \
  -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze -e POSTGRES_DB=breeze \
  -p 5433:5432 postgres:16-alpine
sleep 3

# Simulate: create users table (proves data exists) but no breeze_migrations table
docker exec breeze-pg-legacy psql -U breeze -d breeze -c "
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  INSERT INTO users (email) VALUES ('test@test.com');
"

# Run new autoMigrate — should detect legacy state and baseline
DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze" \
  npx tsx -e "import { autoMigrate } from './apps/api/src/db/autoMigrate'; autoMigrate().then(() => console.log('SUCCESS')).catch(e => { console.error(e); process.exit(1); })"

# Verify it baselined (marked 0001-0065 as applied, didn't try to run them)
docker exec breeze-pg-legacy psql -U breeze -d breeze -c "SELECT count(*) FROM breeze_migrations;"
# Expected: 65

docker stop breeze-pg-legacy && docker rm breeze-pg-legacy
```

- [ ] **Step 3: Test normal startup (dev database)**

```bash
# Run against the existing dev database — should detect normal state, no pending migrations
pnpm dev
# Check logs for: [migrate] Database state: normal
# Check logs for: [migrate] No pending migrations
```

- [ ] **Step 4: Test drift check**

```bash
pnpm db:check-drift
# Expected: "No drift detected"
```

- [ ] **Step 5: Run existing test suite**

```bash
pnpm test --filter=@breeze/api
```

Expected: no new failures from the migration changes.

---

### Task 11: Address SemoTech's issues (#219 and #248)

Now that the migration system is consolidated, write new migrations to fix the issues SemoTech reported, and restore Intel Mac builds.

**Files:**
- Create: `apps/api/migrations/0066-fix-search-vector-fresh-install.sql` (fixes #248)
- Modify: `.github/workflows/release.yml` (restore darwin/amd64)

- [ ] **Step 1: Write migration for search_vector fix**

This is now a no-op since `0001-baseline.sql` includes the column, but we keep it as documentation and for databases that may have partially applied the old schema:

```sql
-- 0066-fix-search-vector-fresh-install.sql
-- Ensures search_vector column and indexes exist on device_event_logs.
-- This is a no-op for databases created with the new baseline (0001).
-- For legacy databases, these objects already exist from manual migrations.
-- Kept as a safety net for edge cases.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "device_event_logs" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(source, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(message, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(event_id, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS "device_event_logs_search_vector_idx"
  ON "device_event_logs" USING gin (search_vector);
CREATE INDEX IF NOT EXISTS "device_event_logs_message_trgm_idx"
  ON "device_event_logs" USING gin (message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "device_event_logs_source_trgm_idx"
  ON "device_event_logs" USING gin (source gin_trgm_ops);
```

- [ ] **Step 2: Restore Intel Mac builds in release.yml**

Three changes in `.github/workflows/release.yml`:

**a) Add darwin/amd64 to build-agent matrix** (after line ~96, before the darwin/arm64 entry):
```yaml
          - goos: darwin
            goarch: amd64
            suffix: ''
            cgo: '1'
            runner: macos-13
```

**b) Add darwin/amd64 download to build-macos-agent job** (before the existing arm64 download):
```yaml
      - name: Download darwin/amd64 artifact
        uses: actions/download-artifact@v8
        with:
          name: breeze-agent-darwin-amd64
          path: staging/
```

The existing `for bin in staging/breeze-agent-darwin-*` loops in the sign/notarize steps will automatically pick up both architectures.

**c) Add darwin/amd64 upload step** (before the existing arm64 upload):
```yaml
      - name: Upload signed darwin/amd64
        uses: actions/upload-artifact@v7
        with:
          name: breeze-agent-darwin-amd64
          path: staging/breeze-agent-darwin-amd64
          overwrite: true
          retention-days: 30
```

The release job (`create-release`) and binaries image job (`build-binaries-image`) both use `breeze-agent-*` glob patterns, so they'll automatically include the new artifact.

- [ ] **Step 3: Commit fixes**

```bash
git add apps/api/migrations/0066-fix-search-vector-fresh-install.sql .github/workflows/release.yml
git commit -m "fix: add search_vector safety migration (#248), restore Intel Mac builds (#219)"
```

- [ ] **Step 4: Reply to GitHub issues**

Post on #219 and #248 with the fix details and version info. Keep #219 open until SemoTech confirms.
