---
issue: LanternOps/breeze#7081
status: plan-drafted
tracking_issue: LanternOps/breeze#8730
---

# Backup Destination Prefix Applied to S3 Snapshot Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backup destination's `providerConfig.prefix` relocates NEW S3 snapshot objects to `<prefix>/snapshots/<id>/...`. Every existing snapshot stays readable at its current bucket-root keys. Nothing is re-keyed.

**Architecture:** The prefix is applied only at the API's S3 I/O layer. The helper keeps writing and reading logical keys (`snapshots/<id>/...`) through brokered storage sessions. The API maps each logical key to a physical key when it presigns, lists, fetches or deletes. Each snapshot records its own key root: `key_layout = 'prefixed_flat'` plus a typed `key_prefix` column. The root is fixed on the snapshot-id reservation at write-session mint and copied to the snapshot row at publish and to the retirement tombstone at retirement. Unprefixed destinations keep writing `legacy_flat` and see no change. GC, reconcile and the janitor list one root at a time inside each storage identity and never across roots.

**Tech Stack:** TypeScript (Hono API), Drizzle ORM, PostgreSQL, `@aws-sdk/client-s3`, Vitest (unit, `vitest.integration.config.ts` against real Postgres), MinIO for the lab check.

**Spec:** No separate spec. Inputs: issue #7081 (body plus the 2026-10-13 re-triage comment) and the aborted fast-track report (`fix-7081` dispatch result, summarised under "Ground truth" below). The "Design contract" section of this plan stands in for the spec. Every executor reads it before starting a task.

---

## Ground truth (verified on `origin/main` @ `d35fb4cde1`)

- **The agent never builds a physical S3 key in production.** `backupCommandCredentials.ts` (~212–243) refuses every direct S3 read or write command. S3 backups run only through brokered storage sessions. The helper sends logical keys. The API presigns them (`backupStoragePresign.ts`, `backupStorageSessions.ts`, `recoveryDownloadService.ts`) and runs list, delete and multipart operations itself (`backupStorageWriteSessions.ts`).
- **Logical keys are embedded everywhere and must not change:**
  - manifests (`files[].backupPath`) and incremental external refs;
  - the `backupObjectKey.ts` grammar and its Go/TS shared vectors (`agent/internal/backup/bmr/testdata/object-key-vectors.json`);
  - `backup_storage_session_uploads.object_key` and `backup_storage_sessions.control_keys`;
  - the helper-signed attestation statement (`backupAttestation.ts`, `agent/internal/backup/attestation.go`, where `keyLayout` is hardcoded to `"legacy_flat"`).
- **`backup_snapshots.key_layout` already exists** (`2026-11-07-100000-backup-helper-protocols-and-key-layout.sql`). It has `CHECK (key_layout IN ('legacy_flat','device_scoped'))`, and `device_scoped` is test-only. Readers refuse unknown layouts. GC skips a whole storage identity while any snapshot in it has an unknown layout (`backupRetention.ts` ~2317, ~2472). `backup_snapshot_attestations.key_layout` has `CHECK (key_layout = 'legacy_flat')`.
- **No `backup_snapshots` row exists at mint.** `mintBackupWriteSession` (`backupStorageWriteSessions.ts:446`) writes `backup_snapshot_id_reservations`, `backup_storage_sessions` and `backup_jobs.snapshot_id`. The row is inserted at publish (`backupResultPersistence.ts:1652`), either from the helper result or from reconcile adoption (`backupSnapshotReconcile.ts:1089`).
- **`normalizeStorageIdentity` (`services/backupStorageIdentity.ts:57`) excludes the prefix.** So do `helperStorageIdentity` and the coarse GC and reconcile signatures.
- **`metadata.storagePrefix` is not a usable carrier.** The agent writes it for Hyper-V and MSSQL (`exec_hyperv.go:144,378`) and reconcile writes it (`backupSnapshotReconcile.ts:694`). It always equals `snapshots/<id>`. It is helper-reported jsonb, and `normalizeStoragePrefix` / `deriveRemoteStorageKey` honour it today.
- **Dedupe base selection** (`jobs/backupWorker.ts` `stampDispatchPinAndIdentity`, ~1140–1336) filters candidates by `storageIdentity` only.
- **BMR direct mode.** When `bootstrap.Download` is nil the agent reads the bucket directly with logical keys (`agent/internal/backup/bmr/session.go:81-88`). The API's authenticated bootstrap builds `Download` for any non-empty snapshot id and strips credentials (`recoveryBootstrap.ts` ~474/494), so production is token-mode today. W03 adds a defensive guard.
- **No server-side validation of `prefix` exists.** `routes/backup/configs.ts:95` only strips trailing slashes. `validateS3Details` (`routes/backup/schemas.ts:32`) is the shared S3 validator for REST create/update (`configs.ts:206,434`) and AI tools (`aiToolsPolicyPrereqs.ts:104`).
- **The connection probe already writes under the prefix** (`configs.ts:150-160`). It verifies that the credential can write at `<prefix>/...`, which matches the new layout.

## Design contract

### Layout model

| `key_layout` | `key_prefix` | Physical key of logical `snapshots/<id>/<rest>` | Root listed by GC |
|---|---|---|---|
| `legacy_flat` | `NULL` | `snapshots/<id>/<rest>` | `snapshots/` |
| `prefixed_flat` | normalized prefix `P` (non-empty) | `P/snapshots/<id>/<rest>` | `P/snapshots/` |

- **I1 (authority).** For S3 snapshots the recorded `(key_layout, key_prefix)` is the only source of a physical key. `providerConfig.prefix` is read **once**, at mint, when a new snapshot id is reserved. `metadata.storagePrefix` is honoured only for `legacy_flat` rows, for backward compatibility, and is ignored for `prefixed_flat`.
- **I2 (frozen root).** A reservation's root never changes after mint. Redelivery of the same job, resume onto an earlier reservation, the janitor and the publish copy all read the reservation's columns and never the current config.
- **I3 (disjoint roots).** A valid prefix has no path segment equal to `snapshots`, compared case-insensitively. So `snapshots/` and every `P/snapshots/` are pairwise disjoint. A listing of one root can never contain another root's objects. (Proof: if `P/snapshots/` started with `Q/snapshots/` and `P ≠ Q`, then `P` would start with `Q/snapshots/` and would contain a `snapshots` segment.)
- **I4 (chains never span roots).** A dedupe base must have the same root as the run it serves. The first run after a prefix edit is a full backup. External refs therefore always resolve under the referencing snapshot's own root. Readers still resolve an external ref through the **origin** snapshot's recorded root and refuse a mismatch rather than guess.
- **I5 (fail closed).** Any reader that gets a `key_layout` it does not support, a `prefixed_flat` row whose `key_prefix` fails validation, or a physical key that does not map back under the expected root, refuses. A reader never falls back to the bucket root.
- **I6 (logical attestation).** The helper's attestation statement describes the **logical** key grammar. Binding compares `logicalKeyLayout(snapshot.keyLayout)` with `attestation.keyLayout`. `logicalKeyLayout('prefixed_flat') === 'legacy_flat'`. No agent change is needed; see Open Decision 2.
- **I7 (local untouched).** `provider = 'local'` always records `legacy_flat` and `NULL`.

### Shared primitives (W01 Task 1, used by every later task)

`apps/api/src/services/backupKeyLayout.ts`, extended:

```ts
import { normalizeBackupDestinationPrefix } from '@breeze/shared';

export const BACKUP_KEY_LAYOUTS = ['legacy_flat', 'prefixed_flat'] as const;
export type BackupKeyLayout = (typeof BACKUP_KEY_LAYOUTS)[number];

export type SnapshotKeyRoot =
  | { layout: 'legacy_flat'; prefix: null }
  | { layout: 'prefixed_flat'; prefix: string };

export const LEGACY_FLAT_ROOT: SnapshotKeyRoot = Object.freeze({ layout: 'legacy_flat', prefix: null });

export function isSupportedKeyLayout(value: unknown): value is BackupKeyLayout {
  return typeof value === 'string' && (BACKUP_KEY_LAYOUTS as readonly string[]).includes(value);
}

/** Root of a snapshot / reservation / retirement row; null = refuse (I5). */
export function snapshotKeyRootOf(row: { keyLayout: unknown; keyPrefix: unknown }): SnapshotKeyRoot | null {
  if (row.keyLayout === 'legacy_flat') return row.keyPrefix == null ? LEGACY_FLAT_ROOT : null;
  if (row.keyLayout === 'prefixed_flat') {
    const n = normalizeBackupDestinationPrefix(row.keyPrefix);
    // The stored value must already be in normalized form; a value that only
    // passes after normalization was not written by this code.
    return n.ok && n.prefix !== null && n.prefix === row.keyPrefix
      ? { layout: 'prefixed_flat', prefix: n.prefix }
      : null;
  }
  return null;
}

/** Root a NEW reservation on this destination gets (mint only; I1). */
export function keyRootForNewSnapshot(
  provider: string,
  providerConfig: Record<string, unknown>,
): { ok: true; root: SnapshotKeyRoot } | { ok: false; reason: 'invalid_destination_prefix' } {
  if (provider !== 's3') return { ok: true, root: LEGACY_FLAT_ROOT };
  const n = normalizeBackupDestinationPrefix(providerConfig.prefix);
  if (!n.ok) return { ok: false, reason: 'invalid_destination_prefix' };
  return { ok: true, root: n.prefix === null ? LEGACY_FLAT_ROOT : { layout: 'prefixed_flat', prefix: n.prefix } };
}

export function physicalKeyFor(root: SnapshotKeyRoot, logicalKey: string): string {
  return root.layout === 'legacy_flat' ? logicalKey : `${root.prefix}/${logicalKey}`;
}

/** Inverse of physicalKeyFor; null when the key is not under this root. */
export function logicalKeyFrom(root: SnapshotKeyRoot, physicalKey: string): string | null {
  if (root.layout === 'legacy_flat') return physicalKey;
  const head = `${root.prefix}/`;
  return physicalKey.startsWith(head) ? physicalKey.slice(head.length) : null;
}

/** The `snapshots/` root GC / reconcile list for this root (always ends in '/'). */
export function physicalSnapshotRootPrefix(root: SnapshotKeyRoot): string {
  return physicalKeyFor(root, 'snapshots/');
}

/** Stable grouping key: 'legacy' | 'prefixed:<P>'. */
export function keyRootId(root: SnapshotKeyRoot): string {
  return root.layout === 'legacy_flat' ? 'legacy' : `prefixed:${root.prefix}`;
}

/** S3 object keys are at most 1024 bytes of UTF-8. Checked on the COMPOSED physical key. */
export const PHYSICAL_KEY_MAX_BYTES = 1024;
export function physicalKeyFits(physicalKey: string): boolean {
  return Buffer.byteLength(physicalKey, 'utf8') <= PHYSICAL_KEY_MAX_BYTES;
}

/** I6: the layout the helper's attestation statement describes. */
export function logicalKeyLayout(layout: BackupKeyLayout): 'legacy_flat' {
  return 'legacy_flat';
}
```

