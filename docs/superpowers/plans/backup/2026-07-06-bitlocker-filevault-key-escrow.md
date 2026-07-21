# BitLocker / FileVault Recovery-Key Escrow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic BitLocker recovery-key escrow (encrypted at rest), credentialed on-demand FileVault rotate-and-escrow, audited fetch-on-demand key reveal, and real escrow status in the fleet Encryption page — issue #2021, spec `docs/superpowers/specs/backup/2026-07-06-bitlocker-filevault-key-escrow-design.md`.

**Architecture:** New `device_recovery_keys` + `recovery_key_access_events` tables (RLS shape 1/5, denormalized `org_id`); the Go agent collects BitLocker key protectors on the existing 5-minute security tick (fingerprint-gated) and pushes full snapshots to a new agent ingest route; two new agent commands handle re-collect and rotate; tech-facing list/reveal/rotate routes live under `/security/encryption/devices/:deviceId/...` with PAM-style dual audit; the existing `/security/encryption` fleet endpoint gets real escrow data.

**Tech Stack:** Hono + Drizzle + Zod (API), Go agent, React (web), Vitest + Go `testing`.

## Global Constraints

- Recovery-key plaintext must NEVER appear in: audit `details`, command results, agent logs, API logs, list endpoints, or test snapshot output. Only the reveal endpoint returns plaintext, fetch-on-demand.
- `encrypted_key` is encrypted via `encryptSecret`/`encryptColumnValueForWrite` with AAD `device_recovery_keys.encrypted_key` and registered in `encryptedColumnRegistry`.
- RLS policies are created in the SAME migration that creates each table; the migration is idempotent; never edit it after it ships.
- Migration filename: `2026-07-06-device-recovery-keys.sql` (rename the date prefix to the actual commit date if it slips, BEFORE it ships).
- Zod 4 is in use: UUID validation is `z.string().guid()`, not `.uuid()`.
- New agent command types: `encryption_collect_keys`, `encryption_rotate_key` (constants in both TS `CommandTypes` and Go `tools.Cmd*`; string values must match exactly).
- Ingest key-type strings: `bitlocker_recovery_password`, `filevault_personal_recovery_key`. Ingest `source` values: `snapshot`, `rotation`.
- Test URLs must not have trailing slashes (Hono 404s them). Use real UUIDs in mock data. `vi.mock` factories are hoisted — no module-level consts inside them.
- Commit after every task with the commit message given in that task, ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: DB schema, migration, and tenancy registrations

**Files:**
- Create: `apps/api/src/db/schema/recoveryKeys.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add one export line)
- Create: `apps/api/migrations/2026-07-06-device-recovery-keys.sql`
- Modify: `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts` (registry entry)
- Test: `apps/api/src/__tests__/integration/deviceRecoveryKeys-rls.integration.test.ts`

**Interfaces:**
- Consumes: `devices`, `organizations` schema tables.
- Produces: Drizzle exports `deviceRecoveryKeys`, `recoveryKeyAccessEvents` (importable from `../../db/schema`), with columns exactly as below. Later tasks rely on column property names `deviceId, orgId, keyType, volumeMount, protectorId, encryptedKey, keyFingerprint, status, escrowedAt, supersededAt` and (events) `keyId, userId, userEmail, action, createdAt`.

- [ ] **Step 1: Write the failing RLS integration test**

Model on `apps/api/src/__tests__/integration/deviceVulnerabilities-rls.integration.test.ts` (read it first; reuse its `db-utils` helpers). Create `apps/api/src/__tests__/integration/deviceRecoveryKeys-rls.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import type { DbAccessContext } from '../../db';
import { deviceRecoveryKeys, recoveryKeyAccessEvents, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite, createDevice } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

describe('device_recovery_keys / recovery_key_access_events RLS', () => {
  runDb('cross-org forged insert is rejected with 42501; same-org insert succeeds', async () => {
    const { partner, orgA, orgB, device } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization(partner.id);
      const orgB = await createOrganization(partner.id);
      const site = await createSite(orgA.id);
      const device = await createDevice(orgA.id, site.id);
      return { partner, orgA, orgB, device };
    });

    // Same-org insert succeeds.
    const inserted = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db.insert(deviceRecoveryKeys).values({
        deviceId: device.id,
        orgId: orgA.id,
        keyType: 'bitlocker_recovery_password',
        volumeMount: 'C:',
        protectorId: '11111111-2222-3333-4444-555555555555',
        encryptedKey: 'enc:test-not-real',
        keyFingerprint: 'a'.repeat(64),
        status: 'active',
      }).returning({ id: deviceRecoveryKeys.id, orgId: deviceRecoveryKeys.orgId });
      return row;
    });
    expect(inserted.orgId).toBe(orgA.id);

    // Cross-tenant forge: org B context inserting an org A row must fail.
    let caught: unknown;
    await withDbAccessContext(orgCtx(orgB.id), async () => {
      try {
        await db.insert(deviceRecoveryKeys).values({
          deviceId: device.id,
          orgId: orgA.id,
          keyType: 'bitlocker_recovery_password',
          volumeMount: 'D:',
          encryptedKey: 'enc:forged',
          keyFingerprint: 'b'.repeat(64),
          status: 'active',
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught, 'cross-org insert must be rejected by RLS').toBeDefined();
    const cause = (caught as { cause?: { message?: string; code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "device_recovery_keys"/
    );

    // Org B cannot read org A's key rows.
    const visibleToB = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.select({ id: deviceRecoveryKeys.id }).from(deviceRecoveryKeys)
        .where(eq(deviceRecoveryKeys.deviceId, device.id))
    );
    expect(visibleToB).toHaveLength(0);

    // Access-events table: forged cross-org insert also rejected.
    let eventCaught: unknown;
    await withDbAccessContext(orgCtx(orgB.id), async () => {
      try {
        await db.insert(recoveryKeyAccessEvents).values({
          keyId: inserted.id,
          deviceId: device.id,
          orgId: orgA.id,
          userId: '99999999-9999-4999-8999-999999999999',
          userEmail: 'forger@example.com',
          action: 'revealed',
        });
      } catch (err) {
        eventCaught = err;
      }
    });
    expect(eventCaught, 'cross-org access-event insert must be rejected by RLS').toBeDefined();
    expect((eventCaught as { cause?: { code?: string } })?.cause?.code).toBe('42501');
  });
});
```

Adjust the `db-utils` helper names/signatures to match what `deviceVulnerabilities-rls.integration.test.ts` actually imports — copy its exact seed pattern.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze_integration" pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceRecoveryKeys-rls.integration.test.ts
```

Expected: FAIL — `deviceRecoveryKeys` export does not exist / relation missing. (If no local integration DB is available, note that and rely on CI's smoke-test job; still complete the remaining steps.) Check how the existing integration tests are invoked in `apps/api/package.json` scripts and use that script if one exists.

- [ ] **Step 3: Create the Drizzle schema**

`apps/api/src/db/schema/recoveryKeys.ts`:

```ts
import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';

// Escrowed disk-encryption recovery keys (BitLocker / FileVault). One row per
// key; rotation supersedes rather than overwrites so a half-failed rotation
// still leaves the old (possibly still valid) key retrievable.
export const deviceRecoveryKeys = pgTable('device_recovery_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  keyType: varchar('key_type', { length: 50 }).notNull(),
  volumeMount: varchar('volume_mount', { length: 100 }),
  protectorId: varchar('protector_id', { length: 100 }),
  encryptedKey: text('encrypted_key').notNull(),
  keyFingerprint: varchar('key_fingerprint', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  escrowedAt: timestamp('escrowed_at').defaultNow().notNull(),
  supersededAt: timestamp('superseded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  deviceIdx: index('device_recovery_keys_device_idx').on(table.deviceId),
  orgIdx: index('device_recovery_keys_org_idx').on(table.orgId),
  activeSlotUnique: uniqueIndex('device_recovery_keys_active_slot_unique')
    .on(table.deviceId, table.keyType, sql`COALESCE(${table.volumeMount}, '')`)
    .where(sql`${table.status} = 'active'`)
}));

// Append-only who-viewed-when ledger for key reveals.
export const recoveryKeyAccessEvents = pgTable('recovery_key_access_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyId: uuid('key_id').notNull().references(() => deviceRecoveryKeys.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  userEmail: varchar('user_email', { length: 255 }).notNull(),
  action: varchar('action', { length: 20 }).notNull().default('revealed'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  keyIdx: index('recovery_key_access_events_key_idx').on(table.keyId),
  deviceIdx: index('recovery_key_access_events_device_idx').on(table.deviceId),
  orgIdx: index('recovery_key_access_events_org_idx').on(table.orgId)
}));
```

Add to `apps/api/src/db/schema/index.ts` (alphabetical position among the other `export *` lines):

```ts
export * from './recoveryKeys';
```

Note on the partial expression index: if the installed Drizzle version rejects `sql\`COALESCE(...)\`` inside `uniqueIndex().on(...)` or `pnpm db:check-drift` can't reconcile it, drop the index from the Drizzle schema entirely and keep it SQL-only in the migration — grep for `uniqueIndex` + `sql\`` under `apps/api/src/db/schema/` first and copy whichever convention an existing expression index uses.

- [ ] **Step 4: Write the migration**

`apps/api/migrations/2026-07-06-device-recovery-keys.sql` — copy the shape of `apps/api/migrations/2026-06-13-device-process-samples.sql` (RLS shape 1: direct org_id, policies in the same file):

```sql
-- 2026-07-06: BitLocker/FileVault recovery-key escrow (issue #2021).
-- device_recovery_keys: escrowed keys, encrypted at rest by the app layer
-- (secretCrypto AAD device_recovery_keys.encrypted_key). RLS shape #1/#5
-- (direct denormalized org_id), policies created in the same migration.
-- recovery_key_access_events: append-only reveal ledger, same shape.

CREATE TABLE IF NOT EXISTS public.device_recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_type varchar(50) NOT NULL,
  volume_mount varchar(100),
  protector_id varchar(100),
  encrypted_key text NOT NULL,
  key_fingerprint varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  escrowed_at timestamp NOT NULL DEFAULT now(),
  superseded_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_recovery_keys_device_idx
  ON public.device_recovery_keys (device_id);
CREATE INDEX IF NOT EXISTS device_recovery_keys_org_idx
  ON public.device_recovery_keys (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_recovery_keys_active_slot_unique
  ON public.device_recovery_keys (device_id, key_type, COALESCE(volume_mount, ''))
  WHERE status = 'active';

ALTER TABLE public.device_recovery_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_recovery_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_recovery_keys;

CREATE POLICY breeze_org_isolation_select ON public.device_recovery_keys
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_recovery_keys
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_recovery_keys
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_recovery_keys
  FOR DELETE USING (public.breeze_has_org_access(org_id));

CREATE TABLE IF NOT EXISTS public.recovery_key_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES public.device_recovery_keys(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_email varchar(255) NOT NULL,
  action varchar(20) NOT NULL DEFAULT 'revealed',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_key_access_events_key_idx
  ON public.recovery_key_access_events (key_id);
CREATE INDEX IF NOT EXISTS recovery_key_access_events_device_idx
  ON public.recovery_key_access_events (device_id);
CREATE INDEX IF NOT EXISTS recovery_key_access_events_org_idx
  ON public.recovery_key_access_events (org_id);

ALTER TABLE public.recovery_key_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_key_access_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.recovery_key_access_events;

CREATE POLICY breeze_org_isolation_select ON public.recovery_key_access_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.recovery_key_access_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.recovery_key_access_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.recovery_key_access_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

Notes: no inner `BEGIN;`/`COMMIT;` (autoMigrate wraps the file); `gen_random_uuid()` is pgcrypto-free on PG13+ (matches existing migrations — verify another 2026 migration uses it; if they use `DEFAULT gen_random_uuid()` you're consistent). Timestamp columns are `timestamp` (not `timestamptz`) to match Drizzle's default `timestamp()` used in the schema above — check `2026-06-13-device-process-samples.sql` vs its schema file and match whichever convention `security_status` uses.

- [ ] **Step 5: Register in tenant cascade and encrypted-column registry**

In `apps/api/src/services/tenantCascade.ts`, add to `ORG_CASCADE_DELETE_ORDER`: `'recovery_key_access_events'` must come BEFORE `'device_recovery_keys'` (FK child first), and both before `'devices'`. Place them adjacent to the other `device_*` entries, respecting the existing ordering convention in the array (read the comment at the top of the array first).

In `apps/api/src/services/encryptedColumnRegistry.ts`, add to `encryptedColumnRegistry`:

```ts
  { table: 'device_recovery_keys', column: 'encrypted_key', kind: 'text', description: 'escrowed BitLocker/FileVault recovery key (#2021)' },
```

- [ ] **Step 6: Run the RLS integration test + cascade contract + drift check**

```bash
cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze_integration" pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceRecoveryKeys-rls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd ../.. && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
```

Expected: PASS (rls-coverage auto-discovers direct-org_id tables — no allowlist edits needed). If drift check flags a mismatch, reconcile schema vs SQL.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/recoveryKeys.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-07-06-device-recovery-keys.sql apps/api/src/services/tenantCascade.ts apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/__tests__/integration/deviceRecoveryKeys-rls.integration.test.ts
git commit -m "feat(api): device_recovery_keys + access-events tables with RLS (#2021)"
```

---

### Task 2: Escrow service (supersede/dedupe upsert)

**Files:**
- Create: `apps/api/src/services/recoveryKeyEscrow.ts`
- Test: `apps/api/src/services/recoveryKeyEscrow.test.ts`

**Interfaces:**
- Consumes: `deviceRecoveryKeys` from `../db/schema` (Task 1); `encryptColumnValueForWrite(table, column, value)` from `./encryptedColumnRegistry`.
- Produces:
  - `type IncomingRecoveryKey = { keyType: 'bitlocker_recovery_password' | 'filevault_personal_recovery_key'; volumeMount?: string | null; protectorId?: string | null; recoveryKey: string }`
  - `fingerprintRecoveryKey(key: string): string` (sha256 hex)
  - `escrowRecoveryKeys(deviceId: string, orgId: string, source: 'snapshot' | 'rotation', keys: IncomingRecoveryKey[]): Promise<{ inserted: number; superseded: number; unchanged: number }>`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/recoveryKeyEscrow.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  deviceRecoveryKeys: {
    id: 'deviceRecoveryKeys.id',
    deviceId: 'deviceRecoveryKeys.deviceId',
    orgId: 'deviceRecoveryKeys.orgId',
    keyType: 'deviceRecoveryKeys.keyType',
    volumeMount: 'deviceRecoveryKeys.volumeMount',
    protectorId: 'deviceRecoveryKeys.protectorId',
    encryptedKey: 'deviceRecoveryKeys.encryptedKey',
    keyFingerprint: 'deviceRecoveryKeys.keyFingerprint',
    status: 'deviceRecoveryKeys.status',
    supersededAt: 'deviceRecoveryKeys.supersededAt',
    updatedAt: 'deviceRecoveryKeys.updatedAt',
  },
}));

