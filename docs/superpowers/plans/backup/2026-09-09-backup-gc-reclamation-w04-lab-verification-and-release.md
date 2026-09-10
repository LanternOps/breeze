---
tracking_issue: LanternOps/breeze#5449
---

# D18 Wave 04 — Lab Verification on MinIO, Release Notes, Campaign Doc Close-out

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 1–3 need the lab (`~/breeze-assurance`, MinIO, the Linux rig) and run from the MAIN session (subagents cannot SSH the rigs).

**Goal:** Prove on real MinIO + a real Linux agent that an expired, unreferenced snapshot is reclaimed while a retained incremental still restores byte-identical, then ship the release-facing text.

**Architecture:** Re-run campaign cells R1/R4 against a stack built from main after W01–W03 merged, with the lab knobs shortened; extend `scripts/backup-assurance/cells-gc.sh` to assert reclamation (object counts drop, retirement row `swept_at` set) and Hyper-V/MSSQL/system-image manifests untouched. Then release notes, docs, campaign ledger.

**Tech Stack:** bash harness (`scripts/backup-assurance/*.sh`), `mc` (MinIO client), psql via the stack's postgres container, Playwright not needed.

**Spec:** docs/superpowers/specs/backup/2026-09-09-backup-gc-reclamation-design.md (§6 "Lab", §8 decisions)

**Depends on:** W01, W02, W03 merged to main; a helper build reporting `backup_version >= 0.112.0` (the W02 gate constant `BACKUP_SERVER_BASE_MIN_HELPER_VERSION`) installed on the Linux rig.

## Global Constraints
- Lab knobs on the API container: `BACKUP_GC_GRACE_MS=1000`, `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS=1000`, `BACKUP_BASE_LEASE_MS=60000`, `BACKUP_PUBLISH_MARGIN_MS=1000`, `BACKUP_RESTORE_PIN_LINGER_MS=1000`. Production floors warn but do not apply outside `NODE_ENV=production` — check the stack is not built with production `NODE_ENV`.
- Never run destructive restores on WIN-B (prod-enrolled); Linux rig only (campaign §9 decision 4).
- Evidence lands under `~/breeze-assurance/runs/lnx/d18-*.txt` and is cited by filename in the campaign doc.

## 0. Ground truth
- `scripts/backup-assurance/cells-gc.sh` (94 lines at campaign close): expires rows by id in system scope, triggers `cleanup-expired-snapshots` via the lab Redis/BullMQ helper in `lab.sh`, counts objects per prefix with `mc ls -r lab/breeze-lab/snapshots/<label>/`, then restores the newest retained snapshot and compares hashes with `compare-hashes.sh`. It currently only asserts that referenced objects survive (R1); R4's reclamation assertion was recorded by hand in `runs/lnx/postfix-GC3.txt`.
- The campaign doc `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` has R4 = FAIL (D18) at line ~238, D18 OPEN at ~288, and decision 6 at §9.
- Docs pages that state storage is not reclaimed: `apps/docs/src/content/docs/backup/storage.mdx`, `apps/docs/src/content/docs/backup/monitoring.mdx` (W02 rewrites the retention text; this wave re-reads them after merge and fixes anything W02 missed).