`packages/shared/src/validators/backupDestinationPrefix.ts` (new; exported from the validators barrel, so the web form can use it too):

```ts
export const BACKUP_DESTINATION_PREFIX_MAX_LENGTH = 256;
// S3 "safe characters" (AWS object-key naming guidelines), per segment.
const SAFE_SEGMENT = /^[A-Za-z0-9!_.*'()-]+$/;

export type BackupDestinationPrefixResult =
  | { ok: true; prefix: string | null }
  | { ok: false; reason: 'not_a_string' | 'too_long' | 'empty_or_dot_segment' | 'unsafe_characters' | 'reserved_segment' };

export function normalizeBackupDestinationPrefix(raw: unknown): BackupDestinationPrefixResult {
  if (raw === undefined || raw === null) return { ok: true, prefix: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return { ok: true, prefix: null };
  if (trimmed.length > BACKUP_DESTINATION_PREFIX_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return { ok: false, reason: 'empty_or_dot_segment' };
    if (!SAFE_SEGMENT.test(segment)) return { ok: false, reason: 'unsafe_characters' };
    if (segment.toLowerCase() === 'snapshots') return { ok: false, reason: 'reserved_segment' };
  }
  return { ok: true, prefix: trimmed };
}
```

### Schema (one migration, W01)

File: `apps/api/migrations/<name>.sql`. Name it to sort **after the newest committed migration on `origin/main` at implementation time**. Today that is `2026-12-26-110000-invoice-lines-work-date.sql`, so for example `2026-12-26-140000-backup-snapshot-key-prefix.sql`. Re-check before committing: `ls apps/api/migrations | sort | tail -1`. Shipped names run ahead of real time. Never use `2026-08-06-g-`. `scripts/check-migration-naming.sh --staged` and `autoMigrate.test.ts` enforce this.