vi.mock('./encryptedColumnRegistry', () => ({
  encryptColumnValueForWrite: vi.fn((_t: string, _c: string, v: string) => `enc:${v}`),
}));

import { db } from '../db';
import { escrowRecoveryKeys, fingerprintRecoveryKey } from './recoveryKeyEscrow';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function mockActiveRows(rows: unknown[]) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  });
}

function mockInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values });
  return values;
}

function mockUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set });
  return { set, where };
}

const KEY = '111111-222222-333333-444444-555555-666666-777777-888888';

describe('fingerprintRecoveryKey', () => {
  it('is a stable 64-char sha256 hex', () => {
    const fp = fingerprintRecoveryKey(KEY);
    expect(fp).toHaveLength(64);
    expect(fp).toBe(fingerprintRecoveryKey(KEY));
    expect(fp).not.toBe(fingerprintRecoveryKey(`${KEY}x`));
  });
});

describe('escrowRecoveryKeys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a brand-new key encrypted, never plaintext', async () => {
    mockActiveRows([]);
    const values = mockInsert();
    mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', protectorId: 'p-1', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 1, superseded: 0, unchanged: 0 });
    const row = values.mock.calls[0][0];
    expect(row.encryptedKey).toBe(`enc:${KEY}`);
    expect(row.keyFingerprint).toBe(fingerprintRecoveryKey(KEY));
    expect(JSON.stringify(row)).not.toContain(`"${KEY}"`);
  });

  it('no-ops when the active row has the same fingerprint', async () => {
    mockActiveRows([{
      id: 'row-1', keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      keyFingerprint: fingerprintRecoveryKey(KEY), status: 'active',
    }]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 0, superseded: 0, unchanged: 1 });
    expect(values).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('supersedes and re-inserts when the fingerprint changed', async () => {
    mockActiveRows([{
      id: 'row-1', keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      keyFingerprint: 'old-fingerprint', status: 'active',
    }]);
    const values = mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);

    expect(stats).toEqual({ inserted: 1, superseded: 1, unchanged: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(values).toHaveBeenCalledTimes(1);
  });

  it('snapshot supersedes active bitlocker rows absent from the snapshot', async () => {
    mockActiveRows([{
      id: 'row-gone', keyType: 'bitlocker_recovery_password', volumeMount: 'D:',
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', []);
    expect(stats).toEqual({ inserted: 0, superseded: 1, unchanged: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
  });

  it('snapshot does NOT supersede filevault rows absent from the snapshot', async () => {
    mockActiveRows([{
      id: 'row-fv', keyType: 'filevault_personal_recovery_key', volumeMount: null,
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'snapshot', []);
    expect(stats).toEqual({ inserted: 0, superseded: 0, unchanged: 0 });
    expect(set).not.toHaveBeenCalled();
  });

  it('rotation source never snapshot-supersedes absent rows', async () => {
    mockActiveRows([{
      id: 'row-other', keyType: 'bitlocker_recovery_password', volumeMount: 'D:',
      keyFingerprint: 'whatever', status: 'active',
    }]);
    mockInsert();
    const { set } = mockUpdate();

    const stats = await escrowRecoveryKeys(DEVICE_ID, ORG_ID, 'rotation', [
      { keyType: 'bitlocker_recovery_password', volumeMount: 'C:', recoveryKey: KEY },
    ]);
    expect(stats.inserted).toBe(1);
    expect(stats.superseded).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && pnpm exec vitest run src/services/recoveryKeyEscrow.test.ts
```

Expected: FAIL — module `./recoveryKeyEscrow` not found.

- [ ] **Step 3: Implement the service**

`apps/api/src/services/recoveryKeyEscrow.ts`:

```ts
import { createHash } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceRecoveryKeys } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';

export type IncomingRecoveryKey = {
  keyType: 'bitlocker_recovery_password' | 'filevault_personal_recovery_key';
  volumeMount?: string | null;
  protectorId?: string | null;
  recoveryKey: string;
};

export type EscrowStats = { inserted: number; superseded: number; unchanged: number };

export function fingerprintRecoveryKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// One "slot" = (keyType, volumeMount). A device has at most one active key per
// slot; a changed fingerprint supersedes the old row (history retained).
function slotOf(keyType: string, volumeMount: string | null | undefined): string {
  return `${keyType}|${volumeMount ?? ''}`;
}

/**
 * Escrow a batch of recovery keys for a device.
 *
 * `source === 'snapshot'` means the batch is the device's FULL current set of
 * BitLocker keys: active bitlocker rows absent from the batch are superseded
 * (the protector no longer exists on the device). FileVault rows are exempt —
 * they are only written by the rotate command (`source === 'rotation'`),
 * which never snapshot-supersedes anything.
 */
export async function escrowRecoveryKeys(
  deviceId: string,
  orgId: string,
  source: 'snapshot' | 'rotation',
  keys: IncomingRecoveryKey[],
): Promise<EscrowStats> {
  const active = await db
    .select({
      id: deviceRecoveryKeys.id,
      keyType: deviceRecoveryKeys.keyType,
      volumeMount: deviceRecoveryKeys.volumeMount,
      keyFingerprint: deviceRecoveryKeys.keyFingerprint,
    })
    .from(deviceRecoveryKeys)
    .where(and(
      eq(deviceRecoveryKeys.deviceId, deviceId),
      eq(deviceRecoveryKeys.status, 'active'),
    ));

  const incomingBySlot = new Map<string, IncomingRecoveryKey>();
  for (const key of keys) {
    incomingBySlot.set(slotOf(key.keyType, key.volumeMount), key);
  }

  const toSupersede: string[] = [];
  let unchanged = 0;

  for (const row of active) {
    const slot = slotOf(row.keyType, row.volumeMount);
    const incoming = incomingBySlot.get(slot);
    if (incoming) {
      if (row.keyFingerprint === fingerprintRecoveryKey(incoming.recoveryKey)) {
        incomingBySlot.delete(slot);
        unchanged++;
      } else {
        toSupersede.push(row.id);
      }
    } else if (source === 'snapshot' && row.keyType === 'bitlocker_recovery_password') {
      toSupersede.push(row.id);
    }
  }

  if (toSupersede.length > 0) {
    await db
      .update(deviceRecoveryKeys)
      .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
      .where(inArray(deviceRecoveryKeys.id, toSupersede));
  }

  let inserted = 0;
  for (const key of incomingBySlot.values()) {
    await db.insert(deviceRecoveryKeys).values({
      deviceId,
      orgId,
      keyType: key.keyType,
      volumeMount: key.volumeMount ?? null,
      protectorId: key.protectorId ?? null,
      encryptedKey: encryptColumnValueForWrite('device_recovery_keys', 'encrypted_key', key.recoveryKey) as string,
      keyFingerprint: fingerprintRecoveryKey(key.recoveryKey),
      status: 'active',
    });
    inserted++;
  }

  return { inserted, superseded: toSupersede.length, unchanged };
}
```

Check `encryptColumnValueForWrite`'s actual signature at `apps/api/src/services/encryptedColumnRegistry.ts:201` and adjust the call/cast if it differs.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run src/services/recoveryKeyEscrow.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/recoveryKeyEscrow.ts apps/api/src/services/recoveryKeyEscrow.test.ts
git commit -m "feat(api): recovery-key escrow service with supersede/dedupe semantics (#2021)"
```

---

### Task 3: Agent ingest route

**Files:**
- Create: `apps/api/src/routes/agents/recoveryKeys.ts`
- Modify: `apps/api/src/routes/agents/schemas.ts` (add `recoveryKeysIngestSchema` after `securityStatusIngestSchema`, ~line 315)
- Modify: `apps/api/src/routes/agents/index.ts` (import + mount after `agentSecurityRoutes`)
- Test: `apps/api/src/routes/agents/recoveryKeys.test.ts`

**Interfaces:**
- Consumes: `escrowRecoveryKeys` (Task 2), `requireAgentRole` middleware, `writeAuditEvent`.
- Produces: `PUT /api/v1/agents/:id/security/recovery-keys` accepting `{ source: 'snapshot'|'rotation', keys: [{ keyType, volumeMount?, protectorId?, recoveryKey }] }` → `{ success: true, stats }`. This is the endpoint the Go agent (Task 9) targets as `security/recovery-keys`.

- [ ] **Step 1: Write the failing route test**

`apps/api/src/routes/agents/recoveryKeys.test.ts` (mock style mirrors `apps/api/src/routes/security/scans.test.ts` — read it first):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', agentId: 'devices.agentId' },
}));

vi.mock('../../middleware/requireAgentRole', () => ({
  requireAgentRole: async (c: any, next: any) => {
    c.set('agent', { agentId: 'agent-1', orgId: '22222222-2222-4222-8222-222222222222', role: 'agent' });
    await next();
  },
}));

const { escrowMock, auditMock } = vi.hoisted(() => ({
  escrowMock: vi.fn(async () => ({ inserted: 1, superseded: 0, unchanged: 0 })),
  auditMock: vi.fn(),
}));

vi.mock('../../services/recoveryKeyEscrow', () => ({ escrowRecoveryKeys: escrowMock }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: auditMock }));

import { db } from '../../db';
import { agentRecoveryKeysRoutes } from './recoveryKeys';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '111111-222222-333333-444444-555555-666666-777777-888888';

function buildApp() {
  const app = new Hono();
  app.route('/', agentRecoveryKeysRoutes);
  return app;
}

function mockDeviceLookup(row: unknown) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  });
}

const validBody = {
  source: 'snapshot',
  keys: [{ keyType: 'bitlocker_recovery_password', volumeMount: 'C:', protectorId: 'p-1', recoveryKey: KEY }],
};

describe('PUT /:id/security/recovery-keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('escrows keys for the resolved device and audits counts only', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(escrowMock).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, 'snapshot', validBody.keys);
    const auditArg = auditMock.mock.calls[0][1];
    expect(JSON.stringify(auditArg)).not.toContain(KEY);
    expect(auditArg.action).toBe('agent.recovery_keys.submit');
  });

  it('404s when the agent id resolves to no device', async () => {
    mockDeviceLookup(null);
    const res = await buildApp().request('/nope/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect(escrowMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid keyType with 400', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'snapshot', keys: [{ keyType: 'luks', recoveryKey: KEY }] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing source with 400', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && pnpm exec vitest run src/routes/agents/recoveryKeys.test.ts
```

Expected: FAIL — `./recoveryKeys` not found.

- [ ] **Step 3: Implement schema + route + mount**

In `apps/api/src/routes/agents/schemas.ts`, after `SecurityStatusPayload` (~line 315):

```ts
export const recoveryKeysIngestSchema = z.object({
  source: z.enum(['snapshot', 'rotation']),
  keys: z.array(z.object({
    keyType: z.enum(['bitlocker_recovery_password', 'filevault_personal_recovery_key']),
    volumeMount: z.string().max(100).optional(),
    protectorId: z.string().max(100).optional(),
    recoveryKey: z.string().min(8).max(512)
  })).max(50)
});

export type RecoveryKeysIngestPayload = z.infer<typeof recoveryKeysIngestSchema>;
```

`apps/api/src/routes/agents/recoveryKeys.ts` (mirrors `apps/api/src/routes/agents/security.ts`):

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { recoveryKeysIngestSchema } from './schemas';
import { escrowRecoveryKeys } from '../../services/recoveryKeyEscrow';
import { requireAgentRole } from '../../middleware/requireAgentRole';

export const agentRecoveryKeysRoutes = new Hono();
// Recovery-key escrow is the main agent's job; reject watchdog-role tokens so
// a weaker credential can't plant or overwrite escrowed key material.
agentRecoveryKeysRoutes.use('*', requireAgentRole);

agentRecoveryKeysRoutes.put('/:id/security/recovery-keys', zValidator('json', recoveryKeysIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const stats = await escrowRecoveryKeys(device.id, device.orgId, payload.source, payload.keys);

  // Counts only — recovery-key material must never reach the audit trail.
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.recovery_keys.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      source: payload.source,
      inserted: stats.inserted,
      superseded: stats.superseded,
      unchanged: stats.unchanged,
    },
  });

  return c.json({ success: true, stats });
});
```

In `apps/api/src/routes/agents/index.ts`: add `import { agentRecoveryKeysRoutes } from './recoveryKeys';` near the other imports and `agentRoutes.route('/', agentRecoveryKeysRoutes);` directly after the `agentSecurityRoutes` mount (line ~67).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run src/routes/agents/recoveryKeys.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/recoveryKeys.ts apps/api/src/routes/agents/recoveryKeys.test.ts apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/index.ts
git commit -m "feat(api): agent recovery-key ingest route (#2021)"
```

---

### Task 4: Sensitive command payload handling (encrypt-at-rest, decrypt-at-delivery, clear-on-complete)

**Files:**
- Create: `apps/api/src/services/sensitiveCommandPayload.ts`
- Test: `apps/api/src/services/sensitiveCommandPayload.test.ts`
- Modify: `apps/api/src/services/commandQueue.ts` (add `CommandTypes` entries; decrypt in the two WS-dispatch sites)
- Modify: `apps/api/src/routes/agents/commands.ts` (decrypt in GET `/:id/commands` map; clear payload on completion)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (decrypt in the two `commands.map` sites)
- Modify: `apps/api/src/services/auditPayloadSanitizer.ts` (extend `SECRET_FIELD_PATTERN`)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `./secretCrypto`.
- Produces:
  - `hasSensitivePayload(type: string): boolean`
  - `encryptSensitivePayloadFields(type: string, payload: Record<string, unknown>): Record<string, unknown>`
  - `decryptSensitivePayloadFields(type: string, payload: unknown): unknown`
  - `CommandTypes.ENCRYPTION_ROTATE_KEY = 'encryption_rotate_key'`, `CommandTypes.ENCRYPTION_COLLECT_KEYS = 'encryption_collect_keys'` in `commandQueue.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/sensitiveCommandPayload.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';

process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-app-encryption-key-for-vitest';

import {
  encryptSensitivePayloadFields,
  decryptSensitivePayloadFields,
  hasSensitivePayload,
} from './sensitiveCommandPayload';

describe('sensitiveCommandPayload', () => {
  it('flags encryption_rotate_key as sensitive, others not', () => {
    expect(hasSensitivePayload('encryption_rotate_key')).toBe(true);
    expect(hasSensitivePayload('security_scan')).toBe(false);
  });

  it('round-trips password and currentRecoveryKey; leaves other fields alone', () => {
    const input = { username: 'jane', password: 'hunter2', currentRecoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', volumeMount: 'C:' };
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', input);
    expect(encrypted.username).toBe('jane');
    expect(encrypted.volumeMount).toBe('C:');
    expect(encrypted.password).not.toBe('hunter2');
    expect(String(encrypted.password)).toMatch(/^enc:/);
    expect(String(encrypted.currentRecoveryKey)).toMatch(/^enc:/);

    const decrypted = decryptSensitivePayloadFields('encryption_rotate_key', encrypted) as Record<string, unknown>;
    expect(decrypted.password).toBe('hunter2');
    expect(decrypted.currentRecoveryKey).toBe('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF');
  });

  it('is a passthrough for non-sensitive command types and non-object payloads', () => {
    const payload = { password: 'plaintext-untouched' };
    expect(encryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('security_scan', payload)).toBe(payload);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', null)).toBe(null);
    expect(decryptSensitivePayloadFields('encryption_rotate_key', 'str')).toBe('str');
  });

  it('skips absent/non-string sensitive fields', () => {
    const encrypted = encryptSensitivePayloadFields('encryption_rotate_key', { volumeMount: 'C:' });
    expect(encrypted).toEqual({ volumeMount: 'C:' });
  });
});
```

Note: if `secretCrypto` requires more env in test mode, check how existing `secretCrypto`-touching tests set up env (grep `APP_ENCRYPTION_KEY` under `apps/api/src`) and copy that.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && pnpm exec vitest run src/services/sensitiveCommandPayload.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service + CommandTypes constants**

`apps/api/src/services/sensitiveCommandPayload.ts`:

```ts
import { decryptSecret, encryptSecret } from './secretCrypto';

// device_commands is intentionally system-scoped (no RLS) and its payload
// column is plaintext JSONB. Commands whose payload carries credentials are
// listed here: the enqueue route encrypts these fields, the delivery paths
// (WS dispatch + heartbeat poll) decrypt them just-in-time, and the result
// route clears the payload once the command reaches a terminal state.
const AAD = 'device_commands.payload';

const SENSITIVE_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  encryption_rotate_key: ['password', 'currentRecoveryKey'],
};

export function hasSensitivePayload(type: string): boolean {
  return type in SENSITIVE_PAYLOAD_FIELDS;
}

export function encryptSensitivePayloadFields(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  if (!fields) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = encryptSecret(value, { aad: AAD });
    }
  }
  return out;
}

export function decryptSensitivePayloadFields(type: string, payload: unknown): unknown {
  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value) {
      out[field] = decryptSecret(value, { aad: AAD });
    }
  }
  return out;
}
```

In `apps/api/src/services/commandQueue.ts`, add to the `CommandTypes` object (line ~35, near `SECURITY_SCAN`):

```ts
  ENCRYPTION_COLLECT_KEYS: 'encryption_collect_keys',
  ENCRYPTION_ROTATE_KEY: 'encryption_rotate_key',
```

- [ ] **Step 4: Hook decrypt-at-delivery (4 sites) and clear-on-complete (1 site)**

Add `import { decryptSensitivePayloadFields, hasSensitivePayload } from '<relative>/sensitiveCommandPayload';` to each file below.

1. `apps/api/src/services/commandQueue.ts` — in `queueCommandForExecution` (~line 543) change the `sendCommandToAgent` call:
```ts
      const sent = sendCommandToAgent(device.agentId, {
        id: command.id,
        type,
        payload: decryptSensitivePayloadFields(type, payload)
      });
```
2. `apps/api/src/services/commandQueue.ts` — in `executeCommand` (~line 791), same change inside the retry loop's `sendCommandToAgent` call.
3. `apps/api/src/routes/agents/commands.ts` — GET `/:id/commands` (~line 126):
```ts
  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: decryptSensitivePayloadFields(cmd.type, cmd.payload),
    })),
  });
