# Incremental Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backup runs upload only changed files; unchanged files become manifest references to prior snapshots' objects; a server-side mark-and-sweep GC keeps retention safe.

**Architecture:** Per the approved spec `docs/superpowers/specs/2026-07-16-incremental-backups-design.md` (read it first — it is binding). Agent: fetch the newest prior manifest, apply the size+mtime/checksum-tiebreak decision table, emit reference entries (absolute `BackupPath` into older prefixes — restore/verify unchanged), fail-open to full backup. Server: `backup_jobs.referenced_size/referenced_files` columns + persistence + response; new GC phase in `backupRetention.ts` (mark from retained manifests, sweep unreferenced objects older than a 48 h grace window, fail-closed on mark errors). Web: savings line on completed jobs.

**Tech Stack:** Go (agent), Hono + Drizzle + Vitest (API), React (web).

## Global Constraints

- Backups have no production users: no v1-manifest compat shims, no migration of existing snapshots — but GC correctness is mandatory (fail-closed mark, 48 h grace, logged deletion counts).
- Dedupe never fails a run: ANY previous-manifest fetch/parse problem → loud log + full backup.
- Reference decision key = `journalLookupKey`-style originalPath-else-sourcePath (reuse; do not invent a second keying rule).
- Migration: `2026-07-16-z-backup-job-referenced.sql` (the `-z-` infix sorts after the earlier same-day backup migration), idempotent `ADD COLUMN IF NOT EXISTS`, no inner BEGIN/COMMIT.
- Go: `go test -race`, `go vet`, gofmt clean; API: Node 22.20.0, vitest green; every UPDATE on backup_jobs terminal-guarded as elsewhere.
- Commit per task with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task I1: Agent — reference decision engine (manifest v2)

**Files:**

- Modify: `agent/internal/backup/snapshot.go` (manifest struct + `createSnapshotWithProgress`), `agent/internal/backup/backup.go` (`RunBackupContext`: previous-manifest fetch + plumb into snapshot call)
- Create: `agent/internal/backup/incremental.go`, `agent/internal/backup/incremental_test.go`
- Test: `agent/internal/backup/snapshot_test.go` (two-run integration)

**Interfaces:**

- Produces (incremental.go):

```go
// previousManifest fetches the newest completed snapshot's manifest for this
// provider, or (nil, reason) when none is usable — the caller runs full.
func previousManifest(ctx context.Context, provider providers.BackupProvider) (*Snapshot, string)

// referenceDecision classifies one walked file against the previous manifest.
type referenceDecision int
const (
	decideUpload referenceDecision = iota
	decideReference
)
func decideFile(f backupFile, prev map[string]SnapshotFile) (referenceDecision, SnapshotFile)
```

  `decideFile` implements the spec's table: key via the SAME originalPath-else-sourcePath rule as `journalLookupKey`; size+mtime equal → reference; size equal + mtime differs → `sha256File(f.sourcePath)` vs entry checksum (hash error → upload); else upload. A reference result returns the manifest entry to append: old `BackupPath`+`Checksum`, current `Size/ModTime/Mode/SourcePath/OriginalPath`.

