# Incremental Backups — Design

**Status:** Approved by Todd 2026-07-16 (three interactive decisions + build placement). Supersedes the design-pass ask in #2592.

**Context:** Every backup run re-uploads every file. The reliability branch (`docs/superpowers/plans/2026-07-16-backup-job-reliability-and-controls.md`) built the substrate: per-file checksums in manifests, originalPath keying (VSS-stable), a checkpoint journal, and cross-prefix object fetches proven by resume. Backups have **no production users yet** — there is no legacy-snapshot compatibility burden, no migration, and the GC ships enabled (correctness still mandatory: it deletes objects future backups reference).

## Decisions (locked)

1. **Snapshot model: synthetic-full manifests + server-side mark-and-sweep GC.** Every snapshot's manifest lists ALL files; unchanged files are *reference entries* whose `BackupPath` points at an object under an older snapshot's prefix. `BackupPath` is already absolute, so restore, verify, and test-restore need **zero changes**. Retention/GFS keeps deleting snapshot rows exactly as today; a new GC phase computes the live object set from retained manifests and deletes unreferenced objects.
2. **Change detection: size+mtime vs previous manifest, checksum on doubt.** Match walked file → previous manifest entry by the journal's key rule (originalPath when present, else sourcePath). Size+mtime equal → reference. Size equal but mtime moved → sha256 the file; checksum equal → reference (with refreshed mtime), else upload. Anything else → upload. This is restic/kopia's mechanism (restic on Windows uses exactly path+size+mtime; ours is slightly stronger via the checksum tiebreak).
3. **Rejected:** the NTFS **archive bit** (single shared mutable flag, corrupted by any other backup product/script; no modern tool defaults to it); **periodic-full chains** (weekly full re-upload, coarser retention); **copy-forward on prune** (slow prunes, breaks under object immutability/legal hold).
4. **Deferred (phase 2, separate issue):** NTFS **USN change journal** as a Windows walk accelerator (what Duplicati/File History use). It only speeds up *enumeration*; the manifest-compare stays the source of truth. Requires journal-wrap/journal-ID fallback to full walk and FRN→path mapping — meaningful cost, not needed for v1 wins (upload bandwidth is the pain, not walk time).

## Agent behavior

- **Previous-manifest fetch:** at run start (after the walk), list snapshots for this destination and download the newest manifest that exists (completed snapshots only — a prefix without a manifest is not a snapshot). Any failure to fetch/parse → log loudly, run as a **full** backup. Dedupe is an optimization; it must never fail or block a run.
- **Manifest v2:** manifest gains `formatVersion: 2` and `baseSnapshotId` (provenance/debug). Reference entries carry: old entry's `BackupPath` + `Checksum`, current stat's `Size`/`ModTime`/`Mode`, current `SourcePath`/`OriginalPath`. No "isRef" flag — a `BackupPath` under another prefix IS the reference. No v1 reader needed (no users), though v1 manifests parse fine anyway (missing fields zero-value).
- **Never referenced:** system-state staging artifacts (fresh temp dir every run — keys are ephemeral) and the manifest itself. Reference decisions apply to regular walked files only.
- **Journal interplay:** unchanged. Only actual uploads are journaled; a resumed run re-derives references the same way (previous manifest re-fetched). Referenced bytes count toward progress immediately (same instant-jump semantics as resume).
- **Result accounting:** `BackupJob`/result JSON gain `referencedFiles int` + `referencedBytes int64` (omitempty). `FilesBackedUp`/`BytesBackedUp` keep meaning "protected by this snapshot" (total); the new fields say how much of that was dedupe savings.

## Server behavior

- **GC (mark-and-sweep) in `backupRetention.ts`,** a new phase after row-level retention, per backup destination (config):
  1. **Mark:** fetch the manifest of every retained `backup_snapshots` row for the destination (legal-hold rows are retained rows — automatically protected). Live set = every object key those manifests name, plus each snapshot's own manifest key.
  2. **Sweep:** list the bucket's snapshot root; delete objects not in the live set — **skipping anything newer than a 48 h grace window** (protects in-flight runs, resumable partial prefixes, and journal-referenced objects whose manifest hasn't landed yet). Manifest-less prefixes older than grace get swept entirely (this also cleans the orphaned-partial leak noted in #2592).
  3. Per-destination failure isolation (one bad config never blocks others), bounded deletes per run (env-tunable cap, same convention as the reaper), and **deletion counts logged** every run (forensic-trail convention).
- **Mark failure = no sweep.** If any retained snapshot's manifest cannot be fetched/parsed, GC for that destination aborts (fail-closed): an incomplete live set must never justify a delete.
- **Amendments from GC review (2026-07-17):**
  1. **Sweep scope = storage identity, not config.** Multiple configs can point at one bucket; the live set is the union of retained snapshots across ALL configs sharing an identity. Identity = provider + endpoint + bucket, deliberately **excluding** `providerConfig.prefix` because the agent ignores prefix when writing (known end-to-end gap — when prefix support ships, agent and GC change together). A snapshot row with `config_id NULL` blocks ALL identity sweeps for the entire run (fail-closed): an unattributable row has no identity, so `sweepUnreferencedBackupObjects` cannot know which live set it belongs to and must protect every identity, not just one.
  2. **S3 listing uses the root prefix with a trailing slash** (`snapshots/`) so look-alike keys outside the namespace (`snapshots-old/…`) are never candidates.
  3. **Manifest-less (resumable) prefixes are protected at prefix granularity for the journal lifetime:** a partial prefix is swept only when its NEWEST object is older than the agent's journal lifetime (`journalMaxAge`, 7 days) **plus a 48 h resume-headroom margin** — a resume opened just inside the journal window legitimately runs past it, so equality leaves a boundary race (corrected 2026-07-17; the constants must cross-reference each other, with the GC side strictly larger). The 48 h grace applies only to loose unreferenced objects. Rationale: the agent trusts its checkpoint journal for 7 days and resume does not re-verify remote objects; deleting mid-resume state corrupts later manifests.
  4. **Dedup-source race mitigation:** the mark phase also includes the newest manifest present in the LISTING (and its referenced keys) regardless of row retention, because agents pick their dedupe base from the bucket listing, not from DB rows.
- **Schema:** `backup_jobs` gains nullable `referenced_size bigint` + `referenced_files integer` (idempotent migration); result persistence writes them when present; `toJobResponse` exposes them.

## Web

Completed jobs with `referencedSize` show upload savings ("2.1 GB protected — 38 MB uploaded"); the existing progress UI needs no change (referenced bytes already flow through bytesDone).

## Testing

- Agent: decision-table unit tests (ref / checksum-tiebreak-ref / checksum-tiebreak-upload / size-change / new file / deleted file absent from new manifest); two-run integration test with a recording provider (run 2 uploads only the changed file; manifest lists all files; reference paths point at run 1's prefix); fetch-failure → full-run fallback test; VSS originalPath match test (portable, simulated mapping).
- API: GC unit tests with mocked provider listing — live-set correctness (referenced old object survives row deletion), grace window, manifest-less prefix sweep, mark-failure aborts sweep, cap honored; migration/persistence/response-shape tests.
- Verify path: existing integrity check already validates size+checksum per manifest entry — a cross-prefix reference to a missing object surfaces there; add one test asserting that.

## Explicitly out of scope (v1)

USN-journal walk acceleration (phase-2 issue), content-defined chunking / sub-file dedup, cross-device dedup, compression changes.