```
4. `apps/api/src/routes/agents/heartbeat.ts` — both `commands.map` sites (~line 364 watchdog branch and ~line 828 main branch): replace `payload: cmd.payload` with `payload: decryptSensitivePayloadFields(cmd.type, cmd.payload)`.

Clear-on-complete — `apps/api/src/routes/agents/commands.ts` result route `.set({...})` (~line 237):
```ts
        .set({
          status: normalizedData.status === 'completed' ? 'completed' : 'failed',
          completedAt: new Date(),
          result: buildStoredCommandResult(normalizedData, stdout),
          // Credentials ride the payload for some commands (e.g. FileVault
          // rotation); blank them once the command is terminal.
          ...(hasSensitivePayload(command.type) ? { payload: null } : {}),
        })
```

Audit sanitizer — in `apps/api/src/services/auditPayloadSanitizer.ts` line 7, extend the pattern alternation with `|(current[_-]?)?recovery[_-]?key` so `recoveryKey`/`currentRecoveryKey` field names are redacted anywhere they appear in audit details:
```ts
const SECRET_FIELD_PATTERN = /^(password|passwd|pwd|token|secret|authorization|cookie|credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase|(current[_-]?)?recovery[_-]?key)$/i;
```

- [ ] **Step 5: Run tests + affected suites**

```bash
cd apps/api && pnpm exec vitest run src/services/sensitiveCommandPayload.test.ts src/routes/agents src/services/commandQueue.test.ts 2>/dev/null || pnpm exec vitest run src/services/sensitiveCommandPayload.test.ts src/routes/agents
```

Expected: new tests PASS; existing agents-route and commandQueue tests still PASS (the decrypt call is a passthrough for non-sensitive types). Fix any test that mocks these files' imports.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/sensitiveCommandPayload.ts apps/api/src/services/sensitiveCommandPayload.test.ts apps/api/src/services/commandQueue.ts apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/services/auditPayloadSanitizer.ts
git commit -m "feat(api): encrypted command payloads with decrypt-at-delivery + clear-on-complete (#2021)"
```

---

### Task 5: Tech-facing routes — list, reveal, rotate, collect

**Files:**
- Create: `apps/api/src/routes/security/recoveryKeys.ts`
- Modify: `apps/api/src/routes/security/schemas.ts` (param/body schemas)
- Modify: `apps/api/src/routes/security/index.ts` (mount)
- Modify: `apps/api/src/routes/devices/events.ts` (`actionLabels` entries)
- Test: `apps/api/src/routes/security/recoveryKeys.test.ts`

**Interfaces:**
- Consumes: schema tables (Task 1), `decryptForColumn` from `../../services/secretCrypto`, `writeRouteAudit`, `CommandTypes`/`queueCommand`, `encryptSensitivePayloadFields` (Task 4).
- Produces (consumed by web Tasks 10-11):
  - `GET /security/encryption/devices/:deviceId/recovery-keys` → `{ data: { device: { id, hostname, os }, keys: KeyMeta[], accessHistory: AccessEvent[] } }` where `KeyMeta = { id, keyType, volumeMount, protectorId, status, escrowedAt, supersededAt }` and `AccessEvent = { id, keyId, userEmail, action, createdAt }`. Never key material.
  - `POST .../recovery-keys/:keyId/reveal` → `{ data: { id, keyType, volumeMount, status, recoveryKey } }`
  - `POST .../recovery-keys/rotate` body `{ volumeMount?, username?, password?, currentRecoveryKey? }` → 202 `{ data: { commandId, status: 'queued' } }`
  - `POST .../recovery-keys/collect` → 202 `{ data: { commandId, status: 'queued' } }`

- [ ] **Step 1: Write the failing route tests**

`apps/api/src/routes/security/recoveryKeys.test.ts` — copy the harness style from `apps/api/src/routes/security/scans.test.ts` (auth injection with `orgCondition: () => undefined`, `getUserPermissions` hoisted mock, real `requirePermission` via `vi.importActual`). Cover:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', hostname: 'devices.hostname', osType: 'devices.osType' },
  deviceRecoveryKeys: {
    id: 'drk.id', deviceId: 'drk.deviceId', orgId: 'drk.orgId', keyType: 'drk.keyType',
    volumeMount: 'drk.volumeMount', protectorId: 'drk.protectorId', encryptedKey: 'drk.encryptedKey',
    status: 'drk.status', escrowedAt: 'drk.escrowedAt', supersededAt: 'drk.supersededAt',
  },
  recoveryKeyAccessEvents: {
    id: 'rkae.id', keyId: 'rkae.keyId', deviceId: 'rkae.deviceId', orgId: 'rkae.orgId',
    userId: 'rkae.userId', userEmail: 'rkae.userEmail', action: 'rkae.action', createdAt: 'rkae.createdAt',
  },
}));