- `Snapshot` gains `FormatVersion int \`json:"formatVersion,omitempty"`and`BaseSnapshotID string json:"baseSnapshotId,omitempty"`; new snapshots set` FormatVersion: 2`and`BaseSnapshotID` when a previous manifest was used.
- `createSnapshotWithProgress` takes the prev map (nil = full): referenced files skip upload AND journaling, append their entry, and count bytes via the same locked `markDone` path (keepalive/progress just work). System-state staging files are never referenced (exclude any file whose sourcePath is under the run's staging dir — pass that dir in, or match the existing systemstate flag on backupFile if one exists; check and pick the cleanest).
- `Snapshot.UploadFailures` semantics unchanged; `Snapshot` gains `ReferencedFiles int` / `ReferencedBytes int64` (json:"-" like UploadFailures? NO — these go on the RESULT, not the manifest: keep them as return-side counters on BackupJob, json omitempty on the wire result only. Manifest stays clean.)
- `BackupJob` gains `ReferencedFiles int \`json:"referencedFiles,omitempty"`+`ReferencedBytes int64 json:"referencedBytes,omitempty"`populated in`RunBackupContext`.

- [ ] **Step 1: Failing decision-table unit tests** (`incremental_test.go`): table-driven — unchanged (ref), mtime-moved-checksum-equal (ref, refreshed mtime), mtime-moved-checksum-differs (upload), size-changed (upload), new file (upload), originalPath key match with differing sourcePaths (ref — VSS case), hash-error (upload).
- [ ] **Step 2: Run** `go test -race ./internal/backup/ -run TestDecideFile -v` — FAIL (undefined). **Step 3: Implement** `incremental.go`. **Step 4: Run** — PASS.
- [ ] **Step 5: Failing integration test** (`snapshot_test.go`): recording provider; run 1 full (3 files); mutate one file; run 2 with prev manifest → exactly 1 upload + manifest listing all 3 with 2 `BackupPath`s under run 1's prefix; deleted-file case (remove a file before run 2 → absent from manifest 2). Plus fetch-failure fallback test: provider whose List/Download errors → run proceeds full, `BaseSnapshotID` empty.
- [ ] **Step 6: Run** — FAIL. **Step 7: Wire** `previousManifest` into `RunBackupContext` (after walk, before snapshot; skip entirely when `SystemStateEnabled && len(paths)==0`) and the prev map through `createSnapshotWithProgress`. **Step 8: Run** `cd agent && go test -race ./internal/backup/... ./cmd/breeze-backup/... && go vet ./...` — PASS.
- [ ] **Step 9: Commit** — `feat(agent): incremental backups — reference unchanged files from previous snapshot manifest`

### Task I2: API — referenced columns end-to-end

**Files:**

- Create: `apps/api/migrations/2026-07-16-z-backup-job-referenced.sql`
- Modify: `apps/api/src/db/schema/backup.ts`, `apps/api/src/services/resultSchemas.ts` (or wherever `backupCommandResultSchema` lives — grep), `apps/api/src/services/backupResultPersistence.ts`, `apps/api/src/routes/backup/jobs.ts` (`toJobResponse`)
- Test: sibling tests of persistence + jobs route (extend existing)

**Interfaces:** migration adds `referenced_size bigint` + `referenced_files integer` (both nullable, `IF NOT EXISTS`); schema fields `referencedSize`/`referencedFiles`; result schema accepts optional `referencedBytes`/`referencedFiles` (agent names) and persistence maps them to the columns **only when defined** (exactly the `errorCount` pattern from commit 2683acc9a — copy it); `toJobResponse` exposes `referencedSize`/`referencedFiles`.

- [ ] **Step 1: Failing tests** — persistence writes columns when present / omits when absent (old agents); response shape includes the fields.
- [ ] **Step 2: Run** (Node 22.20.0) — FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/services/backupResultPersistence* src/routes/backup/` from apps/api — PASS.
- [ ] **Step 5: Commit** — `feat(api): persist + expose incremental-backup referenced size/files`

### Task I3: API — mark-and-sweep GC in backupRetention

**Files:**

- Modify: `apps/api/src/jobs/backupRetention.ts` (read it FIRST end-to-end — reuse its existing provider/S3 client helpers, config iteration, and logging conventions; do not build a second S3 access path)
- Test: `apps/api/src/jobs/backupRetention.test.ts` (extend; if none exists, create following `staleCommandReaper.test.ts` mock style)

**Interfaces:** `export async function sweepUnreferencedBackupObjects(): Promise<{ deleted: number; skippedIdentities: number }>` (or fold into the existing retention run function as a phase — match the file's structure), constants:

```ts
const BACKUP_GC_GRACE_MS = 48 * 60 * 60 * 1000;
const RAW_GC_MAX = Number(process.env.BACKUP_GC_MAX_DELETES_PER_RUN ?? '2000'); // 0 = unlimited, same normalization as STALE_REAPER_MAX_PER_RUN
```

Behavior (spec is binding): per storage identity (provider + endpoint + bucket, the union of ALL configs sharing that identity — NOT per destination/config) — mark from ALL retained `backup_snapshots` rows' manifests (+ each manifest key itself); ANY manifest fetch/parse failure → skip that identity's sweep entirely (fail-closed, log why); an unattributable snapshot row (`config_id NULL`) has no identity and blocks EVERY identity's sweep for the whole run (fail-closed); sweep = list snapshot root, delete objects not live AND older than grace (use the provider's object last-modified from the list call); manifest-less prefixes older than grace swept; per-identity try/catch isolation; one summary log line with deletion count per identity (even 0 is fine to log at debug, &gt;0 at info). The result's `skippedIdentities` counts identities whose sweep was skipped.

- [ ] **Step 1: Failing tests** — live referenced old-prefix object survives after its snapshot row is deleted; unreferenced + old → deleted; unreferenced + young (grace) → kept; mark fetch error → zero deletes for that identity, others proceed; unattributable (`config_id NULL`) row → zero deletes for the whole run; cap honored; manifest-less old prefix swept.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/jobs/backupRetention*` — PASS, then full `npx vitest run` once — PASS.
- [ ] **Step 5: Commit** — `feat(api): mark-and-sweep GC for unreferenced backup objects (incremental retention safety)`

### Task I4: Web — savings display + branch verification

**Files:**

- Modify: `apps/web/src/components/backup/BackupJobList.tsx` (+ its test, + locale files — ALL of en/es-419/fr-FR/de-DE/pt-BR)

**Interfaces:** completed jobs with non-null `referencedSize` render a muted savings line in the expanded detail: "{protected} protected — {uploaded} uploaded" where protected = totalSize, uploaded = totalSize − referencedSize (clamp ≥0), using the existing byte formatter; `data-testid="backup-job-savings"`. No change for null (legacy/full runs show nothing new).

- [ ] **Step 1: Failing test** — completed job with referencedSize renders the savings line; null renders nothing; clamp test (referencedSize &gt; totalSize → uploaded shows 0, no negatives).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (+ all five locale catalogs). **Step 4: Run** `npx vitest run src/components/backup/` + locale parity test — PASS.
- [ ] **Step 5: Branch verification** — `cd agent && go test -race ./... && go vet ./...`; full API `npx vitest run` (Node 22.20.0); `pnpm test --filter=@breeze/web`.
- [ ] **Step 6: Commit** — `feat(web): show incremental backup upload savings on completed jobs`

## Self-review notes

- I1's manifest-entry reuse and I2's optional-fields pattern are both anchored to existing, already-reviewed code paths (journalLookupKey, errorCount persistence) — implementers must reuse, not reinvent.
- Ordering: I1 → I2 (result fields) → I3/I4 in any order; I3 is independent of I1 at the code level but its tests encode I1's reference semantics.
- GC + agent references interact only through manifest contents — no shared code — so the two-sided contract lives in the spec; both sides' tests assert it independently.

