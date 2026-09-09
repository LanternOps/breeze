# Backup Assurance Campaign — 2026-09-09

**Status:** In progress
**Owner:** Todd Hebebrand (executed by Claude)
**Branch:** `ToddHebebrand/backup-assurance`
**Baseline under test:** `main` @ `d340fec414` (v0.111.1 + unreleased) and the shipped v0.111.1 binaries
**Verification standard:** `docs/superpowers/specs/backup/2026-05-13-backup-certification-design.md` §4 (byte-exact restore chain)

## 1. Why

Backup is the product's most consequential feature and the one with the widest gap between what the docs
promise and what has ever been proven. As of this date the only recorded end-to-end evidence is:

| Date | OS | Mode | Restore | Notes |
|---|---|---|---|---|
| 2026-07-15 | Windows Server 2022 | `system_image` | alternate-path, non-destructive | one VM, byte-match |
| 2026-07-17 | macOS (synthetic tree) | `file` full + incremental | alternate-path, test restore, integrity | local provider only |

Nothing else — Linux, Hyper-V, MSSQL, local vault, GC/retention, cross-device, in-place overwrite, bare-metal
recovery on any OS, Windows client OS, or any cloud provider — has a recorded live run. Every restore ever
executed went into a scratch directory. The bare-metal recovery doc (`apps/docs/.../bare-metal-recovery.mdx`)
describes a flow that has never been run. The certification harness designed on 2026-05-13 was never built.

The goal of this campaign is **evidence, not a green checkbox**: for every cell in the matrix below, either a
byte-exact proof with recorded hashes, a filed defect, or an explicit "not testable in this lab" with the reason.

## 2. What the product actually is (so the tests measure the right thing)

Established by code inventory on 2026-09-09; the docs disagree with several of these and §8 reconciles them.

- **Modes:** `file` (all OS), `system_image` (= OS *system-state artifacts*: registry hives / BCD / drivers /
  certs / services / package list; NOT a disk image), `hyperv` (Windows only, per-VM checkpoint export),
  `mssql` (Windows only, per-DB full/diff/log). C2C (M365 / Google Workspace) is agentless and server-side.
- **Destinations on the normal backup path:** `s3` (any S3-compatible endpoint) and `local` only. The API
  create-config validator rejects `azure_blob` / `google_cloud` / `backblaze` even though the DB enum, the agent
  providers, and `storage.mdx` list them. BMR's download path accepts all five.
- **Restore paths:** full / selective / alternate-path via `POST /backup/restore`; integrity check + test
  restore via `POST /backup/verify`; cross-device restore is accepted by the API (`deviceId`) but the
  `RestoreWizard` never sends it; restore-as-VM + instant boot (Hyper-V); MSSQL restore; C2C item restore.
- **Bare-metal recovery is "reinstall, then recover":** operator mints a one-time token, downloads a recovery
  bundle (the `breeze-backup` binary + launch script + bootstrap.json) and optionally a Linux/amd64 ISO built
  from an *operator-supplied* template dir. On a machine that already has a booted OS, `breeze-backup
  bmr-recover --token --server` downloads the snapshot and (a) applies system state — Linux: `cp -a` `/etc`,
  apt/dnf package reinstall, `systemctl enable`, firewall, crontabs; Windows: `reg restore` of hives **onto the
  live registry**, `bcdedit /import`, `certutil -restoreDB`, `netsh advfirewall import`, `pnputil` drivers;
  macOS: prefs, launch items, network config — then (b) restores files, then (c) runs a validation probe. There
  is no disk imaging, no WinPE/WinRE, and Breeze does not author boot media.
- **Encryption:** only S3 SSE-S3 / SSE-KMS on the data path. Client-side encryption has an interface with zero
  implementations; the encryption-keys CRUD manages metadata only.