const { getUserPermissionsMock, writeRouteAuditMock, queueCommandMock, decryptForColumnMock, encryptFieldsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  queueCommandMock: vi.fn(async () => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })),
  decryptForColumnMock: vi.fn(() => '111111-222222-333333-444444-555555-666666-777777-888888'),
  encryptFieldsMock: vi.fn((_t: string, p: Record<string, unknown>) => ({ ...p, __encrypted: true })),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { ENCRYPTION_ROTATE_KEY: 'encryption_rotate_key', ENCRYPTION_COLLECT_KEYS: 'encryption_collect_keys' },
  queueCommand: queueCommandMock,
}));
vi.mock('../../services/secretCrypto', () => ({ decryptForColumn: decryptForColumnMock }));
vi.mock('../../services/sensitiveCommandPayload', () => ({ encryptSensitivePayloadFields: encryptFieldsMock }));

import { db } from '../../db';
import { recoveryKeysRoutes } from './recoveryKeys';
```

Then a `buildApp()` that injects auth (copy `scans.test.ts`, permission `devices: ['read','execute']`) and tests:

1. **list** returns key metadata + access history and the serialized response contains neither `encryptedKey` nor plaintext key.
2. **reveal** happy path: 200, body `data.recoveryKey` equals the decrypted value, `db.insert` called on `recoveryKeyAccessEvents` values containing `userId`/`userEmail`, `writeRouteAuditMock` called with action `device.recovery_key.reveal` and `JSON.stringify(details)` NOT containing the plaintext key.
3. **reveal** 404 when key id not found for device.
4. **site-scope denial**: `getUserPermissionsMock` returns `{ allowedSiteIds: ['other-site'] }`, device has `siteId: 'site-1'` → 403 for list and reveal.
5. **rotate windows**: device `osType: 'windows'` → 202, `queueCommandMock` called with type `encryption_rotate_key` and payload `{ volumeMount: 'C:' }` (default), audit `device.recovery_key.rotate`.
6. **rotate macos without creds** → 400, queueCommand NOT called.
7. **rotate macos with creds** → payload passed to queueCommand has `__encrypted: true` (proving it went through `encryptSensitivePayloadFields`) and audit details contain no `password`.
8. **rotate linux** → 400.
9. **collect** → 202 queues `encryption_collect_keys`.

Prime `db.select` per call with `mockReturnValueOnce` chains: device lookup uses `.from().where().limit()`; key list uses `.from().where().orderBy().limit()`; access events use `.from().where().orderBy().limit()`; reveal key lookup uses `.from().where().limit()`. `db.insert` returns `{ values: vi.fn().mockResolvedValue(undefined) }`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && pnpm exec vitest run src/routes/security/recoveryKeys.test.ts
```

Expected: FAIL — `./recoveryKeys` not found.

- [ ] **Step 3: Add schemas**

In `apps/api/src/routes/security/schemas.ts` (near `deviceIdParamSchema`; note Zod 4 `.guid()`):

```ts
export const recoveryKeyRevealParamSchema = z.object({
  deviceId: z.string().guid(),
  keyId: z.string().guid()
});

export const rotateRecoveryKeySchema = z.object({
  volumeMount: z.string().regex(/^[A-Za-z]:$/).optional(),
  username: z.string().min(1).max(255).optional(),
  password: z.string().min(1).max(1024).optional(),
  currentRecoveryKey: z.string().min(8).max(128).optional()
});
```

- [ ] **Step 4: Implement the routes**

`apps/api/src/routes/security/recoveryKeys.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from '../../db';
import { devices, deviceRecoveryKeys, recoveryKeyAccessEvents } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import { decryptForColumn } from '../../services/secretCrypto';
import { writeRouteAudit } from '../../services/auditEvents';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import { encryptSensitivePayloadFields } from '../../services/sensitiveCommandPayload';
import { deviceIdParamSchema, recoveryKeyRevealParamSchema, rotateRecoveryKeySchema } from './schemas';

/**
 * Site-scope gate: partner-scope users restricted via `allowedSiteIds` must
 * not see/touch a device in a site they cannot access. RLS does not defend
 * the site axis — mirrors security/scans.ts (PR #864/#868).
 */
async function canAccessDeviceSite(
  c: Context,
  auth: Pick<AuthContext, 'user' | 'partnerId' | 'orgId'>,
  deviceSiteId: string | null,
): Promise<boolean> {
  let userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    const fetched = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    userPerms = fetched || undefined;
  }
  if (!userPerms?.allowedSiteIds) return true;
  if (typeof deviceSiteId !== 'string') return false;
  return canAccessSite(userPerms, deviceSiteId);
}

async function loadAccessibleDevice(c: Context, deviceId: string) {
  const auth = c.get('auth');
  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(devices.id, deviceId)];
  if (orgCondition) conditions.push(orgCondition);
  const [device] = await db
    .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId, siteId: devices.siteId, osType: devices.osType })
    .from(devices)
    .where(and(...conditions))
    .limit(1);
  if (!device) return { device: null as null, denied: c.json({ error: 'Device not found' }, 404) };
  if (!(await canAccessDeviceSite(c, auth, device.siteId))) {
    return { device: null as null, denied: c.json({ error: 'Access to this site denied' }, 403) };
  }
  return { device, denied: null as null };
}

export const recoveryKeysRoutes = new Hono();

// Key metadata + reveal ledger. NEVER returns key material.
recoveryKeysRoutes.get(
  '/encryption/devices/:deviceId/recovery-keys',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const keys = await db
      .select({
        id: deviceRecoveryKeys.id,
        keyType: deviceRecoveryKeys.keyType,
        volumeMount: deviceRecoveryKeys.volumeMount,
        protectorId: deviceRecoveryKeys.protectorId,
        status: deviceRecoveryKeys.status,
        escrowedAt: deviceRecoveryKeys.escrowedAt,
        supersededAt: deviceRecoveryKeys.supersededAt,
      })
      .from(deviceRecoveryKeys)
      .where(eq(deviceRecoveryKeys.deviceId, deviceId))
      .orderBy(desc(deviceRecoveryKeys.escrowedAt))
      .limit(50);

    const keyIds = keys.map((k) => k.id);
    const accessHistory = keyIds.length
      ? await db
          .select({
            id: recoveryKeyAccessEvents.id,
            keyId: recoveryKeyAccessEvents.keyId,
            userEmail: recoveryKeyAccessEvents.userEmail,
            action: recoveryKeyAccessEvents.action,
            createdAt: recoveryKeyAccessEvents.createdAt,
          })
          .from(recoveryKeyAccessEvents)
          .where(inArray(recoveryKeyAccessEvents.keyId, keyIds))
          .orderBy(desc(recoveryKeyAccessEvents.createdAt))
          .limit(25)
      : [];

    return c.json({
      data: {
        device: { id: device.id, hostname: device.hostname, os: device.osType },
        keys,
        accessHistory,
      },
    });
  }
);

// Audited fetch-on-demand reveal: ledger row + route audit; plaintext returned once.
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/:keyId/reveal',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', recoveryKeyRevealParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId, keyId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const [key] = await db
      .select()
      .from(deviceRecoveryKeys)
      .where(and(eq(deviceRecoveryKeys.id, keyId), eq(deviceRecoveryKeys.deviceId, deviceId)))
      .limit(1);
    if (!key) return c.json({ error: 'Recovery key not found' }, 404);

    let plaintext: string | null;
    try {
      plaintext = decryptForColumn('device_recovery_keys', 'encrypted_key', key.encryptedKey);
    } catch (err) {
      console.error('[security] recovery key decrypt failed:', { keyId, error: err });
      return c.json({ error: 'Failed to decrypt recovery key — check APP_ENCRYPTION_KEY configuration' }, 500);
    }
    if (!plaintext) return c.json({ error: 'Recovery key material is empty' }, 500);

    await db.insert(recoveryKeyAccessEvents).values({
      keyId: key.id,
      deviceId,
      orgId: key.orgId,
      userId: auth.user.id,
      userEmail: auth.user.email ?? '',
      action: 'revealed',
    });

    // Audit records who/when/which key — NEVER the key itself.
    writeRouteAudit(c, {
      orgId: key.orgId,
      action: 'device.recovery_key.reveal',
      resourceType: 'device',
      resourceId: deviceId,
      details: { keyId: key.id, keyType: key.keyType, volumeMount: key.volumeMount, keyStatus: key.status },
    });

    return c.json({
      data: { id: key.id, keyType: key.keyType, volumeMount: key.volumeMount, status: key.status, recoveryKey: plaintext },
    });
  }
);

// Rotate: Windows needs nothing (defaults volumeMount C:); macOS needs a
// FileVault user's credentials or the current recovery key (encrypted into
// the command payload; see sensitiveCommandPayload.ts).
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', rotateRecoveryKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const os = (device.osType ?? '').toLowerCase();
    let payload: Record<string, unknown>;
    if (os === 'windows') {
      payload = { volumeMount: body.volumeMount ?? 'C:' };
    } else if (os === 'macos' || os === 'darwin') {
      const hasCreds = (body.username && body.password) || body.currentRecoveryKey;
      if (!hasCreds) {
        return c.json({ error: "FileVault rotation requires a FileVault-enabled user's username and password, or the current recovery key" }, 400);
      }
      const raw: Record<string, unknown> = {};
      if (body.username) raw.username = body.username;
      if (body.password) raw.password = body.password;
      if (body.currentRecoveryKey) raw.currentRecoveryKey = body.currentRecoveryKey;
      payload = encryptSensitivePayloadFields(CommandTypes.ENCRYPTION_ROTATE_KEY, raw);
    } else {
      return c.json({ error: `Recovery key rotation is not supported on ${device.osType}` }, 400);
    }

    const command = await queueCommand(device.id, CommandTypes.ENCRYPTION_ROTATE_KEY, payload, auth.user.id);

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.recovery_key.rotate',
      resourceType: 'device',
      resourceId: deviceId,
      details: { os, volumeMount: os === 'windows' ? (body.volumeMount ?? 'C:') : null },
    });

    return c.json({ data: { commandId: command.id, status: 'queued' } }, 202);
  }
);

// On-demand re-collect (Windows snapshot refresh).
recoveryKeysRoutes.post(
  '/encryption/devices/:deviceId/recovery-keys/collect',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const { device, denied } = await loadAccessibleDevice(c, deviceId);
    if (!device) return denied;

    const command = await queueCommand(device.id, CommandTypes.ENCRYPTION_COLLECT_KEYS, {}, auth.user.id);
    return c.json({ data: { commandId: command.id, status: 'queued' } }, 202);
  }
);
```

Check `writeRouteAudit`'s `RouteAuditInput` shape in `apps/api/src/services/auditEvents.ts:126` and match required fields (compare with the call in `apps/api/src/routes/devices/actuateElevation.ts:274`).

Mount in `apps/api/src/routes/security/index.ts`: `import { recoveryKeysRoutes } from './recoveryKeys';` + `securityRoutes.route('/', recoveryKeysRoutes);` after the `complianceRoutes` line.

Add to `actionLabels` in `apps/api/src/routes/devices/events.ts` (~line 296):

```ts
  'device.recovery_key.reveal': 'Recovery key revealed',
  'device.recovery_key.rotate': 'Recovery key rotation requested',
  'agent.recovery_keys.submit': 'Recovery keys escrowed',
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && pnpm exec vitest run src/routes/security/recoveryKeys.test.ts
```