```sql
-- #7081: per-snapshot key root for backup destinations with a real prefix.
-- DDL only; every existing row stays ('legacy_flat', NULL). Idempotent.
-- Rollback floor: once a later release writes 'prefixed_flat', an API older
-- than this one must not run against the database (it would refuse those
-- rows at best; see backupKeyLayout.ts).

ALTER TABLE backup_snapshot_id_reservations
  ADD COLUMN IF NOT EXISTS key_layout text NOT NULL DEFAULT 'legacy_flat';
ALTER TABLE backup_snapshot_id_reservations ADD COLUMN IF NOT EXISTS key_prefix text;
ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS key_prefix text;
ALTER TABLE backup_snapshot_retirements
  ADD COLUMN IF NOT EXISTS key_layout text NOT NULL DEFAULT 'legacy_flat';
ALTER TABLE backup_snapshot_retirements ADD COLUMN IF NOT EXISTS key_prefix text;

-- Widen the snapshot layout CHECK. autoMigrate runs this whole file in ONE
-- transaction, so the ACCESS EXCLUSIVE lock is held through the validation
-- scan; a NOT VALID/VALIDATE split would buy nothing here.
ALTER TABLE backup_snapshots DROP CONSTRAINT IF EXISTS backup_snapshots_key_layout_chk;
ALTER TABLE backup_snapshots ADD CONSTRAINT backup_snapshots_key_layout_chk
  CHECK (key_layout IN ('legacy_flat', 'prefixed_flat', 'device_scoped'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_snapshots', 'backup_snapshot_id_reservations', 'backup_snapshot_retirements'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_key_prefix_chk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ('
      || '((key_layout = ''prefixed_flat'') = (key_prefix IS NOT NULL))'
      || ' AND (key_prefix IS NULL OR (key_prefix <> '''' AND key_prefix !~ ''(^/|/$|//)'' AND length(key_prefix) <= 256))'
      || ')', t, t || '_key_prefix_chk');
  END LOOP;
END $$;

DO $$
BEGIN
  ALTER TABLE backup_snapshot_id_reservations ADD CONSTRAINT backup_snapshot_id_reservations_key_layout_chk
    CHECK (key_layout IN ('legacy_flat', 'prefixed_flat'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE backup_snapshot_retirements ADD CONSTRAINT backup_snapshot_retirements_key_layout_chk
    CHECK (key_layout IN ('legacy_flat', 'prefixed_flat'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

**Database-enforced binding (quorum finding; app copy-forward alone is not enough).** The same migration also does the following:

1. **Root immutability.** Add a `BEFORE UPDATE` trigger `breeze_backup_key_root_immutable()` on `backup_snapshots`, `backup_snapshot_id_reservations` and `backup_snapshot_retirements`. It raises `'<table>: key_layout/key_prefix are immutable'` when `(NEW.key_layout, NEW.key_prefix) IS DISTINCT FROM (OLD.key_layout, OLD.key_prefix)`. Drop and recreate the trigger idempotently: `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`.
2. **Reservation ↔ snapshot equality.** `CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_reserve_id()`, starting from its **latest** definition (`grep -ln breeze_backup_snapshot_reserve_id apps/api/migrations | sort | tail -1`; today `2026-11-08-160000-backup-snapshot-reservation-current-job.sql`). Copy it verbatim and add two changes:
   - When a reservation is `FOUND`, raise `unique_violation` / `backup_snapshot_id_reservations_pkey` if `(r.key_layout, r.key_prefix) IS DISTINCT FROM (NEW.key_layout, NEW.key_prefix)`.
   - The synthesizing `INSERT` (the `legacy_published` branch) copies `NEW.key_layout, NEW.key_prefix`.

   The function runs as an AFTER trigger (verified: `AFTER INSERT OR UPDATE OF snapshot_id ON backup_snapshots`, `2026-11-08-120000-backup-snapshot-id-reservations.sql:354`), so it cannot rewrite `NEW`. Publish therefore has to *send* the reservation's pair (W01 Task 7), and the trigger proves it did.
3. **Erasure evidence keeps the root.** Add `key_layout text` and `key_prefix text` (both nullable) to `backup_erasure_targets` (`2026-12-11-100000-backup-erasure-fences.sql`). `CREATE OR REPLACE` `public.breeze_backup_erasure_fence_on_delete()` from its latest definition so that a fenced `snapshot_prefix` target records `OLD.key_layout, OLD.key_prefix` from whichever source row is being deleted. `backup_erasure_targets` has **no `org_id`**: it is platform evidence with a system-only policy. So it needs no cascade or export-policy entry, and the integration suites confirm that.

`backup_snapshot_attestations_key_layout_chk` stays `= 'legacy_flat'` (I6).

**Tenancy and registration checklist for this migration.** It adds no table, so it needs no new RLS policy and no `rls-coverage` allowlist change. The three tables are already shape 1 (`org_id`) with policies.

| List | Action |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:451-453`) | None. All three tables are already registered. Grep to confirm. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`) | None. No new table. |
| `AUDIT_ADMIN_REQUIRED_TABLES` | None. |
| **`CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:261-263`)** | **Required.** Add to `included`: `key_layout` and `key_prefix` on `backup_snapshot_id_reservations` and on `backup_snapshot_retirements`, and `key_prefix` on `backup_snapshots`. Plain `text`, and no name part matches `SUSPICIOUS_NAME_PARTS`. `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` fail without this, and only under **Integration Tests**. |

Drizzle: add `keyLayout`/`keyPrefix` to `db/schema/backupSnapshotIdReservations.ts` and to `backupSnapshotRetirements` in `db/schema/backup.ts`, and add `keyPrefix` to `backupSnapshots`. Then run `pnpm db:check-drift`.

## Sweep-all-readers list (every site is owned by a wave)

Line numbers are on `d35fb4cde1`. Re-grep before each wave:
`grep -rn -E "snapshots/|backupSnapshotRootPrefix|backupSnapshotManifestKey|backupSystemState(Manifest|Artifact)Key|backupLayoutManifestKey|iterateBackupObjectsUnderPrefix|listBackupObjectsUnderPrefix|fetchBackupObject(Bytes|Text)|deleteBackupObjectKeys|applyBackupSnapshotImmutability|deleteBackupSnapshotArtifacts|presignSnapshotObjectGet|deriveRemoteStorageKey|storagePrefix|originStoragePrefix" apps/api/src --include='*.ts' | grep -v '\.test\.ts'`

| # | Site | Operation | Root source | Wave |
|---|---|---|---|---|
| R1 | `backupStorageWriteSessions.ts` `resolveWriteSessionObjects` (~751; presign GET/PUT/part ~836/843/847) | presign | reservation (own keys); base snapshot row (base GET) | W01 plumbing, W03 live |
| R2 | `createWriteSessionMultipart` / `completeWriteSessionMultipart` / `abortWriteSessionMultipart` (~908/988/1044) | multipart | reservation | W01 plumbing |
| R3 | `listWriteSessionPrefix` (~1083) | list, with keys **returned to the helper** | reservation; strip with `logicalKeyFrom` | W01 plumbing |
| R4 | `deleteWriteSessionKeys` (~1117), `resumeWriteSession` (~1420, abort at 1427/1441) | delete / abort | reservation (resume: the **earlier** reservation's root) | W01 plumbing |
| R5 | `backupStorageSessions.ts` read-session mint (~807 gate, ~864 control keys) and `resolveStorageSessionObjects` (~1006, presign ~1121, external keys ~1087-1096) | presign GET | snapshot row; external refs: origin row | W01 |
| R6 | `recoveryDownloadService.ts` `getAuthenticatedRecoveryDownloadTarget` (S3 ~374, local ~395), `deriveRemoteStorageKey` (~208), `authorizeExternalReference` (~43) | presign GET | snapshot row; origin row | W01 |
| R7 | `backupSnapshotStorage.ts` `normalizeStoragePrefix` → `applyBackupSnapshotImmutability` (~777) and `deleteBackupSnapshotArtifacts` (~759, test-only callers) | list + retention / delete | snapshot row | W01 |
| R8 | `backupResultPersistence.ts` ~1527 (`location`), ~1826-1840 (immutability after insert), ~1652 insert | write row | reservation → row copy | W01 copy (no-op), W03 live |
| R9 | `routes/backup/snapshots.ts:575` (immutability) and `:738` (`layoutManifestKey` display) | retention / display | snapshot row | W01 |
| R10 | `backupAttestationVerify.ts` (~149-235 control fetch; ~189 binding; ~316) and `backupAttestation.ts:170` (accept) | get / bind | snapshot row; I6 | W01 |
| R11 | `backupSnapshotFileIndex.ts` `fetchAndParseManifest` (~413), own-prefix parse (~461), `verifyOriginsAndWrite` (~516, writes `origin_storage_prefix`) | get / identity | snapshot row; origin row | W01 |
| R12 | `backupRestoreIntegrity.ts:89-97` `controlObjectKey` | logical compare only | none (logical) | W01 (assert unchanged) |
| R13 | `backupStorageWriteDelivery.ts:92` `baseManifestKeyFor` | logical key → session control key | base row (resolved at R1) | W01 |
| R14 | `jobs/backupRetention.ts` GC: `listStorageIdentityGroups` (~1620), `relistGroup` (~1745), `markLiveBackupObjects` (~1337-1440), `deleteSelectedCandidates` (~1564), `reclaimUnrooted` (~1887), `resolveErasureFencedReferences` (~2186), layout gate (~2317, ~2472), coarse collision (~942-1040), retirement insert (~407) | list / get / delete | per-root loop | W02 |
| R15 | `backupSnapshotReconcile.ts` root list (~766-787), `extractManifestBearingSnapshots` (~376), manifest get (~1024), `manifestToCommandResult` (~694 `storagePrefix`) | list / get / adopt | per-root loop; the adopted row records the root it was found under | W02 |
| R16 | `jobs/backupWriteSessionJanitor.ts` `abortRecordedUploads` (~136-170), `sweepFinishedPrefixes` (~282-322) | list multipart / abort | reservation | W02 |
| R17 | `backupErasureFence.ts` (~106/115 identity; fenced-ref manifest reads) | get | snapshot row / fence root | W02 |
| R18 | `jobs/backupWorker.ts` `stampDispatchPinAndIdentity` (~1140-1336) | base selection | destination root at dispatch (I4) | W02 |
| R19 | `routes/backup/bmr.ts:1477`, `bmrRecoveries.ts:446` (config passed into the builder), `recoveryBootstrap.ts:146,474,494` (`pathPrefix` is logical; `Download` is always built for a non-empty id and credentials are stripped) | BMR bootstrap | snapshot row | W03 defensive guard |
| R23 | `aiToolsPolicyPrereqs.ts:1006,1106` `resolveS3ProviderConfig` (AI create/update bypass `validateS3Details`) | config write | validator | W01 |
| R24 | `backupStoragePresign.ts:~359` `probeConditionalWrites` (bucket-root probe key) | put/delete | destination prefix | W03 |
| R25 | `backup_erasure_targets` + `breeze_backup_erasure_fence_on_delete()` | erasure evidence | source row's root | W01 DDL, W02 read |
| R26 | `breeze_backup_snapshot_reserve_id()` trigger (publish/adopt binding) | DB binding | reservation | W01 DDL |
| R20 | `routes/backup/schemas.ts:32` `validateS3Details` (REST create/update, AI tools) | config write | validator | W01 |
| R21 | `apps/web/.../BackupDestinationSection.tsx:718` + `keyPrefixForOrganizingObjectsInThe` (7 locales) | UI copy / inline validation | validator | W03 |
| R22 | `routes/backup/configs.ts:95,150-160` connection probe | put/delete under prefix | already consistent | none (assert in W03 lab) |

Not in scope, intentionally: `recoveryMediaService.ts`, `s3Storage.ts` and `artifacts/blobStorage.ts` (not snapshot objects); `backupStorageCredentialHistory.ts:189` (bucket-root `MaxKeys 1` credential probe).

**Agent legacy paths: limitation in W03, not changed.** The agent.yaml manager, `breeze-backup rebuild --provider-config`, and BMR direct mode read raw bucket keys. The API closes BMR direct mode for `prefixed_flat` snapshots in W03. The other two are operator-run tools that take hand-supplied config. W03 files a follow-up issue for a `prefix` option on them (a key-prefix decorator on `providers/s3.go`). See Open Decision 6.

**Latent bug the sweep found, out of scope here (file separately).** `origin_storage_prefix` is copied from the origin's `metadata.storagePrefix` (`backupSnapshotFileIndex.ts:516`), which for Hyper-V, MSSQL and reconciled snapshots is already `snapshots/<originId>`. `deriveRemoteStorageKey` (~218) and the local branch (~403) then build `snapshots/<o>/snapshots/<o>/files/...`. This is inferred from reading and not reproduced. W01 Task 5 stops using `origin_storage_prefix` for root resolution in favour of the origin row's recorded root, which removes the path. File the issue anyway so the legacy behaviour gets its own regression test.

## Rollout and rollback

- **The ordering guarantee is structural.** No code path writes `prefixed_flat` until W03. W01 teaches every direct reader the new root. W02 teaches GC, reconcile, the janitor and base selection. Both are behaviour-neutral on their own, because every row is `legacy_flat` and the mapping is the identity for `legacy_flat`.
- **Release gating.** W01 and W02 may ship in the same release. **W03 must ship in a release after the W01+W02 release is deployed to EU and US and rollback below it is off the table.** The W01 release becomes the new rollback floor (it extends the floor `2026-11-07-100000` already declares). During a rolling deploy, or with horizontally scaled replicas (#8139), an older replica that meets a `prefixed_flat` row refuses it or skips that GC identity. That is the designed fail-closed behaviour for **readers**.
- **The new layout value does not protect against pre-W01 *writers*.** A pre-W01 replica's redelivery path (`backupStorageWriteSessions.ts` ~624) does not check layout, so it would presign legacy-root keys for a prefixed reservation. So W03 may go live only when **no pre-W01 API replica or worker is running anywhere**: drain old replicas, then run the CLAUDE.md version-skew check. W01/W02 replicas are safe, because they read the reservation root (W01 Task 4).
- **No backfill, no re-keying.** Existing snapshots keep `legacy_flat`. After W03 the first run on an already-prefixed destination is a full backup under the new root (I4). Release notes must say so. They must also warn that an IAM policy scoped to `bucket/snapshots/*` stops working for prefixed destinations. The connection test already writes under the prefix, so "Test connection" catches it.

## CI traps (apply to every wave)

- Branch each wave from `main` **after the previous wave merges**, as `feature/<parent#>-backup-prefix/wave-<sub#>`. A PR based on a sibling branch runs **no** CI (`ci.yml` triggers on `pull_request: branches: [main]`), and `gh pr checks` then shows only the smoke-binary workflows as green. If a wave is stacked anyway, run `gh workflow run CI --ref <branch>` and wait for it.
- `pnpm test` does **not** run `vitest.integration.config.ts` or `vitest.config.rls.ts`. Run every integration suite this plan names explicitly: `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>`. The export-policy and cascade suites fail only under **Integration Tests**.
- Run one test file with `cd apps/api && npx vitest run <path>`. Never use `pnpm --filter … test -- --run`. Vitest path filters are substring matches, so check the reported file count.
- `backupRetention.test.ts` uses an ordered `selectQueue` mock. Any new `db.select` in the GC call sequence shifts every later push. Run the **whole file** after every GC task, not only `-t`.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "exit $?"`. Do not pipe it to `tail`, because that hides an OOM as a pass.

## Global Constraints

- Logical keys (`snapshots/<id>/...`) are never changed anywhere: not in manifests, the attestation statement, `backupObjectKey.ts`, the shared vectors, session `control_keys`, or `backup_storage_session_uploads.object_key`.
- Physical keys are computed only via `physicalKeyFor` / `logicalKeyFrom` / `physicalSnapshotRootPrefix` from `backupKeyLayout.ts`. Never concatenate a prefix inline.
- `providerConfig.prefix` is read only by `keyRootForNewSnapshot` (mint) and by `validateS3Details` / the connection probe.
- The prefix rules are exactly those in `normalizeBackupDestinationPrefix`: max 256 chars, S3 safe characters per segment, no `''`/`.`/`..` segment, no `snapshots` segment (case-insensitive).
- `normalizeStorageIdentity` is unchanged. The prefix is NOT part of the storage identity (Open Decision 1).
- `provider = 'local'` always means `legacy_flat` / `NULL`.
- Migration DDL only, idempotent, no inner `BEGIN/COMMIT`, sorted after the newest committed migration.
- Every new web string goes into all 7 locales (`apps/web/src/locales/*/policies.json`). The parity test lives in `src/lib/i18n`.

## Review Focus

1. **A destination prefix edited while a job is mid-flight.** Expected: the redelivered or resumed session keeps writing the reservation's original root (I2). The next dispatch takes a full backup under the new root. Pinned in W01 Task 4 (redelivery test) and W02 Task 4 (base scoping).
2. **A shared MSP bucket where org A has no prefix and org B uses prefix `orgB`.** Expected: GC and reconcile for A never list or delete under `orgB/snapshots/`, and B's never under bucket-root `snapshots/`. Pinned in W02 Task 2 (MinIO/real-Postgres two-root GC test) and W02 Task 3.
3. **An existing config whose stored prefix fails the new rules** (`a//b`, `snapshots`, spaces, unicode). Expected: the save path rejects it with a specific message. At mint after W03, the backup is refused with `invalid_destination_prefix` and an actionable message, never silently written to the bucket root. Pinned in W01 Task 2 and W03 Task 1. The production audit query is in W03 Task 0.
4. **A restore, file browse or BMR token-mode download of a prefixed incremental whose base is also prefixed.** Expected: every external ref resolves via the origin row's root. A tampered or mismatched origin root is refused (I4/I5). Pinned in W01 Task 5.
5. **An attestation for a prefixed snapshot.** Expected: the statement (`keyLayout: legacy_flat`, logical keys) is accepted, binds, and verifies by fetching the physical control objects. A statement claiming any other layout is still rejected. Pinned in W01 Task 6.

---

# Wave W01: key-root model, migration, and every direct reader (behaviour-neutral)

**Ships:** migration, primitives, prefix validation on save, and every direct reader and writer-plumbing site resolving physical keys through the recorded root. **Behaviour change:** none for existing data. Configs saved with an invalid prefix are now rejected (Task 2). **No code path writes `prefixed_flat`.** Mint's root is hard-wired to `LEGACY_FLAT_ROOT` via `resolveMintKeyRoot` (Task 4) until W03.

**GC gate (Task 1).** W01 adds `prefixed_flat` to `BACKUP_KEY_LAYOUTS` (readable) but introduces `GC_SUPPORTED_KEY_LAYOUTS = ['legacy_flat']`, which GC uses at `backupRetention.ts` ~535/593/2317-2326/2472. W02 widens it. A `prefixed_flat` row that appears early (a bug, or a hand edit) therefore makes GC skip that identity, as unknown layouts do today. It is never swept by a root-blind GC.