- **Incremental:** unconditional; unchanged files are *referenced* from older snapshot prefixes. Server-side
  GC (`backupRetention.ts`) is the only object-deletion path and must never delete an object a newer manifest
  references.

## 3. Lab

| Rig | Host | OS | Enrolled to | Role in campaign |
|---|---|---|---|---|
| WIN-A | `WIN-IMDR2GAIDMV` 100.101.28.70 (Hyper-V guest on `KIT`) | Windows Server 2022 Std Eval, 4 vCPU, 2.25 GB | dead local stack → **re-enroll to lab stack** | main Windows rig; candidate for SQL Server Express + nested Hyper-V |
| WIN-B | `WIN-DHQNR1F8LO2` 100.101.150.55 (Hyper-V guest on `KIT`) | Windows Server 2022 Std Eval, 4 vCPU, 2.5 GB, agent v0.111.1 | **prod EU** (`eu.2breeze.app`) | shipped-binary path: prod API dispatch → MinIO on the Mac as the S3 destination; non-destructive only |
| LNX-QEMU | QEMU/HVF on this Mac (arm64) | Ubuntu 24.04 cloud image, fresh disk per run | lab stack | Linux file/system_image; **bare-metal recovery into a fresh VM** |
| LNX-X86 | `ubuntu` 100.80.42.117 (KVM rig) | Ubuntu 22.04, prod-US enrolled | isolated second agent → lab stack via reverse tunnel | x86_64 Linux confirmation; needs Tailscale check-mode approval |
| MAC | this Mac (arm64) | macOS | isolated agent rig `~/breeze-backup-e2e-rig` → lab stack | macOS file/system_image + restore; BMR darwin restorer non-destructively only |
| Storage | MinIO on the Mac (`docker-compose.dev.yml` minio), reachable from the Windows VMs over Tailscale (verified 200) | — | — | S3 destination for every rig; local-vault directories per rig |

Lab API: `pnpm wt-stack` in this worktree (API runs role `all`, so backup workers are in-process). Not
available in this lab: a hypervisor console for `KIT` (no fresh Windows VMs, no VM snapshots, no Windows
10/11 client), real cloud buckets (Azure / GCS / B2), an M365 tenant for C2C, a physical machine for
PXE/ISO boot.

## 4. Test matrix