Expected: PASS (~10 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/security/recoveryKeys.ts apps/api/src/routes/security/recoveryKeys.test.ts apps/api/src/routes/security/schemas.ts apps/api/src/routes/security/index.ts apps/api/src/routes/devices/events.ts
git commit -m "feat(api): audited recovery-key list/reveal/rotate/collect routes (#2021)"
```

---

### Task 6: Real escrow status + real volumes in the fleet encryption endpoint

**Files:**
- Modify: `apps/api/src/routes/security/helpers.ts` (add `parseEncryptionVolumes`)
- Modify: `apps/api/src/routes/security/compliance.ts` (`GET /encryption`, lines 118-191)
- Modify: `apps/api/src/routes/security/schemas.ts` (`encryptionQuerySchema` escrow filter, line 247)
- Test: `apps/api/src/routes/security/compliance.test.ts` (create — none exists today)

**Interfaces:**
- Consumes: `deviceRecoveryKeys` (Task 1), existing `listStatusRows`/`toStatusResponse`/`normalizeEncryption`.
- Produces: `/security/encryption` response where `recoveryKeyEscrowed` is real, `volumes` items are `{ drive, encrypted, method, status: string|null, percentEncrypted: number|null }` (the `size` field is REMOVED — Task 11 updates the UI in the same PR), and query accepts `escrow=escrowed|missing`. `summary` gains `recoveryKeysEscrowed: number`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/security/compliance.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: { selectDistinct: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  deviceRecoveryKeys: { deviceId: 'drk.deviceId', status: 'drk.status' },
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

const { listStatusRowsMock } = vi.hoisted(() => ({ listStatusRowsMock: vi.fn() }));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<any>('./helpers');
  return { ...actual, listStatusRows: listStatusRowsMock };
});

vi.mock('../../services/securityPosture', () => ({ getSecurityPostureTrend: vi.fn(async () => []) }));

import { db } from '../../db';
import { complianceRoutes } from './compliance';

const DEV_ESCROWED = '11111111-1111-4111-8111-111111111111';
const DEV_BARE = '22222222-2222-4222-8222-222222222222';

// Full StatusRow shape consumed by toStatusResponse — copy field defaults
// from listStatusRows' mapping in helpers.ts:234.
function statusRow(overrides: Record<string, unknown>) {
  return {
    deviceId: DEV_BARE, orgId: '33333333-3333-4333-8333-333333333333',
    deviceName: 'pc', os: 'windows', deviceState: 'online',
    provider: 'windows_defender', providerVersion: null, definitionsVersion: null,
    definitionsDate: null, realTimeProtection: true, threatCount: 0,
    firewallEnabled: true, encryptionStatus: 'encrypted', encryptionDetails: null,
    localAdminSummary: null, passwordPolicySummary: null, gatekeeperEnabled: null,
    lastScan: null, lastScanType: null,
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: null, partnerId: null,
      accessibleOrgIds: [], user: { id: 'u' },
      orgCondition: () => undefined, canAccessOrg: () => true,
    });
    await next();
  });
  app.route('/', complianceRoutes);
  return app;
}

function mockEscrowRows(deviceIds: string[]) {
  (db.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deviceIds.map((deviceId) => ({ deviceId }))) }),
  });
}

describe('GET /encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports real escrow status, not the old heuristic', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'has-key' }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'no-key' }),
    ]);
    mockEscrowRows([DEV_ESCROWED]);
    const res = await buildApp().request('/encryption');
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));
    expect(byName['has-key'].recoveryKeyEscrowed).toBe(true);
    expect(byName['no-key'].recoveryKeyEscrowed).toBe(false); // encrypted windows, old heuristic said true
    expect(json.summary.recoveryKeysEscrowed).toBe(1);
  });

  it('escrow=missing filters to devices without active keys', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'has-key' }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'no-key' }),
    ]);
    mockEscrowRows([DEV_ESCROWED]);
    const res = await buildApp().request('/encryption?escrow=missing');
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].deviceName).toBe('no-key');
  });

  it('uses real agent-reported volumes when present, synthesized fallback otherwise', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({
        deviceId: DEV_ESCROWED, deviceName: 'real-vols',
        encryptionDetails: { source: 'bitlocker', volumes: [{ mount: 'C:', method: 'xtsaes128', protected: true, status: 'FullyEncrypted', percentEncrypted: 100 }] },
      }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'fallback' }),
    ]);
    mockEscrowRows([]);
    const res = await buildApp().request('/encryption');
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));
    expect(byName['real-vols'].volumes[0]).toEqual({ drive: 'C:', encrypted: true, method: 'xtsaes128', status: 'FullyEncrypted', percentEncrypted: 100 });
    expect(byName['fallback'].volumes[0].drive).toBe('C:');
    expect(byName['fallback'].volumes[0].status).toBeNull();
    expect(byName['fallback'].volumes[0]).not.toHaveProperty('size');
  });
});
```

Adjust the mocked auth object to whatever fields `requireScope`-less compliance handlers actually read (`auth.orgId`, `auth.accessibleOrgIds`, `auth.orgCondition`, `auth.canAccessOrg` — see `listStatusRows`). Note `compliance.ts` also mounts `/trends` etc.; only `/encryption` is exercised.

Also add unit tests for `parseEncryptionVolumes` in the existing `apps/api/src/routes/security/helpers.test.ts`:

```ts
describe('parseEncryptionVolumes', () => {
  it('returns null for null/undefined/malformed', () => {
    expect(parseEncryptionVolumes(null)).toBeNull();
    expect(parseEncryptionVolumes(undefined)).toBeNull();
    expect(parseEncryptionVolumes({ source: 'bitlocker' })).toBeNull();
    expect(parseEncryptionVolumes({ volumes: 'nope' })).toBeNull();
  });

  it('maps well-formed volumes and skips junk entries', () => {
    const result = parseEncryptionVolumes({
      source: 'bitlocker',
      volumes: [
        { mount: 'C:', method: 'xtsaes128', protected: true, status: 'FullyEncrypted', percentEncrypted: 100 },
        'junk',
        { mount: 'D:', protected: false },
      ],
    });
    expect(result).toEqual([
      { drive: 'C:', encrypted: true, method: 'xtsaes128', status: 'FullyEncrypted', percentEncrypted: 100 },
      { drive: 'D:', encrypted: false, method: 'unknown', status: null, percentEncrypted: null },
    ]);
  });
});
```

(add `parseEncryptionVolumes` to that file's existing `./helpers` import).

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && pnpm exec vitest run src/routes/security/compliance.test.ts src/routes/security/helpers.test.ts
```

Expected: FAIL — `parseEncryptionVolumes` not exported; compliance behavior mismatches.

- [ ] **Step 3: Implement**

Add to `apps/api/src/routes/security/helpers.ts` (near the other `to*` coercers, using the existing `toObject`/`toBoolean`/`toNumber`/`toStringValue` helpers in that file):

```ts
export type EncryptionVolume = {
  drive: string;
  encrypted: boolean;
  method: string;
  status: string | null;
  percentEncrypted: number | null;
};

// Agent-reported per-volume encryption detail (security_status.encryption_details,
// shape {source, volumes:[{mount, method, protected, status, percentEncrypted}]}).
// Returns null when absent/malformed so callers can fall back to a synthesized row.
export function parseEncryptionVolumes(details: unknown): EncryptionVolume[] | null {
  const obj = toObject(details);
  if (!obj || !Array.isArray(obj.volumes)) return null;
  const volumes: EncryptionVolume[] = [];
  for (const raw of obj.volumes) {
    const vol = toObject(raw);
    if (!vol) continue;
    volumes.push({
      drive: toStringValue(vol.mount) ?? '-',
      encrypted: toBoolean(vol.protected) ?? false,
      method: toStringValue(vol.method) ?? 'unknown',
      status: toStringValue(vol.status),
      percentEncrypted: toNumber(vol.percentEncrypted),
    });
  }
  return volumes.length > 0 ? volumes : null;
}
```

In `apps/api/src/routes/security/schemas.ts` add to `encryptionQuerySchema` (line 247):

```ts
  escrow: z.enum(['escrowed', 'missing']).optional(),
```

Rewrite the `GET /encryption` handler body in `apps/api/src/routes/security/compliance.ts` (add imports `db` from `'../../db'`, `deviceRecoveryKeys` from `'../../db/schema'`, `eq` from `'drizzle-orm'`, and `parseEncryptionVolumes` from `'./helpers'`):

```ts
    const rows = await listStatusRows(auth, query.orgId);
    const statuses = rows.map(toStatusResponse);

    // Real escrow status: devices with at least one active escrowed key.
    // RLS + listStatusRows both scope to accessible orgs.
    const escrowRows = await db
      .selectDistinct({ deviceId: deviceRecoveryKeys.deviceId })
      .from(deviceRecoveryKeys)
      .where(eq(deviceRecoveryKeys.status, 'active'));
    const escrowedDeviceIds = new Set(escrowRows.map((r) => r.deviceId));

    const methodByOs: Record<'windows' | 'macos' | 'linux', string> = {
      windows: 'bitlocker',
      macos: 'filevault',
      linux: 'luks'
    };

    let devicesData = rows.map((row) => {
      const status = toStatusResponse(row);
      const encStatus = status.encryptionStatus;
      const method = encStatus === 'unencrypted' ? 'none' : methodByOs[status.os];
      const fallbackVolume = {
        drive: status.os === 'windows' ? 'C:' : status.os === 'macos' ? 'Macintosh HD' : '/dev/sda1',
        encrypted: encStatus !== 'unencrypted',
        method: method === 'bitlocker' ? 'BitLocker' : method === 'filevault' ? 'FileVault' : method === 'luks' ? 'LUKS2' : 'None',
        status: null as string | null,
        percentEncrypted: null as number | null
      };

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        encryptionMethod: method,
        encryptionStatus: encStatus,
        volumes: parseEncryptionVolumes(row.encryptionDetails) ?? [fallbackVolume],
        tpmPresent: status.os === 'windows',
        recoveryKeyEscrowed: escrowedDeviceIds.has(status.deviceId)
      };
    });

    if (query.status) {
      devicesData = devicesData.filter((device) => device.encryptionStatus === query.status);
    }
    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }
    if (query.escrow) {
      const wantEscrowed = query.escrow === 'escrowed';
      devicesData = devicesData.filter((device) => device.recoveryKeyEscrowed === wantEscrowed);
    }
    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }
```

Keep the existing summary block, adding one field:

```ts
        recoveryKeysEscrowed: rows.filter((row) => escrowedDeviceIds.has(row.deviceId)).length,