### Task 1: Prefix validator and key-root primitives

**Files:**
- Create: `packages/shared/src/validators/backupDestinationPrefix.ts`, `packages/shared/src/validators/backupDestinationPrefix.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (export)
- Modify: `apps/api/src/services/backupKeyLayout.ts` (full content in "Shared primitives" above, plus `GC_SUPPORTED_KEY_LAYOUTS` and `isGcSupportedKeyLayout`)
- Create: `apps/api/src/services/backupKeyLayout.test.ts`

**Interfaces:**
- Produces: `normalizeBackupDestinationPrefix(raw: unknown): BackupDestinationPrefixResult`, `BACKUP_DESTINATION_PREFIX_MAX_LENGTH` (from `@breeze/shared`); and `SnapshotKeyRoot`, `LEGACY_FLAT_ROOT`, `snapshotKeyRootOf`, `keyRootForNewSnapshot`, `physicalKeyFor`, `logicalKeyFrom`, `physicalSnapshotRootPrefix`, `keyRootId`, `logicalKeyLayout`, `PHYSICAL_KEY_MAX_BYTES`, `physicalKeyFits`, `isSupportedKeyLayout`, `GC_SUPPORTED_KEY_LAYOUTS`, `isGcSupportedKeyLayout` (from `backupKeyLayout.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/backupDestinationPrefix.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeBackupDestinationPrefix as n } from './backupDestinationPrefix';

describe('normalizeBackupDestinationPrefix', () => {
  it.each([
    [undefined, null], [null, null], ['', null], ['  /  ', null],
    ['tenant-a', 'tenant-a'], ['/tenant-a/', 'tenant-a'], ['a/b.c/d_e', 'a/b.c/d_e'],
    ['  msp/acme  ', 'msp/acme'],
  ])('accepts %j -> %j', (raw, prefix) => {
    expect(n(raw)).toEqual({ ok: true, prefix });
  });
  it.each([
    [42, 'not_a_string'],
    ['a//b', 'empty_or_dot_segment'], ['a/./b', 'empty_or_dot_segment'], ['..', 'empty_or_dot_segment'],
    ['a b', 'unsafe_characters'], ['ä', 'unsafe_characters'], ['a\0b', 'unsafe_characters'], ['a\\b', 'unsafe_characters'],
    ['snapshots', 'reserved_segment'], ['x/Snapshots/y', 'reserved_segment'],
    ['a'.repeat(257), 'too_long'],
  ])('rejects %j (%s)', (raw, reason) => {
    expect(n(raw)).toEqual({ ok: false, reason });
  });
});
```

```ts
// apps/api/src/services/backupKeyLayout.test.ts
import { describe, expect, it } from 'vitest';
import {
  LEGACY_FLAT_ROOT, keyRootForNewSnapshot, logicalKeyFrom, physicalKeyFor,
  physicalSnapshotRootPrefix, snapshotKeyRootOf, isGcSupportedKeyLayout, isSupportedKeyLayout, physicalKeyFits,
} from './backupKeyLayout';

const P = { layout: 'prefixed_flat', prefix: 'msp/acme' } as const;