Legend for the `Result` column in §6: **PASS** (byte-exact, hashes recorded) · **FAIL** (defect filed, issue #)
· **PARTIAL** · **BLOCKED** (lab limitation, reason) · **N/A** (mode not supported on OS).

### 4.1 Fidelity corpus (seeded by `scripts/backup-assurance/seed-corpus.{sh,ps1}`, hashed before and after)

- Sizes: 0 B, 1 B, 4095 B, 4096 B, 1 MiB, 100 MiB, 2.5 GiB (forces S3 multipart), plus 10,000 × 1 KiB files
  (indexing / result-cap pressure: the server `result` cap is 5 MB ≈ 13k entries).
- Names: unicode (`café`, CJK, emoji), spaces, leading/trailing dots, `#`/`%`/`+`/`&` (URL-key hazards),
  200-char component, Windows path > 260 chars, 20-level nesting, empty directories.
- Content: random bytes (all 256 values), highly compressible, sparse (Unix), identical content in two paths
  (dedupe / hardlink sensitivity).
- Metadata: mtime (exact), Unix mode bits (0600/0755/setuid stripped?), Windows read-only / hidden / system
  attributes, an explicit DACL (Windows), xattr (macOS), symlink (documented as skipped — assert skipped
  *loudly*, not silently), hardlink pair.
- Adversarial: file held open with an exclusive lock during backup (VSS on Windows), file appended to during
  backup, file deleted between scan and upload, permission-denied file, directory junction / mount point.

### 4.2 Cells

| # | Area | Cell | WIN-A | WIN-B (prod) | LNX-QEMU | LNX-X86 | MAC |
|---|---|---|---|---|---|---|---|
| F1 | file → S3 | full backup of corpus, integrity check, test restore | ● | ● | ● | ● | ● |
| F2 | file → S3 | full restore to alternate path, byte + metadata diff | ● | ● | ● | ● | ● |
| F3 | file → S3 | in-place restore over a modified/deleted tree (overwrite semantics) | ● | — | ● | ● | ● |
| F4 | file → S3 | selective restore (single file, one directory, unicode name) | ● | ● | ● | ● | ● |
| F5 | file → S3 | cross-device restore via API `deviceId` (WIN-A → MAC, LNX → WIN-A) | ● | — | ● | — | ● |
| F6 | file → local vault | F1 + F2 against a local directory destination | ● | — | ● | — | ● |
| F7 | file | exclude patterns honoured; symlink skip is visible in the result | ● | — | ● | — | ● |
| I1 | incremental | run 2 unchanged → every file referenced, 0 bytes re-uploaded | ● | ● | ● | — | ● |
| I2 | incremental | modify + delete + add → run 3; restore of run 3 does **not** resurrect deleted files | ● | — | ● | — | ● |
| I3 | incremental | restore run 2 after run 3 exists (older snapshot still restorable) | ● | — | ● | — | — |
| R1 | retention/GC | shorten retention, run GC; run-3 restore still byte-exact (no referenced object deleted) | ● | — | ● | — | — |
| R2 | retention/GC | GFS tags + keep-counts prune exactly the expected snapshots; legal hold blocks | ● | — | — | — | — |
| S1 | system_image | backup + alternate-path restore, required artifacts present | ● | ● | ● | ● | ● |
| S2 | system_image | partial collection fails loud (rename a hive / deny read) | ● | — | ● | — | — |
| C1 | controls | Stop mid-upload → job cancelled, no manifest, journal kept, next run resumes | ● | — | ● | — | ● |
| C2 | controls | kill helper / reboot mid-run → reaper marks failed within 15 min, next run resumes | ● | — | ● | — | — |
| C3 | controls | network cut mid-upload → job does not sit Running forever (#2798 known) | ● | — | ● | — | — |
| C4 | controls | scheduled run fires at the configured time/timezone; backup window respected | ● | — | — | — | — |
| E1 | errors | wrong S3 credentials / missing bucket / unreachable endpoint → failed job with actionable message | ● | — | ● | — | — |
| E2 | errors | restore target disk full / permission denied → failed restore, partial state reported | ● | — | ● | — | — |
| E3 | errors | helper binary missing or hash-mismatched → loud failure, readiness reflects it | ● | — | ● | — | — |
| V1 | VSS | locked file captured via shadow copy; VSS-unavailable fallback visible (#3010) | ● | ● | N/A | N/A | N/A |
| H1 | hyperv | discover VM, backup (app-consistent), restore VM, restore-as-VM, instant boot | ◐ nested | — | N/A | N/A | N/A |
| M1 | mssql | SQL Server Express: full + diff + log chain, restore to new DB name, row-hash match | ◐ install | — | N/A | N/A | N/A |
| B1 | BMR | token → bundle → `bmr-recover` on a **fresh** machine → system state + files applied → reboot → validation | ◑ blocked (no fresh VM) | — | ● | — | ◐ non-destructive |
| B2 | BMR | token security: single use, expiry, wrong org, tampered bundle signature | ● | — | ● | — | — |
| T1 | tenancy | restore/verify/token routes refuse cross-org snapshot + device ids | ● (API) | — | — | — | — |
| U1 | UI | dashboard, device tab, restore wizard, verification tab, recovery bootstrap tab, readiness (#3970) | ● | ● | ● | — | ● |
| P1 | prod path | WIN-B: shipped v0.111.1 agent + prod EU API → MinIO; F1/F2/F4/I1/S1/V1 | — | ● | — | — | — |

● planned · ◐ attempt, may be blocked · ◑ blocked pending a decision (§9) · — not planned this campaign

### 4.3 Explicitly out of scope (lab limitation, listed so nobody mistakes silence for coverage)

Windows 10/11 client OS; Azure / GCS / B2 (API rejects them anyway); C2C M365 / Google Workspace; physical
PXE / ISO boot; DR-plan execution; encryption key rotation (no data-path consumer exists); Windows BMR onto
fresh hardware (needs a fresh VM — see §9).

## 5. Method

1. Seed corpus → record `pre.sha256` (path, size, sha256, mtime, mode/attrs).
2. Trigger via the API the way the UI does (`POST /backup/jobs/run/:deviceId`, `/backup/restore`,
   `/backup/verify`); poll `backup_jobs` / `restore_jobs` to a terminal state; capture the job row + result JSON.
3. Verify in storage: list objects under the snapshot prefix, compare manifest entries to object sizes.
4. Restore → record `post.sha256` → `diff pre post` must be empty; metadata diff must match the documented
   fidelity (mode + mtime on Unix, attributes on Windows).
5. Every cell records: rig, agent/helper version, API commit, snapshot id, job id, hashes file, verdict.
6. Defects: file a GitHub issue per root cause with the evidence; fix in this branch when small and
   low-blast-radius (agent-shipped code gets the full review round); otherwise link the issue.

Harness lives in `scripts/backup-assurance/` (seed/hash/diff scripts, an API driver) and is shaped after the
certification spec's verbs (`seed`, `snapshot_hash`, `trigger_backup`, `wait_for`, `trigger_restore`,
`verify_byte_exact`, `verify_filesystem_metadata`) so it can be lifted into the cert harness later.

## 6. Results ledger

Filled in as cells execute. One row per cell per rig.

| Cell | Rig | Versions | Snapshot / job | Result | Evidence |
|---|---|---|---|---|---|

## 7. Defects found

| # | Severity | Cell | Summary | Issue / fix |
|---|---|---|---|---|

## 8. Docs vs reality (to reconcile at the end)

| Doc claim | Reality | Action |
|---|---|---|
| `bare-metal-recovery.mdx`: "restore a complete system — OS, drivers, configuration, and data — to new hardware… boot the target from Breeze recovery media… the machine reboots into the restored OS" | reinstall-then-recover of system-state artifacts + files; no disk image; ISO is Linux/amd64 from an operator template; Windows applies hives to a live registry | rewrite after B1 evidence |
| `storage.mdx` lists Azure / GCS / B2 | API validator accepts `s3` and `local` only | fix docs or the validator (decision) |
| `encryption.mdx` implies backup encryption keys protect data | only S3 SSE; keys are metadata | rewrite |
| `restoring.mdx` "Cross-Device Restore" | API-only; wizard never sends `deviceId` | verify F5, then either wire the UI or mark API-only |

## 9. Decisions needed from Todd (batched; conservative defaults applied meanwhile)

1. **Ubuntu x86 rig** — Tailscale check-mode approval link needed to open the ControlMaster. Default: QEMU
   arm64 covers Linux until approved.
2. **`KIT` Hyper-V host access** (192.168.0.7, Tailscale `kit-1`, no SSH/WinRM exposed) — needed for fresh
   Windows VMs (Windows BMR B1, Windows 10/11 client, VM snapshots for destructive tests). Default: Windows
   BMR stays BLOCKED; no destructive restore onto a VM I cannot roll back.
3. **Install SQL Server Express + the Hyper-V role on WIN-A** (2.25 GB RAM; nested virt appears exposed).
   Default: proceed — both are removable and the VM is a throwaway lab box.
4. **In-place overwrite restores on WIN-B** (prod-enrolled). Default: alternate-path only on WIN-B.
5. **Real cloud credentials** (S3 / B2 / Azure) and an **M365 test tenant** for provider and C2C cells.
   Default: skipped, listed as out of scope.