```

(inside `summary`, after `unencrypted`). `tpmPresent` stays heuristic — out of scope per spec.

- [ ] **Step 4: Run tests**

```bash
cd apps/api && pnpm exec vitest run src/routes/security/compliance.test.ts src/routes/security/helpers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/security/compliance.ts apps/api/src/routes/security/compliance.test.ts apps/api/src/routes/security/helpers.ts apps/api/src/routes/security/helpers.test.ts apps/api/src/routes/security/schemas.ts
git commit -m "feat(api): real recovery-key escrow status + real volumes in fleet encryption endpoint (#2021)"
```

---

### Task 7: Go agent — BitLocker key collector, parsers, fingerprint

**Files:**
- Create: `agent/internal/security/recoverykeys.go`
- Test: `agent/internal/security/recoverykeys_test.go`

**Interfaces:**
- Consumes: package-private helpers already in `agent/internal/security/status.go`: `runCommand(timeout, name, args...)`, `parseJSONValue(output)`, `toObjectSlice(v)`, `stringFromAny(v)`.
- Produces (consumed by Tasks 8-9):
  - `type RecoveryKey struct { Mount string \`json:"volumeMount,omitempty"\`; ProtectorID string \`json:"protectorId,omitempty"\`; KeyType string \`json:"keyType"\`; Key string \`json:"recoveryKey"\` }`
  - `const KeyTypeBitLocker = "bitlocker_recovery_password"`, `const KeyTypeFileVault = "filevault_personal_recovery_key"`
  - `CollectRecoveryKeys() ([]RecoveryKey, error)` — nil,nil on non-Windows
  - `FingerprintRecoveryKeys(keys []RecoveryKey) string` — "" for empty
  - (unexported, testable) `parseBitLockerRecoveryKeys(output string) ([]RecoveryKey, error)`

- [ ] **Step 1: Write the failing tests**

`agent/internal/security/recoverykeys_test.go`:

```go
package security

import (
	"strings"
	"testing"
)

func TestParseBitLockerRecoveryKeys(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		want    int
		wantErr bool
		check   func(t *testing.T, keys []RecoveryKey)
	}{
		{
			name:   "two volumes",
			output: `[{"Mount":"C:","ProtectorId":"{11111111-1111-1111-1111-111111111111}","RecoveryPassword":"111111-222222-333333-444444-555555-666666-777777-888888"},{"Mount":"D:","ProtectorId":"{22222222-2222-2222-2222-222222222222}","RecoveryPassword":"999999-888888-777777-666666-555555-444444-333333-222222"}]`,
			want:   2,
			check: func(t *testing.T, keys []RecoveryKey) {
				if keys[0].Mount != "C:" {
					t.Errorf("mount = %q, want C:", keys[0].Mount)
				}
				if keys[0].ProtectorID != "11111111-1111-1111-1111-111111111111" {
					t.Errorf("protector braces not stripped: %q", keys[0].ProtectorID)
				}
				if keys[0].KeyType != KeyTypeBitLocker {
					t.Errorf("keyType = %q", keys[0].KeyType)
				}
			},
		},
		{
			name:   "PS 5.1 single object collapse",
			output: `{"Mount":"C:","ProtectorId":"{11111111-1111-1111-1111-111111111111}","RecoveryPassword":"111111-222222-333333-444444-555555-666666-777777-888888"}`,
			want:   1,
		},
		{name: "empty array", output: `[]`, want: 0},
		{name: "empty output", output: ``, want: 0},
		{name: "entry without password skipped", output: `[{"Mount":"C:","ProtectorId":"{x}","RecoveryPassword":""}]`, want: 0},
		{name: "malformed json", output: `not-json{`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			keys, err := parseBitLockerRecoveryKeys(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if len(keys) != tt.want {
				t.Fatalf("len = %d, want %d", len(keys), tt.want)
			}
			if tt.check != nil {
				tt.check(t, keys)
			}
		})
	}
}

func TestFingerprintRecoveryKeys(t *testing.T) {
	a := RecoveryKey{Mount: "C:", ProtectorID: "p1", KeyType: KeyTypeBitLocker, Key: "key-one"}
	b := RecoveryKey{Mount: "D:", ProtectorID: "p2", KeyType: KeyTypeBitLocker, Key: "key-two"}

	if got := FingerprintRecoveryKeys(nil); got != "" {
		t.Errorf("empty fingerprint = %q, want empty string", got)
	}
	fp1 := FingerprintRecoveryKeys([]RecoveryKey{a, b})
	fp2 := FingerprintRecoveryKeys([]RecoveryKey{b, a})
	if fp1 != fp2 {
		t.Error("fingerprint must be order-insensitive")
	}
	changed := RecoveryKey{Mount: "C:", ProtectorID: "p1", KeyType: KeyTypeBitLocker, Key: "key-changed"}
	if FingerprintRecoveryKeys([]RecoveryKey{changed, b}) == fp1 {
		t.Error("fingerprint must change when a key changes")
	}
	if strings.Contains(fp1, "key-one") {
		t.Error("fingerprint must not embed key material")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && go test -race ./internal/security/ -run 'TestParseBitLockerRecoveryKeys|TestFingerprintRecoveryKeys'
```

Expected: FAIL — undefined symbols.

- [ ] **Step 3: Implement**

`agent/internal/security/recoverykeys.go`:

```go
package security

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"
)

// RecoveryKey is one escrowable disk-encryption recovery key. JSON tags match
// the API ingest schema (apps/api/src/routes/agents/schemas.ts
// recoveryKeysIngestSchema). Key material must never be logged.
type RecoveryKey struct {
	Mount       string `json:"volumeMount,omitempty"`
	ProtectorID string `json:"protectorId,omitempty"`
	KeyType     string `json:"keyType"`
	Key         string `json:"recoveryKey"`
}

const (
	KeyTypeBitLocker = "bitlocker_recovery_password"
	KeyTypeFileVault = "filevault_personal_recovery_key"
)

// @() forces an array even for a single protector (PowerShell 5.1 collapses
// one-element pipelines to a bare object otherwise); the parser still handles
// a bare object defensively.
const bitlockerKeyProtectorPS = `$r = Get-BitLockerVolume | ForEach-Object { $mp = $_.MountPoint; $_.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' } | ForEach-Object { [PSCustomObject]@{ Mount = $mp; ProtectorId = "$($_.KeyProtectorId)"; RecoveryPassword = $_.RecoveryPassword } } }; if ($null -eq $r) { '[]' } else { ConvertTo-Json -InputObject @($r) -Compress }`

// CollectRecoveryKeys reads all BitLocker recovery-password protectors.
// Windows only; other platforms return (nil, nil) — FileVault keys cannot be
// read after enablement and are escrowed via the rotate command instead.
func CollectRecoveryKeys() ([]RecoveryKey, error) {
	if runtime.GOOS != "windows" {
		return nil, nil
	}
	output, err := runCommand(
		20*time.Second,
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		bitlockerKeyProtectorPS,
	)
	if err != nil {
		return nil, fmt.Errorf("bitlocker key protector query failed: %w", err)
	}
	return parseBitLockerRecoveryKeys(output)
}

func parseBitLockerRecoveryKeys(output string) ([]RecoveryKey, error) {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil, nil
	}
	parsed, err := parseJSONValue(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse bitlocker key protector output: %w", err)
	}
	keys := make([]RecoveryKey, 0)
	for _, item := range toObjectSlice(parsed) {
		mount, _ := stringFromAny(item["Mount"])
		protectorID, _ := stringFromAny(item["ProtectorId"])
		password, _ := stringFromAny(item["RecoveryPassword"])
		if password == "" {
			continue
		}
		keys = append(keys, RecoveryKey{
			Mount:       strings.ToUpper(strings.TrimSpace(mount)),
			ProtectorID: strings.Trim(strings.TrimSpace(protectorID), "{}"),
			KeyType:     KeyTypeBitLocker,
			Key:         password,
		})
	}
	return keys, nil
}

// FingerprintRecoveryKeys returns a stable, order-insensitive digest of a key
// set. Used to gate transmission: only send when the set changed. Empty set →
// "" (matches the "never sent" initial state, so agents with no keys stay quiet).
func FingerprintRecoveryKeys(keys []RecoveryKey) string {
	if len(keys) == 0 {
		return ""
	}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		sum := sha256.Sum256([]byte(k.Key))
		parts = append(parts, k.KeyType+"|"+strings.ToUpper(k.Mount)+"|"+k.ProtectorID+"|"+hex.EncodeToString(sum[:]))
	}
	sort.Strings(parts)
	total := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(total[:])
}
```

If `parseJSONValue`/`toObjectSlice`/`stringFromAny` have different names or signatures in `status.go`, adapt to the actual helpers (they are used by `collectEncryptionDetailsWindows` at `status.go:512`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && go test -race ./internal/security/ -run 'TestParseBitLockerRecoveryKeys|TestFingerprintRecoveryKeys'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/security/recoverykeys.go agent/internal/security/recoverykeys_test.go
git commit -m "feat(agent): BitLocker recovery-key collector + fingerprint (#2021)"
```

---

### Task 8: Go agent — rotation (BitLocker add-before-delete, FileVault fdesetup)

**Files:**
- Modify: `agent/internal/security/recoverykeys.go`
- Test: `agent/internal/security/recoverykeys_test.go` (append)

**Interfaces:**
- Consumes: `CollectRecoveryKeys`, `runCommand` (Task 7 / existing).
- Produces (consumed by Task 9):
  - `RotateBitLockerKey(mount string) (RecoveryKey, error)` — may return a valid key WITH a non-nil error (new key added but old-protector removal failed; caller must still escrow).
  - `RotateFileVaultKey(username, password, currentRecoveryKey string) (RecoveryKey, error)`
  - (unexported, testable) `parseFileVaultNewKey(output string) (string, error)`, `buildFileVaultAuthPlist(username, password, currentRecoveryKey string) string`, `validBitLockerMount(mount string) bool`, `validProtectorID(id string) bool`

- [ ] **Step 1: Write the failing tests** (append to `recoverykeys_test.go`)

```go
func TestParseFileVaultNewKey(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		want    string
		wantErr bool
	}{
		{
			name:   "typical fdesetup output",
			output: "New personal recovery key = 'DWXL-9K2M-4NPQ-R7ST-UV3W-XY8Z'",
			want:   "DWXL-9K2M-4NPQ-R7ST-UV3W-XY8Z",
		},
		{name: "no key in output", output: "Error: unable to change recovery key.", wantErr: true},
		{name: "empty", output: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseFileVaultNewKey(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("key = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildFileVaultAuthPlist(t *testing.T) {
	withCreds := buildFileVaultAuthPlist("jane", `pa<ss&"word`, "")
	if !strings.Contains(withCreds, "<key>Username</key>") || !strings.Contains(withCreds, "<string>jane</string>") {
		t.Error("username missing from plist")
	}
	if !strings.Contains(withCreds, "pa&lt;ss&amp;&#34;word") && !strings.Contains(withCreds, "pa&lt;ss&amp;&quot;word") {
		t.Errorf("password not XML-escaped: %s", withCreds)
	}
	withKey := buildFileVaultAuthPlist("", "", "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF")
	if strings.Contains(withKey, "<key>Username</key>") {
		t.Error("recovery-key auth must not include Username")
	}
	if !strings.Contains(withKey, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF") {
		t.Error("recovery key missing from plist")
	}
}