## File structure
- Modify: `scripts/backup-assurance/cells-gc.sh` — add R4 assertions (reclaimed prefix empty, retirement row swept, unrelated manifests intact).
- Modify: `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` — R4 → PASS, D18 → FIXED (PR numbers), §9 decision 6 → resolved.
- Modify: `apps/docs/src/content/docs/backup/storage.mdx`, `monitoring.mdx` — final wording pass.
- Modify: release notes source per `update-breeze-release-notes` skill (next version's entry).

### Task 1: Extend `cells-gc.sh` with the reclamation assertions

**Files:**
- Modify: `scripts/backup-assurance/cells-gc.sh` (append after the existing restore/compare block)

**Interfaces:**
- Consumes: `lab.sh` helpers (`$L gc-run` or whatever the existing script calls to enqueue `cleanup-expired-snapshots` — read the file; the name is defined there), `$S/mc`, `psql()`.
- Produces: exit code 0 only when every assertion passes; `runs/lnx/d18-gc.txt` transcript.

- [ ] **Step 1: Write the assertion block (this is the "test")**

```bash
say "R4: reclaimed prefixes must be empty and retired"
FAIL=0
for lbl in $LABELS; do
  n=$($S/mc ls -r lab/breeze-lab/snapshots/$lbl/ 2>/dev/null | wc -l | tr -d ' ')
  swept=$(psql "select count(*) from backup_snapshot_retirements where snapshot_id='$lbl' and swept_at is not null")
  echo "$lbl: $n objects remain, swept_at set: $swept"
  # Objects a retained manifest still references legitimately survive; everything else must be gone.
  refd=$(for m in $(psql "select snapshot_id from backup_snapshots where device_id='$DEV'"); do
           $S/mc cat lab/breeze-lab/snapshots/$m/manifest.json 2>/dev/null | jq -r '.files[].backupPath' | grep "^snapshots/$lbl/" ; done | sort -u | wc -l | tr -d ' ')
  echo "$lbl: $refd objects still referenced by retained manifests"
  if [ "$n" -ne "$refd" ]; then echo "FAIL: $lbl has $n objects but only $refd are referenced"; FAIL=1; fi
  if [ "$refd" -eq 0 ] && [ "$swept" -ne 1 ]; then echo "FAIL: $lbl fully reclaimed but retirement not marked swept"; FAIL=1; fi
done

say "R4b: unrelated manifests (other devices / modes) untouched"
for m in $(psql "select snapshot_id from backup_snapshots where device_id<>'$DEV'"); do
  $S/mc stat lab/breeze-lab/snapshots/$m/manifest.json >/dev/null 2>&1 || { echo "FAIL: retained manifest $m missing"; FAIL=1; }
done

say "R4c: bucket total dropped"
TOTAL_AFTER=$($S/mc ls -r lab/breeze-lab/snapshots/ 2>/dev/null | wc -l | tr -d ' ')
echo "objects in bucket: before=$TOTAL_BEFORE after=$TOTAL_AFTER"
[ "$TOTAL_AFTER" -lt "$TOTAL_BEFORE" ] || { echo "FAIL: nothing reclaimed"; FAIL=1; }
exit $FAIL
```

- [ ] **Step 2: Run against the pre-fix stack (control) — expect FAIL**

Run (main session, lab up on a main build that predates W02):
```bash
LAB_SCRATCH=~/breeze-assurance/scratch scripts/backup-assurance/cells-gc.sh <expired-row-id> | tee ~/breeze-assurance/runs/lnx/d18-gc-control.txt
```
Expected: `FAIL: nothing reclaimed` (the control proves the assertion discriminates).

- [ ] **Step 3: Rebuild the lab stack from main with W01–W03 merged, install the new helper on the Linux rig**

```bash
# from the worktree used for the lab (see docs/testing/backup-assurance/... §3 for the exact compose project)
git fetch origin main && git checkout origin/main
pnpm wt-stack up   # then set the Global Constraints env on the api service and restart it
# Linux rig: control+rc install recipe in memory file lab_rigs_windows_ubuntu_ssh_2026_09.md
```
Verify: `psql "select backup_version from devices where id='$DEV'"` prints a version >= 0.112.0.

- [ ] **Step 4: Produce the chain, expire the base, run the cell — expect PASS**

```bash
# run 1 (full), delete crlf.txt from the corpus, run 2 (incremental), run 3 (incremental) — cells-lnx-i2-c1.sh does this
scripts/backup-assurance/cells-lnx-i2-c1.sh | tee ~/breeze-assurance/runs/lnx/d18-chain.txt
BASE=$(psql "select id from backup_snapshots where device_id='$DEV' order by timestamp asc limit 1")
LAB_SCRATCH=~/breeze-assurance/scratch scripts/backup-assurance/cells-gc.sh $BASE | tee ~/breeze-assurance/runs/lnx/d18-gc.txt
```
Expected: exit 0; the base prefix keeps exactly the objects run 2/3 reference and `crlf.txt.gz` is gone; the newest snapshot restores 10,04x/10,04x byte-identical (`compare-hashes.sh` output in the transcript).

- [ ] **Step 5: Commit the harness change**

```bash
git add scripts/backup-assurance/cells-gc.sh
git commit -m "test(backup-assurance): assert reclamation and retirement in cells-gc.sh (D18 R4)"
```

### Task 2: Pin and lease cells (in-flight base survives; expired lease refuses to publish)

**Files:**
- Create: `scripts/backup-assurance/cells-gc-pins.sh`

- [ ] **Step 1: Write the cell**

```bash
#!/usr/bin/env bash
# D18 pins: (a) a running job's base is not retired; (b) a job past its lease cannot publish.
set -uo pipefail
cd "$(dirname "$0")/../.."
source scripts/backup-assurance/lab.sh   # psql(), say(), enqueue helpers
DEV=$(jq -r .devLnx "$LAB_STATE")
BASE=$(psql "select id from backup_snapshots where device_id='$DEV' order by timestamp desc limit 1")
BASE_LBL=$(psql "select snapshot_id from backup_snapshots where id='$BASE'")

say "(a) start a run, confirm the pin, expire the base, run retention: row must survive"
JOB=$(curl -sf -X POST "$LAB_API/backup/jobs" -H "Authorization: Bearer $LAB_TOKEN" -H 'content-type: application/json' \
      -d "{\"deviceId\":\"$DEV\",\"configId\":\"$(jq -r .configId "$LAB_STATE")\"}" | jq -r .id)
sleep 5
psql "select base_snapshot_id, publish_lease_expires_at from backup_jobs where id='$JOB'"
psql "select set_config('breeze.scope','system',false); update backup_snapshots set expires_at = now() - interval '1 hour' where id='$BASE'"
lab_run_retention   # helper from lab.sh that enqueues cleanup-expired-snapshots and waits
psql "select count(*) from backup_snapshots where id='$BASE'"          # expect 1
psql "select count(*) from backup_snapshot_retirements where snapshot_id='$BASE_LBL'"   # expect 0
docker logs "$LAB_API_CONTAINER" 2>&1 | grep -c 'skippedPinned' 

say "(b) lease expiry: dispatch with BACKUP_BASE_LEASE_MS=60000, stall the agent >60 s, resume: helper must refuse to publish"
# stall by SIGSTOP-ing breeze-backup on the rig for 90 s (vmssh helper), then SIGCONT
$LAB_SCRATCH/vmssh lnx 'sudo pkill -STOP breeze-backup; sleep 90; sudo pkill -CONT breeze-backup'
sleep 30
psql "select status, error_log from backup_jobs where id='$JOB'"     # expect failed / publish_lease_expired
$LAB_SCRATCH/mc stat lab/breeze-lab/snapshots/$(psql "select snapshot_id from backup_jobs where id='$JOB'")/manifest.json && echo "FAIL: manifest published after lease" || echo "OK: no manifest"
```

- [ ] **Step 2: Run it, capture `runs/lnx/d18-pins.txt`; expected: (a) row survives with `skippedPinned 1`, (b) job `failed` with `publish_lease_expired`, no manifest.**

- [ ] **Step 3: Commit**

```bash
git add scripts/backup-assurance/cells-gc-pins.sh
git commit -m "test(backup-assurance): D18 pin and lease cells"
```

### Task 3: Campaign doc close-out

**Files:**
- Modify: `docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md` (R4 row ~:238, D18 row ~:288, §9 item 6, §10 issue table)

- [ ] **Step 1: Edit R4 to PASS with evidence file names, D18 to FIXED with the W01–W03 PR numbers, §9.6 to "resolved: contract C (spec link), decisions §8 of the spec applied as defaults", and add rows for the two new cells (R5 pins, R6 lease).**
- [ ] **Step 2: Commit**

```bash
git add docs/testing/backup-assurance/2026-09-09-backup-assurance-campaign.md
git commit -m "docs(backup-assurance): close D18 — R4 PASS on MinIO, pin/lease cells added"
```

### Task 4: Release notes + docs wording pass

**Files:**
- Modify: release notes entry for the next version (follow the `update-breeze-release-notes` skill for file location and schema)
- Modify: `apps/docs/src/content/docs/backup/storage.mdx`, `monitoring.mdx`

- [ ] **Step 1: Release-note paragraph (self-hoster facing)**

```md
**Backup storage is now reclaimed.** Retention previously deleted only the database record of an expired snapshot; its objects stayed in the bucket forever. Expired snapshots' exclusive objects are now removed by the 6-hourly GC. Two things to know:
- Reclamation on a destination only activates once every device backing up to it runs the backup helper from this release or newer (older helpers choose their own dedupe base and cannot be pinned). The API logs `reclamation deferred: legacy helper <device>` until then.
- Deleting a device or organisation now also reclaims its backups after the orphan window (default 9 days). Previously those objects leaked.
New env knobs (all optional): `BACKUP_BASE_LEASE_MS` (7 d), `BACKUP_PUBLISH_MARGIN_MS` (1 h), `BACKUP_RESTORE_PIN_LINGER_MS` (7 d), `BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS` (9 d). Migrations `2026-10-15-160011` and `-160012` add the pin columns and the `backup_snapshot_retirements` table; the backfill is batched and safe on large tables.
```

- [ ] **Step 2: Re-read both docs pages after W02 merged; remove any remaining "storage is not reclaimed" sentence; add the legacy-helper deferral and the device-deletion behaviour.**
- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/backup/storage.mdx apps/docs/src/content/docs/backup/monitoring.mdx <release-notes-file>
git commit -m "docs(backup): storage reclamation contract, knobs, legacy-helper deferral (D18)"
```

### Task 5: Wave verification
- [ ] `~/breeze-assurance/runs/lnx/d18-gc-control.txt` shows FAIL; `d18-gc.txt` and `d18-pins.txt` show PASS.
- [ ] `pnpm --filter @breeze/docs build` (docs site builds).
- [ ] PR body: link the three evidence files, the spec, and `Closes #5429`; note the two §8 decisions as applied defaults.

## Open questions / contradictions
- `lab.sh` helper names for enqueueing retention (`lab_run_retention`) are assumed — read `lab.sh` and use the real name.
- If the helper's `backup_version` on the rig comes from a dev build (`dev` counts as NOT capable per `backupHelperSupportsQueue`), the gate defers reclamation and Task 1 Step 4 cannot pass; build the helper with a real version tag (`0.112.0-lab`? prereleases also count as NOT capable — use `0.112.0`).