describe('backupKeyLayout', () => {
  it('legacy_flat is the identity mapping', () => {
    expect(physicalKeyFor(LEGACY_FLAT_ROOT, 'snapshots/s1/manifest.json')).toBe('snapshots/s1/manifest.json');
    expect(logicalKeyFrom(LEGACY_FLAT_ROOT, 'snapshots/s1/x')).toBe('snapshots/s1/x');
    expect(physicalSnapshotRootPrefix(LEGACY_FLAT_ROOT)).toBe('snapshots/');
  });
  it('prefixed_flat maps and strips under its own root only', () => {
    expect(physicalKeyFor(P, 'snapshots/s1/files/a')).toBe('msp/acme/snapshots/s1/files/a');
    expect(logicalKeyFrom(P, 'msp/acme/snapshots/s1/files/a')).toBe('snapshots/s1/files/a');
    expect(logicalKeyFrom(P, 'snapshots/s1/files/a')).toBeNull();
    expect(logicalKeyFrom(P, 'msp/acmeX/snapshots/s1/a')).toBeNull();
    expect(physicalSnapshotRootPrefix(P)).toBe('msp/acme/snapshots/');
  });
  it('snapshotKeyRootOf fails closed on inconsistent rows', () => {
    expect(snapshotKeyRootOf({ keyLayout: 'legacy_flat', keyPrefix: null })).toEqual(LEGACY_FLAT_ROOT);
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: 'msp/acme' })).toEqual(P);
    expect(snapshotKeyRootOf({ keyLayout: 'legacy_flat', keyPrefix: 'x' })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: null })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: '/msp/acme/' })).toBeNull(); // not stored normalized
    expect(snapshotKeyRootOf({ keyLayout: 'prefixed_flat', keyPrefix: 'snapshots' })).toBeNull();
    expect(snapshotKeyRootOf({ keyLayout: 'device_scoped', keyPrefix: null })).toBeNull();
  });
  it('keyRootForNewSnapshot: local and empty prefix are legacy; invalid refuses', () => {
    expect(keyRootForNewSnapshot('local', { path: '/x', prefix: 'p' })).toEqual({ ok: true, root: LEGACY_FLAT_ROOT });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b' })).toEqual({ ok: true, root: LEGACY_FLAT_ROOT });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b', prefix: '/msp/acme/' })).toEqual({ ok: true, root: P });
    expect(keyRootForNewSnapshot('s3', { bucket: 'b', prefix: 'a//b' })).toEqual({ ok: false, reason: 'invalid_destination_prefix' });
  });
  it('physicalKeyFits checks the composed key in bytes', () => {
    expect(physicalKeyFits(physicalKeyFor(P, `snapshots/s1/${'a'.repeat(990)}`))).toBe(false);
    expect(physicalKeyFits(physicalKeyFor(LEGACY_FLAT_ROOT, `snapshots/s1/${'a'.repeat(990)}`))).toBe(true);
  });
  it('readable vs GC-supported sets diverge until W02', () => {
    expect(isSupportedKeyLayout('prefixed_flat')).toBe(true);
    expect(isGcSupportedKeyLayout('prefixed_flat')).toBe(false); // W02 Task 2 flips this assertion
    expect(isGcSupportedKeyLayout('legacy_flat')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found): `cd packages/shared && npx vitest run src/validators/backupDestinationPrefix.test.ts` and `cd apps/api && npx vitest run src/services/backupKeyLayout.test.ts`.
- [ ] **Step 3: Implement** the two modules exactly as in "Shared primitives". Add:
  ```ts
  export const GC_SUPPORTED_KEY_LAYOUTS = ['legacy_flat'] as const satisfies readonly BackupKeyLayout[];
  export function isGcSupportedKeyLayout(v: unknown): boolean {
    return typeof v === 'string' && (GC_SUPPORTED_KEY_LAYOUTS as readonly string[]).includes(v);
  }
  ```
  Rewrite the module doc comment: two readable layouts, root disjointness (I3), and the GC split.
- [ ] **Step 4: Switch GC's layout gate to `isGcSupportedKeyLayout` / `GC_SUPPORTED_KEY_LAYOUTS`** at `backupRetention.ts` ~33, ~535, ~593, ~2317-2326 (the `notInArray(..., [...BACKUP_KEY_LAYOUTS])` becomes `GC_SUPPORTED_KEY_LAYOUTS`). Add a `backupRetention.test.ts` case: one `prefixed_flat` row on an identity, then the identity is reported `unsupported_key_layout` and nothing is listed or deleted. Run the **whole** file.
- [ ] **Step 5: Run all three suites, expect PASS. Typecheck. Commit** `feat(backup): key-root primitives and destination prefix validator (#7081)`.

### Task 2: Validate the prefix on every config write

**Files:**
- Modify: `apps/api/src/routes/backup/schemas.ts:32` (`validateS3Details`)
- Modify: `apps/api/src/routes/backup/configs.ts:95` (probe uses the normalized value)
- Test: `apps/api/src/routes/backup/schemas.test.ts` (create if absent), `apps/api/src/routes/backup/configs.test.ts`

**Interfaces:** Consumes `normalizeBackupDestinationPrefix`. Produces `validateS3Details(details)`, which now returns `{ error, region, endpoint, prefix: string | null }` and, on a bad prefix, `error: 'Invalid key prefix: <human reason>'`.

- [ ] **Step 1: Failing tests.** `validateS3Details({ bucket: 'b', region: 'us-east-1', prefix: 'a//b' }).error` matches `/Invalid key prefix/`. `prefix: 'snapshots'` gives an error naming the reserved segment. `prefix: '/acme/'` gives no error and `prefix: 'acme'`. A route test shows POST and PATCH `/backup/configs` with `details.prefix: 'a b'` return 400, and that `details.prefix: '/acme/'` is **stored as `acme`**.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `validateS3Details`, call `normalizeBackupDestinationPrefix(details.prefix)`. Map the reasons to messages:

  | reason | message |
  |---|---|
  | `not_a_string` | `must be text` |
  | `too_long` | `must be at most 256 characters` |
  | `empty_or_dot_segment` | `must not contain empty, "." or ".." segments` |
  | `unsafe_characters` | `may only contain letters, digits and ! _ . * ' ( ) - separated by /` |
  | `reserved_segment` | `must not contain a "snapshots" segment` |

  At both call sites (`configs.ts:206`, `:434`), write the normalized prefix back into `details`, or delete the key when it is `null`. `aiToolsPolicyPrereqs.ts:104` gets the error for free. **The AI create and update tools bypass `validateS3Details`.** They call `resolveS3ProviderConfig` at `aiToolsPolicyPrereqs.ts:1006` (create) and `:1106` (update, after `preserveSecretFields`). Make `resolveS3ProviderConfig` run the same prefix normalization and error. Add tests showing that both AI tools reject `prefix: 'snapshots'` and store `/acme/` as `acme`.
- [ ] **Step 4: Sweep other writers of `providerConfig.prefix`:** `grep -rn "prefix" apps/api/src/routes/backup apps/api/src/services/aiTools*Backup* apps/api/src/services/configurationPolicy*.ts | grep -v test`. Any path that persists S3 `providerConfig` without `validateS3Details` gets the same call. Mint re-validates anyway (W03 Task 1), so a missed writer fails closed.
- [ ] **Step 5: Run tests and typecheck, then commit** `feat(backup): validate destination key prefix on save (#7081)`.

### Task 3: Migration, Drizzle schema, export policy

**Files:**
- Create: `apps/api/migrations/<sorted-name>-backup-snapshot-key-prefix.sql` (content under "Schema" above, including the three database-enforced bindings)
- Modify: `apps/api/src/db/schema/backupSnapshotIdReservations.ts`, `apps/api/src/db/schema/backup.ts` (`backupSnapshots.keyPrefix`, `backupSnapshotRetirements.keyLayout/keyPrefix`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:261-263`
- Create: `apps/api/src/__tests__/integration/backupKeyPrefixSchema.integration.test.ts`

- [ ] **Step 1: Failing integration test** (real Postgres, system context). It asserts:
  - (a) inserting a `backup_snapshots` row with `key_layout='prefixed_flat', key_prefix=NULL` fails with `23514`;
  - (b) `legacy_flat` + `key_prefix='x'` fails with `23514`;
  - (c) `prefixed_flat` + `'msp/acme'` succeeds;
  - (d) `key_prefix='/x'` and `'a//b'` fail with `23514`;
  - (e) the same three checks on `backup_snapshot_id_reservations` and `backup_snapshot_retirements`;
  - (f) re-applying the migration file (`readFileSync` + `sql.unsafe`) is a no-op;
  - (g) `UPDATE ... SET key_prefix = 'other'` on each of the three tables raises (immutability);
  - (h) inserting a `backup_snapshots` row for a reserved id whose reservation is `prefixed_flat`/`P` but whose row says `legacy_flat` raises `23505`/`backup_snapshot_id_reservations_pkey`, and the matching pair succeeds;
  - (i) inserting a snapshot row with no reservation synthesizes one carrying the row's pair;
  - (j) deleting a `prefixed_flat` snapshot row under an erasure context records `key_layout`/`key_prefix` on its `backup_erasure_targets` row. Reuse the setup from `backupErasureFence*.integration.test.ts`.

  Use the row builders in `backupStorageWriteSessions.integration.test.ts` / `restoreIntegrityFixture.ts`.
- [ ] **Step 2: Run, expect FAIL:** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/backupKeyPrefixSchema.integration.test.ts`.
- [ ] **Step 3: Implement** the migration, the Drizzle columns (`keyLayout: text('key_layout').notNull().default('legacy_flat')`, `keyPrefix: text('key_prefix')`), and the export-policy `included` additions.
- [ ] **Step 4: Verify:**
  - `pnpm db:migrate && pnpm db:check-drift` (no drift);
  - `scripts/check-migration-naming.sh --staged`;
  - `npx vitest run src/db/autoMigrate.test.ts`;
  - the new suite;
  - `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts`.

  All must pass.
- [ ] **Step 5: Commit** `feat(backup): key_prefix columns and prefixed_flat layout CHECK (#7081)`.

### Task 4: Reservation root and write-session I/O plumbing (R1–R4, R13)

**Files:**
- Modify: `apps/api/src/services/backupSnapshotIdReservations.ts` (`reserveNewSnapshotId` takes `keyRoot: SnapshotKeyRoot`; `loadReservation` / `findReservedForJob` return `keyRoot`)
- Modify: `apps/api/src/services/backupStorageWriteSessions.ts` (mint; `resolveWriteSessionObjects`; multipart create/complete/abort; `listWriteSessionPrefix`; `deleteWriteSessionKeys`; `resumeWriteSession`)
- Modify: `apps/api/src/services/backupStorageWriteDelivery.ts:92` (base manifest key unchanged; the base root is resolved inside `resolveWriteSessionObjects`)
- Test: `apps/api/src/services/backupStorageWriteSessions.test.ts`, `apps/api/src/__tests__/integration/backupStorageWriteSessions.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces:
  - `resolveMintKeyRoot(provider, providerConfig): { ok: true; root: SnapshotKeyRoot } | { ok: false; reason: 'invalid_destination_prefix' }`. It is exported from `backupStorageWriteSessions.ts` and **returns `{ ok: true, root: LEGACY_FLAT_ROOT }` unconditionally in W01/W02**. W03 Task 1 replaces its body with `keyRootForNewSnapshot`.
  - `WriteSessionDeps.resolveMintKeyRoot` (injectable, so tests can force a prefixed root).
  - `loadReservationKeyRoot(snapshotId): Promise<SnapshotKeyRoot | null>`.

- [ ] **Step 1: Failing unit tests.** Use the existing `fakeDeps()` pattern with `deps.resolveMintKeyRoot = () => ({ ok: true, root: { layout: 'prefixed_flat', prefix: 'msp/acme' } })`. Assert:
  1. Presigned PUT for logical `snapshots/<id>/files/a` is called with key `msp/acme/snapshots/<id>/files/a`.
  2. `createMultipartUpload`, `completeMultipartUpload` and `abortMultipartUpload` get the physical key, while `backup_storage_session_uploads.object_key` stores the **logical** key.
  3. `listWriteSessionPrefix('snapshots/<id>/')` calls `listKeys` with `msp/acme/snapshots/<id>/` and returns `['snapshots/<id>/files/a']` to the helper. A physical key not under the root (a fake returning `snapshots/<id>/x`) is dropped and logged, never returned.
  4. `deleteWriteSessionKeys` deletes physical keys.
  5. The authorization helpers (`authorizeWriteKey`, `isAllowedWriteListPrefix`) still take and reject **logical** keys exactly as before (existing tests unchanged).
  6. **Redelivery (Review Focus 1).** Mint once with root P, then mint again for the same job with `resolveMintKeyRoot` returning `LEGACY_FLAT_ROOT`. The second session reuses the reservation, and presigns still use P.
  7. **Resume / takeover.** `resumeWriteSession` onto an earlier reservation with root P aborts and lists under P even when the current mint root is legacy. This is intended. An unfinished full-backup journal from before a prefix edit may legitimately be resumed (both dispatched bases are null; `decideResumeTarget` ~1222-1233), and it finishes under its **original** root. So "the first run after an edit uses the new root" holds for new reservations only. Document this in the `resumeWriteSession` doc comment.
  8. **Base GET.** With a base snapshot row `prefixed_flat`/`msp/acme`, resolving the control key `snapshots/<base>/manifest.json` presigns `msp/acme/snapshots/<base>/manifest.json`. A base row whose root fails `snapshotKeyRootOf` makes resolve return `{ status: 409, code: 'base_key_root_invalid' }`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `reserveNewSnapshotId` writes `keyLayout`/`keyPrefix` from `keyRoot`.
  - In mint, call `deps.resolveMintKeyRoot` **only** in the `else` (new reservation) branch. On `{ ok: false }` return `{ mode: 'unbrokered', reason: 'invalid_destination_prefix' }` and record the metric. The redelivery branch reads `existing.keyRoot`.
  - A composed physical key that fails `physicalKeyFits` is refused per key with `{ status: 400, code: 'key_too_long' }`, before any presign. The logical-key checks are unchanged.
  - Every storage call in the write session obtains `root = snapshotKeyRootOf(reservationRow)`. A `null` root revokes the session with reason `key_root_invalid` (410), and the call passes `physicalKeyFor(root, key)`.
  - Listings map back with `logicalKeyFrom` and drop `null`s.
  - Add `invalid_destination_prefix` and `key_root_invalid` to `backupWriteRefusalMessage` (`backupStorageWriteDelivery.ts`). Message for the former: `"The backup destination's key prefix is invalid. Edit the destination and save a valid prefix."`
- [ ] **Step 4: Integration test.** In `backupStorageWriteSessions.integration.test.ts`, add a case that mints with a forced prefixed root and asserts that the reservation row has `key_layout='prefixed_flat', key_prefix='msp/acme'` against real Postgres. Then a second mint on the same job keeps it. Run the unit and integration suites. They must pass, and every pre-existing case must stay green. That is the "no-op for legacy" proof.
- [ ] **Step 5: Commit** `feat(backup): write sessions resolve physical keys from the reservation's key root (#7081)`.

### Task 5: Read sessions, recovery downloads and file index (R5, R6, R11)

**Files:**
- Modify: `apps/api/src/services/backupStorageSessions.ts` (mint gate ~807, `resolveStorageSessionObjects` ~1006-1121)
- Modify: `apps/api/src/services/backupStorageSessionStore.ts` (`loadVerifiedOrigins` ~206 also selects the origin snapshot row's `keyLayout`/`keyPrefix`)
- Modify: `apps/api/src/services/recoveryDownloadService.ts` (`getAuthenticatedRecoveryDownloadTarget`, `deriveRemoteStorageKey`, `authorizeExternalReference`)
- Modify: `apps/api/src/services/backupSnapshotFileIndex.ts` (~413, ~461, ~516)
- Test: `backupStorageSessions.test.ts`, `recoveryDownloadService.test.ts`, `backupSnapshotFileIndex.test.ts`; integration `backupStorageSessions.integration.test.ts`

**Interfaces:** Produces `loadOriginKeyRoots(storageIdentity, orgId, deviceId, originIds): Promise<Map<string, SnapshotKeyRoot>>` (live row, else unswept-or-swept retirement row; an invalid pair is omitted, so the ref fails closed). Produces `resolveSnapshotPhysicalKey(input: { ownRoot: SnapshotKeyRoot; ownSnapshotId: string; logicalKey: string; originRoots: Map<string, SnapshotKeyRoot> }): string | null`, a pure function in `backupKeyLayout.ts`. It classifies the key with `classifyBackupObjectKey`. `own` maps under `ownRoot`. `external` maps under `originRoots.get(originSnapshotId)` and returns `null` if that is missing or differs from `ownRoot` (I4).

- [ ] **Step 1: Failing tests.**
  - `resolveSnapshotPhysicalKey`: own legacy → identity; own P → `P/...`; external with origin root P and own P → `P/snapshots/<origin>/...`; external whose origin root is missing → `null`; external with origin legacy but own P → `null`.
  - Read session: a `prefixed_flat` snapshot presigns `P/snapshots/<id>/manifest.json`. A row whose root is invalid makes the read-session mint return `unbrokered` / `key_layout_unsupported` (reuse the existing reason).
  - Recovery download: the S3 branch for a `prefixed_flat` snapshot presigns `P/snapshots/<id>/files/x`. **`metadata.storagePrefix` on a `prefixed_flat` row is ignored**: set it to `evil/snapshots/<id>` and assert it is not used. A `legacy_flat` row keeps today's behaviour (all existing tests unchanged).
  - File index: hydration fetches the manifest at the physical key and writes origins. Root resolution uses the origin **row** root, not `origin_storage_prefix`.
  - **Origin roots are enforced, not just resolved (quorum finding).** Hydration (`backupSnapshotFileIndex.ts` ~505-525) accepts a live origin by org, device and identity, and a retired origin from `backup_snapshot_retirements`. Neither check looks at the root today. Each must also require the origin's root to equal the snapshot's own root, taking the live row's pair or the retirement row's pair (added in W01 Task 3). On a mismatch, `file_index_status = 'error'` with `file_index_error = 'origin_key_root_mismatch'`, and no origins are written.
  - The read-session external-key path (`backupStorageSessionStore.ts` `loadVerifiedOrigins` ~206) applies the same rule. A recorded origin whose root differs from the snapshot's root is not granted.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Load `keyLayout`/`keyPrefix` with every snapshot row these paths already load (`backupStorageSessionStore.ts:35` already selects `keyLayout`; add `keyPrefix`).
  - Replace the `isSupportedKeyLayout` gates with `snapshotKeyRootOf(row) !== null`.
  - `deriveRemoteStorageKey` becomes a thin wrapper. For `legacy_flat` it keeps the existing `metadata.storagePrefix` / `originStoragePrefix` behaviour **byte-for-byte**, which keeps this wave a no-op. For `prefixed_flat` it uses `resolveSnapshotPhysicalKey`.
  - The local branch is unchanged, because local is always legacy.
- [ ] **Step 4: Run the unit suites plus `backupStorageSessions.integration.test.ts` and `backupRestoreAuthorizations.integration.test.ts`. Typecheck.**
- [ ] **Step 5: Commit** `feat(backup): snapshot readers resolve physical keys from the recorded key root (#7081)`.

### Task 6: Attestation, immutability, deletion and display (R7, R9, R10, R12)

**Files:**
- Modify: `apps/api/src/services/backupAttestationVerify.ts` (~189 binding, ~200-215 fetch), `apps/api/src/services/backupAttestation.ts` (binding at record time, if it compares layout)
- Modify: `apps/api/src/services/backupSnapshotStorage.ts` (`normalizeStoragePrefix` → `snapshotStoragePrefixFor(row)`; `applyBackupSnapshotImmutability` / `deleteBackupSnapshotArtifacts` take `keyLayout`/`keyPrefix` in `SnapshotStorageInput`)
- Modify: `apps/api/src/services/backupResultPersistence.ts:1826-1840`, `apps/api/src/routes/backup/snapshots.ts:575,738`
- Test: `backupAttestationVerify.test.ts`, `backupSnapshotStorage.test.ts`, `routes/backup/snapshots.test.ts`, `backupRestoreIntegrity.test.ts`

- [ ] **Step 1: Failing tests.**
  - Restore integrity (`backupRestoreIntegrity.ts:105`): `prefixed_flat` snapshot plus `legacy_flat` attestation counts as bound.
  - Verify: snapshot `prefixed_flat`/`P` with an attestation row `key_layout='legacy_flat'` gives binding OK, and `fetchObject` is called with `P/snapshots/<id>/manifest.json`, then `verified`. Snapshot `device_scoped` gives `mismatch`/`binding_changed` (unchanged).
  - Accept: a statement whose `keyLayout` is anything but `legacy_flat` is still rejected (`unsupported_key_layout`).
  - Immutability: `prefixed_flat` lists and retains under `P/snapshots/<id>`. `metadata.storagePrefix` is ignored for `prefixed_flat`.
  - Snapshots route: `layoutManifestKey` in the response stays **logical** (assert unchanged).
  - Restore integrity: `controlObjectKey` output is unchanged (logical).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Binding: `logicalKeyLayout(snapshot.keyLayout) !== attestation.keyLayout` (`snapshot.keyLayout` already passed `snapshotKeyRootOf`). Apply it at **all three** comparison sites:
  - `backupAttestationVerify.ts:189` (pre-fetch binding);
  - `backupAttestationVerify.ts:~350` (the locked completion re-check);
  - `backupRestoreIntegrity.ts:105`.

  The completion re-check must also compare `(keyLayout, keyPrefix)` with the values used for the fetch. The immutability trigger makes a change impossible, and the explicit compare documents the dependency. Fetch: `physicalKeyFor(root, expectedControlKey(...))`. `snapshotStoragePrefixFor`: `prefixed_flat` gives `physicalKeyFor(root, 'snapshots/<id>')`; `legacy_flat` keeps today's `normalizeStoragePrefix`. Add a Global-Constraint comment above it that points at I1.
- [ ] **Step 4: Run the suites plus `backupStorageWriteSessions.integration.test.ts` (it exercises attestation verify). Typecheck.**
- [ ] **Step 5: Commit** `feat(backup): attestation and immutability honour the snapshot key root (#7081)`.

### Task 7: Publish copies the reservation root to the snapshot row (R8)

**Files:**
- Modify: `apps/api/src/services/backupResultPersistence.ts` (~1489-1534 `insertValues`, ~1629-1652)
- Test: `backupResultPersistence.test.ts`; integration `backupStorageWriteSessions.integration.test.ts` (publish path)

- [ ] **Step 1: Failing tests.**
  - Publish of a reserved id whose reservation is `prefixed_flat`/`P` inserts `backup_snapshots` with the same pair.
  - Publish of an id with no reservation (`legacy_published`/`legacy_job`) inserts `legacy_flat`/`NULL`.
  - An UPDATE of an existing row never changes `key_layout`/`key_prefix`.
  - **A helper result carrying `keyLayout` or `metadata.storagePrefix` cannot influence the columns.**
  - `location` for a `prefixed_flat` row is `P/snapshots/<id>`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Read the reservation inside the same transaction that already consults `backup_snapshot_id_reservations` for the conflict check, and set `keyLayout`/`keyPrefix` on `insertValues` from it. The reserve-id trigger (W01 Task 3) rejects a mismatch, so a wrong copy fails loudly with the existing `unique_violation` handling rather than writing a row under the wrong root. Add an integration case proving that.
- [ ] **Step 4: Run, expect PASS. Then run the full W01 regression:**
  - `cd apps/api && npx vitest run src/services/backup src/jobs/backup src/routes/backup`, checking the file count;
  - every `backup*` integration suite: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/backup`;
  - typecheck.
- [ ] **Step 5: Commit** `feat(backup): snapshot rows inherit the reservation key root at publish (#7081)`.

**W01 exit criteria:** every existing backup test passes unchanged. `grep -rn "'prefixed_flat'" apps/api/src --include='*.ts' | grep -v test` shows no writer outside `keyRootForNewSnapshot` (unreachable: `resolveMintKeyRoot` is hard-wired). PR body: `Closes #<W01 sub-issue>`, `Refs #7081`.

---

# Wave W02: GC, reconcile, janitor and base selection, per key root (behaviour-neutral)

**Ships:** GC and reconcile enumerate and process each `(storage identity, key root)` separately. Retirements carry the root. Dedupe base selection is root-scoped. `GC_SUPPORTED_KEY_LAYOUTS` gains `prefixed_flat`. **Behaviour change:** none (all rows are still legacy). The structural proof is that every pre-existing GC, reconcile and janitor test passes with a single `legacy` root.

### Task 1: Enumerate the key roots of a storage identity

**Files:**
- Create: `apps/api/src/services/backupKeyRoots.ts`, `apps/api/src/services/backupKeyRoots.test.ts`

**Interfaces:** Produces `listIdentityKeyRoots(input: { storageIdentity: string; configs: Array<{ provider: string; providerConfig: Record<string, unknown> }> }): Promise<{ roots: SnapshotKeyRoot[]; invalid: Array<{ source: string; keyPrefix: unknown }> }>`. It runs in a system DB context and its result is sorted by `keyRootId`. Roots are the union of:
- `LEGACY_FLAT_ROOT` (always);
- `SELECT DISTINCT key_layout, key_prefix` from `backup_snapshots`, `backup_snapshot_id_reservations` and `backup_snapshot_retirements` (`swept_at IS NULL`) for that `storage_identity`;
- `keyRootForNewSnapshot` of each current config in the group, so an orphan written under the current prefix before any row exists is still visited.

Rows whose root fails `snapshotKeyRootOf` go into `invalid`.

- [ ] **Step 1: Failing tests** (Drizzle mock pattern; see the `breeze-testing` skill):
  - legacy-only identity → `[legacy]`;
  - a prefixed snapshot plus a prefixed config with a different prefix → three roots, sorted;
  - a reservation-only prefixed root is included;
  - a swept retirement is excluded;
  - a corrupt row is reported in `invalid`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: PASS.** Step 5: commit `feat(backup): enumerate key roots per storage identity (#7081)`.

### Task 2: GC runs once per (identity, root)

**Files:**
- Modify: `apps/api/src/jobs/backupRetention.ts`:
  - `listStorageIdentityGroups` (~1620) takes `root`;
  - the identity loop (~2461+);
  - `relistGroup` (~1745);
  - `markLiveBackupObjects` (~1337-1440): manifest and control fetches go through `physicalKeyFor`, and the live set stays logical;
  - `deleteSelectedCandidates` (~1564): delete physical;
  - `reclaimUnrooted` (~1887);
  - the retirement insert (~407) copies `keyLayout`/`keyPrefix` from the snapshot row;
  - `loadIdentityGcState` filters rows to the root.
- Modify: `apps/api/src/services/backupKeyLayout.ts` (`GC_SUPPORTED_KEY_LAYOUTS = ['legacy_flat', 'prefixed_flat']`; flip the Task 1 W01 assertion)
- Create: `apps/api/src/__tests__/helpers/inMemoryS3.ts` and a test seam `__setBackupS3ClientFactoryForTests(factory | null)` in `backupSnapshotStorage.ts` (used by `buildS3StorageClient`; a no-op in production)
- Test: `backupRetention.test.ts` (whole file), new `apps/api/src/__tests__/integration/backupGcKeyRoots.integration.test.ts`

**Rules to implement (copy them into a doc comment above the root loop):**
1. List `physicalSnapshotRootPrefix(root)` once per `(physical identity, root)`. Strip every listed key with `logicalKeyFrom(root, key)`. A `null` result is an invariant breach: abort this root and log. The existing per-snapshot summarising, marking and age rules then run on **logical** keys unchanged.
2. The rows considered for a root are only those whose recorded root equals it: retained snapshots, retirements, `NULL`-identity rows, reservations and fences.
3. **Cross-root protection.** A snapshot id listed under root R that has a snapshot, reservation or retirement row naming a different root is never deleted. It is logged (`[BackupGC] identity <k> root <R>: snapshot <id> is recorded under root <R'> — protected`) and reported to Sentry once per run.
4. `listIdentityKeyRoots(...).invalid` non-empty → skip the whole identity for this run with reason `key_root_invalid`, the same posture as `unsupported_key_layout`.
5. **Cross-root external refs fail closed.** While marking a root's live set, if any manifest's external ref names an origin whose recorded root (live row, retirement or erasure target) differs from the current root, or has no resolvable root, then skip the **whole identity** for this run with reason `cross_root_reference`. Raise a Sentry error. I4 makes this unreachable by construction, and this rule is what keeps a bug from becoming data loss. (GC marks logical `backupPath` strings directly, ~1374, so a cross-root ref would otherwise protect nothing in the origin's root.)
6. **Absence is proven only by a root's own listing.** The retirement `swept_at` confirmation (~2000-2010, "no group at all for its snapshotId") and the abandoned-reservation reclaim (~2700-2712, `listedIdsByIdentityKey`) must test only against the listing of **the root the retirement or reservation records**, and only when that root's listing succeeded. Key `listedIdsByIdentityKey` by `${identity.key}::${keyRootId(root)}`. A listing of root A must never confirm a root-B record as gone.
7. **Foreign-owner checks stay bucket-wide.** `foreignOwnedSnapshotIds` and the run-start owner map are computed across all roots of the physical identity, exactly as today. Only storage I/O is partitioned.
8. **Erasure fences carry roots.** `resolveErasureFencedReferences` (~2186) reads a fenced snapshot's manifest under the root on its `backup_erasure_targets` row. A missing or invalid root counts as `unresolved` (existing fail-closed path). A manifest fetched under the wrong root never populates `fencedRefsCache`.
9. The deletion cap, the skip-set, coarse-collision detection (~942-1040) and the helper-version gate apply per `(identity, root)` unit. The coarse signature gains `::<keyRootId>`, so two configs on one bucket with different prefixes are not a "suspicious collision".

- [ ] **Step 1: Failing tests.**
  - Unit (`backupRetention.test.ts`):
    - (a) a legacy-only identity issues exactly the same listing call as before, with prefix `snapshots/`;
    - (b) an identity with roots `[legacy, P]` lists `snapshots/` and `P/snapshots/`, each once;
    - (c) a retired `prefixed_flat` snapshot's objects are deleted at physical `P/snapshots/<id>/...`;
    - (d) cross-root protection (rule 3);
    - (e) an invalid root skips the identity;
    - (f) a prefixed manifest whose external ref names a legacy-root origin skips the identity (`cross_root_reference`) and deletes nothing;
    - (g) a root-B retirement is **not** marked swept by a run whose root-B listing failed while root A listed fine;
    - (h) an abandoned root-B reservation is not reclaimed on the evidence of root A's listing.
  - Integration (`backupGcKeyRoots.integration.test.ts`, real Postgres + `inMemoryS3`; **Review Focus 2**). One bucket holds:
    - org A legacy snapshot `a1` (retained) and orphan `a2` (old, unreserved);
    - org B `prefixed_flat`/`orgB` snapshot `b1` (retained) and retired `b2`;
    - an object at `orgB/snapshots/a1/manifest.json`, i.e. A's id under B's root.

    After one GC run:
    - `a2` and `b2` are gone;
    - `a1` and `b1` are untouched;
    - `orgB/snapshots/a1/...` is untouched and logged;
    - no key outside `snapshots/` or `orgB/snapshots/` was listed or deleted (assert on the fake's call log).
- [ ] **Step 2: Run, expect FAIL.** Step 3: implement, keeping storage calls at depth 0 (`assertOutsideHeldDbContext`).
- [ ] **Step 4: Run the whole of `backupRetention.test.ts` plus `backupGcReclamation.integration.test.ts`, `backupRetentionPins.integration.test.ts` and the new suite. Typecheck.**
- [ ] **Step 5: Commit** `feat(backup): GC lists and sweeps per key root, never across (#7081)`.

### Task 3: Reconcile per root

**Files:** Modify `apps/api/src/services/backupSnapshotReconcile.ts` (~376, ~694, ~766-787, ~1024, ~1089). Test: `backupSnapshotReconcile.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Reconcile for a config with valid prefix P lists `P/snapshots/` **and** `snapshots/`. Both are roots this config's org may own, the latter for its pre-W03 snapshots.
  - A manifest-bearing orphan found under P is adopted with a `reconcile` reservation and a snapshot row recording `prefixed_flat`/`P`.
  - One found under `snapshots/` is adopted as `legacy_flat`.
  - `manifestToCommandResult` no longer sets `metadata.storagePrefix` for a `prefixed_flat` adoption (the row columns are authoritative).
  - A config with an invalid stored prefix reconciles the legacy root only and logs.
  - **Base acceptance is root-scoped.** The declared-base lookup (~1045-1058) accepts a live or retired base only if its root equals the root the orphan was found under. Otherwise the orphan is not adopted (`base_key_root_mismatch`, logged).
- [ ] **Step 2: FAIL. Step 3: Implement.** Thread `root` through `extractManifestBearingSnapshots` (it parses logical keys after `logicalKeyFrom`) and through the adoption path's reservation creation. The `coarseStorageIdentity` sharing test stays bucket-level. Sharing is about tenants on one bucket, and a prefix does not change it.
- [ ] **Step 4: PASS plus typecheck. Step 5: Commit** `feat(backup): reconcile adopts orphans per key root (#7081)`.

### Task 4: Dedupe base selection is root-scoped (I4)

**Files:** Modify `apps/api/src/jobs/backupWorker.ts` `stampDispatchPinAndIdentity` (~1140-1336) and `apps/api/src/services/backupStorageWriteSessions.ts` (mint). Test: `backupWorker.test.ts`; integration `backupRetentionPins.integration.test.ts` or a new `backupBaseKeyRoot.integration.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `stampDispatchPinAndIdentity` computes `root = resolveMintKeyRoot(provider, providerConfig)` and adds `eq(keyLayout, root.layout)` and `root.prefix === null ? isNull(keyPrefix) : eq(keyPrefix, root.prefix)` to `eligible`. With the newest candidate on another root and an older one on the same root, the older one is pinned. With none on the same root, the job gets no base (a full backup).
  - An invalid prefix gives no base. Mint refuses later.
  - Mint: when the job's `base_snapshot_id` row has a root different from the new reservation's root (a prefix edit raced between dispatch and delivery), mint returns `{ mode: 'unbrokered', reason: 'base_key_root_mismatch' }` and records the metric. `backupWriteRefusalMessage('base_key_root_mismatch')` reads `"The destination's key prefix changed after this backup was scheduled. The next scheduled run will take a full backup under the new prefix."`
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS plus the integration test** (real Postgres, two snapshots on different roots, assert the pinned base). **Step 5: Commit** `feat(backup): dedupe base must share the run's key root (#7081)`.

### Task 5: Janitor and erasure fences per root (R16, R17)

**Files:** Modify `apps/api/src/jobs/backupWriteSessionJanitor.ts` (~136-170, ~282-322) and `apps/api/src/services/backupErasureFence.ts`. Test: `backupWriteSessionJanitor.test.ts`, `backupErasureFence.test.ts`, integration `backupStorageWriteSessions.integration.test.ts` (janitor cases).

- [ ] **Step 1: Failing tests.**
  - `sweepFinishedPrefixes` for a `prefixed_flat` reservation lists multipart uploads under `P/snapshots/<id>/` and aborts physical keys.
  - `abortRecordedUploads` maps the logical `object_key` through the reservation root.
  - A reservation with an invalid root is skipped and logged, never swept at the bucket root.
  - Erasure-fence manifest reads use the fenced snapshot's recorded root.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS plus the whole-W02 regression** (`npx vitest run src/jobs/backup src/services/backup`, every `backup*` integration suite, typecheck). **Step 5: Commit** `feat(backup): janitor and erasure fences resolve the reservation key root (#7081)`.

**W02 exit criteria:** every existing GC, reconcile and janitor test passes unchanged. The two-root integration suite passes. PR body: `Closes #<W02 sub-issue>`, `Refs #7081`.

---

# Wave W03: turn the writer on, guard BMR direct mode, UI, lab verification

**Precondition (hard):** the release containing W01+W02 is deployed to EU and US, and parity is confirmed with the version-skew check in CLAUDE.md. W03 merges only after that. Record the release tag in the PR body.

### Task 0: Production audit of existing prefixes (read-only, before merge)

- [ ] Run on each region (Todd/ops, read-only, as `breeze` in psql):
  ```sql
  SELECT org_id, id, provider_config->>'prefix' AS prefix
  FROM backup_configs
  WHERE provider = 's3' AND coalesce(provider_config->>'prefix', '') <> '';
  ```
  Run the result through `normalizeBackupDestinationPrefix` (a short `tsx` one-off locally; do not commit the data). Record in the PR only the **counts** of valid, normalizable and invalid prefixes. No org names: the repo is public. Invalid prefixes get the Open Decision 4 treatment before merge.

### Task 1: Mint records the destination root

**Files:** Modify `apps/api/src/services/backupStorageWriteSessions.ts` (`resolveMintKeyRoot` body → `return keyRootForNewSnapshot(provider, providerConfig);`) and `apps/api/src/jobs/backupWorker.ts` (it already calls `resolveMintKeyRoot`; no change). Test: `backupStorageWriteSessions.test.ts`, `backupStorageWriteDelivery.test.ts`.

- [ ] **Step 1: Failing tests.**
  - An S3 config with `prefix: 'msp/acme'` → the reservation is `prefixed_flat`/`msp/acme`, and the PUT presign key is `msp/acme/snapshots/<id>/...`.
  - No prefix → `legacy_flat` (and the existing tests are untouched).
  - `prefix: 'a//b'` → `refused` with the `invalid_destination_prefix` message (**Review Focus 3**).
  - Local → `legacy_flat`.
  - **Capability probe under the prefix.** `probeConditionalWrites` (`backupStoragePresign.ts` ~359) writes `breeze-capability-probe/<uuid>` at the bucket root. That fails, or answers for the wrong policy, on a credential scoped to `bucket/<prefix>/*`. When the destination has a valid prefix, probe at `<prefix>/breeze-capability-probe/<uuid>`. That location is outside `<prefix>/snapshots/`, so it is invisible to GC. Test it with a fake that records the PUT key.
- [ ] **Step 2: FAIL. Step 3: Implement** (one-line body swap plus the probe key; delete the "hard-wired until W03" comment). **Step 4: PASS. Step 5: Commit** `feat(backup): apply the destination prefix to new S3 snapshots (#7081)`.

### Task 2: Refuse BMR direct mode for prefixed snapshots (R19)

**Files:** Modify `apps/api/src/routes/backup/bmr.ts` (~1477) and `apps/api/src/routes/backup/bmrRecoveries.ts` (~446). Test: `bmr.test.ts`, `bmrRecoveries.test.ts`.

> Quorum correction: the authenticated bootstrap already builds a `Download` descriptor for any non-empty snapshot id and strips provider credentials (`recoveryBootstrap.ts` ~474/494). Raw config passed into the builder is not emitted unchanged. This task is therefore a **defensive** guard against a future regression, not a fix for a live hole.

- [ ] **Step 1: Failing tests.** Building a bootstrap for a `prefixed_flat` snapshot never includes raw `providerConfig`. If the token-mode `Download` descriptor cannot be issued, the route returns 409 `{ code: 'recovery_requires_token_mode' }` with the message `"This snapshot uses a key prefix and can only be recovered with token-mode download. Update the recovery media."` A legacy snapshot is unchanged.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `feat(backup): guard BMR bootstrap so prefixed snapshots are token-mode only (#7081)`.

### Task 3: UI copy, inline validation, docs, comment cleanup

**Files:**
- `apps/web/src/components/configurationPolicies/featureTabs/BackupDestinationSection.tsx:718`
- `apps/web/src/locales/*/policies.json` (all 7)
- `apps/api/src/services/backupSnapshotStorage.ts` (replace the KNOWN GAP block above `backupSnapshotRootPrefix` with a pointer to `backupKeyLayout.ts`)
- `apps/api/src/services/recoveryDownloadService.ts:175-244` comments
- `apps/docs/` backup destination page (use the `update-breeze-docs` skill)

- [ ] **Step 1: Failing test.** A web component test shows that entering `a//b` renders the validator's message inline and disables save. The help text reads (en): `"Key prefix for this destination. New snapshots are stored under <prefix>/snapshots/. Existing snapshots stay where they are. Changing it makes the next backup a full backup."`
- [ ] **Step 2: FAIL. Step 3: Implement** with `normalizeBackupDestinationPrefix` from `@breeze/shared`. Add the new key to all 7 locales. Run `apps/web` `src/lib/i18n` parity plus the component test.
- [ ] **Step 4: PASS. Step 5: Commit** `feat(web): explain and validate the backup destination key prefix (#7081)`.

### Task 4: End-to-end round trip (CI) and MinIO lab verification

- [ ] **CI test:** `apps/api/src/__tests__/integration/backupKeyPrefixRoundTrip.integration.test.ts` (real Postgres + `inMemoryS3`). On one destination:
  1. A legacy snapshot is published (pre-existing).
  2. The prefix is set to `tenant-a`.
  3. A brokered write mints, uploads the manifest and two files via the presigned keys (the fake records the physical keys), and publishes.
  4. Assert: the new row is `prefixed_flat`/`tenant-a`, the objects are at `tenant-a/snapshots/<id>/...`, the legacy objects are untouched.
  5. A read session resolves and fetches every object of **both** snapshots.
  6. Attestation verify returns `verified` for the new one.
  7. Retention retires the legacy snapshot, and GC deletes only `snapshots/<legacy>/...`.
  8. A second run with a base pins only the `tenant-a` snapshot.
- [ ] **Lab (MinIO, worktree stack via the `worktree-stack` skill, a real helper on a lab VM; never on a host with the installed agent).** Record each result in the PR:
  1. A destination with no prefix: backup → objects at `snapshots/` (regression).
  2. Set the prefix to `lab-7081`, then "Test connection" → OK, and a probe object is written under `lab-7081/`.
  3. Backup → a full run. `mc ls -r minio/<bucket>/lab-7081/snapshots/` shows the snapshot. Bucket-root `snapshots/` has no new id.
  4. Second backup → incremental against step 3's snapshot.
  5. File-level restore from step 1's (legacy) and step 4's (prefixed) snapshots.
  6. BMR token-mode download of step 4's snapshot (bmr-recover, or the Restore-as-VM fetch).
  7. Change the prefix to `lab-7081b` → the next run is full under `lab-7081b/`. Both older snapshots still restore.
  8. Expire the step-3 snapshot (shorten retention) and run GC → only `lab-7081/snapshots/<step3>/` objects are removed (`mc ls` before and after).
  9. Reconcile: delete a test snapshot's row in the lab DB only, run reconcile, and check that it is re-adopted as `prefixed_flat`.
- [ ] **Commit** the test: `test(backup): prefixed and legacy snapshots round-trip end to end (#7081)`.

### Task 5: Follow-ups and release notes

- [ ] File an issue: "Agent legacy S3 paths (agent.yaml manager, `rebuild --provider-config`) ignore the destination prefix". Body: a key-prefix decorator on `agent/internal/backup/providers/s3.go`, and the operator must pass the snapshot's `key_prefix`. Link #7081.
- [ ] File an issue for the `origin_storage_prefix` double-`snapshots/` latent bug (see Sweep). Inferred and not reproduced; ask for a reproduction test first.
- [ ] Release-notes text for the W03 release. Self-hoster section: prefixed destinations now store new snapshots under `<prefix>/snapshots/`; the first backup afterwards is a full backup; IAM policies scoped to `bucket/snapshots/*` must include `bucket/<prefix>/snapshots/*`; existing snapshots are not moved.

**W03 exit criteria:** CI is green, including integration. The lab checklist passes 9/9. PR body: `Closes #<W03 sub-issue>`. `Closes #7081` goes only on this last wave.

---

## Open Decisions (approval ask)

Advisor quorum: Fable's position, then an independent `codex exec` review (read-only, `gpt-6-astra`, `xhigh`) on 2026-10-13. The record is below each decision.

1. **Is the prefix part of the storage identity?** **Recommend: no.** Keep `normalizeStorageIdentity` bucket-wide. That needs no backfill, keeps the read-session drift guard and the `(storage_identity, snapshot_id)` unique index (which stays stricter: bucket-wide), and separates roots through each snapshot's recorded `(key_layout, key_prefix)`. *Quorum: agree.*
2. **How are attestations handled for prefixed snapshots?** **Recommend: logical attestation (I6), no agent change.** The helper only ever sees logical keys, so its statement's `keyLayout: legacy_flat` is a true description of what it signed. The API compares `logicalKeyLayout(snapshot.keyLayout)` at all three binding sites, and immutability triggers pin the physical tuple. The alternative is to carry the layout in the write envelope and have the helper echo it, which needs a new statement format, an agent release and new shared vectors. It buys a signature over the physical root, but the helper does not know or control that root. *Quorum: agree, provided all three comparisons are updated and the tuple cannot change between fetch and record. Both are now in W01 Task 6 and the migration.*
3. **Where is the root recorded?** **Recommend: a new layout value `prefixed_flat` plus a typed `key_prefix` column on reservations, snapshots and retirements, bound by DB triggers.** The alternatives are a column alone or `metadata.storagePrefix`. With the new value, a reader that misses the sweep, or an older replica, fails closed instead of reading the bucket root. `metadata.storagePrefix` is helper-reported jsonb with different semantics. *Quorum: agree, and add DB enforcement: root immutability, reservation↔snapshot equality in the reserve-id trigger, and roots on `backup_erasure_targets`. All are folded into the W01 migration. Codex also noted that the value does not protect against pre-W01 writers, so a drain gate is added to Rollout.*
4. **What happens to existing configs whose stored prefix fails the new rules?** Options:
   - **(a) Refuse at mint with an actionable message** until an admin re-saves the destination. Fail-closed and visible, but those backups stop until it is fixed.
   - **(b) Fall back to `legacy_flat` with a warning.** Backups continue, but the prefix silently stays cosmetic for them.
   - **(c) Run a one-off normalization migration.**

   **Recommend (a) plus the W03 Task 0 audit before merge.** If the audit finds any invalid prefixes, notify those partners before W03 deploys. *Quorum: no position taken; codex agreed with the validation rules (D4) and added the composed-key byte limit.*
5. **Do existing prefixed destinations switch automatically at W03?** **Recommend: yes, automatically.** Every new snapshot on a destination with a prefix goes under `<prefix>/snapshots/`, which is what the field has always promised. Consequences: the first run is a full backup, and IAM policies scoped to `bucket/snapshots/*` must be widened. The connection test catches the latter, and the release notes call out both. The alternative is opt-in, either a per-destination toggle or applying only to configs saved after W03. That is safer for IAM but leaves a second, permanent "cosmetic prefix" mode. *Quorum: no position taken; Fable recommendation.*
6. **Do the agent legacy S3 paths get a prefix option in this feature?** These are the agent.yaml manager, `rebuild --provider-config`, and the standalone BMR direct mode. **Recommend: no.** File a follow-up issue (W03 Task 5) and document the limitation. These are operator-run tools with hand-supplied config, and the API never hands them a prefixed snapshot. *Quorum: agree ("documented standalone-agent limitation").*
7. **Wave order differs from the brief's expected shape.** The brief suggested W02 = writer and W03 = GC. **Recommend the order here:** W01 readers, W02 GC/reconcile/janitor/base scoping, W03 writer. No writer then exists before GC understands the layout, and W03 is gated on W01+W02 being deployed with pre-W01 replicas drained. *Quorum: agree. It also recommends keeping the separate readable vs GC-supported layout sets (W01 Task 1) even though they are not strictly needed, because they preserve GC's existing barrier for free.*

**Disagreements recorded.** Codex did not contradict any recommendation. It raised six gaps, all accepted and folded into the tasks:
- DB-level root binding and immutability;
- origin-root enforcement in file-index hydration, read-session grants and reconcile base acceptance;
- per-root evidence for retirement `swept_at` and the abandoned-reservation reclaim;
- roots on erasure targets;
- the composed physical key byte limit;
- the AI tools' `resolveS3ProviderConfig` and the bucket-root capability probe as missed sites.

It also corrected one factual premise: BMR bootstrap already forces token mode, so W03 Task 2 is now a defensive guard.

**Owner approved all recommendations 2026-10-13.**

## Self-review notes

- Spec coverage: the three-part scope in the issue comment maps as follows. (1) I/O-layer mapping: W01 Tasks 4-6. (2) Recording the layout at mint with readers taught first: W01 Tasks 3, 4 and 7, with the writer in W03 Task 1. (3) GC and reconcile per root: W02 Tasks 2 and 3. Agent legacy paths: Open Decision 6. Connection test: R22.
- Every Review Focus item names its owning task and test.
- Type names are consistent across tasks: `SnapshotKeyRoot`, `snapshotKeyRootOf`, `resolveMintKeyRoot`, `physicalKeyFor`, `logicalKeyFrom`, `keyRootId`, `GC_SUPPORTED_KEY_LAYOUTS`.