func TestMountAndProtectorValidation(t *testing.T) {
	if !validBitLockerMount("C:") || validBitLockerMount("C:\\") || validBitLockerMount("'; rm") {
		t.Error("mount validation wrong")
	}
	if !validProtectorID("11111111-1111-1111-1111-111111111111") || validProtectorID("x'; $(evil)") {
		t.Error("protector id validation wrong")
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent && go test -race ./internal/security/ -run 'TestParseFileVaultNewKey|TestBuildFileVaultAuthPlist|TestMountAndProtectorValidation'
```

Expected: FAIL — undefined symbols.

- [ ] **Step 3: Implement** (append to `recoverykeys.go`; add imports `context`, `encoding/xml`, `errors`, `os/exec`, `regexp`)

```go
var (
	bitlockerMountPattern = regexp.MustCompile(`^[A-Za-z]:$`)
	protectorIDPattern    = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	// FileVault personal recovery keys: six dash-separated groups of four.
	fileVaultKeyPattern = regexp.MustCompile(`[A-Z0-9]{4}(?:-[A-Z0-9]{4}){5}`)
)

func validBitLockerMount(mount string) bool  { return bitlockerMountPattern.MatchString(mount) }
func validProtectorID(id string) bool        { return protectorIDPattern.MatchString(id) }

// RotateBitLockerKey adds a new recovery-password protector BEFORE removing
// the old ones, so the volume always has at least one recovery password. On
// partial failure (new key added, old removal failed) it returns the NEW key
// alongside the error — the caller must still escrow it.
func RotateBitLockerKey(mount string) (RecoveryKey, error) {
	if runtime.GOOS != "windows" {
		return RecoveryKey{}, errors.New("bitlocker rotation is only supported on windows")
	}
	mount = strings.ToUpper(strings.TrimSpace(mount))
	if !validBitLockerMount(mount) {
		return RecoveryKey{}, fmt.Errorf("invalid volume mount %q", mount)
	}

	before, err := CollectRecoveryKeys()
	if err != nil {
		return RecoveryKey{}, fmt.Errorf("collect before rotation: %w", err)
	}
	oldIDs := make(map[string]bool)
	for _, k := range before {
		if strings.EqualFold(k.Mount, mount) {
			oldIDs[k.ProtectorID] = true
		}
	}

	if _, err := runCommand(30*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf("Add-BitLockerKeyProtector -MountPoint '%s' -RecoveryPasswordProtector | Out-Null", mount)); err != nil {
		return RecoveryKey{}, fmt.Errorf("add recovery password protector: %w", err)
	}

	after, err := CollectRecoveryKeys()
	if err != nil {
		return RecoveryKey{}, fmt.Errorf("collect after rotation: %w", err)
	}
	var newKey *RecoveryKey
	for i := range after {
		if strings.EqualFold(after[i].Mount, mount) && !oldIDs[after[i].ProtectorID] {
			newKey = &after[i]
			break
		}
	}
	if newKey == nil {
		return RecoveryKey{}, errors.New("new recovery password protector not found after add")
	}

	for id := range oldIDs {
		if !validProtectorID(id) {
			return *newKey, fmt.Errorf("new protector added but old protector id %q is malformed; remove it manually", id)
		}
		if _, err := runCommand(30*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command",
			fmt.Sprintf("Remove-BitLockerKeyProtector -MountPoint '%s' -KeyProtectorId '{%s}' | Out-Null", mount, id)); err != nil {
			return *newKey, fmt.Errorf("new protector added but removing old protector failed: %w", err)
		}
	}
	return *newKey, nil
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// buildFileVaultAuthPlist builds the -inputplist body for fdesetup. With a
// username the auth is user credentials; without, Password carries the
// current personal recovery key.
func buildFileVaultAuthPlist(username, password, currentRecoveryKey string) string {
	if username != "" {
		return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Username</key><string>%s</string><key>Password</key><string>%s</string></dict></plist>`,
			xmlEscape(username), xmlEscape(password))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Password</key><string>%s</string></dict></plist>`,
		xmlEscape(currentRecoveryKey))
}

func parseFileVaultNewKey(output string) (string, error) {
	match := fileVaultKeyPattern.FindString(output)
	if match == "" {
		// Do NOT embed output in the error: on success paths it contains the key.
		return "", errors.New("no personal recovery key found in fdesetup output")
	}
	return match, nil
}

// RotateFileVaultKey rotates the FileVault personal recovery key via
// `fdesetup changerecovery -personal -inputplist` (plist over stdin — never
// on disk or argv) and returns the NEW key for escrow. Error messages and
// logs must never contain the key, the password, or raw fdesetup output.
func RotateFileVaultKey(username, password, currentRecoveryKey string) (RecoveryKey, error) {
	if runtime.GOOS != "darwin" {
		return RecoveryKey{}, errors.New("filevault rotation is only supported on macos")
	}
	if (username == "" || password == "") && currentRecoveryKey == "" {
		return RecoveryKey{}, errors.New("filevault rotation requires user credentials or the current recovery key")
	}

	plist := buildFileVaultAuthPlist(username, password, currentRecoveryKey)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "fdesetup", "changerecovery", "-personal", "-inputplist")
	cmd.Stdin = strings.NewReader(plist)
	outputBytes, err := cmd.CombinedOutput()
	output := string(outputBytes)
	if err != nil {
		// fdesetup exits non-zero on auth failure; output may echo details but
		// never include it in the returned error (success output holds the key).
		return RecoveryKey{}, fmt.Errorf("fdesetup changerecovery failed: %w", err)
	}
	newKey, err := parseFileVaultNewKey(output)
	if err != nil {
		return RecoveryKey{}, err
	}
	return RecoveryKey{Mount: "/", KeyType: KeyTypeFileVault, Key: newKey}, nil
}
```

- [ ] **Step 4: Run all package tests**

```bash
cd agent && go test -race ./internal/security/...
```

Expected: PASS (including pre-existing tests). `go vet ./internal/security/` clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/security/recoverykeys.go agent/internal/security/recoverykeys_test.go
git commit -m "feat(agent): BitLocker/FileVault recovery-key rotation (#2021)"
```

---

### Task 9: Go agent — heartbeat wiring + command handlers

**Files:**
- Modify: `agent/internal/remote/tools/types.go` (constants, after `CmdSensitiveDataScan` ~line 113)
- Modify: `agent/internal/privilege/check.go` (elevated map)
- Modify: `agent/internal/heartbeat/heartbeat.go` (struct fields ~line 166; tick ~line 998; new send funcs near `sendSecurityStatus` ~line 2289)
- Create: `agent/internal/heartbeat/handlers_encryption.go`

**Interfaces:**
- Consumes: `security.CollectRecoveryKeys`, `security.FingerprintRecoveryKeys`, `security.RotateBitLockerKey`, `security.RotateFileVaultKey` (Tasks 7-8); `h.sendInventoryData`, `handlerRegistry`, `tools.GetPayloadString`, `tools.NewSuccessResult/NewErrorResult`.
- Produces: agent PUTs `security/recovery-keys` payload `{"source":"snapshot"|"rotation","keys":[RecoveryKey...]}` (Task 3's endpoint); handles commands `encryption_collect_keys` / `encryption_rotate_key`.

- [ ] **Step 1: Add command constants and privilege entries**

`agent/internal/remote/tools/types.go`, after `CmdSensitiveDataScan` (line ~113):

```go
	CmdEncryptionCollectKeys    = "encryption_collect_keys"
	CmdEncryptionRotateKey      = "encryption_rotate_key"
```

`agent/internal/privilege/check.go`, add to `elevatedCommandTypes`:

```go
	tools.CmdEncryptionCollectKeys:    true,
	tools.CmdEncryptionRotateKey:      true,
```

- [ ] **Step 2: Add heartbeat fields + send/push functions**

In `agent/internal/heartbeat/heartbeat.go`, on the `Heartbeat` struct next to `lastSecurityUpdate` (~line 166), add:

```go
	lastRecoveryKeysFP  string
	pendingRecoveryKeys []security.RecoveryKey
```

Next to `sendSecurityStatus` (~line 2289), add:

```go
// sendRecoveryKeys escrows the device's BitLocker recovery keys. Runs on the
// security tick but only transmits when the key set changed (fingerprint
// gate) — recovery keys should not transit the wire every 5 minutes. Also
// drains rotation results whose upload previously failed.
func (h *Heartbeat) sendRecoveryKeys() {
	h.mu.Lock()
	pending := h.pendingRecoveryKeys
	h.pendingRecoveryKeys = nil
	h.mu.Unlock()
	if len(pending) > 0 {
		if err := h.pushRecoveryKeys("rotation", pending); err != nil {
			h.mu.Lock()
			h.pendingRecoveryKeys = append(pending, h.pendingRecoveryKeys...)
			h.mu.Unlock()
		}
	}

	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		log.Warn("recovery key collection failed", "error", err.Error())
		return
	}
	fp := security.FingerprintRecoveryKeys(keys)
	h.mu.Lock()
	last := h.lastRecoveryKeysFP
	h.mu.Unlock()
	if fp == last {
		return
	}
	if err := h.pushRecoveryKeys("snapshot", keys); err != nil {
		return
	}
	h.mu.Lock()
	h.lastRecoveryKeysFP = fp
	h.mu.Unlock()
}

// pushRecoveryKeys uploads keys for escrow. Key material is never logged —
// sendInventoryData logs only the label.
func (h *Heartbeat) pushRecoveryKeys(source string, keys []security.RecoveryKey) error {
	if keys == nil {
		keys = []security.RecoveryKey{} // marshal as [], not null (zod rejects null)
	}
	payload := map[string]any{"source": source, "keys": keys}
	return h.sendInventoryData("security/recovery-keys", payload, fmt.Sprintf("recovery keys (%s, %d)", source, len(keys)))
}
```

Note on the empty-set gate: `FingerprintRecoveryKeys` of an empty set is `""`, which equals the initial `lastRecoveryKeysFP` — agents with no BitLocker keys (macOS/Linux/unencrypted Windows) never send. A transition from N keys to 0 produces `fp="" != last` → the empty snapshot IS sent and supersedes the stale rows.

In the tick loop (~line 998), inside the existing security branch:

```go
			// Send security status every 5 minutes
			if shouldSendSecurity {
				go h.sendSecurityStatus()
				go h.sendRecoveryKeys()
			}
```

- [ ] **Step 3: Create the command handlers**

`agent/internal/heartbeat/handlers_encryption.go`:

```go
package heartbeat

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

func init() {
	handlerRegistry[tools.CmdEncryptionCollectKeys] = handleEncryptionCollectKeys
	handlerRegistry[tools.CmdEncryptionRotateKey] = handleEncryptionRotateKey
}

// handleEncryptionCollectKeys re-collects BitLocker recovery keys and pushes a
// full snapshot immediately. Results carry counts only — never key material.
func handleEncryptionCollectKeys(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := h.pushRecoveryKeys("snapshot", keys); err != nil {
		return tools.NewErrorResult(fmt.Errorf("collected %d recovery keys but escrow upload failed: %w", len(keys), err), time.Since(start).Milliseconds())
	}
	h.mu.Lock()
	h.lastRecoveryKeysFP = security.FingerprintRecoveryKeys(keys)
	h.mu.Unlock()
	return tools.NewSuccessResult(map[string]any{"keysCollected": len(keys)}, time.Since(start).Milliseconds())
}

// handleEncryptionRotateKey rotates the recovery key and escrows the new one.
// A generated-but-unescrowed key is unrecoverable (FileVault), so on upload
// failure the key is parked on the heartbeat for retry on the next security
// tick. The CommandResult never contains key or credential material.
func handleEncryptionRotateKey(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	var (
		key       security.RecoveryKey
		rotateErr error
	)
	switch runtime.GOOS {
	case "windows":
		mount := strings.ToUpper(tools.GetPayloadString(cmd.Payload, "volumeMount", "C:"))
		key, rotateErr = security.RotateBitLockerKey(mount)
	case "darwin":
		username := tools.GetPayloadString(cmd.Payload, "username", "")
		password := tools.GetPayloadString(cmd.Payload, "password", "")
		currentKey := tools.GetPayloadString(cmd.Payload, "currentRecoveryKey", "")
		key, rotateErr = security.RotateFileVaultKey(username, password, currentKey)
	default:
		return tools.NewErrorResult(fmt.Errorf("recovery key rotation is not supported on %s", runtime.GOOS), time.Since(start).Milliseconds())
	}

	if key.Key != "" {
		if pushErr := h.pushRecoveryKeys("rotation", []security.RecoveryKey{key}); pushErr != nil {
			h.mu.Lock()
			h.pendingRecoveryKeys = append(h.pendingRecoveryKeys, key)
			h.mu.Unlock()
			if rotateErr == nil {
				rotateErr = fmt.Errorf("key rotated but escrow upload failed; will retry on next security tick: %w", pushErr)
			}
		}
	}
	if rotateErr != nil {
		return tools.NewErrorResult(rotateErr, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"rotated":     true,
		"keyType":     key.KeyType,
		"volumeMount": key.Mount,
	}, time.Since(start).Milliseconds())
}
```

Note: agent-side command audit (`heartbeat.go:3338`) logs only `cmd.Type` — verified, no payload redaction needed on the agent.

- [ ] **Step 4: Build + full agent test run**

```bash
cd agent && go build ./... && go vet ./... && go test -race ./internal/heartbeat/... ./internal/security/... ./internal/privilege/...
```

Expected: builds clean, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/tools/types.go agent/internal/privilege/check.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/handlers_encryption.go
git commit -m "feat(agent): recovery-key escrow heartbeat wiring + collect/rotate commands (#2021)"
```

---

### Task 10: Web — RecoveryKeysPanel + device Security tab integration

**Files:**
- Create: `apps/web/src/components/security/RecoveryKeysPanel.tsx`
- Modify: `apps/web/src/components/devices/DeviceSecurityTab.tsx`
- Test: `apps/web/src/components/security/RecoveryKeysPanel.test.tsx`

**Interfaces:**
- Consumes: Task 5's endpoints; `fetchWithAuth` from `@/stores/auth`; `runAction`/`handleActionError` from `@/lib/runAction`; `formatDateTime` from `@/lib/dateTimeFormat`.
- Produces: `export default function RecoveryKeysPanel({ deviceId, timezone }: { deviceId: string; timezone?: string })` — reusable in both the device tab (this task) and the fleet page (Task 11).

- [ ] **Step 1: Write the failing component test**

`apps/web/src/components/security/RecoveryKeysPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, runActionMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/lib/runAction', () => ({
  runAction: runActionMock,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error {},
}));

import RecoveryKeysPanel from './RecoveryKeysPanel';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '33333333-3333-4333-8333-333333333333';

const listPayload = {
  data: {
    device: { id: DEVICE_ID, hostname: 'PC-01', os: 'windows' },
    keys: [{
      id: KEY_ID, keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      protectorId: 'p-1', status: 'active', escrowedAt: '2026-07-01T00:00:00Z', supersededAt: null,
    }],
    accessHistory: [],
  },
};

function mockList() {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => listPayload });
}

