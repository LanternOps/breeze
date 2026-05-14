# Backup Certification System — Design

**Status:** Design approved, awaiting implementation plan
**Date:** 2026-05-13
**Owner:** Todd Hebebrand
**Scope of this spec:** Architecture for the certification system + vertical slice covering file-level backup on Windows (S3 + Local Vault storage targets). Subsequent slices (macOS/Linux file-level, Hyper-V, MSSQL, C2C/M365, BMR, DR plans, encryption/retention) will each get their own spec, built on top of the harness defined here.

---

## 1. Motivation

Breeze RMM has 11 backup feature areas spanning file-level, Hyper-V image, MSSQL database, cloud-to-cloud (Microsoft 365), local vault (SMB/USB), bare-metal recovery, DR plans, encryption, SLA/policy, retention/GFS, and VSS/system-state. Backup correctness is the product's most consequential property: a silently-broken backup is worse than no backup, because it destroys customer trust precisely when it's most needed.

This system exists to give us three things, in order of priority:

1. **Proof to ourselves** that every backup feature, on every supported platform, actually produces restorable, byte-identical data — not just "the job said success."
2. **A regression safety net** that catches any change to backup-critical code before it ships.
3. **A release gate** that blocks publishing an API or agent image when the backup feature set hasn't been re-certified against the current source tree.

This is explicitly **not** a compliance or audit deliverable. It is internal engineering hygiene. Compliance use cases (SOC 2 evidence, customer-facing certification claims) may be derived from it later, but the design here optimizes for engineer confidence and release safety.

## 2. Vocabulary

These three terms are used precisely throughout the spec.

- **Subject Under Test (SUT)** — a specific Breeze backup feature being verified, identified by a slug like `file-level-backup-windows-s3`. One feature can have multiple SUTs (e.g., the same feature against different storage providers).
- **Cert Run** — a single execution of the harness against a SUT. Produces an Evidence Bundle. If every assertion passes, also produces a signed Cert Manifest.
- **Evidence Bundle** — the heavy artifact recording exactly what happened during a cert run: hashes, logs, intermediate state, the YAML test definition. Lives in S3 with Object Lock.
- **Cert Manifest** — a small, signed JSON document that says "on date D, commit C, with backup-critical source hashes H1..Hn, the SUT passed every test with evidence pointer E." Committed to the repo. This is what the release gate checks.

## 3. Contract

A Cert Manifest is valid iff every hash in its `sourceHashes` field matches the current tree at the path it references. Mismatch → release blocked → re-cert required.

This is the load-bearing invariant. It makes the certification tamper-evident in the strict sense: not "the test code is tamper-evident" but "the relationship between *what was tested* and *what's about to ship* is tamper-evident."

A second invariant: the harness never mocks the system under test. The agent that runs backups during a cert run is the production-built agent binary. The API is a real instance (a dedicated cert API instance — see §8). Storage is real cloud storage and real SMB shares. Mocks are permitted only *outside* the SUT (e.g., to seed data or query M365 for verification) — they are scaffolding, not the thing being certified.

## 4. Verification depth

Every cert run uses byte-exact restore verification. The chain is:

1. Generate or load canonical seed data with known SHA-256 hashes (corpus-level manifest hash + per-file hashes).
2. Snapshot-hash the seed in place (immediately before backup).
3. Trigger backup via Breeze API; record the agent's reported snapshot ID.
4. Verify the backup landed in the configured storage target (object exists, size matches, content hash matches what the agent reported).
5. Wipe the target volume.
6. Trigger restore via Breeze API.
7. Re-hash the restored data and diff against the pre-backup hash list.
8. Verify filesystem metadata (ACLs, owners, timestamps where they're supposed to round-trip).

Any mismatch at step 7 or 8 → cert run fails, no manifest is produced.

For non-file backup types, byte-exact extends naturally:

- **VM backup:** verify_vm_boot probes the restored VM and hashes its probe output.
- **MSSQL:** verify_db_roundtrip connects, runs canonical queries, and hashes result sets.
- **C2C/M365:** verify_m365_items enumerates items via Graph and hashes per-item state.

Across all features, the rule is the same: pick a level where bit-flips, encoding drift, or silent truncation cannot hide.

## 5. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  e2e-tests/cert/ (new code)                                        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ cert-runner.ts  (extends existing run.ts machinery)          │  │
│  │   ├─ loads test definitions: tests/cert/*.yaml               │  │
│  │   ├─ orchestrates targets via target adapters                │  │
│  │   ├─ records hashes at every step into Evidence Bundle       │  │
│  │   └─ on full pass: builds + signs Cert Manifest              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│           │                                                        │
│  ┌────────┴────────────┐                                           │
│  │ Target adapters     │  proxmox.ts │ winrm.ts │ ssh.ts │ smb.ts  │
│  │ (spin / seed / wipe)│  s3.ts │ azure.ts │ gcs.ts │ b2.ts        │
│  │                     │  m365.ts │ mssql.ts │ bmr.ts │ ipmi.ts    │
│  └─────────────────────┘                                           │
│           │                                                        │
│  ┌────────┴────────────┐                                           │
│  │ Action verbs        │  seed │ snapshot_hash │ trigger_backup    │
│  │ (YAML primitives)   │  wait_for │ wipe │ trigger_restore       │
│  │                     │  verify_byte_exact │ verify_vm_boot      │
│  │                     │  verify_db_roundtrip │ verify_m365_items │
│  │                     │  verify_filesystem_metadata              │
│  │                     │  assert_api_state │ assert_log_contains  │
│  └─────────────────────┘                                           │
└────────────────────────────────────────────────────────────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │  Cert API instance      │ ← real Breeze API + agent
                  │  Breeze agent (real)    │   under test, NOT mocked
                  └─────────────────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │  Real storage targets   │
                  │  S3 / Azure / GCS / B2  │
                  │  SMB vault / USB        │
                  │  M365 tenant            │
                  └─────────────────────────┘
                              ↓
                  ┌─────────────────────────┐
                  │  Evidence Store         │
                  │  S3 (Object Lock)       │
                  │  + cert-manifests/ repo │
                  └─────────────────────────┘
```

**Design properties:**

1. **The harness never mocks the SUT.** See §3.
2. **Target adapters are the only platform-specific code.** Each adapter has one job (e.g., `proxmox.ts` knows how to clone-from-template; `winrm.ts` knows how to run commands inside a Windows guest; `breeze-api.ts` knows how to trigger backups). YAML test definitions stay declarative. This isolates change: a new storage provider adds one adapter, not changes scattered across the test suite.
3. **Evidence is captured at every observable transition.** Pre-backup hash, in-storage hash, post-restore hash, log fingerprints, API DB state — all recorded. The chain is the evidence; any missing link fails the cert.
4. **Action verbs are an enumerated, closed set.** No `eval`, no `exec_arbitrary`, no raw HTTP. A reviewer reading the YAML knows exactly what the run did.

## 6. Evidence Bundle and Cert Manifest

Two documents per cert run, with a one-way pointer from the lightweight repo file to the heavy S3 object.

### 6.1 Evidence Bundle — S3, Object Lock COMPLIANCE mode

Path: `s3://breeze-cert-evidence/<utc-iso8601>-<feature-slug>-<git-sha>.tar.zst`
Retention: 7 years (re-evaluate before first expiry).

Bundle contents:

```
bundle/
  bundle.json                 # top-level metadata + merkle root
  test-definition.yaml        # exact YAML driving this run (copied in)
  source-hashes.json          # SHA-256 of every backup-critical file
  agent-binary.sha256         # hash of the agent binary used
  api-build.sha256            # hash of the API build image + migration count
  steps/
    001-seed.json             # per-step record
    002-trigger-backup.json
    003-snapshot-landed.json
    004-wipe.json
    005-trigger-restore.json
    006-verify.json
  logs/
    api.log
    agent.log
    runner.log
  raw/
    seed-corpus.sha256sums    # one line per seed file: <sha256>  <relpath>
    restore-result.sha256sums
```

`bundle.json` shape:

```json
{
  "schemaVersion": 1,
  "feature": "file-level-backup-windows-s3",
  "startedAt": "2026-05-13T14:02:11Z",
  "completedAt": "2026-05-13T14:38:47Z",
  "runner": { "host": "...", "userAgent": "breeze-cert/0.1.0" },
  "git": { "commit": "abc123...", "branch": "main", "dirty": false },
  "sut": {
    "agentBuild": "0.65.10",
    "apiBuild": "0.65.10",
    "apiMigrationCount": 248,
    "imageDigests": { "api": "sha256:...", "agent": "sha256:..." }
  },
  "targets": { "proxmoxNode": "...", "windowsGuest": "...", "s3Bucket": "..." },
  "corpus": { "version": "mixed-1gb-v1", "manifestSha256": "sha256:..." },
  "result": "pass",
  "stepHashes": ["sha256:...", "..."],
  "evidenceRoot": "sha256:..."
}
```

`evidenceRoot` is the merkle root of all `steps/*.json` and `raw/*.sha256sums` files, computed deterministically.

### 6.2 Cert Manifest — committed to repo

Path: `cert-manifests/<feature-slug>/<utc-iso8601>-<git-sha>.json`
Also: `cert-manifests/<feature-slug>/latest.json` (symlink or pointer file to the most recent manifest for HEAD).

```json
{
  "schemaVersion": 1,
  "feature": "file-level-backup-windows-s3",
  "certifiedAt": "2026-05-13T14:38:47Z",
  "git": { "commit": "abc123...", "tag": null },
  "sourceHashes": {
    "agent/internal/backup/backup.go": "sha256:...",
    "agent/internal/backup/providers/s3.go": "sha256:...",
    "apps/api/src/routes/backup/jobs.ts": "sha256:...",
    "apps/api/src/db/schema/backup.ts": "sha256:..."
  },
  "evidence": {
    "s3Object": "s3://breeze-cert-evidence/2026-05-13T14:02:11Z-file-level-backup-windows-s3-abc123.tar.zst",
    "bundleSha256": "sha256:..."
  },
  "signature": {
    "alg": "ed25519",
    "keyId": "breeze-cert-2026-Q2",
    "publicKey": "base64...",
    "value": "base64..."
  }
}
```

The signed payload is the **canonical JSON** of the manifest (sorted keys, no extra whitespace, all fields except `signature` itself).

### 6.3 Key management

- Ed25519 keypair dedicated to certification.
- Private key lives in 1Password (vault: Engineering / item: `breeze-cert signing key`) and in CI's secret store for automated runs.
- Public keys land in `internal/release-keys/breeze-cert.<keyId>.pub`, are checked into the repo, and **stay there forever** so historical manifests can always be verified.
- Key rotates yearly. Rotation creates a new keyId; old keyIds remain valid for verifying historical manifests but cannot sign new ones.
- Rotation procedure documented in `docs/backup-certification/key-management.md`.

### 6.4 Repo write protection

`cert-manifests/**` is append-only:

- `CODEOWNERS` requires explicit review for any change to existing files.
- A pre-commit hook (and a CI check) rejects modifications to existing files; new files only.
- The one exception is the `latest.json` pointer file per feature, which is updated by the cert run as it commits a new manifest.

## 7. Backup-critical source path list

The source-hash calculation needs a deterministic input list. Stored in `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`:

```yaml
# Changes to any of these paths invalidate every cert manifest that references them.
agent:
  - agent/internal/backup/**
  - agent/internal/heartbeat/handlers_backup.go
  - agent/internal/heartbeat/handlers_vault.go
api:
  - apps/api/src/routes/backup/**
  - apps/api/src/routes/c2c/**
  - apps/api/src/db/schema/backup.ts
  - apps/api/src/db/schema/backupVerification.ts
  - apps/api/src/db/schema/c2c.ts
  - apps/api/src/db/schema/drPlans.ts
  - apps/api/src/services/backupEncryption.ts
  - apps/api/src/services/backupSnapshotStorage.ts
shared:
  - packages/shared/src/types/backup*.ts
migrations:
  - apps/api/migrations/*backup*.sql
  - apps/api/migrations/*c2c*.sql
  - apps/api/migrations/*vault*.sql
  - apps/api/migrations/*dr*.sql
```

`BACKUP_CRITICAL_PATHS.yaml` is itself in the source-hash list, self-referentially. Changing the scope of what counts as backup-critical invalidates every existing manifest, which is the correct behavior — it forces a deliberate re-cert when scope changes.

## 8. Cert API instance

A dedicated cert API instance, not the dev instance. Properties:

- Runs the same image as production, configured with its own Postgres and Redis.
- Network-isolated from production data stores.
- Reachable from the Proxmox cert lab segment and from the cert runner host.
- DB schema migration count is recorded in every Evidence Bundle's `sut.apiMigrationCount`, so we can prove the API under test had exactly migrations 0001..NNNN applied.
- Build image digest is recorded in `sut.imageDigests.api`.
- Provisioned via the same docker compose plumbing as the rest of the stack (`docker-compose.override.yml.cert` — a new override file).

Operationally, it's one more thing to maintain. The tradeoff is forensic clarity: we always know exactly what API version+schema state was tested, with no risk of dev work in flight polluting the run.

## 9. Lab infrastructure

### 9.1 Logical layout

```
                  ┌─────────────────────────────────────┐
                  │  Cert Runner host                   │
                  │  (laptop OR CI runner)              │
                  └──────────────┬──────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
 ┌─────────────┐          ┌──────────────┐         ┌──────────────┐
 │  Proxmox    │          │  Cloud       │         │  Physical    │
 │  cluster    │          │  accounts    │         │  Dells       │
 │             │          │              │         │  (BMR only)  │
 │  - Win 2022 │          │  - S3        │         │  - PXE boot  │
 │  - Ubuntu   │          │  - Azure     │         │  - IPMI ctrl │
 │  - macOS*   │          │  - GCS       │         └──────────────┘
 │  - SQL Srv  │          │  - B2        │
 │  - Hyper-V  │          │  - M365 tnt  │
 │   (nested)  │          │  - SQL svc   │
 │  - SMB host │          └──────────────┘
 │   (vault)   │
 └─────────────┘
```
*macOS in Proxmox may be replaced with a physical Mac if Apple licensing constraints make Proxmox-on-macOS unworkable.*

### 9.2 Proxmox gold images

Each target has a version-pinned template, content-hash recorded in the Cert Manifest:

- `win-server-2022-breeze-agent-<version>` — clean Windows Server, Breeze agent at a known version, no test data.
- `win-11-pro-breeze-agent-<version>`
- `ubuntu-2404-breeze-agent-<version>`
- `rhel-9-breeze-agent-<version>`
- `macos-14-breeze-agent-<version>` (or physical-Mac fallback)
- `win-2022-hyperv-host-breeze-agent-<version>` — nested virt enabled with guest VMs pre-loaded
- `win-2022-sql-2022-breeze-agent-<version>` — SQL Server installed

Template build is a separate small system (Packer or a documented manual recipe + hash). Each cert run clones from template by ID, verifies the template's content-hash before use, and aborts if the hash doesn't match the YAML's `target.templateSha256`.

### 9.3 Network isolation

The cert lab network segment can reach:
- Cert API instance (and only that — not production API).
- Dedicated cloud buckets (separate accounts from production).
- M365 cert tenant.

It cannot reach production data stores. Belt and suspenders: the cert API instance points at separate Postgres / Redis, never at production credentials.

## 10. Target adapters — single-responsibility breakdown

| Adapter | Does | Does NOT do |
|---|---|---|
| `proxmox.ts` | Clone-from-template, start/stop, snapshot/rollback, console log capture | Run code inside the guest |
| `winrm.ts` | Run commands inside a Windows guest, push/pull files, hash trees | Know about Breeze |
| `ssh.ts` | Same, for macOS/Linux guests | Same |
| `breeze-api.ts` | Authenticated API calls (login, trigger backup, query snapshot) | Care which VM the agent is on |
| `s3.ts` / `azure.ts` / `gcs.ts` / `b2.ts` | HEAD/GET storage objects, list bucket contents, verify Object Lock state | Drive backup jobs |
| `smb.ts` | Mount, list, hash files on SMB vault target | Manage shares |
| `m365.ts` | OAuth, Graph API enumeration, create/delete test items | Drive C2C backup |
| `mssql.ts` | Connect via sqlcmd/tedious, run canonical queries, hash result sets | Drive MSSQL backup |
| `bmr.ts` | IPMI power cycle a physical Dell, watch for PXE boot, verify post-restore boot | Restore (that's breeze-api) |
| `ipmi.ts` | Power/console for physical hosts | Anything else |

Each adapter is a thin module with a typed interface and its own unit tests, with the *adapter mocked at the network boundary* (harness mocks are fine — they don't compromise SUT integrity).

## 11. YAML test definition format

A cert test lives at `e2e-tests/tests/cert/<feature>.yaml`. Example (file-level Windows S3):

```yaml
feature: file-level-backup-windows-s3
description: |
  Seed a Windows guest with a 1 GB corpus including
  open-file (locked DB) cases, back it up to S3 via the
  Breeze agent, wipe target volume, restore from snapshot,
  byte-compare every file.
target:
  kind: proxmox-windows-guest
  template: win-server-2022-breeze-agent-0.65.10
  templateSha256: sha256:...
  cpus: 4
  memory: 8192
  disks:
    - { name: C, sizeGiB: 60 }
    - { name: D, sizeGiB: 50 }
seed:
  corpus: corpora/mixed-1gb-v1
  expectedSha256: sha256:abc...
  layout: D:\seed\
  includeCases:
    - small-files-10k
    - large-binary-2gb
    - locked-sqlite-db
    - sparse-file-100gb
    - unicode-paths
    - long-paths
    - acls-mixed
storage:
  provider: s3
  bucket: breeze-cert-target-s3
  region: us-east-1
  encryption: enabled
  immutability: enabled
backup:
  configRef: ${cert.backupConfig}
  type: full
  triggerBy: api
steps:
  - id: seed
    action: seed
    expect: { manifestSha256: sha256:abc... }

  - id: snapshot-pre
    action: snapshot_hash
    scope: D:\seed\
    saveAs: pre

  - id: trigger
    action: trigger_backup
    timeoutSec: 1800

  - id: snapshot-in-storage
    action: verify_artifact_in_storage
    expect:
      providerObjectExists: true
      manifestRecordedInDb: true
      apiReportsSuccess: true
      artifactHashMatchesAgentReport: true

  - id: wipe
    action: wipe
    scope: D:\seed\
    confirm: true

  - id: restore
    action: trigger_restore
    snapshotRef: ${steps.trigger.snapshotId}
    target: D:\seed\
    timeoutSec: 1800

  - id: verify
    action: verify_byte_exact
    expectMatchesSnapshot: pre
    abortOn: any-mismatch

  - id: verify-acls
    action: verify_filesystem_metadata
    scope: D:\seed\
    expectMatchesSnapshot: pre
    fields: [acl, owner, ctime-preserved-or-explained]
```

### 11.1 Action verb registry (closed set)

| Action | Purpose | Evidence captured |
|---|---|---|
| `seed` | Lay down canonical corpus on target | corpus version, manifest hash, per-file SHA-256 |
| `snapshot_hash` | Hash a directory tree on target | hash list, total size, file count |
| `trigger_backup` | Drive backup via Breeze API | job ID, agent-reported result, API DB record |
| `trigger_restore` | Drive restore via API | restore job ID, target path, result |
| `verify_artifact_in_storage` | Confirm backup is actually in storage and matches agent claims | provider GET hash, DB record, agent log fingerprint |
| `wipe` | Destructively erase target | proof of erasure (post-wipe scan must be empty) |
| `verify_byte_exact` | Re-hash restored data and diff against baseline | restored hash list, diff |
| `verify_vm_boot` | For VM backups: boot restored VM, run a probe | boot success, probe output hash |
| `verify_db_roundtrip` | For MSSQL: connect, run canonical queries, compare result hashes | query result hash, LSN |
| `verify_m365_items` | For C2C: enumerate items via Graph + compare to pre-state | item count, per-item hash |
| `verify_filesystem_metadata` | ACLs, owners, timestamps round-trip | per-file metadata hash |
| `assert_api_state` | Check API DB rows reflect what happened | row hash |
| `assert_log_contains` | Log fingerprint check (sparingly — easy to fool) | log line hashes |

**Forbidden verbs:** `eval`, `exec_arbitrary`, `http_raw`, or any action that bypasses the structured action layer. New verbs require a spec amendment.

## 12. Canonical seed corpora

Hybrid model:

- **Structural cases** (locked DB, unicode paths, ACL fixtures, sparse files, long paths) are PRNG-generated from a seeded spec at runtime. Spec lives in `e2e-tests/cert/corpora/spec.ts`. Identical seeds → identical bytes.
- **Bulk data** (the 1 GB random blob, the 2 GB binary) is generated once and stored in S3 with the bucket key matching the corpus version: `s3://breeze-cert-corpora/mixed-1gb-v1.tar.zst`. Hash-pinned in YAML via `seed.expectedSha256`.

A corpus has a version (`mixed-1gb-v1`). Changing the corpus means cutting a new version (`mixed-1gb-v2`); old versions remain valid for verifying historical manifests. The corpus version is recorded in `bundle.json` and is part of the manifest's signed payload (because changing the corpus changes what was actually tested).

## 13. Vertical slice — what gets built first

### 13.1 In scope (slice 1)

| SUT | Target | Storage | Coverage |
|---|---|---|---|
| File-level backup (full) | Windows Server 2022 Proxmox guest | S3 + Local Vault (SMB) | byte-exact, ACL round-trip, VSS path (locked SQLite), unicode/long-path |
| File-level backup (incremental) | same guest, run #2 after a known delta | same | only changed files re-uploaded, restore reconstructs latest state byte-exact |
| File-level restore | same guest, wiped data volume | same | full restore, selective-file restore |
| Snapshot integrity verification | API `/backup/verification` endpoint | S3 | API's own verification must agree with byte-exact result |

### 13.2 Out of scope (deferred to later slices)

Hyper-V, MSSQL, C2C/M365, BMR, DR plan execution, GFS retention pruning, SLA dashboard, encryption key rotation, macOS/Linux file-level. The harness must be designed so these slot in without architectural change.

### 13.3 Concrete artifacts produced by slice 1

1. `e2e-tests/cert/cert-runner.ts` — orchestrator.
2. `e2e-tests/cert/adapters/{proxmox.ts, winrm.ts, smb.ts, s3.ts, breeze-api.ts}` — target adapters.
3. `e2e-tests/cert/actions/*.ts` — one file per action verb.
4. `e2e-tests/tests/cert/file-windows-s3.yaml` + `file-windows-vault.yaml`.
5. `e2e-tests/cert/corpora/spec.ts` — PRNG corpus generator and S3-pinned blob references.
6. `cert-manifests/BACKUP_CRITICAL_PATHS.yaml`.
7. `cert-manifests/file-level-backup-windows-s3/<utc>-<sha>.json` — the first signed manifest.
8. `internal/release-keys/breeze-cert.2026-Q2.pub` (private key in 1Password).
9. `scripts/verify-cert-manifest.ts` — verifier used in CI and locally.
10. `.github/workflows/backup-cert-check.yml` — the release gate workflow.
11. `docker-compose.override.yml.cert` — cert API instance composition.

### 13.4 Definition of done for slice 1

- Running `pnpm cert:run file-windows-s3` on a fresh checkout (with Proxmox + AWS env vars set) produces an Evidence Bundle, uploads it to S3 with Object Lock, signs and commits a Cert Manifest, and exits 0.
- A trivial modification to `agent/internal/backup/backup.go` (e.g., a one-line comment) causes the next `pnpm cert:verify` to fail with `BACKUP_CRITICAL_HASH_MISMATCH: agent/internal/backup/backup.go`.
- A PR touching any backup-critical path is automatically labeled `backup-recert-required` by CI; the `backup-cert-gate` status check is required for merge to `main` and stays red until a fresh manifest signed for `HEAD` is committed.
- A reviewer auditing a Cert Manifest can: verify the signature locally, fetch the bundle from S3, replay the YAML, and reach the same byte-exact result.

## 14. CI integration and release gate

Three checks. The first two run cheaply on every PR; the third is the aggregator that goes in branch protection.

### 14.1 `backup-cert-source-scan`

Runs on every PR.

- Compute SHA-256 of every path matched by `BACKUP_CRITICAL_PATHS.yaml` at HEAD.
- For each `cert-manifests/<feature>/latest.json`, compare the manifest's `sourceHashes` against HEAD.
- If any mismatch: write a PR comment listing which paths changed and which features need re-cert; apply label `backup-recert-required`; exit non-zero.

### 14.2 `backup-cert-manifest-verify`

Runs on every PR and push to main.

- For every Cert Manifest in `cert-manifests/**`:
  - Verify Ed25519 signature against known public keys in `internal/release-keys/breeze-cert.*.pub`.
  - Fetch `bundle.json` from S3 (HEAD + range read) and verify `bundleSha256`.
  - Reject any manifest signed by an unknown key or with a mismatched bundle hash.

### 14.3 `backup-cert-gate`

The aggregator. Required status check on protected branches.

Green only if:
- Source scan passes (no orphan hash mismatches for any feature listed in `BACKUP_CRITICAL_PATHS.yaml`).
- All manifests verify.
- Every feature in scope (initially just `file-level-backup-windows-s3` and `file-level-backup-windows-vault`) has at least one valid manifest for HEAD.

### 14.4 Release-time integration

`apps/api`'s build pipeline already produces versioned images. We add:

- The image build embeds a label `breeze.cert.sourceCommit=<sha>`.
- `.github/workflows/release.yml` checks: for the commit being released, does a valid Cert Manifest exist for *every* feature in `BACKUP_CRITICAL_PATHS.yaml`?
  - **Yes** → publish image, tag release.
  - **No** → release fails unless `--cert-bypass <reason>` is supplied, which requires a justification entry in `cert-manifests/BYPASSES.md` and a second approver. Bypass is logged forever and does **not** create a valid manifest.

### 14.5 Local dev ergonomics

- `pnpm cert:run --quick <feature>` runs the smallest viable matrix for fast iteration. Quick runs produce a `draft: true` manifest that is **not** signed and **not** accepted by the gate.
- Full cert runs are required pre-merge, not pre-commit.
- `pnpm cert:diff` shows: "your branch changes these backup-critical files, so these features need re-cert: X, Y, Z."

### 14.6 What this does NOT do

- It does not run the full matrix on every PR. The matrix is too expensive (real VMs, real S3, real M365). PR-time check is source-hash based only. Full cert runs trigger manually (`pnpm cert:run`) or on a schedule (nightly main-branch run, weekly full-matrix).
- It does not certify production deployments. Tying the manifest to droplet-state is out of scope (image-digest pinning, already partly addressed by `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, handles the production side).

## 15. Documentation

All under `docs/backup-certification/`:

| Doc | Audience | Contents |
|---|---|---|
| `README.md` | Anyone | What the system is, what it certifies, what a manifest means, link to other docs |
| `runbook.md` | Engineer running a cert | Env vars, AWS/Proxmox/M365 creds, run procedure, failure triage |
| `architecture.md` | Engineer modifying the system | Adapters, action vocabulary, evidence pipeline (living version of this spec) |
| `bypass-policy.md` | Anyone considering a hotfix bypass | When acceptable, required justification fields, second-approver requirement, audit trail |
| `key-management.md` | Whoever holds the Ed25519 key | 1Password vault path, rotation, revocation |
| `incident-playbook.md` | On-call if a cert mysteriously fails or a manifest fails verification | Triage tree, real-regression vs flaky-lab, how to reproduce locally |
| `templates.md` | Whoever maintains Proxmox gold images | How to rebuild a template, record its hash, roll out a new agent version |

Plus the BYPASSES log itself (`cert-manifests/BYPASSES.md`), append-only, one entry per bypass: who, when, what feature, why, second approver, planned re-cert date.

## 16. Testing the harness itself

The cert system cannot be the most consequential code in the repo without itself being tested. Three layers:

1. **Adapter unit tests** — each adapter mocks its network boundary, verifies behavior under happy and error paths. Vitest, runs in normal CI.
2. **Harness contract tests** — verify the runner:
   - A forged "successful" run with a deliberately tampered hash must fail to produce a manifest.
   - A correct run must produce a manifest the verifier accepts.
   - A manifest with a flipped bit in the signature must fail verification.
   - A manifest with a sourceHash for a non-existent path must fail verification.
3. **Recurring meta-test** — a nightly job that introduces a known seeded "bug" into a *fork* of the agent (e.g., a backup that silently truncates the last 4 KB of every file), runs the cert against it, and asserts the cert **fails with a byte-exact mismatch error**. If the meta-test ever passes the forged build, the cert system has rotted and an alert fires.

Layer 3 is the antidote to the classic "the test passes because we accidentally turned off the assertion" failure mode.

## 17. Slice 2+ roadmap (informational, not in scope of this spec)

Each future slice gets its own spec:

- **Slice 2 — macOS + Linux file-level.** Same architecture, more adapters.
- **Slice 3 — Hyper-V image backup + VM boot verification.** Nested virt, boot probe over guest console.
- **Slice 4 — MSSQL.** `verify_db_roundtrip` action gets serious.
- **Slice 5 — C2C / M365.** M365 cert tenant lifecycle, Graph item enumeration.
- **Slice 6 — BMR on physical Dell.** IPMI choreography, PXE bootstrap token flow.
- **Slice 7 — Encryption, retention/GFS, immutability + legal hold.** Time-shift scenarios, key rotation, deletion attempts that must be denied.
- **Slice 8 — DR plan execution.** Multi-device choreography proves end-to-end.

Each adds tests; none changes the harness, the action verb set without explicit amendment, the manifest schema, or the stamping model.

## 18. Open questions deferred to implementation planning

The implementation plan will need to resolve, with concrete answers:

- Proxmox API client choice for `proxmox.ts` (proxmox-api npm, or HTTP directly).
- Exact PRNG used by the corpus generator (must be cross-platform deterministic — likely `seedrandom` + a documented algorithm description in the spec doc).
- Whether the cert API instance runs on the same Proxmox cluster or a separate host (probably same cluster, separate VM).
- macOS testing approach: Proxmox-on-macOS or physical Mac. Decision deferred until slice 2.
- Whether `BYPASSES.md` entries should auto-create GitHub issues for re-cert tracking, or stay purely as Markdown.