describe('RecoveryKeysPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists escrowed keys without key material', async () => {
    mockList();
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText('C:')).toBeTruthy());
    expect(screen.getByText(/BitLocker/i)).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/security/encryption/devices/${DEVICE_ID}/recovery-keys`,
      expect.anything()
    );
  });

  it('reveals a key on demand via the reveal endpoint', async () => {
    mockList();
    runActionMock.mockResolvedValue('111111-222222-333333-444444-555555-666666-777777-888888');
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText('C:')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await waitFor(() =>
      expect(screen.getByText('111111-222222-333333-444444-555555-666666-777777-888888')).toBeTruthy()
    );
    expect(runActionMock).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no keys are escrowed', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { device: { id: DEVICE_ID, hostname: 'PC-01', os: 'linux' }, keys: [], accessHistory: [] } }),
    });
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText(/no recovery keys escrowed/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/web && pnpm exec vitest run src/components/security/RecoveryKeysPanel.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

`apps/web/src/components/security/RecoveryKeysPanel.tsx` (imports MUST use the `@/` specifiers mocked above):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Eye, KeyRound, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { cn, friendlyFetchError } from '@/lib/utils';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';

type KeyMeta = {
  id: string;
  keyType: 'bitlocker_recovery_password' | 'filevault_personal_recovery_key';
  volumeMount: string | null;
  protectorId: string | null;
  status: 'active' | 'superseded';
  escrowedAt: string;
  supersededAt: string | null;
};

type AccessEvent = { id: string; keyId: string; userEmail: string; action: string; createdAt: string };

type PanelData = {
  device: { id: string; hostname: string; os: string };
  keys: KeyMeta[];
  accessHistory: AccessEvent[];
};

const keyTypeLabel: Record<KeyMeta['keyType'], string> = {
  bitlocker_recovery_password: 'BitLocker',
  filevault_personal_recovery_key: 'FileVault',
};

function fmt(value: string | null, timezone?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return formatUserDateTime(date, timezone ? { timeZone: timezone } : undefined);
}

export default function RecoveryKeysPanel({ deviceId, timezone }: { deviceId: string; timezone?: string }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateForm, setRotateForm] = useState({ username: '', password: '', currentRecoveryKey: '' });
  const [rotating, setRotating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchKeys = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/security/encryption/devices/${deviceId}/recovery-keys`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchKeys();
    return () => abortRef.current?.abort();
  }, [fetchKeys]);

  const revealKey = async (keyId: string) => {
    setBusyKeyId(keyId);
    try {
      const key = await runAction<string>({
        request: () => fetchWithAuth(`/security/encryption/devices/${deviceId}/recovery-keys/${keyId}/reveal`, { method: 'POST' }),
        errorFallback: 'Failed to reveal recovery key',
        parseSuccess: (body) => (body as { data: { recoveryKey: string } }).data.recoveryKey,
      });
      setRevealed((prev) => ({ ...prev, [keyId]: key }));
      fetchKeys(); // refresh access history with this reveal
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to reveal recovery key');
    } finally {
      setBusyKeyId(null);
    }
  };

  const rotate = async () => {
    const os = data?.device.os ?? '';
    setRotating(true);
    try {
      const body =
        os === 'macos'
          ? {
              username: rotateForm.username || undefined,
              password: rotateForm.password || undefined,
              currentRecoveryKey: rotateForm.currentRecoveryKey || undefined,
            }
          : {};
      await runAction({
        request: () => fetchWithAuth(`/security/encryption/devices/${deviceId}/recovery-keys/rotate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        errorFallback: 'Failed to queue key rotation',
        successMessage: 'Key rotation queued — the new key will be escrowed when the agent completes it',
      });
      setRotateOpen(false);
      setRotateForm({ username: '', password: '', currentRecoveryKey: '' });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to queue key rotation');
    } finally {
      setRotating(false);
    }
  };

  const collectNow = async () => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/security/encryption/devices/${deviceId}/recovery-keys/collect`, { method: 'POST' }),
        errorFallback: 'Failed to queue key collection',
        successMessage: 'Key collection queued',
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) handleActionError(err, 'Failed to queue key collection');
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <p className="py-4 text-sm text-destructive">{error}</p>;
  }

  const os = data?.device.os ?? '';
  const canRotate = os === 'windows' || os === 'macos';
  const canCollect = os === 'windows';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4" /> Recovery Keys</h4>
        <div className="flex gap-2">
          {canCollect && (
            <button type="button" onClick={collectNow} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40">
              <RefreshCw className="h-3 w-3" /> Collect now
            </button>
          )}
          {canRotate && (
            <button type="button" onClick={() => setRotateOpen(true)} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40">
              <RotateCcw className="h-3 w-3" /> Rotate key
            </button>
          )}
        </div>
      </div>

      {(data?.keys.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recovery keys escrowed.
          {os === 'macos' && ' FileVault keys can only be captured by rotating — use "Rotate key" with a FileVault user\'s credentials.'}
          {os === 'linux' && ' Recovery-key escrow is not supported on Linux.'}
        </p>
      ) : (
        <div className="space-y-2">
          {data!.keys.map((k) => (
            <div key={k.id} className={cn('rounded-md border p-3', k.status === 'superseded' && 'opacity-70')}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">{keyTypeLabel[k.keyType]}</span>
                  {k.volumeMount && <span className="ml-2 text-muted-foreground">{k.volumeMount}</span>}
                  <span className={cn('ml-2 inline-flex rounded-full border px-2 py-0.5 text-xs',
                    k.status === 'active' ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' : 'bg-muted text-muted-foreground')}>
                    {k.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Escrowed {fmt(k.escrowedAt, timezone)}</span>
                  {revealed[k.id] ? (
                    <button type="button" onClick={() => navigator.clipboard.writeText(revealed[k.id])}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted/40">
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  ) : (
                    <button type="button" disabled={busyKeyId === k.id} onClick={() => revealKey(k.id)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted/40 disabled:opacity-50">
                      {busyKeyId === k.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />} Reveal
                    </button>
                  )}
                </div>
              </div>
              {revealed[k.id] && (
                <div className="mt-2 rounded bg-muted/40 p-2">
                  <code className="break-all font-mono text-sm">{revealed[k.id]}</code>
                  <p className="mt-1 text-xs text-muted-foreground">This access has been recorded in the audit trail.</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(data?.accessHistory.length ?? 0) > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Recent access</h5>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {data!.accessHistory.map((event) => (
              <li key={event.id}>{event.userEmail} {event.action} · {fmt(event.createdAt, timezone)}</li>
            ))}
          </ul>
        </div>
      )}

      {rotateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !rotating && setRotateOpen(false)}>
          <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold">Rotate recovery key</h4>
            {os === 'macos' ? (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  macOS only reveals the FileVault personal recovery key when it is rotated, and rotation must be
                  authorized by a FileVault-enabled user (or the current recovery key). Credentials are used once and not stored.
                </p>
                <div className="mt-3 space-y-2">
                  <input type="text" placeholder="FileVault username" value={rotateForm.username}
                    onChange={(e) => setRotateForm((f) => ({ ...f, username: e.target.value }))}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
                  <input type="password" placeholder="Password" value={rotateForm.password}
                    onChange={(e) => setRotateForm((f) => ({ ...f, password: e.target.value }))}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
                  <p className="text-center text-xs text-muted-foreground">— or —</p>
                  <input type="text" placeholder="Current recovery key" value={rotateForm.currentRecoveryKey}
                    onChange={(e) => setRotateForm((f) => ({ ...f, currentRecoveryKey: e.target.value }))}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                A new BitLocker recovery password will be generated and escrowed; the old one is removed after the new key is in place.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={rotating} onClick={() => setRotateOpen(false)} className="rounded-md border px-3 py-1.5 text-sm">Cancel</button>
              <button type="button" disabled={rotating || (os === 'macos' && !((rotateForm.username && rotateForm.password) || rotateForm.currentRecoveryKey))}
                onClick={rotate} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
                {rotating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Rotate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Verify `ActionError` exposes `.status` (see `apps/web/src/lib/runAction.ts:4`) and that `runAction`'s `parseSuccess` receives the parsed JSON body; adjust if the real contract differs.

- [ ] **Step 4: Integrate into DeviceSecurityTab**

In `apps/web/src/components/devices/DeviceSecurityTab.tsx`: add `import RecoveryKeysPanel from '../security/RecoveryKeysPanel';` and render a new card in the returned JSX, directly after the `<DeviceSecurityStatus .../>` block (find it in the render tree):

```tsx
      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <RecoveryKeysPanel deviceId={deviceId} timezone={timezone} />
      </div>
```

- [ ] **Step 5: Run tests**

```bash
cd apps/web && pnpm exec vitest run src/components/security/RecoveryKeysPanel.test.tsx && pnpm exec vitest run src/components/devices 2>/dev/null || true
```

Expected: panel tests PASS; existing DeviceSecurityTab tests (if any) still PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/security/RecoveryKeysPanel.tsx apps/web/src/components/security/RecoveryKeysPanel.test.tsx apps/web/src/components/devices/DeviceSecurityTab.tsx
git commit -m "feat(web): recovery keys panel with audited reveal + rotate on device security tab (#2021)"
```

---

### Task 11: Web — EncryptionPage real escrow + filter + embedded panel

**Files:**
- Modify: `apps/web/src/components/security/EncryptionPage.tsx`

**Interfaces:**
- Consumes: Task 6's response shape (`recoveryKeyEscrowed` real; `volumes: { drive, encrypted, method, status, percentEncrypted }`; `escrow` query param; `summary.recoveryKeysEscrowed`), `RecoveryKeysPanel` (Task 10).

- [ ] **Step 1: Update types and volume rendering**

In `apps/web/src/components/security/EncryptionPage.tsx`:

Replace the `Volume` type (lines 8-13):

```tsx
type Volume = {
  drive: string;
  encrypted: boolean;
  method: string;
  status: string | null;
  percentEncrypted: number | null;
};
```

Update `Summary` (line 26) to add `recoveryKeysEscrowed: number;` and its initial state default `recoveryKeysEscrowed: 0`.

In the expanded-volumes table (lines 214-233): change the `Size` header to `Status`, and the size cell to:

```tsx
                                  <td className="py-1 text-muted-foreground">
                                    {v.status ?? '-'}{typeof v.percentEncrypted === 'number' ? ` (${Math.round(v.percentEncrypted)}%)` : ''}
                                  </td>
```

- [ ] **Step 2: Add escrow filter + column + embedded panel**

Add state `const [escrowFilter, setEscrowFilter] = useState('');`, include it in `fetchData`'s params (`if (escrowFilter) params.set('escrow', escrowFilter);`) and in the `useCallback` dependency array. Add a select next to the OS filter:

```tsx
        <select value={escrowFilter} onChange={(e) => setEscrowFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All escrow states</option>
          <option value="escrowed">Key escrowed</option>
          <option value="missing">Key missing</option>
        </select>
```

Change the Recovery Key cell (line 210) to a real status badge:

```tsx
                        <div className="px-4 py-3 text-sm">
                          {d.recoveryKeyEscrowed ? (
                            <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700">Escrowed</span>
                          ) : d.encryptionStatus !== 'unencrypted' && d.os !== 'linux' ? (
                            <span className="inline-flex rounded-full border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-700">Missing</span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </div>
```

In the expanded section (after the volumes table, inside the `isExpanded` block), embed the panel:

```tsx
                          <div className="mt-4 border-t pt-3">
                            <RecoveryKeysPanel deviceId={d.deviceId} />
                          </div>
```

with `import RecoveryKeysPanel from './RecoveryKeysPanel';` at the top. Optionally surface `summary.recoveryKeysEscrowed` by changing the "Partial" stat card row to a fifth card only if the grid allows; otherwise skip — the column + filter carry the feature.

- [ ] **Step 3: Verify build + typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json 2>/dev/null || pnpm typecheck 2>/dev/null || pnpm exec astro check
```

Use whichever typecheck script `apps/web/package.json` actually defines. Expected: clean for the touched files.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/security/EncryptionPage.tsx
git commit -m "feat(web): real escrow status, escrow filter, and key panel on fleet encryption page (#2021)"
```

---

### Task 12: Repo-wide contract sweep + full verification

**Files:**
- Possibly modify: any out-of-plan consumers found by the sweeps.

- [ ] **Step 1: Sweep for consumers of the changed response contract**

```bash
grep -rn "recoveryKeyEscrowed" --include="*.ts" --include="*.tsx" apps packages e2e-tests | grep -v node_modules
grep -rn "security/encryption" --include="*.ts" --include="*.tsx" apps packages e2e-tests | grep -v node_modules
grep -rn "encryption" apps/api/src/services/aiTools*.ts apps/api/src/routes/mcp* 2>/dev/null | grep -iv "encryptionStatus\b" | head -30
```

For every hit outside the files this plan already touched (AI tools, MCP server, report generators, e2e specs): if it consumes `volumes[].size` or assumes the old fake `recoveryKeyEscrowed`, update it to the new contract. If `get_security_posture`/`get_compliance_status` AI tools surface encryption info, confirm they read `security_status` directly (unaffected) rather than the `/security/encryption` response shape.

- [ ] **Step 2: Full test + typecheck run**

```bash
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
cd agent && go build ./... && go test -race ./... && cd ..
```

Expected: all PASS. Fix anything red before proceeding.

- [ ] **Step 3: Integration suite (if local DB available)**

```bash
cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze_integration" pnpm exec vitest run --config vitest.integration.config.ts
```

Expected: PASS including rls-coverage, tenantCascade, and the new deviceRecoveryKeys RLS suite.

- [ ] **Step 4: Manual RLS forge verification (spec requirement)**

If the local docker Postgres is up:

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SET breeze.scope='organization'; INSERT INTO device_recovery_keys (device_id, org_id, key_type, encrypted_key, key_fingerprint) VALUES (gen_random_uuid(), gen_random_uuid(), 'bitlocker_recovery_password', 'enc:x', repeat('a',64));"
```

First check how the RLS context GUCs are actually named (`grep -rn "set_config\|current_setting" apps/api/src/db/index.ts | head`) and set them the way `withDbAccessContext` does. Expected: `new row violates row-level security policy`.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: contract sweep + verification for recovery-key escrow (#2021)" --allow-empty
```

---

## Verification checklist (maps to spec's Testing section)

- [x] Go table-driven parser tests (BitLocker protectors incl. PS 5.1 collapse, fdesetup output) — Tasks 7-8
- [x] Fingerprint gating tests — Task 7
- [x] API ingest supersede/dedupe/no-op + snapshot-supersede exemption for FileVault — Task 2
- [x] Reveal: happy path, site-scope denial, ledger row, audit-has-no-key assertion — Task 5
- [x] Rotate validation (OS mismatch, missing macOS creds, payload encryption) — Task 5
- [x] RLS cross-tenant forge 42501 for both tables + contract tests — Tasks 1, 12
- [x] Fleet endpoint real escrow + filter + real volumes — Task 6
- [x] Web reveal modal fetch-on-reveal + empty/error states — Task 10
