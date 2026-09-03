# Windows System Restore Checkpoint Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `system_protection` configuration-policy toggle that makes Breeze create — and honestly report — a Windows System Restore checkpoint before patching, script execution, and software install.

**Architecture:** The toggle is **inline settings** on a new `system_protection` config-policy feature type (Pattern B, no normalized table), so partner-wide-first ownership is inherited from the already dual-axis `configuration_policies` parent and **no new config table or RLS policy is written**. The server resolves the toggle at **command-creation time** and stamps a versioned `restorePoint` block into the command payload (the agent heartbeat runs under an org-scoped RLS context and cannot see partner-wide rows — #2930/#1105). A new `agent/internal/systemrestore` package performs one checkpoint **per command**, verifies it by identity (unique description + exact sequence number) rather than by "sequence advanced", and returns a typed `Outcome`. Outcomes land in a new `device_restore_point_attempts` ledger (RLS shape 1) which is the **only durable record** — terminal command processing erases the payload.

**Tech Stack:** Go 1.x agent (`golang.org/x/sys/windows`, WMI `root\default:SystemRestore`), Hono + Drizzle + PostgreSQL (RLS), Zod validators in `@breeze/shared`, React/Astro web, Vitest + `go test -race`.

**Spec:** `docs/superpowers/specs/agent/2026-09-02-windows-restore-checkpoint-policy-spec.md` (approved Gate A, 2026-09-02; all six Open Decisions resolved as recommended)

**Issue:** LanternOps/breeze#4609

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Open Decision 1 is a hard gate.** No wave after W01 starts until the `RESTOREPOINTINFOW` / `STATEMGRSTATUS` layout question is settled on real Windows hardware. Resolution A was approved: *verify on hardware first*.
2. **Product language is constrained.** Every user-visible surface says *"System Restore point creation was confirmed at execution time"*. **Never** "rollback available", "backup", "you can roll back", or any phrasing implying recoverability. System Restore protects system files, registry, programs and settings — **not personal files** — and a created point can later be purged by VSS or rendered unusable under VBS rules (July 2026 Windows change).
3. **v1 is reporting-only** (Open Decision 2 → B). No `onFailure` / `abort` knob. Per-action `off | best_effort | require_recent` modes are **v2 and out of scope here**.
4. **Never gate by Windows SKU** (Open Decision 4 → A). Probe DLL, entry point, provider and enabled state at runtime. A documented support matrix is documentation only.
5. **Never auto-enable System Restore** (Open Decision 5 → A). Report `skipped_disabled`.
6. **Never write `SystemRestorePointCreationFrequency`** (Open Decision 6 → A). Render `existing_accepted` as a *neutral* state naming the existing point's age.
7. **Protocol back-compat contract:** a missing `restorePoint` block on `install_patches` means **legacy best-effort enabled**; a missing block on `script` / `software_install` means **disabled**. An explicit patch *disable* is unenforceable until the device reports the new capability, and the UI must say so.
8. **Sequence numbers are `int64`.** They exceed the JS safe-integer range: **decimal string** on the wire, `bigint` in Postgres, `string` in TypeScript.
9. **Migration naming.** The newest committed migration is `apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql` — over a month ahead of real time. A file named for today would replay *before* it. This plan uses `2026-10-07-1000NN-*`. **Re-check against `origin/main` immediately before every push** (`ls apps/api/migrations | sort | tail -3`); rename if `origin/main` gained something that sorts after. The pre-push hook runs `scripts/check-migration-naming.sh --against-ref origin/main`.
10. **`2026-08-06` is a CLOSED date block.** Never add `-g-` or later to it.
11. **Migrations are idempotent and carry no inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in one transaction. Never edit a shipped migration.
12. **Six registration lists** apply to `device_restore_point_attempts` (W04). RLS coverage does **not** imply cascade coverage. Code review has caught a missed cascade list 0/5; the contract tests caught it 5/5. Treat it as a mechanical grep.
13. **CI trap:** `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` and `orgMergeRegistry.integration.test.ts` run only under **Integration Tests** (needs a live DB). `pnpm test` does **not** run them. Local green ≠ CI green.
14. **CI trap:** never write `pnpm --filter <pkg> test -- --run <path>` — the `--` makes vitest run the whole suite in watch mode. Use `pnpm --filter <pkg> test --run <path>` or `cd apps/api && npx vitest run <path>`.
15. **CI trap:** vitest's path filter is a plain substring match, not a glob. `vitest run src/routes/foo/` silently skips sibling `src/routes/foo.test.ts`. List files explicitly and check the reported file count.
16. **Stacked PRs get NO CI.** `ci.yml` triggers on `pull_request: branches: [main]`. A wave PR based on a sibling wave branch runs no CI at all and `gh pr checks` reads green. Either target `main` or dispatch per branch: `gh workflow run CI --ref <branch>`.
17. **No secret material** enters the `restorePoint` block, the `Outcome`, or the ledger. `commandSecretRedaction` and `redactAgentResultErrorFields` stay unaffected.
18. Aim to keep files under 500 lines (soft guideline). Declarative registries may run longer.

---

## File Structure

**Agent (Go)**

| File | Responsibility |
|---|---|
| `agent/internal/systemrestore/types.go` | `Status` constants, `Outcome` struct, `Request` struct — platform-neutral, compiled everywhere |
| `agent/internal/systemrestore/create_windows.go` | Native `SRSetRestorePointW` call, correctly-aligned structs, COM init, privilege probe |
| `agent/internal/systemrestore/create_other.go` | `!windows` no-op returning `StatusUnsupported` |
| `agent/internal/systemrestore/verify_windows.go` | WMI `root\default:SystemRestore` enumeration + identity verification + frequency read |
| `agent/internal/systemrestore/layout_windows_test.go` | `unsafe.Sizeof` / `unsafe.Offsetof` assertions — the permanent settlement of Open Decision 1 |
| `agent/internal/systemrestore/create_test.go` | Table-driven tests against injected seams |
| `agent/internal/systemrestore/request.go` | Parse the `restorePoint` payload block; back-compat defaults per Global Constraint 7 |
| `agent/internal/backup/vss/session_lifetime.go` (modify) | Export `AcquireSnapshotCreation` / `SnapshotCreationBusy` so restore-point creation shares the one process-wide gate |
| `agent/internal/patching/preflight_windows.go` (modify) | `CreateRestorePoint` deleted; `windows.go` call site rewired |
| `agent/internal/patching/preflight_other.go` (modify) | `CreateRestorePoint` no-op deleted |
| `agent/internal/heartbeat/restorepoint.go` | Shared handler helper: parse block → gate → call `systemrestore` → attach `Outcome` to the result |
| `agent/internal/heartbeat/handlers_patch.go` (modify) | One checkpoint per `install_patches` command, not per patch |
| `agent/internal/heartbeat/handlers_script.go` (modify) | Checkpoint after validation/session selection, before execution |
| `agent/internal/remote/tools/software_install.go` (modify) | Checkpoint after download+checksum+no-op detection, before `executeInstaller` |
| `agent/internal/remote/tools/types.go` (modify) | `RestorePoint *systemrestore.Outcome` on `CommandResult` |
| `agent/internal/websocket/client.go` (modify) | `RestorePoint` on the WS wire `CommandResult` |
| `agent/internal/heartbeat/heartbeat.go` (modify) | `toWSCommandResult` carries `RestorePoint` through |

**API (TypeScript)**

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-07-100000-system-protection-config-feature-type.sql` | `ALTER TYPE config_feature_type ADD VALUE 'system_protection'` — its own file |
| `apps/api/migrations/2026-10-07-100100-device-restore-point-attempts.sql` | Ledger table + RLS shape 1 + composite FK + indexes |
| `apps/api/src/db/schema/configurationPolicies.ts` (modify) | `'system_protection'` in `configFeatureTypeEnum` |
| `apps/api/src/db/schema/deviceRestorePointAttempts.ts` | Drizzle table |
| `apps/api/src/services/configurationPolicy.ts` (modify) | `systemProtectionInlineSettingsSchema` parse in `addFeatureLink` + `updateFeatureLink` + `validateFeaturePolicyExists` inline-only branch |
| `apps/api/src/services/featureConfigResolver.ts` (modify) | `resolveSystemProtectionForDevice` |
| `apps/api/src/services/policyBaselineDefaults.ts` (modify) | `NOT_ENFORCED` entry |
| `apps/api/src/services/restorePointRequest.ts` | Build the versioned `restorePoint` block + insert the `requested` ledger row; the single chokepoint |
| `apps/api/src/services/restorePointIngest.ts` | Terminalise the ledger row from an agent result; idempotent on `requestId` |
| `apps/api/src/services/tenantCascade.ts` (modify) | `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify) | `CORE_TENANT_EXPORT_POLICY` |
| `apps/api/src/services/orgMergeRegistry.ts` (modify) | repoint entry |
| `apps/api/src/routes/devices/core.ts` (modify) | 3 device lists |
| `apps/api/src/routes/agents/schemas.ts` (modify) | `restorePoint` on `commandResultSchema` |
| `apps/api/src/routes/agentWs.ts` (modify) | ingest after the terminal CAS + the direct non-UUID software branch |
| `apps/api/src/routes/agents/commands.ts` (modify) | ingest after the REST terminal CAS |
| `apps/api/src/jobs/patchJobExecutor.ts` (modify) | stamp at `prepareDeviceExecution` |
| `apps/api/src/services/scriptDispatch.ts` (modify) | stamp in the payload build |
| `apps/api/src/services/softwareDeployment.ts` (modify) | stamp at both payload build sites |
| `apps/api/src/routes/devices/restorePoints.ts` | Read route for the device-detail attempts list |

**Shared / Web**

| File | Responsibility |
|---|---|
| `packages/shared/src/constants/configFeatureTypes.ts` (modify) | `'system_protection'` in `CONFIG_FEATURE_TYPES`; **not** in `ORG_SCOPED_ONLY_FEATURE_TYPES` |
| `packages/shared/src/validators/systemProtectionInlineSettings.ts` | Strict Zod schema + typed defaults constant |
| `packages/shared/src/validators/index.ts` (modify) | re-export + `'system_protection'` in `addFeatureLinkSchema`'s hand-listed enum |
| `packages/shared/src/types/restorePoint.ts` | `RestorePointStatus` union + `RestorePointOutcome` + `RestorePointRequestBlock` |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (modify) | `FEATURE_META.system_protection` |
| `apps/web/src/components/configurationPolicies/featureTabs/SystemProtectionTab.tsx` | Editor tab |
| `apps/web/src/components/restorePoints/RestorePointBadge.tsx` | The one shared badge renderer with the constrained copy |
| `apps/web/src/components/scripts/ExecutionDetails.tsx` (modify) | badge |
| `apps/web/src/components/software/DeploymentProgress.tsx` (modify) | badge |
| `apps/web/src/components/patches/PatchInstallHistory.tsx` (modify) | badge |
| `apps/web/src/components/devices/DeviceRestorePointAttempts.tsx` | Device-detail list |

**Docs:** `apps/docs/src/content/docs/features/configuration-policies.mdx`, `patch-management.mdx`, `scripts.mdx`, `software-policies.mdx`.

---

## Wave Overview

| Wave | Title | Depends on | Independently shippable because |
|---|---|---|---|
| W01 | Win32 ABI verification + struct correction + layout regression test | — | Fixes/confirms the existing patch-install checkpoint on its own; **hard gate** |
| W02 | `agent/internal/systemrestore` package | W01 | Agent-only refactor; existing patch call site keeps identical behaviour |
| W03 | `system_protection` policy feature type (shared + API + web tab) | — | Dark policy surface; nothing consumes it yet |
| W04 | `device_restore_point_attempts` ledger + six registration lists | — | Table + contracts; nothing writes to it yet |
| W05 | Server: stamp the request block at the three creation sites | W03, W04 | Old agents ignore the block; no behaviour change |
| W06 | Server: result ingest + ledger terminalisation | W04 | Tolerates agents that never send the field |
| W07 | Agent: honour the block on all three paths + result transport | W02, W05, W06 | Customer-machine code; normal agent release + fleet-promote gate |
| W08 | Console surfaces + ledger read route | W04, W06 | Read-only renders |
| W09 | Docs, support matrix, release notes | W07, W08 | Documentation only |

---

# Wave 01 — Win32 ABI verification, struct correction, layout regression test

**HARD GATE. No other wave starts until Task 1.2 has produced a result on real hardware.**

The shipped code at `agent/internal/patching/preflight_windows.go:329-336` declares `llSequenceNumber` as `uint32` in **both** `RESTOREPOINTINFOW` and `STATEMGRSTATUS`, with a comment (from hardening commit `13aee57b6a`) asserting that `int64` "would corrupt the Description field offset". The Windows SDK declares both as `INT64`. Both cannot be true. If the SDK is right, Breeze may never have created a usable restore point — which changes what we tell the prospect on #4609.

### Task 1.1: Standalone verification harness (throwaway, not shipped)

**Files:**
- Create: `agent/cmd/srprobe/main_windows.go`
- Create: `agent/cmd/srprobe/main_other.go`
- Create: `agent/cmd/srprobe/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. This binary is **deleted in Task 1.5**; only its recorded output survives, in the issue comment and the support matrix.

- [ ] **Step 1: Write the non-Windows stub so `go build ./...` stays green on the CI Linux runner**

`agent/cmd/srprobe/main_other.go`:

```go
//go:build !windows

package main

import "fmt"

func main() {
	fmt.Println("srprobe is Windows-only; nothing to do on this platform")
}
```

- [ ] **Step 2: Write the Windows harness that calls BOTH layouts and enumerates the result**

`agent/cmd/srprobe/main_windows.go`:

```go
//go:build windows

// Command srprobe settles issue #4609 Open Decision 1: is the shipped
// RESTOREPOINTINFOW / STATEMGRSTATUS layout (uint32 llSequenceNumber) or the
// Windows SDK layout (INT64) the correct one?
//
// THROWAWAY. Deleted in the same wave once its output is recorded. It is a
// diagnostic, not a feature: it creates real restore points, so run it only on
// a disposable test machine.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Layout A — exactly as shipped today (preflight_windows.go:329-336).
type restorePointInfoA struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   uint32
	Description      [256]uint16
}

type statemgrStatusA struct {
	Status         uint32
	SequenceNumber uint32
}

// Layout B — the Windows SDK declaration. llSequenceNumber is INT64, and the
// compiler inserts 4 bytes of padding after the two DWORDs to align it on x64.
type restorePointInfoB struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   int64
	Description      [256]uint16
}

type statemgrStatusB struct {
	Status         uint32
	_              uint32
	SequenceNumber int64
}

const (
	beginSystemChange  = 100
	applicationInstall = 0
)

func main() {
	fmt.Printf("GOARCH-dependent sizes:\n")
	fmt.Printf("  A: sizeof(RESTOREPOINTINFO)=%d offsetof(Description)=%d sizeof(STATEMGRSTATUS)=%d\n",
		unsafe.Sizeof(restorePointInfoA{}), unsafe.Offsetof(restorePointInfoA{}.Description),
		unsafe.Sizeof(statemgrStatusA{}))
	fmt.Printf("  B: sizeof(RESTOREPOINTINFO)=%d offsetof(Description)=%d sizeof(STATEMGRSTATUS)=%d\n",
		unsafe.Sizeof(restorePointInfoB{}), unsafe.Offsetof(restorePointInfoB{}.Description),
		unsafe.Sizeof(statemgrStatusB{}))

	dll := windows.NewLazySystemDLL("srclient.dll")
	proc := dll.NewProc("SRSetRestorePointW")
	if err := proc.Find(); err != nil {
		fmt.Printf("FATAL: SRSetRestorePointW not available: %v\n", err)
		os.Exit(1)
	}

	stamp := time.Now().UTC().Format("150405.000")

	descA := "BREEZE-PROBE-A-" + stamp
	rpiA := restorePointInfoA{EventType: beginSystemChange, RestorePointType: applicationInstall}
	copyDesc(rpiA.Description[:], descA)
	var stA statemgrStatusA
	rA, _, errA := proc.Call(uintptr(unsafe.Pointer(&rpiA)), uintptr(unsafe.Pointer(&stA)))
	fmt.Printf("A: ret=%d nStatus=%d seq=%d callErr=%v desc=%q\n", rA, stA.Status, stA.SequenceNumber, errA, descA)

	// Wait past any same-second collision before the second attempt. The
	// throttle (SystemRestorePointCreationFrequency, default 1440 min) is
	// EXPECTED to make the second call reuse the first point's sequence — that
	// is itself a datum, so record it rather than trying to defeat it.
	time.Sleep(2 * time.Second)

	descB := "BREEZE-PROBE-B-" + stamp
	rpiB := restorePointInfoB{EventType: beginSystemChange, RestorePointType: applicationInstall}
	copyDesc(rpiB.Description[:], descB)
	var stB statemgrStatusB
	rB, _, errB := proc.Call(uintptr(unsafe.Pointer(&rpiB)), uintptr(unsafe.Pointer(&stB)))
	fmt.Printf("B: ret=%d nStatus=%d seq=%d callErr=%v desc=%q\n", rB, stB.Status, stB.SequenceNumber, errB, descB)

	fmt.Println("\n--- root\\default:SystemRestore enumeration ---")
	dump()
}

func copyDesc(dst []uint16, s string) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		panic(err)
	}
	if len(u) > len(dst) {
		u = append(u[:len(dst)-1], 0)
	}
	copy(dst, u)
}

func dump() {
	// PowerShell rather than a WMI binding: this is a throwaway diagnostic and
	// the shipped verifier (Task 2.4) does its own typed enumeration.
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance -Namespace root/default -ClassName SystemRestore | "+
			"Select-Object SequenceNumber,Description,CreationTime,RestorePointType,EventType | Format-List",
	).CombinedOutput()
	fmt.Println(strings.TrimSpace(string(out)))
	if err != nil {
		fmt.Printf("(enumeration error: %v)\n", err)
	}
}
```

- [ ] **Step 3: Build for Windows from the dev machine and confirm both platforms compile**

Run:
```bash
cd agent && GOOS=windows GOARCH=amd64 go build -o /tmp/srprobe.exe ./cmd/srprobe && go build ./cmd/srprobe && go vet ./cmd/srprobe/...
```
Expected: both builds succeed, `go vet` clean. `/tmp/srprobe.exe` exists.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/srprobe
git commit -m "chore(agent): add throwaway srprobe harness to settle #4609 restore-point ABI"
```

### Task 1.2: Run the harness on real hardware and record the verdict

**Files:**
- Modify: `agent/cmd/srprobe/README.md`

**Interfaces:**
- Consumes: `/tmp/srprobe.exe` from Task 1.1.
- Produces: the boolean **`SDK_LAYOUT_IS_CORRECT`** that Task 1.3 branches on, plus the raw output pasted into issue #4609 and reused as the seed of the W09 support matrix.

- [ ] **Step 1: Run on each target, elevated, from an Administrator PowerShell**

Targets — all four are required before the gate lifts:
- Windows 11 client (24H2 or later)
- Windows 10 client (22H2)
- Windows Server 2022
- Windows Server 2025

On each:
```powershell
Get-ComputerRestorePoint | Format-List           # baseline: what exists BEFORE
Enable-ComputerRestore -Drive "C:\"              # test box only; never in product code
.\srprobe.exe 2>&1 | Tee-Object -FilePath srprobe-$env:COMPUTERNAME.txt
Get-ComputerRestorePoint | Format-List           # what exists AFTER
```

- [ ] **Step 2: Read the verdict off the output**

Decision rule, applied per machine:

| Observation | Verdict |
|---|---|
| `BREEZE-PROBE-A-…` appears in the enumeration with a plausible sequence number, `BREEZE-PROBE-B-…` does not (or B returns ret=0) | Layout A (`uint32`) is correct — the shipped comment was right |
| `BREEZE-PROBE-B-…` appears and `BREEZE-PROBE-A-…` does not, **or** A's description is truncated/garbled in the enumeration, **or** A returns ret≠0 with `nStatus=0` and creates nothing | Layout B (SDK `int64`) is correct — **the shipped code has been silently doing nothing** |
| Both appear, only because the second call was throttled into reusing the first point | Inconclusive on this machine — re-run after `Get-ComputerRestorePoint` shows the newest point is older than the configured frequency, or on a fresh VM snapshot |

Note the throttle explicitly: a second call inside `SystemRestorePointCreationFrequency` minutes returns `TRUE`/`ERROR_SUCCESS` while reusing the previous point's sequence. Run A and B from **separate fresh VM snapshots** if the same-machine run is inconclusive.

- [ ] **Step 3: Record the result in the harness README and on the issue**

`agent/cmd/srprobe/README.md` gains a `## Results (2026-09-xx)` section with, per machine: OS build, `Get-ComputerRestorePoint` before/after, the full `srprobe.exe` stdout, and the one-line verdict.

Post the same table as a comment on issue #4609. If Layout B wins, the comment must say plainly: *"Breeze has not been creating usable System Restore points on the patch-install path; the issue's framing that we already do this for patching is incorrect."*

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/srprobe/README.md
git commit -m "docs(agent): record #4609 restore-point ABI hardware verification results"
```

### Task 1.3: Layout regression test — the permanent settlement

**Files:**
- Create: `agent/internal/patching/preflight_layout_windows_test.go`

**Interfaces:**
- Consumes: the Task 1.2 verdict.
- Produces: a Windows-tagged test that fails if anyone changes the struct layout again. The **same file moves to `agent/internal/systemrestore/layout_windows_test.go` in W02** — write it here first so W01 ships a regression guard even if W02 slips.

- [ ] **Step 1: Write the failing test**

Write the assertions for the layout the hardware verdict selected. If **Layout B (SDK `int64`)** won:

```go
//go:build windows

package patching

import (
	"testing"
	"unsafe"
)

// Settles issue #4609 Open Decision 1 permanently. The shipped code declared
// llSequenceNumber as uint32 in both structs, with a comment claiming int64
// "would corrupt the Description field offset". Hardware verification
// (agent/cmd/srprobe, see its README) showed the Windows SDK layout — INT64,
// with x64 alignment padding in STATEMGRSTATUS — is the correct one. These
// assertions are the reason nobody has to re-litigate it.
func TestRestorePointInfoLayout(t *testing.T) {
	var rpi restorePointInfo
	if got, want := unsafe.Sizeof(rpi.SequenceNumber), uintptr(8); got != want {
		t.Fatalf("RESTOREPOINTINFOW.llSequenceNumber size = %d, want %d (Windows SDK declares INT64)", got, want)
	}
	if got, want := unsafe.Offsetof(rpi.SequenceNumber), uintptr(8); got != want {
		t.Fatalf("RESTOREPOINTINFOW.llSequenceNumber offset = %d, want %d (two DWORDs then 8-byte alignment)", got, want)
	}
	if got, want := unsafe.Offsetof(rpi.Description), uintptr(16); got != want {
		t.Fatalf("RESTOREPOINTINFOW.szDescription offset = %d, want %d", got, want)
	}
	if got, want := unsafe.Sizeof(rpi), uintptr(16+512); got != want {
		t.Fatalf("sizeof(RESTOREPOINTINFOW) = %d, want %d", got, want)
	}
}

func TestStatemgrStatusLayout(t *testing.T) {
	var st statemgrStatus
	if got, want := unsafe.Sizeof(st.SequenceNumber), uintptr(8); got != want {
		t.Fatalf("STATEMGRSTATUS.llSequenceNumber size = %d, want %d", got, want)
	}
	if got, want := unsafe.Offsetof(st.SequenceNumber), uintptr(8); got != want {
		t.Fatalf("STATEMGRSTATUS.llSequenceNumber offset = %d, want %d (DWORD + 4 bytes padding)", got, want)
	}
	if got, want := unsafe.Sizeof(st), uintptr(16); got != want {
		t.Fatalf("sizeof(STATEMGRSTATUS) = %d, want %d", got, want)
	}
}
```

If **Layout A (`uint32`)** won instead, write the mirror-image assertions (`Sizeof(SequenceNumber)==4`, `Offsetof(Description)==12`, `Sizeof(rpi)==12+512`, `Sizeof(st)==8`) and replace the comment body with the hardware evidence that A is correct. **Either verdict ships a test** — that is the point of the task.

- [ ] **Step 2: Move the structs to package scope so the test can see them**

They are currently declared *inside* `CreateRestorePoint`. Hoist them out, unchanged in field names, above the function in `preflight_windows.go`:

```go
// RESTOREPOINTINFOW / STATEMGRSTATUS. The field types are load-bearing and
// asserted by preflight_layout_windows_test.go — see #4609 and the hardware
// verification in agent/cmd/srprobe/README.md before changing either.
type restorePointInfo struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   int64
	Description      [256]uint16
}

type statemgrStatus struct {
	Status         uint32
	_              uint32
	SequenceNumber int64
}
```

(Use the `uint32` forms if the verdict was Layout A.)

- [ ] **Step 3: Run the test to verify it fails against the OLD declarations**

Temporarily revert the hoisted structs to the shipped `uint32` shape, then run on a Windows machine (or a Windows CI runner):
```bash
cd agent && GOOS=windows go vet ./internal/patching/ && go test -race -run 'TestRestorePointInfoLayout|TestStatemgrStatusLayout' ./internal/patching/
```
Expected (if verdict was B): FAIL with `RESTOREPOINTINFOW.llSequenceNumber size = 4, want 8`.

**This step is what makes the test real.** A layout test written after the struct is already correct confirms rather than discriminates. Watch it go red before restoring the corrected declaration.

- [ ] **Step 4: Restore the corrected declarations and re-run**

Run: same command.
Expected: PASS, both tests.

- [ ] **Step 5: Delete the inner struct declarations from `CreateRestorePoint` and rebuild**

`CreateRestorePoint`'s body now references the package-level types. Delete the shadowing `type restorePointInfo struct {…}` / `type statemgrStatus struct {…}` blocks and the now-false comment.

Run:
```bash
cd agent && GOOS=windows go build ./... && go build ./... && go test -race ./internal/patching/...
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/patching/preflight_windows.go agent/internal/patching/preflight_layout_windows_test.go
git commit -m "fix(agent): correct RESTOREPOINTINFOW/STATEMGRSTATUS layout and pin it with a regression test (#4609)"
```

### Task 1.4: Read `nStatus` on the failure path

**Files:**
- Modify: `agent/internal/patching/preflight_windows.go`
- Create: `agent/internal/patching/preflight_restore_test.go`

**Interfaces:**
- Consumes: the package-level structs from Task 1.3.
- Produces: `CreateRestorePoint` still returns `error`; its message now distinguishes "entry point missing" from "call returned FALSE with nStatus=N". W02 replaces this function entirely — this task exists so W01 is independently useful.

- [ ] **Step 1: Write the failing test for the error-message contract**

`agent/internal/patching/preflight_restore_test.go` (no build tag — it tests a pure helper that both platforms compile):

```go
package patching

import "testing"

func TestFormatRestorePointFailure(t *testing.T) {
	tests := []struct {
		name    string
		ret     uintptr
		nStatus uint32
		want    string
	}{
		{"call returned false with a status", 0, 5, "SRSetRestorePointW returned FALSE (nStatus=5)"},
		{"call returned true but status nonzero", 1, 13, "SRSetRestorePointW reported nStatus=13"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := formatRestorePointFailure(tc.ret, tc.nStatus)
			if got != tc.want {
				t.Fatalf("formatRestorePointFailure(%d, %d) = %q, want %q", tc.ret, tc.nStatus, got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestFormatRestorePointFailure ./internal/patching/`
Expected: FAIL — `undefined: formatRestorePointFailure`.

- [ ] **Step 3: Implement the helper in a platform-neutral file**

Create `agent/internal/patching/restore_failure.go`:

```go
package patching

import "fmt"

// formatRestorePointFailure renders the two distinguishable failure shapes of
// SRSetRestorePointW. Both matter: the shipped code only ever reported the
// boolean return, so a call that came back TRUE with a nonzero nStatus was
// recorded as a success (#4609).
func formatRestorePointFailure(ret uintptr, nStatus uint32) string {
	if ret == 0 {
		return fmt.Sprintf("SRSetRestorePointW returned FALSE (nStatus=%d)", nStatus)
	}
	return fmt.Sprintf("SRSetRestorePointW reported nStatus=%d", nStatus)
}
```

- [ ] **Step 4: Use it in `CreateRestorePoint`**

Replace the tail of `CreateRestorePoint` in `preflight_windows.go`:

```go
	var status statemgrStatus
	r, _, callErr := procSRSetRestorePoint.Call(
		uintptr(unsafe.Pointer(&rpi)),
		uintptr(unsafe.Pointer(&status)),
	)
	// BOTH signals, not just the boolean: SRSetRestorePointW can return TRUE
	// with a nonzero nStatus, which the shipped code counted as success.
	if r == 0 || status.Status != 0 {
		return fmt.Errorf("%s: %v", formatRestorePointFailure(r, status.Status), callErr)
	}

	return nil
```

- [ ] **Step 5: Run the tests**

Run:
```bash
cd agent && go test -race ./internal/patching/... && GOOS=windows go build ./...
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/patching/restore_failure.go agent/internal/patching/preflight_restore_test.go agent/internal/patching/preflight_windows.go
git commit -m "fix(agent): treat a nonzero SRSetRestorePointW nStatus as failure (#4609)"
```

### Task 1.5: Delete the harness and open the wave PR

**Files:**
- Delete: `agent/cmd/srprobe/` (the whole directory)

- [ ] **Step 1: Confirm the results are recorded somewhere durable before deleting**

Run: `git log --oneline -- agent/cmd/srprobe/README.md` and confirm the Task 1.2 commit exists, and that the issue comment is posted (`gh issue view 4609 --comments | grep -c 'srprobe'` returns ≥1).

**Do not delete until both are true.** The README's content is the only record of a hardware run nobody will repeat.

- [ ] **Step 2: Delete**

```bash
git rm -r agent/cmd/srprobe
cd agent && go build ./... && GOOS=windows go build ./...
```
Expected: both builds green.

- [ ] **Step 3: Commit and open the PR**

```bash
git commit -m "chore(agent): remove the srprobe harness now that #4609 Open Decision 1 is settled"
git push -u origin <branch>
gh pr create --base main --title "fix(agent): correct Windows restore-point ABI and pin the layout (#4609 W01)" \
  --body "$(cat <<'BODY'
Wave 01 of #4609. Settles Open Decision 1 on real hardware.

- Hardware verification across Win10 22H2 / Win11 24H2 / Server 2022 / Server 2025 (results recorded in the commit history and on #4609).
- `RESTOREPOINTINFOW` / `STATEMGRSTATUS` corrected to the verified layout, hoisted to package scope.
- `preflight_layout_windows_test.go` pins `unsafe.Sizeof` / `unsafe.Offsetof` so the question is settled permanently.
- A nonzero `nStatus` is now a failure even when the call returns TRUE.

Refs #4609
BODY
)"
```

- [ ] **Step 4: Verify CI**

Run: `gh pr checks --watch`
Expected: `test-agent` green. The layout test is Windows-tagged, so confirm it actually **ran** in the Windows agent job rather than being silently skipped — grep the job log for `TestRestorePointInfoLayout`.

---

# Wave 02 — `agent/internal/systemrestore` package

Agent-only. No server change, no protocol change. At the end of this wave the patch-install path behaves **exactly as it does today** (best-effort, per-update, logged at Debug) but goes through the new package, and every status the feature will ever report is implemented and unit-tested.

**Dependency note:** `github.com/yusufpapurcu/wmi v1.2.4` is already in `agent/go.mod` as an *indirect* dependency. This wave promotes it to a direct one (`go mod tidy` does this automatically once it is imported). No new module download; `go.sum` is unchanged.

### Task 2.1: Status and Outcome types (platform-neutral)

**Files:**
- Create: `agent/internal/systemrestore/types.go`
- Create: `agent/internal/systemrestore/types_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `systemrestore.Status` (string), the nine `Status*` constants, `systemrestore.Outcome`, `systemrestore.Request`, and `func (s Status) Terminal() bool`. Every later task and W07's transport changes depend on these exact names and JSON tags.

- [ ] **Step 1: Write the failing test**

`agent/internal/systemrestore/types_test.go`:

```go
package systemrestore

import (
	"encoding/json"
	"testing"
)

func TestOutcomeJSONShape(t *testing.T) {
	o := Outcome{
		Status:         StatusExistingAccepted,
		RequestID:      "3f1d1a0e-0000-4000-8000-000000000001",
		SequenceNumber: "9223372036854775807",
		Description:    "Breeze: install 6 updates [3f1d1a0e]",
		AttemptedAt:    "2026-09-02T18:03:11Z",
		DurationMs:     1234,

		ExistingPointAgeMinutes: 240,
		FrequencyMinutes:        1440,
	}
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(b, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The sequence number MUST be a JSON string: int64 exceeds the JS safe
	// integer range and the console/API read it as a string (#4609).
	if _, ok := round["sequenceNumber"].(string); !ok {
		t.Fatalf("sequenceNumber must marshal as a JSON string, got %T", round["sequenceNumber"])
	}
	for _, k := range []string{"status", "requestId", "attemptedAt", "durationMs"} {
		if _, ok := round[k]; !ok {
			t.Fatalf("required key %q missing from marshalled Outcome: %s", k, b)
		}
	}
}

func TestOutcomeOmitsEmptyOptionalFields(t *testing.T) {
	b, err := json.Marshal(Outcome{Status: StatusUnsupported, RequestID: "x", AttemptedAt: "t"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	_ = json.Unmarshal(b, &round)
	for _, k := range []string{"sequenceNumber", "description", "message", "existingPointAgeMinutes", "frequencyMinutes"} {
		if _, ok := round[k]; ok {
			t.Fatalf("optional key %q should be omitted when empty: %s", k, b)
		}
	}
}

func TestStatusTerminal(t *testing.T) {
	tests := []struct {
		status Status
		want   bool
	}{
		{StatusCreated, true},
		{StatusExistingAccepted, true},
		{StatusSkippedDisabled, true},
		{StatusSkippedDefinitions, true},
		{StatusUnsupported, true},
		{StatusBusy, true},
		{StatusInsufficientPrivs, true},
		{StatusVerificationFailed, true},
		{StatusFailed, true},
		{Status("requested"), false},
		{Status(""), false},
	}
	for _, tc := range tests {
		if got := tc.status.Terminal(); got != tc.want {
			t.Fatalf("Status(%q).Terminal() = %v, want %v", tc.status, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race ./internal/systemrestore/...`
Expected: FAIL — `no Go files in .../internal/systemrestore` (the package does not exist yet).

- [ ] **Step 3: Write the types**

`agent/internal/systemrestore/types.go`:

```go
// Package systemrestore creates and verifies Windows System Restore
// checkpoints on behalf of risky agent actions (patch install, script
// execution, software install) — see issue #4609.
//
// The package reports what actually happened rather than what was attempted.
// Windows throttles restore-point creation to one per
// SystemRestorePointCreationFrequency minutes (default 1440) and
// SRSetRestorePointW returns TRUE inside that window while reusing the
// previous point's sequence number, so a naive implementation reports N
// successes for at most one real checkpoint. StatusExistingAccepted is the
// honest name for that case; StatusVerificationFailed is the honest name for
// "the call claimed success and we could not confirm it".
//
// Nothing in this package promises recoverability. A created point can later be
// purged by VSS under storage pressure, or rendered unusable under VBS rules.
package systemrestore

// Status is the outcome of one checkpoint attempt.
type Status string

const (
	// StatusCreated — a new restore point was created AND verified by identity
	// (its exact sequence number carries our unique description).
	StatusCreated Status = "created"
	// StatusExistingAccepted — the native call succeeded but returned a
	// sequence number that already existed before it: Windows reused a prior
	// point because we are inside the creation-frequency window. Neutral, not
	// a failure — but never reported as "created".
	StatusExistingAccepted Status = "existing_accepted"
	// StatusSkippedDisabled — System Restore is turned off on this machine.
	// Breeze never turns it on (issue #4609 Open Decision 5).
	StatusSkippedDisabled Status = "skipped_disabled"
	// StatusSkippedDefinitions — every patch in the command was a definitions
	// update, so no checkpoint was warranted.
	StatusSkippedDefinitions Status = "skipped_definition_only"
	// StatusUnsupported — no srclient.dll, no SRSetRestorePointW entry point,
	// no SystemRestore WMI provider, or a non-Windows platform. Determined by
	// probing at runtime, NEVER by SKU (Open Decision 4).
	StatusUnsupported Status = "unsupported"
	// StatusBusy — the process-wide VSS snapshot-creation gate was held (a
	// Breeze backup is creating a snapshot set). We decline rather than
	// thrash shadow storage.
	StatusBusy Status = "busy"
	// StatusInsufficientPrivs — the agent's token is not elevated.
	StatusInsufficientPrivs Status = "insufficient_privileges"
	// StatusVerificationFailed — the native call reported success but WMI
	// could not confirm a point with our exact sequence AND description.
	// Deliberately distinct from both created and existing_accepted.
	StatusVerificationFailed Status = "verification_failed"
	// StatusFailed — the native call itself failed.
	StatusFailed Status = "failed"
)

// Terminal reports whether s is one of the statuses this package can produce.
// The server also stores a non-terminal "requested" status on the ledger row it
// writes at command-creation time; that value never originates here.
func (s Status) Terminal() bool {
	switch s {
	case StatusCreated, StatusExistingAccepted, StatusSkippedDisabled,
		StatusSkippedDefinitions, StatusUnsupported, StatusBusy,
		StatusInsufficientPrivs, StatusVerificationFailed, StatusFailed:
		return true
	}
	return false
}

// Request is the server-stamped instruction carried in the command payload
// under the "restorePoint" key. Resolved at command-creation time because the
// agent heartbeat runs under an org-scoped RLS context and cannot see
// partner-wide policy rows (#2930).
type Request struct {
	Version        int    `json:"v"`
	RequestID      string `json:"requestId"`
	Enabled        bool   `json:"enabled"`
	Label          string `json:"label"`
	ResolvedAt     string `json:"resolvedAt"`
	PolicyRevision string `json:"policyRevision"`
	ValidUntil     string `json:"validUntil"`
}

// Outcome is what the agent reports back on the command result, under the
// top-level "restorePoint" key.
type Outcome struct {
	Status    Status `json:"status"`
	RequestID string `json:"requestId"`
	// SequenceNumber is a DECIMAL STRING, not a number: Windows sequence
	// numbers are INT64 and exceed the JavaScript safe-integer range.
	SequenceNumber string `json:"sequenceNumber,omitempty"`
	Description    string `json:"description,omitempty"`
	Message        string `json:"message,omitempty"`
	AttemptedAt    string `json:"attemptedAt"`
	DurationMs     int64  `json:"durationMs"`
	// ExistingPointAgeMinutes and FrequencyMinutes are set on the
	// StatusExistingAccepted path so the console can say "existing point
	// reused — created 4h ago (Windows limit: every 24h)".
	ExistingPointAgeMinutes int64 `json:"existingPointAgeMinutes,omitempty"`
	FrequencyMinutes        int64 `json:"frequencyMinutes,omitempty"`
}
```

- [ ] **Step 4: Run the tests**

Run: `cd agent && go test -race ./internal/systemrestore/... && GOOS=windows go build ./internal/systemrestore/`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/systemrestore/types.go agent/internal/systemrestore/types_test.go
git commit -m "feat(agent): add systemrestore Status/Outcome/Request types (#4609)"
```

### Task 2.2: Request parsing with the back-compat default matrix

**Files:**
- Create: `agent/internal/systemrestore/request.go`
- Create: `agent/internal/systemrestore/request_test.go`

**Interfaces:**
- Consumes: `Request` from Task 2.1.
- Produces: `func ParseRequest(payload map[string]any, legacyDefaultEnabled bool) (Request, bool)` — returns the parsed request and whether a checkpoint should be attempted. W07's three handlers call it with `legacyDefaultEnabled=true` for `install_patches` and `false` for script/software.

- [ ] **Step 1: Write the failing test**

`agent/internal/systemrestore/request_test.go`:

```go
package systemrestore

import "testing"

func TestParseRequest(t *testing.T) {
	block := map[string]any{
		"v":              float64(1), // encoding/json decodes numbers as float64
		"requestId":      "3f1d1a0e-0000-4000-8000-000000000001",
		"enabled":        true,
		"label":          "Breeze: install 6 updates",
		"resolvedAt":     "2026-09-02T18:03:11Z",
		"policyRevision": "rev-7",
		"validUntil":     "2026-09-03T18:03:11Z",
	}

	tests := []struct {
		name          string
		payload       map[string]any
		legacyDefault bool
		wantAttempt   bool
		wantRequestID string
	}{
		{
			name:          "explicit enabled block is honoured",
			payload:       map[string]any{"restorePoint": block},
			legacyDefault: false,
			wantAttempt:   true,
			wantRequestID: "3f1d1a0e-0000-4000-8000-000000000001",
		},
		{
			name: "explicit disabled block suppresses the attempt",
			payload: map[string]any{"restorePoint": map[string]any{
				"v": float64(1), "requestId": "abc", "enabled": false,
			}},
			legacyDefault: true, // even on the patch path
			wantAttempt:   false,
			wantRequestID: "abc",
		},
		{
			// Global Constraint 7: a missing block on install_patches means
			// LEGACY BEST-EFFORT ENABLED, so an old server keeps today's
			// behaviour rather than silently losing protection.
			name:          "missing block on the patch path falls back to legacy enabled",
			payload:       map[string]any{},
			legacyDefault: true,
			wantAttempt:   true,
			wantRequestID: "",
		},
		{
			// ...and a missing block on script/software means DISABLED.
			name:          "missing block on script/software means disabled",
			payload:       map[string]any{},
			legacyDefault: false,
			wantAttempt:   false,
			wantRequestID: "",
		},
		{
			name:          "an unknown future version is ignored, falling back to the platform default",
			payload:       map[string]any{"restorePoint": map[string]any{"v": float64(99), "enabled": true, "requestId": "z"}},
			legacyDefault: false,
			wantAttempt:   false,
			wantRequestID: "",
		},
		{
			name:          "a non-object restorePoint value is ignored",
			payload:       map[string]any{"restorePoint": "yes please"},
			legacyDefault: false,
			wantAttempt:   false,
			wantRequestID: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, attempt := ParseRequest(tc.payload, tc.legacyDefault)
			if attempt != tc.wantAttempt {
				t.Fatalf("attempt = %v, want %v", attempt, tc.wantAttempt)
			}
			if req.RequestID != tc.wantRequestID {
				t.Fatalf("RequestID = %q, want %q", req.RequestID, tc.wantRequestID)
			}
		})
	}
}

func TestParseRequestKeepsLabelAndRevision(t *testing.T) {
	req, attempt := ParseRequest(map[string]any{"restorePoint": map[string]any{
		"v": float64(1), "requestId": "r1", "enabled": true,
		"label": "Breeze: run script Cleanup", "policyRevision": "rev-7",
	}}, false)
	if !attempt {
		t.Fatal("expected an attempt")
	}
	if req.Label != "Breeze: run script Cleanup" {
		t.Fatalf("Label = %q", req.Label)
	}
	if req.PolicyRevision != "rev-7" {
		t.Fatalf("PolicyRevision = %q", req.PolicyRevision)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestParseRequest ./internal/systemrestore/`
Expected: FAIL — `undefined: ParseRequest`.

- [ ] **Step 3: Implement**

`agent/internal/systemrestore/request.go`:

```go
package systemrestore

// PayloadKey is the command-payload key the server stamps the request under.
const PayloadKey = "restorePoint"

// SupportedVersion is the only Request.Version this agent understands. A newer
// block is ignored rather than half-honoured — the server can add a v2 shape
// without an old agent mis-reading it.
const SupportedVersion = 1

// ParseRequest reads the server-stamped restore-point block off a command
// payload and decides whether to attempt a checkpoint.
//
// legacyDefaultEnabled encodes the mixed-fleet protocol contract (#4609):
// a MISSING block on install_patches means legacy best-effort enabled (pass
// true), while a missing block on script / software_install means disabled
// (pass false). An old server that stamps nothing therefore keeps exactly
// today's behaviour on every path.
//
// The second return is authoritative; the returned Request is zero-valued when
// it is false and no block was present.
func ParseRequest(payload map[string]any, legacyDefaultEnabled bool) (Request, bool) {
	raw, ok := payload[PayloadKey].(map[string]any)
	if !ok {
		return Request{}, legacyDefaultEnabled
	}

	version := 0
	if v, ok := raw["v"].(float64); ok {
		version = int(v)
	}
	if version != SupportedVersion {
		// Unknown shape: fall back to the platform default rather than
		// guessing at a field layout we do not know.
		return Request{}, legacyDefaultEnabled
	}

	req := Request{
		Version:        version,
		RequestID:      stringField(raw, "requestId"),
		Label:          stringField(raw, "label"),
		ResolvedAt:     stringField(raw, "resolvedAt"),
		PolicyRevision: stringField(raw, "policyRevision"),
		ValidUntil:     stringField(raw, "validUntil"),
	}
	enabled, _ := raw["enabled"].(bool)
	req.Enabled = enabled

	return req, enabled
}

func stringField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}
```

- [ ] **Step 4: Run the tests**

Run: `cd agent && go test -race ./internal/systemrestore/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/systemrestore/request.go agent/internal/systemrestore/request_test.go
git commit -m "feat(agent): parse the server-stamped restorePoint request block (#4609)"
```

### Task 2.3: Export the VSS snapshot-creation gate

**Files:**
- Modify: `agent/internal/backup/vss/session_lifetime.go`
- Modify: `agent/internal/backup/vss/session_lifetime_test.go`
- Create: `agent/internal/systemrestore/gate.go`

**Interfaces:**
- Consumes: the existing unexported `acquireSnapshotCreation` / `snapshotCreationBusy` in `package vss`.
- Produces: `vss.AcquireSnapshotCreation(ctx) (release func(), err error)` and `vss.SnapshotCreationBusy() bool`; and in `systemrestore`, the seam `var acquireGate = vss.AcquireSnapshotCreation` so tests can substitute it.

**Why this rather than a private mutex:** a System Restore mutex local to this package would not see the Breeze backup agent's own VSS snapshot creation, which is already serialised process-wide at `agent/internal/backup/vss/vss_windows.go:298`. Two requesters inside the creation interval is exactly what produces `VSS_E_SNAPSHOT_SET_IN_PROGRESS`, and thrashing shadow storage is how a checkpoint evicts the backup it was supposed to complement.

- [ ] **Step 1: Write the failing test for the exported API**

Append to `agent/internal/backup/vss/session_lifetime_test.go`:

```go
// The exported wrappers are what agent/internal/systemrestore uses to share
// this one process-wide gate (#4609). They must be the SAME gate, not a
// parallel one — a second gate would let a restore point and a backup snapshot
// enter the VSS creation interval together.
func TestExportedSnapshotCreationGateIsTheSameGate(t *testing.T) {
	release, err := AcquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("AcquireSnapshotCreation: %v", err)
	}
	if !SnapshotCreationBusy() {
		t.Fatal("SnapshotCreationBusy() = false while the gate is held")
	}
	if !snapshotCreationBusy() {
		t.Fatal("the exported acquire did not take the unexported gate")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := AcquireSnapshotCreation(ctx); !errors.Is(err, ErrVSSSessionInProgress) {
		t.Fatalf("second acquire with a cancelled ctx = %v, want ErrVSSSessionInProgress", err)
	}
	release()
	if SnapshotCreationBusy() {
		t.Fatal("SnapshotCreationBusy() = true after release")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestExportedSnapshotCreationGate ./internal/backup/vss/`
Expected: FAIL — `undefined: AcquireSnapshotCreation`.

- [ ] **Step 3: Add the exported wrappers**

Append to `agent/internal/backup/vss/session_lifetime.go`:

```go
// AcquireSnapshotCreation is the exported form of acquireSnapshotCreation, for
// non-backup callers that also enter the VSS snapshot-creation interval —
// currently agent/internal/systemrestore, which creates Windows System Restore
// checkpoints before risky actions (#4609).
//
// It is deliberately the SAME gate rather than a second one. VSS serialises the
// creation interval process-wide; a restore point requested while a backup is
// inside StartSnapshotSet..DoSnapshotSet gets VSS_E_SNAPSHOT_SET_IN_PROGRESS,
// and both operations compete for the same shadow storage. Callers that cannot
// afford to wait should pass a short context and treat ErrVSSSessionInProgress
// as "busy, skip this one" rather than retrying.
func AcquireSnapshotCreation(ctx context.Context) (release func(), err error) {
	return acquireSnapshotCreation(ctx)
}

// SnapshotCreationBusy reports whether the process-wide creation gate is held.
// Diagnostics only — the answer is stale the moment it returns.
func SnapshotCreationBusy() bool {
	return snapshotCreationBusy()
}
```

- [ ] **Step 4: Add the seam in `systemrestore`**

`agent/internal/systemrestore/gate.go`:

```go
package systemrestore

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// acquireGate is the process-wide VSS snapshot-creation gate, indirected
// through a var so create_test.go can substitute a held/free gate without
// running any VSS code. Never reassign it outside tests.
var acquireGate = vss.AcquireSnapshotCreation

// gateWaitBudget bounds how long a checkpoint waits for a concurrent backup's
// snapshot creation. Short on purpose: a checkpoint is a courtesy before a
// risky action, and the risky action has its own deadline. Exceeding it yields
// StatusBusy, which is an honest report, not a failure.
const gateWaitBudget = 90 * time.Second

func withSnapshotGate(ctx context.Context, fn func() Outcome) Outcome {
	gateCtx, cancel := context.WithTimeout(ctx, gateWaitBudget)
	defer cancel()
	release, err := acquireGate(gateCtx)
	if err != nil {
		return Outcome{Status: StatusBusy, Message: "another VSS snapshot creation is in progress"}
	}
	defer release()
	return fn()
}
```

Add `"time"` to the import block.

- [ ] **Step 5: Run the tests on both platforms**

Run:
```bash
cd agent && go test -race ./internal/backup/vss/... ./internal/systemrestore/... && GOOS=windows go build ./...
```
Expected: PASS. The `vss` package has no build tag on `session_lifetime.go` — this is deliberate (see the file's own comment) and is why the gate is testable under `-race` on Linux CI.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/backup/vss/session_lifetime.go agent/internal/backup/vss/session_lifetime_test.go agent/internal/systemrestore/gate.go
git commit -m "feat(agent): share the VSS snapshot-creation gate with systemrestore (#4609)"
```

### Task 2.4: Windows enumeration, frequency read, and the identity verifier

**Files:**
- Create: `agent/internal/systemrestore/verify_windows.go`
- Create: `agent/internal/systemrestore/verify_other.go`
- Create: `agent/internal/systemrestore/verify_test.go`
- Modify: `agent/go.mod` (promote `github.com/yusufpapurcu/wmi` from indirect to direct via `go mod tidy`)

**Interfaces:**
- Consumes: `Status`, `Outcome` (Task 2.1).
- Produces:
  - `type restorePointRow struct { SequenceNumber int64; Description string; CreationTime time.Time }`
  - `type environment struct { listPoints func() ([]restorePointRow, error); frequencyMinutes func() (int64, error); enabled func() (bool, error); elevated func() bool; now func() time.Time }`
  - `func classify(env environment, req Request, desc string, before map[int64]restorePointRow, candidate int64, callErr error) Outcome`

`classify` is where **all** the decision logic lives, and it is pure — it takes the pre-call snapshot and the native call's result and returns the `Outcome`. That is what makes the honesty cases testable on Linux without Windows.

- [ ] **Step 1: Write the failing test for `classify`**

`agent/internal/systemrestore/verify_test.go` (no build tag — `classify` is pure Go):

```go
package systemrestore

import (
	"errors"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Date(2026, 9, 2, 18, 0, 0, 0, time.UTC) }

func envWith(points []restorePointRow) environment {
	return environment{
		listPoints:       func() ([]restorePointRow, error) { return points, nil },
		frequencyMinutes: func() (int64, error) { return 1440, nil },
		enabled:          func() (bool, error) { return true, nil },
		elevated:         func() bool { return true },
		now:              fixedNow,
	}
}

func snapshot(points []restorePointRow) map[int64]restorePointRow {
	m := make(map[int64]restorePointRow, len(points))
	for _, p := range points {
		m[p.SequenceNumber] = p
	}
	return m
}

const desc = "Breeze: install 6 updates [3f1d1a0e]"

func TestClassifyCreatedOnAFreshMachine(t *testing.T) {
	after := []restorePointRow{{SequenceNumber: 42, Description: desc, CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q (message=%q)", out.Status, StatusCreated, out.Message)
	}
	if out.SequenceNumber != "42" {
		t.Fatalf("SequenceNumber = %q, want %q — it must be a decimal string", out.SequenceNumber, "42")
	}
	if out.Description != desc {
		t.Fatalf("Description = %q, want %q", out.Description, desc)
	}
}

func TestClassifyExistingAcceptedWhenTheSequencePreExisted(t *testing.T) {
	// The honesty case: SRSetRestorePointW returned TRUE, but the sequence it
	// handed back was already on the machine before the call — Windows reused
	// a prior point because we are inside the creation-frequency window.
	prior := restorePointRow{
		SequenceNumber: 41,
		Description:    "Some earlier point",
		CreationTime:   fixedNow().Add(-4 * time.Hour),
	}
	out := classify(envWith([]restorePointRow{prior}), Request{RequestID: "r1"}, desc, snapshot([]restorePointRow{prior}), 41, nil)
	if out.Status != StatusExistingAccepted {
		t.Fatalf("Status = %q, want %q", out.Status, StatusExistingAccepted)
	}
	if out.ExistingPointAgeMinutes != 240 {
		t.Fatalf("ExistingPointAgeMinutes = %d, want 240", out.ExistingPointAgeMinutes)
	}
	if out.FrequencyMinutes != 1440 {
		t.Fatalf("FrequencyMinutes = %d, want 1440", out.FrequencyMinutes)
	}
	if out.Status == StatusCreated {
		t.Fatal("a reused point must never be reported as created")
	}
}

func TestClassifyVerificationFailedWhenWMICannotConfirm(t *testing.T) {
	// The call claimed success, the sequence is new, but no point with our
	// unique description carries it. Never "created", and never mislabelled
	// as rate-limited.
	after := []restorePointRow{{SequenceNumber: 42, Description: "something else entirely", CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyVerificationFailedWhenTheSequenceIsAbsentEntirely(t *testing.T) {
	out := classify(envWith(nil), Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyFailedOnNativeError(t *testing.T) {
	out := classify(envWith(nil), Request{RequestID: "r1"}, desc, snapshot(nil), 0, errors.New("SRSetRestorePointW returned FALSE (nStatus=5)"))
	if out.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusFailed)
	}
	if out.Message == "" {
		t.Fatal("a failure must carry a message")
	}
}

func TestClassifyDoesNotClaimRateLimitingWhenWMIIsUnreadable(t *testing.T) {
	// A WMI enumeration error is NOT evidence of a throttle. It is evidence of
	// nothing, and must read as verification_failed.
	env := envWith(nil)
	env.listPoints = func() ([]restorePointRow, error) { return nil, errors.New("WMI unavailable") }
	out := classify(env, Request{RequestID: "r1"}, desc, snapshot(nil), 42, nil)
	if out.Status != StatusVerificationFailed {
		t.Fatalf("Status = %q, want %q", out.Status, StatusVerificationFailed)
	}
}

func TestClassifyCarriesTheRequestID(t *testing.T) {
	after := []restorePointRow{{SequenceNumber: 7, Description: desc, CreationTime: fixedNow()}}
	out := classify(envWith(after), Request{RequestID: "req-abc"}, desc, snapshot(nil), 7, nil)
	if out.RequestID != "req-abc" {
		t.Fatalf("RequestID = %q, want %q", out.RequestID, "req-abc")
	}
	if out.AttemptedAt == "" {
		t.Fatal("AttemptedAt must be set")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestClassify ./internal/systemrestore/`
Expected: FAIL — `undefined: classify`, `undefined: restorePointRow`, `undefined: environment`.

- [ ] **Step 3: Write the platform-neutral classifier**

Create `agent/internal/systemrestore/verify.go` (no build tag):

```go
package systemrestore

import "time"

// restorePointRow is one row of root\default:SystemRestore.
type restorePointRow struct {
	SequenceNumber int64
	Description    string
	CreationTime   time.Time
}

// environment is the injectable seam over every platform-specific read. Real
// implementations live in verify_windows.go; verify_other.go returns an
// environment that reports "unsupported" for everything.
type environment struct {
	listPoints       func() ([]restorePointRow, error)
	frequencyMinutes func() (int64, error)
	enabled          func() (bool, error)
	elevated         func() bool
	now              func() time.Time
}

// classify turns the pre-call snapshot plus the native call's result into an
// Outcome. It is pure and platform-neutral on purpose: the honesty cases
// (existing_accepted vs verification_failed vs created) are exactly the
// behaviour that must never regress, and this way they are covered by
// `go test -race` on every developer machine and in the Linux CI job — not
// only in the Windows job.
//
// Identity, not ordering. "The max sequence number went up" is NOT an identity
// contract: a third-party requester (Windows Update, an MSI, a backup product)
// can create a point between our two reads, and Windows may reuse a sequence
// inside the creation-frequency window. So we require the EXACT candidate
// sequence to carry our unique description.
func classify(
	env environment,
	req Request,
	desc string,
	before map[int64]restorePointRow,
	candidate int64,
	callErr error,
) Outcome {
	out := Outcome{
		RequestID:   req.RequestID,
		Description: desc,
		AttemptedAt: env.now().UTC().Format(time.RFC3339Nano),
	}

	if callErr != nil {
		out.Status = StatusFailed
		out.Message = callErr.Error()
		return out
	}

	// Rate-limit path first: if the sequence the call handed back already
	// existed, Windows reused a prior point. Report the existing point's age
	// and the configured frequency so the console can say something useful
	// instead of "failed".
	if prior, existed := before[candidate]; existed {
		out.Status = StatusExistingAccepted
		out.SequenceNumber = formatSequence(candidate)
		out.Description = prior.Description
		out.ExistingPointAgeMinutes = int64(env.now().Sub(prior.CreationTime).Minutes())
		if freq, err := env.frequencyMinutes(); err == nil {
			out.FrequencyMinutes = freq
		}
		out.Message = "Windows reused an existing restore point (creation frequency limit)"
		return out
	}

	after, err := env.listPoints()
	if err != nil {
		// A WMI read failure is evidence of nothing. It is emphatically NOT
		// evidence of a throttle, and it is not permission to claim success.
		out.Status = StatusVerificationFailed
		out.Message = "could not enumerate restore points to confirm creation: " + err.Error()
		return out
	}

	for _, row := range after {
		if row.SequenceNumber == candidate && row.Description == desc {
			out.Status = StatusCreated
			out.SequenceNumber = formatSequence(candidate)
			out.Description = row.Description
			return out
		}
	}

	out.Status = StatusVerificationFailed
	out.SequenceNumber = formatSequence(candidate)
	out.Message = "the native call reported success but no restore point with the expected sequence and description was found"
	return out
}
```

Add a `formatSequence` helper in the same file:

```go
// formatSequence renders an int64 sequence number as a decimal string. Never a
// JSON number: these exceed the JavaScript safe-integer range and the console
// reads them as strings.
func formatSequence(n int64) string {
	return strconv.FormatInt(n, 10)
}
```

(import `strconv`.)

- [ ] **Step 4: Run the classifier tests**

Run: `cd agent && go test -race -run TestClassify ./internal/systemrestore/`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the Windows environment**

`agent/internal/systemrestore/verify_windows.go`:

```go
//go:build windows

package systemrestore

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows/registry"
)

// win32SystemRestore mirrors the root\default:SystemRestore WMI class. Field
// names must match the WMI property names exactly — the wmi package binds by
// name, and a typo silently yields a zero value rather than an error.
type win32SystemRestore struct {
	SequenceNumber   int64
	Description      string
	CreationTime     string // WMI DATETIME, e.g. 20260902180311.000000-000
	RestorePointType int32
	EventType        int32
}

const srPolicyKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore`

// defaultFrequencyMinutes is Microsoft's documented default for
// SystemRestorePointCreationFrequency when the value is absent.
const defaultFrequencyMinutes int64 = 1440

func newEnvironment() environment {
	return environment{
		listPoints:       listRestorePoints,
		frequencyMinutes: readCreationFrequency,
		enabled:          systemRestoreEnabled,
		elevated:         privilege.IsRunningAsRoot,
		now:              time.Now,
	}
}

func listRestorePoints() ([]restorePointRow, error) {
	var rows []win32SystemRestore
	q := "SELECT SequenceNumber, Description, CreationTime, RestorePointType, EventType FROM SystemRestore"
	if err := wmi.QueryNamespace(q, &rows, `root\default`); err != nil {
		return nil, fmt.Errorf("SystemRestore WMI query failed: %w", err)
	}
	out := make([]restorePointRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, restorePointRow{
			SequenceNumber: r.SequenceNumber,
			Description:    r.Description,
			CreationTime:   parseWMIDateTime(r.CreationTime),
		})
	}
	return out, nil
}

// parseWMIDateTime parses the CIM DATETIME form yyyymmddHHMMSS.mmmmmmsUUU.
// A malformed value yields the zero time, which classify renders as an
// implausibly large age rather than a crash — the age is advisory copy, never
// a decision input.
func parseWMIDateTime(s string) time.Time {
	if len(s) < 14 {
		return time.Time{}
	}
	t, err := time.ParseInLocation("20060102150405", s[:14], time.Local)
	if err != nil {
		return time.Time{}
	}
	return t
}

func readCreationFrequency() (int64, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, srPolicyKey, registry.QUERY_VALUE)
	if err != nil {
		return defaultFrequencyMinutes, nil // absent key = Windows default
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemRestorePointCreationFrequency")
	if err != nil {
		return defaultFrequencyMinutes, nil
	}
	return int64(v), nil
}

// systemRestoreEnabled reports whether System Restore is on for the system
// drive. Breeze NEVER turns it on (#4609 Open Decision 5): enabling it
// allocates shadow storage on the system volume, which can evict existing
// shadow copies and collide with the Breeze backup agent's own snapshots.
// A disabled machine gets StatusSkippedDisabled and the MSP remediates.
func systemRestoreEnabled() (bool, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, srPolicyKey, registry.QUERY_VALUE)
	if err != nil {
		// No policy key at all: probe by enumerating instead of guessing.
		if _, listErr := listRestorePoints(); listErr != nil {
			return false, listErr
		}
		return true, nil
	}
	defer k.Close()
	// DisableSR = 1 means System Restore is off machine-wide.
	if v, _, err := k.GetIntegerValue("DisableSR"); err == nil && v == 1 {
		return false, nil
	}
	if _, listErr := listRestorePoints(); listErr != nil {
		return false, listErr
	}
	return true, nil
}
```

- [ ] **Step 6: Write the non-Windows environment**

`agent/internal/systemrestore/verify_other.go`:

```go
//go:build !windows

package systemrestore

import (
	"errors"
	"time"
)

// errUnsupported is returned by every read on a non-Windows platform. Nothing
// spawns a process, reads a registry, or touches the filesystem here — the
// no-op is total (#4609).
var errUnsupported = errors.New("System Restore is Windows-only")

func newEnvironment() environment {
	return environment{
		listPoints:       func() ([]restorePointRow, error) { return nil, errUnsupported },
		frequencyMinutes: func() (int64, error) { return 0, errUnsupported },
		enabled:          func() (bool, error) { return false, errUnsupported },
		elevated:         func() bool { return false },
		now:              time.Now,
	}
}
```

- [ ] **Step 7: Tidy modules and build both platforms**

Run:
```bash
cd agent && go mod tidy && git diff --stat go.mod go.sum && go build ./... && GOOS=windows go build ./... && go test -race ./internal/systemrestore/...
```
Expected: `go.mod` shows `github.com/yusufpapurcu/wmi` moved out of the indirect block; `go.sum` unchanged. Both builds green, tests PASS.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/systemrestore/verify.go agent/internal/systemrestore/verify_windows.go agent/internal/systemrestore/verify_other.go agent/internal/systemrestore/verify_test.go agent/go.mod agent/go.sum
git commit -m "feat(agent): identity-based restore-point verification via root\\default:SystemRestore (#4609)"
```

### Task 2.5: `Create` — the public entry point

**Files:**
- Create: `agent/internal/systemrestore/create.go`
- Create: `agent/internal/systemrestore/create_windows.go`
- Create: `agent/internal/systemrestore/create_other.go`
- Create: `agent/internal/systemrestore/create_test.go`
- Create: `agent/internal/systemrestore/layout_windows_test.go`

**Interfaces:**
- Consumes: `Request`, `Outcome`, `environment`, `classify`, `withSnapshotGate`.
- Produces: `func Create(ctx context.Context, req Request) Outcome` — the single entry point W07's three handlers call.

**Open Decision 3 was resolved B-for-correctness, A-if-the-budget-forces-it. This plan ships A (in-process) and says so plainly:** `windows.Proc.Call` is synchronous and **cannot** be cancelled by `context.WithTimeout`. The `ctx` argument bounds only the snapshot-gate wait and the WMI verification poll — **not** the native call. The server-side deadlines in W05 are sized around that (patch polling already gives up at 30 minutes, `patchJobExecutor.ts:1070`; the script budget is the command's own `timeoutSeconds`). An out-of-process helper with a killable boundary is the correct long-term shape and is recorded as a follow-up in W09, not smuggled in here.

- [ ] **Step 1: Write the failing test**

`agent/internal/systemrestore/create_test.go` (no build tag):

```go
package systemrestore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBuildDescriptionEmbedsTheRequestIDAndFitsTheFixedBuffer(t *testing.T) {
	req := Request{RequestID: "3f1d1a0e-0000-4000-8000-000000000001", Label: "Breeze: install 6 updates"}
	got := buildDescription(req)
	if !strings.Contains(got, "3f1d1a0e") {
		t.Fatalf("description %q must embed the requestId so verification can key on identity", got)
	}
	if !strings.Contains(got, "install 6 updates") {
		t.Fatalf("description %q lost the human-readable label", got)
	}
	if len([]rune(got)) > maxDescriptionRunes {
		t.Fatalf("description is %d runes, over the %d-rune cap", len([]rune(got)), maxDescriptionRunes)
	}
}

func TestBuildDescriptionTruncatesAHostileLabelWithoutLosingTheRequestID(t *testing.T) {
	req := Request{RequestID: "abcdef12-0000-4000-8000-000000000001", Label: strings.Repeat("x", 4000)}
	got := buildDescription(req)
	if len([]rune(got)) > maxDescriptionRunes {
		t.Fatalf("description is %d runes, over the %d-rune cap", len([]rune(got)), maxDescriptionRunes)
	}
	if !strings.Contains(got, "abcdef12") {
		t.Fatalf("truncation dropped the requestId: %q", got)
	}
}

func TestCreateReturnsSkippedDisabledWhenSystemRestoreIsOff(t *testing.T) {
	env := newTestEnvironment()
	env.enabled = func() (bool, error) { return false, nil }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusSkippedDisabled {
		t.Fatalf("Status = %q, want %q", out.Status, StatusSkippedDisabled)
	}
}

func TestCreateReturnsUnsupportedWhenTheProviderIsAbsent(t *testing.T) {
	env := newTestEnvironment()
	env.enabled = func() (bool, error) { return false, ErrUnsupported }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", out.Status, StatusUnsupported)
	}
}

func TestCreateReturnsInsufficientPrivilegesForANonElevatedToken(t *testing.T) {
	env := newTestEnvironment()
	env.elevated = func() bool { return false }
	out := createWith(context.Background(), Request{RequestID: "r1"}, env, neverCalledNative(t))
	if out.Status != StatusInsufficientPrivs {
		t.Fatalf("Status = %q, want %q", out.Status, StatusInsufficientPrivs)
	}
}

func TestCreateReturnsBusyWhenTheSnapshotGateIsHeld(t *testing.T) {
	prev := acquireGate
	t.Cleanup(func() { acquireGate = prev })
	acquireGate = func(ctx context.Context) (func(), error) { return nil, errors.New("in progress") }

	out := createWith(context.Background(), Request{RequestID: "r1"}, newTestEnvironment(), neverCalledNative(t))
	if out.Status != StatusBusy {
		t.Fatalf("Status = %q, want %q", out.Status, StatusBusy)
	}
}

func TestCreateHappyPathReportsCreatedAndDuration(t *testing.T) {
	env := newTestEnvironment()
	var seen string
	native := func(desc string) (int64, error) {
		seen = desc
		env.listPoints = func() ([]restorePointRow, error) {
			return []restorePointRow{{SequenceNumber: 99, Description: desc, CreationTime: fixedNow()}}, nil
		}
		return 99, nil
	}
	out := createWith(context.Background(), Request{RequestID: "r1", Label: "Breeze: run script"}, env, native)
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q (message=%q)", out.Status, StatusCreated, out.Message)
	}
	if seen == "" {
		t.Fatal("the native call never received a description")
	}
	if out.DurationMs < 0 {
		t.Fatalf("DurationMs = %d, want >= 0", out.DurationMs)
	}
}

func newTestEnvironment() environment {
	return environment{
		listPoints:       func() ([]restorePointRow, error) { return nil, nil },
		frequencyMinutes: func() (int64, error) { return 1440, nil },
		enabled:          func() (bool, error) { return true, nil },
		elevated:         func() bool { return true },
		now:              time.Now,
	}
}

func neverCalledNative(t *testing.T) nativeCall {
	t.Helper()
	return func(string) (int64, error) {
		t.Fatal("the native SRSetRestorePointW call must not run on this path")
		return 0, nil
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run 'TestCreate|TestBuildDescription' ./internal/systemrestore/`
Expected: FAIL — `undefined: buildDescription`, `undefined: createWith`, `undefined: nativeCall`, `undefined: ErrUnsupported`.

- [ ] **Step 3: Write the platform-neutral orchestration**

`agent/internal/systemrestore/create.go`:

```go
package systemrestore

import (
	"context"
	"errors"
	"strings"
	"time"
)

// ErrUnsupported means this machine has no usable System Restore provider:
// no srclient.dll, no SRSetRestorePointW entry point, no SystemRestore WMI
// class, or a non-Windows platform. Determined by probing, NEVER by SKU —
// Microsoft's own documentation conflicts on Windows Server, so a SKU gate
// would be wrong under at least one reading of it (#4609 Open Decision 4).
var ErrUnsupported = errors.New("System Restore is not available on this machine")

// maxDescriptionRunes bounds the description we hand SRSetRestorePointW. The
// native buffer is a fixed [256]uint16 including the null terminator, so 255
// UTF-16 code units is the hard ceiling; we stay under it in runes, which is
// conservative for any character outside the BMP.
const maxDescriptionRunes = 200

// nativeCall performs the actual SRSetRestorePointW call for the given
// description and returns the sequence number Windows reported. Injected so
// every decision path above it is testable without Windows.
type nativeCall func(description string) (int64, error)

// Create takes one Windows System Restore checkpoint for req and reports what
// actually happened.
//
// TIMEOUT CAVEAT, stated plainly: ctx bounds the VSS snapshot-gate wait and the
// WMI verification, but NOT the native call. windows.Proc.Call is synchronous
// and cannot be cancelled by a context — there is no in-process way to abandon
// it. Callers must size their own deadlines assuming this can block for as long
// as the Windows System Restore subsystem takes. See #4609 Open Decision 3;
// moving the call into a killable helper process is the recorded follow-up.
func Create(ctx context.Context, req Request) Outcome {
	return createWith(ctx, req, newEnvironment(), nativeCreateRestorePoint)
}

func createWith(ctx context.Context, req Request, env environment, native nativeCall) Outcome {
	start := env.now()
	finish := func(o Outcome) Outcome {
		o.RequestID = req.RequestID
		if o.AttemptedAt == "" {
			o.AttemptedAt = start.UTC().Format(time.RFC3339Nano)
		}
		o.DurationMs = env.now().Sub(start).Milliseconds()
		return o
	}

	enabled, err := env.enabled()
	switch {
	case errors.Is(err, ErrUnsupported), errors.Is(err, errUnsupportedSentinel()):
		return finish(Outcome{Status: StatusUnsupported, Message: "System Restore is not available on this machine"})
	case err != nil:
		return finish(Outcome{Status: StatusFailed, Message: "could not determine System Restore state: " + err.Error()})
	case !enabled:
		// Breeze never turns System Restore on (Open Decision 5). Report it so
		// the MSP can remediate with their own script.
		return finish(Outcome{Status: StatusSkippedDisabled, Message: "System Restore is turned off on this device"})
	}

	if !env.elevated() {
		// Command privilege checking is warn-only in the agent
		// (heartbeat.go), and script/software commands are not in the
		// elevated list at all — so detect the real token rather than
		// returning a generic failure the tech cannot act on.
		return finish(Outcome{Status: StatusInsufficientPrivs, Message: "the agent is not running with an elevated token"})
	}

	desc := buildDescription(req)

	return finish(withSnapshotGate(ctx, func() Outcome {
		// Snapshot BEFORE the call so classify can tell a genuinely new
		// sequence from one Windows reused under the frequency throttle.
		before := map[int64]restorePointRow{}
		if rows, err := env.listPoints(); err == nil {
			for _, r := range rows {
				before[r.SequenceNumber] = r
			}
		}
		candidate, callErr := native(desc)
		return classify(env, req, desc, before, candidate, callErr)
	}))
}

// buildDescription builds a UNIQUE, length-bounded description embedding the
// requestId. Uniqueness is what makes identity verification possible: without
// it, a concurrent third-party restore point could be mistaken for ours.
func buildDescription(req Request) string {
	shortID := req.RequestID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	suffix := " [" + shortID + "]"

	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = "Breeze"
	}
	budget := maxDescriptionRunes - len([]rune(suffix))
	runes := []rune(label)
	if len(runes) > budget {
		runes = runes[:budget]
	}
	return string(runes) + suffix
}
```

Add to `verify_other.go` and `verify_windows.go` a small shim so `createWith` can recognise the platform sentinel:

```go
// verify_other.go
func errUnsupportedSentinel() error { return errUnsupported }
```
```go
// verify_windows.go
func errUnsupportedSentinel() error { return ErrUnsupported }
```

- [ ] **Step 4: Write the Windows native call**

`agent/internal/systemrestore/create_windows.go`:

```go
//go:build windows

package systemrestore

import (
	"fmt"
	"unsafe"

	"github.com/go-ole/go-ole"
	"golang.org/x/sys/windows"
)

// RESTOREPOINTINFOW and STATEMGRSTATUS.
//
// The field types are load-bearing and pinned by layout_windows_test.go. They
// were WRONG in the shipped code (uint32 llSequenceNumber in both structs,
// with a comment asserting the opposite) until #4609 W01 settled it on real
// hardware — see agent/cmd/srprobe/README.md in that commit's history. Do not
// change either declaration without redoing that verification.
type restorePointInfoW struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   int64
	Description      [256]uint16
}

type statemgrStatusW struct {
	Status         uint32
	_              uint32
	SequenceNumber int64
}

const (
	beginSystemChange  = 100
	applicationInstall = 0
)

// nativeCreateRestorePoint calls SRSetRestorePointW.
//
// COM: SRSetRestorePoint requires CoInitializeEx. Today the shipped call
// happens incidentally inside the patching COM thread; this package does its
// own initialisation so a generic handler (script, software install) is not
// relying on that accident. CoInitializeSecurity is deliberately NOT called —
// it is process-wide and the backup/VSS subsystem has its own requirements
// (#4609 Open Decision 3); we take the process's existing security settings.
func nativeCreateRestorePoint(description string) (int64, error) {
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		// RPC_E_CHANGED_MODE means COM is already initialised on this
		// goroutine's thread in another mode, which is fine to proceed under.
		if oleErr, ok := err.(*ole.OleError); !ok || oleErr.Code() != 0x80010106 {
			return 0, fmt.Errorf("CoInitializeEx failed: %w", err)
		}
	} else {
		defer ole.CoUninitialize()
	}

	dll := windows.NewLazySystemDLL("srclient.dll")
	proc := dll.NewProc("SRSetRestorePointW")
	if err := proc.Find(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrUnsupported, err)
	}

	rpi := restorePointInfoW{EventType: beginSystemChange, RestorePointType: applicationInstall}
	descUTF16, err := windows.UTF16FromString(description)
	if err != nil {
		return 0, fmt.Errorf("failed to convert description: %w", err)
	}
	if len(descUTF16) > len(rpi.Description) {
		descUTF16 = append(descUTF16[:len(rpi.Description)-1], 0)
	}
	copy(rpi.Description[:], descUTF16)

	var status statemgrStatusW
	r, _, callErr := proc.Call(
		uintptr(unsafe.Pointer(&rpi)),
		uintptr(unsafe.Pointer(&status)),
	)
	// BOTH signals. SRSetRestorePointW can return TRUE with a nonzero nStatus;
	// the shipped code read only the boolean and counted that as success.
	if r == 0 {
		return 0, fmt.Errorf("SRSetRestorePointW returned FALSE (nStatus=%d): %v", status.Status, callErr)
	}
	if status.Status != 0 {
		return 0, fmt.Errorf("SRSetRestorePointW reported nStatus=%d", status.Status)
	}
	return status.SequenceNumber, nil
}
```

- [ ] **Step 5: Write the non-Windows native stub**

`agent/internal/systemrestore/create_other.go`:

```go
//go:build !windows

package systemrestore

// nativeCreateRestorePoint is a total no-op on non-Windows: no process spawn,
// no registry read, no filesystem access, no error path that could surprise a
// macOS or Linux fleet (#4609).
func nativeCreateRestorePoint(string) (int64, error) {
	return 0, ErrUnsupported
}
```

- [ ] **Step 6: Move the layout regression test into this package**

Create `agent/internal/systemrestore/layout_windows_test.go` as a copy of W01's `preflight_layout_windows_test.go`, with `restorePointInfo` → `restorePointInfoW` and `statemgrStatus` → `statemgrStatusW`, and the same assertions the hardware verdict selected. Keep the W01 file where it is until Task 2.6 deletes the old function.

- [ ] **Step 7: Run everything on both platforms**

Run:
```bash
cd agent && go test -race ./internal/systemrestore/... && go build ./... && GOOS=windows go build ./... && GOOS=windows go vet ./internal/systemrestore/
```
Expected: PASS. The non-Windows `Create` returns `StatusUnsupported` via `env.enabled()` returning `errUnsupported`.

- [ ] **Step 8: Add the explicit non-Windows no-op test**

Append to `create_test.go`:

```go
func TestCreateOnThisPlatform(t *testing.T) {
	// On Linux/macOS this exercises the real newEnvironment(), which must
	// report unsupported without spawning anything.
	out := Create(context.Background(), Request{RequestID: "r1", Label: "Breeze"})
	if runtime.GOOS != "windows" && out.Status != StatusUnsupported {
		t.Fatalf("Status on %s = %q, want %q", runtime.GOOS, out.Status, StatusUnsupported)
	}
	if out.RequestID != "r1" {
		t.Fatalf("RequestID = %q, want r1", out.RequestID)
	}
}
```

(import `runtime`.) Run: `cd agent && go test -race ./internal/systemrestore/...` — PASS.

- [ ] **Step 9: Commit**

```bash
git add agent/internal/systemrestore/
git commit -m "feat(agent): systemrestore.Create with gated, verified checkpoint creation (#4609)"
```

### Task 2.6: Retire `patching.CreateRestorePoint`

**Files:**
- Modify: `agent/internal/patching/windows.go`
- Modify: `agent/internal/patching/preflight_windows.go`
- Modify: `agent/internal/patching/preflight_other.go`
- Delete: `agent/internal/patching/preflight_layout_windows_test.go`
- Delete: `agent/internal/patching/restore_failure.go`, `agent/internal/patching/preflight_restore_test.go`
- Modify: `agent/internal/patching/manager_test.go` if it references the removed symbol

**Interfaces:**
- Consumes: `systemrestore.Create` (Task 2.5).
- Produces: nothing new. `patching` no longer exports `CreateRestorePoint`.

**Behaviour must not change in this wave.** The per-update call site keeps its per-update, best-effort, Debug-logged semantics; it just routes through the new package. Moving to one-checkpoint-per-command is W07's job, because that is the change that needs the server's request block to be meaningful.

- [ ] **Step 1: Confirm the call sites before touching anything**

Run: `cd agent && grep -rn "CreateRestorePoint" --include='*.go' .`
Expected: exactly the definition in `preflight_windows.go`, the no-op in `preflight_other.go`, and the single call in `windows.go`. If a fourth site appears, stop and re-scope the task.

- [ ] **Step 2: Rewire the patching call site**

In `agent/internal/patching/windows.go`, replace:

```go
		// Create restore point before install (best-effort, skip for definitions)
		category := w.mapCategory(update)
		if category != "definitions" {
			if rpErr := CreateRestorePoint("Before install: " + title); rpErr != nil {
				log.Debug("restore point creation failed (non-fatal)", "error", rpErr)
			}
		}
```

with:

```go
		// Create restore point before install (best-effort, skip for definitions).
		//
		// Still PER UPDATE and still best-effort here — #4609 W07 moves the
		// checkpoint up to one per install_patches command, where the server's
		// policy decision is available. This wave only changes which package
		// performs the call.
		category := w.mapCategory(update)
		if category != "definitions" {
			out := systemrestore.Create(context.Background(), systemrestore.Request{
				Label: "Before install: " + title,
			})
			if out.Status != systemrestore.StatusCreated {
				log.Debug("restore point not created (non-fatal)",
					"status", string(out.Status), "message", out.Message)
			}
		}
```

Add `"context"` and `"github.com/breeze-rmm/agent/internal/systemrestore"` to the imports.

- [ ] **Step 3: Delete the old implementation and its W01 scaffolding**

Remove from `preflight_windows.go`: the package-level `restorePointInfo` / `statemgrStatus` types and the whole `CreateRestorePoint` function. Remove `CreateRestorePoint` from `preflight_other.go`. Then:

```bash
git rm agent/internal/patching/preflight_layout_windows_test.go agent/internal/patching/restore_failure.go agent/internal/patching/preflight_restore_test.go
```

The layout assertions live on in `agent/internal/systemrestore/layout_windows_test.go` (Task 2.5 Step 6) — verify that file exists before deleting the `patching` copy.

- [ ] **Step 4: Confirm the symbol is gone and both platforms build**

Run:
```bash
cd agent && grep -rn "CreateRestorePoint" --include='*.go' . ; go build ./... && GOOS=windows go build ./... && go test -race ./internal/patching/... ./internal/systemrestore/...
```
Expected: the grep prints nothing; both builds green; tests PASS.

- [ ] **Step 5: Commit and open the wave PR**

```bash
git add -A agent/
git commit -m "refactor(agent): route patch-install checkpoints through systemrestore (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(agent): systemrestore package with honest checkpoint reporting (#4609 W02)" --body "Wave 02 of #4609. Agent-only; patch-install behaviour is unchanged.

- New \`agent/internal/systemrestore\` package: typed \`Status\`/\`Outcome\`, request parsing with the mixed-fleet default matrix, identity-based verification against \`root\\default:SystemRestore\`, the shared VSS snapshot-creation gate, runtime capability probing (never SKU gating).
- \`existing_accepted\` and \`verification_failed\` are distinct from \`created\` and unit-tested — the throttle case is now reportable instead of invisible.
- \`patching.CreateRestorePoint\` removed; its one call site rewired.
- Timeout caveat is documented in \`Create\`'s doc comment rather than claimed: \`windows.Proc.Call\` cannot be cancelled by a context.

Refs #4609"
```

- [ ] **Step 6: Verify CI actually ran the Windows tests**

Run: `gh pr checks --watch`, then grep the `test-agent` Windows job log for `TestRestorePointInfoLayout` and `TestStatemgrStatusLayout`.
Expected: both present and passing. A Windows-tagged test that never ran is not a passing test.

---

# Wave 03 — `system_protection` config-policy feature type

Independent of W01/W02 — this wave touches no agent code. It ships a **dark** policy surface: a tech can author the toggle, and nothing reads it yet. An unassigned feature link is itself the off switch, so no feature flag is needed.

**Partner-wide-first is satisfied structurally, not by new code.** The toggle rides `config_policy_feature_links.inline_settings`, whose parent `configuration_policies` is already dual-axis (`org_id` XOR `partner_id`, `configuration_policies_one_owner_chk`, migration `2026-06-27-config-policies-partner-ownership.sql`, registered in `DUAL_AXIS_TENANT_TABLES`). Partner-wide authoring is already gated on `canManagePartnerWidePolicies(auth)`; resolution already admits partner-owned rows via `policyOwnershipCondition(hierarchy)` + `withPartnerWideVisibility`. **No new table, no new RLS policy, no new registration list.**

`system_protection` must **NOT** be added to `ORG_SCOPED_ONLY_FEATURE_TYPES` — its settings are partner-agnostic booleans with no per-tenant anchor.

### Task 3.1: Enum migration + Drizzle enum + canonical constant

**Files:**
- Create: `apps/api/migrations/2026-10-07-100000-system-protection-config-feature-type.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:30`
- Modify: `packages/shared/src/constants/configFeatureTypes.ts:22`

**Interfaces:**
- Consumes: nothing.
- Produces: the string literal `'system_protection'` as a member of `ConfigFeatureType` and of the Postgres `config_feature_type` enum.

- [ ] **Step 1: Confirm the migration name still sorts last**

Run: `ls apps/api/migrations/*.sql | sort | tail -3`
Expected: the newest is `2026-10-06-100000-script-custom-field-writeback.sql`, so `2026-10-07-100000-...` sorts after it. **If `origin/main` has gained something newer, pick a name that sorts after that instead** — shipped migrations are content-hash immutable and cannot be renamed later.

- [ ] **Step 2: Write the migration**

`apps/api/migrations/2026-10-07-100000-system-protection-config-feature-type.sql`:

```sql
-- Add the `system_protection` config-policy feature type (#4609).
--
-- Pattern B (inline settings only): the toggle lives in
-- config_policy_feature_links.inline_settings (JSONB), like vulnerability /
-- warranty / helper / pam. No normalized settings table -- see the spec for why
-- (a normalized table would add THREE extra registration lists for four
-- booleans with no independent identity, lifecycle, or query surface).
--
-- ALTER TYPE ... ADD VALUE is transaction-safe here because the new value is
-- NOT used elsewhere in this migration -- Postgres 12+ allows ADD VALUE inside
-- the transaction autoMigrate wraps each file in, as long as the value isn't
-- consumed in the same transaction. That is exactly why this is its own file.
-- Precedent: 2026-06-29-vuln-config-feature-type.sql.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'system_protection'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'system_protection';
  END IF;
END $$;
```

- [ ] **Step 3: Add the canonical constant FIRST so the parity guards go red**

The parity tests already exist (`apps/api/src/services/policyBaselineDefaults.test.ts` pins `CONFIG_FEATURE_TYPES` to the Drizzle enum; `apps/web/.../featureTypeParity.test.ts` pins `FEATURE_META` to it). Adding the constant before the enum and the tab is what proves they discriminate.

In `packages/shared/src/constants/configFeatureTypes.ts`, append to `CONFIG_FEATURE_TYPES`:

```ts
export const CONFIG_FEATURE_TYPES = [
  'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
  'vulnerability', 'system_protection',
] as const;
```

Leave `ORG_SCOPED_ONLY_FEATURE_TYPES` untouched, and add a line to its doc comment:

```
 * system_protection is deliberately absent: its settings are partner-agnostic
 * booleans with no per-tenant anchor, so it is authorable partner-wide from
 * day one (#4609, epic #2135).
```

- [ ] **Step 4: Run the parity tests and watch them fail**

Run:
```bash
cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts
cd ../web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts
```
Expected: BOTH FAIL — the API one because the Drizzle enum lacks `system_protection`, the web one because `FEATURE_META` lacks it. Both guards work.

- [ ] **Step 5: Add the value to the Drizzle enum**

In `apps/api/src/db/schema/configurationPolicies.ts`, append `'system_protection',` to `configFeatureTypeEnum` after `'vulnerability'`.

- [ ] **Step 6: Re-run the API parity test**

Run: `cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts`
Expected: still FAIL, but now on the missing `NOT_ENFORCED` entry rather than the enum. Task 3.3 closes it; the web test stays red until Task 3.4.

- [ ] **Step 7: Apply the migration and verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Expected: the migration applies; drift check clean. (`db:check-drift` compares schema to migrations, not schema to a live DB — run `db:migrate` first so the enum actually exists.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-07-100000-system-protection-config-feature-type.sql \
        apps/api/src/db/schema/configurationPolicies.ts \
        packages/shared/src/constants/configFeatureTypes.ts
git commit -m "feat(api): add the system_protection config-policy feature type (#4609)"
```

### Task 3.2: Strict inline-settings validator in `@breeze/shared`

**Files:**
- Create: `packages/shared/src/validators/systemProtectionInlineSettings.ts`
- Create: `packages/shared/src/validators/systemProtectionInlineSettings.test.ts`
- Modify: `packages/shared/src/validators/index.ts:22` (re-export) and `:585` (`addFeatureLinkSchema` enum)

**Interfaces:**
- Consumes: nothing.
- Produces: `systemProtectionInlineSettingsSchema` (a `.strict()` object, **not** `.partial()`), `type SystemProtectionInlineSettings`, `SYSTEM_PROTECTION_DEFAULTS: Readonly<SystemProtectionInlineSettings>`.

**Do not copy `vulnerability` literally.** Its resolver does an unchecked cast (`featureConfigResolver.ts:1202`) and the generic validator accepts essentially any record. This schema is strict and the resolver parses.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/validators/systemProtectionInlineSettings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  systemProtectionInlineSettingsSchema,
  SYSTEM_PROTECTION_DEFAULTS,
} from './systemProtectionInlineSettings';
import { addFeatureLinkSchema } from './index';

describe('systemProtectionInlineSettingsSchema', () => {
  it('applies the legacy-parity defaults for an empty object', () => {
    const parsed = systemProtectionInlineSettingsSchema.parse({});
    // beforePatching defaults TRUE to match what the agent already does today
    // (windows.go creates a point per non-definitions update); the two new
    // paths default FALSE so enabling the feature never surprises a fleet.
    expect(parsed).toEqual({
      beforePatching: true,
      beforeScripts: false,
      beforeSoftwareInstall: false,
      labelPrefix: 'Breeze',
    });
    expect(SYSTEM_PROTECTION_DEFAULTS).toEqual(parsed);
  });

  it('rejects unknown keys rather than silently persisting them', () => {
    // An AI-guessed key like `beforeRemoteTerminal` must not be stored and
    // echoed back as if it took effect -- the runtime reader would ignore it.
    const res = systemProtectionInlineSettingsSchema.safeParse({
      beforePatching: true,
      beforeRemoteTerminal: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-boolean toggle', () => {
    expect(systemProtectionInlineSettingsSchema.safeParse({ beforeScripts: 'yes' }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ beforeScripts: 1 }).success).toBe(false);
  });

  it('bounds labelPrefix to 64 characters and rejects an empty one', () => {
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: 'x'.repeat(64) }).success).toBe(true);
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: 'x'.repeat(65) }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: '' }).success).toBe(false);
  });

  it('rejects a labelPrefix containing control characters', () => {
    // It ends up inside a fixed-width native UTF-16 buffer AND inside the
    // unique description that identity verification matches on.
    const withSOH = 'a' + String.fromCharCode(1) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withSOH }).success).toBe(false);
    const withNewline = 'a' + String.fromCharCode(10) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withNewline }).success).toBe(false);
    const withDEL = 'a' + String.fromCharCode(127) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withDEL }).success).toBe(false);
  });

  it('does NOT accept an onFailure / abort knob -- v1 is reporting-only', () => {
    // Open Decision 2 resolved to B: strict modes are v2, shaped as PER-ACTION
    // off | best_effort | require_recent. A global onFailure is the wrong
    // granularity and must not sneak in.
    expect(systemProtectionInlineSettingsSchema.safeParse({ onFailure: 'abort' }).success).toBe(false);
  });
});

describe('addFeatureLinkSchema system_protection', () => {
  it('accepts system_protection with inlineSettings', () => {
    const res = addFeatureLinkSchema.safeParse({
      featureType: 'system_protection',
      inlineSettings: { beforeScripts: true },
    });
    expect(res.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/validators/systemProtectionInlineSettings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the validator**

`packages/shared/src/validators/systemProtectionInlineSettings.ts`:

```ts
import { z } from 'zod';

// Zod schema for the `system_protection` configuration-policy inlineSettings
// JSONB (#4609). Controls whether the agent takes a Windows System Restore
// checkpoint before each of three risky actions.
//
// STRICT, and NOT `.partial()` -- unlike remoteAccessInlineSettings. Every
// field carries a default, so a policy that sets only one toggle still resolves
// to a complete typed decision, and an unknown key is a hard error rather than
// a value silently persisted into the JSONB mirror and ignored at runtime (the
// `vulnerability` feature type's unchecked cast is the anti-pattern this
// deliberately avoids).
//
// Defaults are LEGACY PARITY, not "all on":
//   beforePatching        true  -- the agent already creates a point per
//                                 non-definitions update today, so defaulting
//                                 false would silently REMOVE protection.
//   beforeScripts         false -- new behaviour; opt in.
//   beforeSoftwareInstall false -- new behaviour; opt in.
//
// There is deliberately NO onFailure / abort field. v1 is reporting-only
// (Open Decision 2 -> B); strict modes land in v2 as PER-ACTION
// `off | best_effort | require_recent`, which a single global knob cannot
// express.

// Codepoint check rather than a regex literal: the prefix is copied into a
// fixed-width UTF-16 native buffer AND into the unique restore-point
// description that identity verification string-matches on, so anything WMI
// might normalise or truncate is rejected up front.
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

const labelPrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => !hasControlCharacters(s), {
    message: 'labelPrefix must not contain control characters',
  });

export const systemProtectionInlineSettingsSchema = z
  .object({
    beforePatching: z.boolean().default(true),
    beforeScripts: z.boolean().default(false),
    beforeSoftwareInstall: z.boolean().default(false),
    labelPrefix: labelPrefixSchema.default('Breeze'),
  })
  .strict();

export type SystemProtectionInlineSettings = z.infer<typeof systemProtectionInlineSettingsSchema>;

/**
 * The single typed constant for "no policy assigned anywhere in the hierarchy".
 * The UI must distinguish this PLATFORM DEFAULT from an explicit policy value --
 * a tech reading the tab needs to know whether someone chose these or nobody has
 * configured anything.
 */
export const SYSTEM_PROTECTION_DEFAULTS: Readonly<SystemProtectionInlineSettings> = Object.freeze(
  systemProtectionInlineSettingsSchema.parse({}),
);
```

- [ ] **Step 4: Wire the re-export and the `addFeatureLinkSchema` enum**

In `packages/shared/src/validators/index.ts`, next to line 22:

```ts
export * from './systemProtectionInlineSettings';
```

and in `addFeatureLinkSchema` (line ~585) append `'system_protection'` to the hand-listed `z.enum([...])`.

**This enum is hand-maintained and does NOT derive from `CONFIG_FEATURE_TYPES`.** It is the easiest thing in this wave to miss, and missing it makes the route reject the tab's POST with a Zod error while every type-level check stays green.

- [ ] **Step 5: Run the tests**

Run: `cd packages/shared && npx vitest run src/validators/systemProtectionInlineSettings.test.ts src/validators/index_configpolicy.test.ts`
Expected: PASS. Confirm the reported file count is **2** — vitest's filter is a substring match, so verify both files actually ran.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/systemProtectionInlineSettings.ts \
        packages/shared/src/validators/systemProtectionInlineSettings.test.ts \
        packages/shared/src/validators/index.ts
git commit -m "feat(shared): strict system_protection inline-settings validator (#4609)"
```

### Task 3.3: Service validation, baseline defaults, and the resolver

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (`addFeatureLink` ~1216, `updateFeatureLink` ~1312, `validateFeaturePolicyExists` inline-only branch ~2327)
- Modify: `apps/api/src/services/policyBaselineDefaults.ts:62`
- Modify: `apps/api/src/services/featureConfigResolver.ts`
- Create: `apps/api/src/services/systemProtectionResolver.test.ts`

**Interfaces:**
- Consumes: `systemProtectionInlineSettingsSchema`, `SYSTEM_PROTECTION_DEFAULTS` (Task 3.2).
- Produces: `resolveSystemProtectionForDevice(deviceId: string): Promise<ResolvedSystemProtection>` where
  `interface ResolvedSystemProtection { settings: SystemProtectionInlineSettings; policyRevision: string | null; isPlatformDefault: boolean }`.
  W05's `restorePointRequest.ts` is the only consumer.

- [ ] **Step 1: Write the failing resolver test**

`apps/api/src/services/systemProtectionResolver.test.ts`. Copy the `vi.mock('../db', …)` block and Drizzle chain-mock helpers **verbatim** from the sibling `featureConfigResolver` tests in this directory rather than inventing a new shape — the chain (`select().from().innerJoin().innerJoin().where().orderBy()`) must match the resolver exactly or the mock resolves to `undefined` and every assertion becomes vacuous.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSystemProtectionForDevice } from './featureConfigResolver';

describe('resolveSystemProtectionForDevice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the platform defaults when no policy exists anywhere in the hierarchy', async () => {
    mockHierarchy({ deviceId: 'dev-1', orgId: 'org-1', partnerId: 'p-1' });
    mockRows([]);
    const res = await resolveSystemProtectionForDevice('dev-1');
    expect(res.settings).toEqual({
      beforePatching: true,
      beforeScripts: false,
      beforeSoftwareInstall: false,
      labelPrefix: 'Breeze',
    });
    expect(res.isPlatformDefault).toBe(true);
    expect(res.policyRevision).toBeNull();
  });

  it('closest wins: a device-level false beats a partner-wide true', async () => {
    mockHierarchy({ deviceId: 'dev-1', orgId: 'org-1', partnerId: 'p-1' });
    mockRows([
      { inlineSettings: { beforeScripts: true }, assignmentLevel: 'partner', assignmentPriority: 0, assignmentCreatedAt: new Date('2026-01-01'), policyUpdatedAt: new Date('2026-01-01') },
      { inlineSettings: { beforeScripts: false }, assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: new Date('2026-02-01'), policyUpdatedAt: new Date('2026-02-01') },
    ]);
    const res = await resolveSystemProtectionForDevice('dev-1');
    expect(res.settings.beforeScripts).toBe(false);
    expect(res.isPlatformDefault).toBe(false);
  });

  it('a partner-wide opt-in applies when there is no closer policy', async () => {
    mockHierarchy({ deviceId: 'dev-1', orgId: 'org-1', partnerId: 'p-1' });
    mockRows([
      { inlineSettings: { beforeScripts: true, beforeSoftwareInstall: true }, assignmentLevel: 'partner', assignmentPriority: 0, assignmentCreatedAt: new Date('2026-01-01'), policyUpdatedAt: new Date('2026-03-04T05:06:07Z') },
    ]);
    const res = await resolveSystemProtectionForDevice('dev-1');
    expect(res.settings.beforeScripts).toBe(true);
    expect(res.settings.beforeSoftwareInstall).toBe(true);
    expect(res.policyRevision).toBe('2026-03-04T05:06:07.000Z');
  });

  it('partially-specified settings merge over the defaults', async () => {
    mockHierarchy({ deviceId: 'dev-1', orgId: 'org-1', partnerId: 'p-1' });
    mockRows([{ inlineSettings: { beforeScripts: true }, assignmentLevel: 'organization', assignmentPriority: 0, assignmentCreatedAt: new Date(), policyUpdatedAt: new Date() }]);
    const res = await resolveSystemProtectionForDevice('dev-1');
    expect(res.settings.beforePatching).toBe(true);  // default retained
    expect(res.settings.beforeScripts).toBe(true);    // explicit
  });

  it('THROWS on malformed stored settings rather than silently resolving to off', async () => {
    // A silent downgrade to "off" is the exact failure this feature exists to
    // prevent: the tech would see no checkpoint and no explanation.
    mockHierarchy({ deviceId: 'dev-1', orgId: 'org-1', partnerId: 'p-1' });
    mockRows([{ inlineSettings: { beforeScripts: 'sometimes' }, assignmentLevel: 'organization', assignmentPriority: 0, assignmentCreatedAt: new Date(), policyUpdatedAt: new Date() }]);
    await expect(resolveSystemProtectionForDevice('dev-1')).rejects.toThrow(/system_protection/i);
  });

  it('returns the platform defaults for an unknown device', async () => {
    mockHierarchy(null);
    const res = await resolveSystemProtectionForDevice('nope');
    expect(res.isPlatformDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/systemProtectionResolver.test.ts`
Expected: FAIL — `resolveSystemProtectionForDevice` is not exported from `./featureConfigResolver`.

- [ ] **Step 3: Write the resolver**

Append to `apps/api/src/services/featureConfigResolver.ts`, structured like `resolveVulnerabilityEnabledForDevice` but **parsing** instead of casting:

```ts
// ============================================
// System Restore checkpoint policy (#4609)
// ============================================

export interface ResolvedSystemProtection {
  settings: SystemProtectionInlineSettings;
  /** The winning policy's updatedAt as an ISO string; null when nothing is assigned. */
  policyRevision: string | null;
  /** True when no policy exists anywhere in the hierarchy -- the UI must say so. */
  isPlatformDefault: boolean;
}

/**
 * Resolve the `system_protection` toggles for a device via the config-policy
 * hierarchy ("closest wins"). Pattern B inline settings -- there is no
 * normalized table; the toggles live in the feature link's JSONB.
 *
 * PARSES rather than casts. Malformed stored settings raise a visible
 * resolution error (which fails command creation) instead of silently
 * degrading to "no checkpoint" -- a silent downgrade is precisely the failure
 * mode this feature exists to eliminate.
 *
 * DEFAULTS ARE LEGACY PARITY: with nothing assigned, beforePatching is true
 * (matching what the agent does today) and the two new paths are false.
 */
export async function resolveSystemProtectionForDevice(
  deviceId: string,
): Promise<ResolvedSystemProtection> {
  const platformDefault: ResolvedSystemProtection = {
    settings: { ...SYSTEM_PROTECTION_DEFAULTS },
    policyRevision: null,
    isPlatformDefault: true,
  };

  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return platformDefault;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // #2930 -- the ownership predicate admits partner-owned rows, but under an
  // org-scoped RLS context those rows are invisible and the join silently
  // returns nothing. withPartnerWideVisibility is the audited escape; the query
  // is self-tenanted by this device's own hierarchy.
  const rows = await withPartnerWideVisibility(() =>
    db
      .select({
        inlineSettings: configPolicyFeatureLinks.inlineSettings,
        assignmentLevel: configPolicyAssignments.level,
        assignmentPriority: configPolicyAssignments.priority,
        assignmentCreatedAt: configPolicyAssignments.createdAt,
        policyUpdatedAt: configurationPolicies.updatedAt,
      })
      .from(configPolicyAssignments)
      .innerJoin(
        configurationPolicies,
        and(
          eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
          eq(configurationPolicies.status, 'active'),
          policyOwnershipCondition(hierarchy),
        ),
      )
      .innerJoin(
        configPolicyFeatureLinks,
        and(
          eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
          eq(configPolicyFeatureLinks.featureType, 'system_protection'),
        ),
      )
      .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
      .orderBy(
        configPolicyAssignments.level,
        configPolicyAssignments.priority,
        configPolicyAssignments.createdAt,
      ),
  );

  if (rows.length === 0) return platformDefault;

  const winner = sortByHierarchy(rows)[0]!;
  const parsed = systemProtectionInlineSettingsSchema.safeParse(winner.inlineSettings ?? {});
  if (!parsed.success) {
    throw new Error(
      `Malformed system_protection policy settings for device ${deviceId}: ${parsed.error.message}`,
    );
  }

  return {
    settings: parsed.data,
    policyRevision: winner.policyUpdatedAt ? new Date(winner.policyUpdatedAt).toISOString() : null,
    isPlatformDefault: false,
  };
}
```

Add imports at the top of the file: `systemProtectionInlineSettingsSchema`, `SYSTEM_PROTECTION_DEFAULTS`, `type SystemProtectionInlineSettings` from `@breeze/shared`.

- [ ] **Step 4: Add the service-level validation backstops**

In `apps/api/src/services/configurationPolicy.ts`, alongside the existing `vulnerability` branches.

`addFeatureLink`, after the `vulnerability` block (~line 1220):
```ts
  // Service-level backstop for callers that bypass the HTTP route's validation
  // (the AI manage_policy_feature_link tool calls this directly). Stores the
  // PARSED result so unknown keys are stripped from the JSONB mirror on every
  // path -- an AI-guessed toggle must not be persisted-and-echoed as if it took
  // effect, since the runtime reader would ignore it.
  if (featureType === 'system_protection' && inlineSettings !== undefined && inlineSettings !== null) {
    inlineSettings = systemProtectionInlineSettingsSchema.parse(inlineSettings);
  }
```

`updateFeatureLink`, after the `vulnerability` block (~line 1318):
```ts
  if (existing.featureType === 'system_protection' && updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
    updates.inlineSettings = systemProtectionInlineSettingsSchema.parse(updates.inlineSettings);
  }
```

`validateFeaturePolicyExists` inline-only branch (~line 2327) — add the feature type and update the comment:
```ts
  if (
    featureType === 'monitoring' ||
    featureType === 'event_log' ||
    featureType === 'onedrive_helper' ||
    featureType === 'vulnerability' ||
    featureType === 'system_protection'
  ) {
    // These feature types have no policy table -- inline settings only.
    if (featurePolicyId) {
      return { valid: false, error: `${featureType} feature type does not support featurePolicyId; use inlineSettings instead` };
    }
    return { valid: true };
  }
```

Import `systemProtectionInlineSettingsSchema` from `@breeze/shared` at the top of the file.

- [ ] **Step 5: Add the baseline-defaults entry**

In `apps/api/src/services/policyBaselineDefaults.ts`, add to `NOT_ENFORCED`:

```ts
  system_protection: { label: 'System Protection', behavior: 'Not enforced -- patch installs still take a best-effort Windows restore point; scripts and software installs take none.' },
```

The wording is the honest description of the platform default (`beforePatching: true`, the other two false), not "nothing happens".

- [ ] **Step 6: Run the API tests**

Run:
```bash
cd apps/api && npx vitest run src/services/systemProtectionResolver.test.ts src/services/policyBaselineDefaults.test.ts src/services/vulnerabilityInlineSettings.test.ts
```
Expected: all PASS. Confirm the reported file count is **3**.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/featureConfigResolver.ts \
        apps/api/src/services/configurationPolicy.ts \
        apps/api/src/services/policyBaselineDefaults.ts \
        apps/api/src/services/systemProtectionResolver.test.ts
git commit -m "feat(api): resolve system_protection policy settings per device (#4609)"
```

### Task 3.4: `SystemProtectionTab` editor tab

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/SystemProtectionTab.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/SystemProtectionTab.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (tab switch)

**Interfaces:**
- Consumes: `FeatureTabProps`, `FEATURE_META`, `useFeatureLink`, `FeatureTabShell`, `SYSTEM_PROTECTION_DEFAULTS`.
- Produces: a default-exported `SystemProtectionTab` and `FEATURE_META.system_protection`.

- [ ] **Step 1: Confirm the parity test is still red**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts`
Expected: FAIL — `FEATURE_META` is missing `system_protection`. It has been red since Task 3.1 Step 3; that is the red-first signal for this tab.

- [ ] **Step 2: Write the failing component test**

`SystemProtectionTab.test.tsx`. Copy the render/mock scaffolding from the sibling `VulnerabilityTab.test.tsx` verbatim, then:

```tsx
it('renders three toggles seeded from the platform defaults', () => {
  renderTab({ existingLink: undefined });
  expect(screen.getByTestId('system-protection-before-patching-toggle')).toBeTruthy();
  expect(screen.getByTestId('system-protection-before-scripts-toggle')).toBeTruthy();
  expect(screen.getByTestId('system-protection-before-software-toggle')).toBeTruthy();
});

it('labels the unconfigured state as the platform default, not as a policy choice', () => {
  // A tech must be able to tell "nobody has configured this" from "someone
  // deliberately chose these values".
  renderTab({ existingLink: undefined });
  expect(screen.getByTestId('system-protection-platform-default-note')).toBeTruthy();
});

it('never promises recoverability', () => {
  const { container } = renderTab({ existingLink: undefined });
  const text = (container.textContent ?? '').toLowerCase();
  expect(text).not.toContain('rollback available');
  expect(text).not.toContain('you can roll back');
  // ...and it must say what System Restore actually is.
  expect(text).toContain('not a backup');
});

it('warns that an explicit patch disable is unenforceable on older agents', () => {
  renderTab({ existingLink: link({ beforePatching: false }) });
  expect(screen.getByTestId('system-protection-legacy-agent-warning')).toBeTruthy();
});

it('saves the full settings object through useFeatureLink', async () => {
  const save = vi.fn().mockResolvedValue({ id: 'l1', featureType: 'system_protection' });
  renderTab({ existingLink: undefined, save });
  fireEvent.click(screen.getByTestId('system-protection-before-scripts-toggle'));
  fireEvent.click(screen.getByTestId('feature-tab-save'));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][1]).toMatchObject({
    featureType: 'system_protection',
    inlineSettings: { beforePatching: true, beforeScripts: true, beforeSoftwareInstall: false },
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/SystemProtectionTab.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Add the `FEATURE_META` entry**

In `types.ts`:

```ts
  system_protection: { label: 'System Protection', fetchUrl: null, description: 'Take a Windows System Restore checkpoint before patching, scripts, and software installs' },
```

- [ ] **Step 5: Write the tab**

`SystemProtectionTab.tsx`, modelled on `VulnerabilityTab.tsx` (same `FeatureTabShell` + `useFeatureLink` + inherited/override/revert wiring, same `defaults`-merge `useState`/`useEffect` shape), with:

- three toggles bound to `beforePatching` / `beforeScripts` / `beforeSoftwareInstall`, carrying the `data-testid`s asserted above;
- a `labelPrefix` text input with `maxLength={64}`;
- a `data-testid="system-protection-platform-default-note"` block rendered only when `!existingLink && !parentLink`:
  > *No policy is assigned. Platform default: a checkpoint is attempted before patch installs only.*
- a `data-testid="system-protection-legacy-agent-warning"` callout rendered when `settings.beforePatching === false`:
  > *Turning this off only takes effect on agents that report System Restore support. Older agents will continue to attempt a checkpoint before patch installs.*
- a standing explanatory block, verbatim:
  > *System Restore protects system files, the registry, installed programs and settings. It is **not a backup** and does not protect personal files. Windows limits restore-point creation to once every 24 hours by default, and a created point can later be removed by Windows or become unusable. Breeze reports what actually happened for each action.*

The ownerScope selector and "All orgs" badge come from `FeatureTabShell` — no per-tab work. No `runAction`: this tab mutates through the typed `useFeatureLink` service layer, an existing allowlisted pattern (`apps/web/src/lib/runActionAllowlist.ts`).

- [ ] **Step 6: Wire the tab into the detail page**

In `ConfigPolicyDetailPage.tsx`, add the `system_protection` case to the tab-component switch and import `SystemProtectionTab`. `FEATURE_TYPES` derives from `FEATURE_META`, so no hand-listed array needs editing.

- [ ] **Step 7: Run the web tests**

Run:
```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/SystemProtectionTab.test.tsx src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts
```
Expected: both PASS. Confirm the reported file count is **2**.

- [ ] **Step 8: Typecheck, lint, commit, open the PR**

Run:
```bash
pnpm --filter @breeze/shared build && pnpm lint && (cd apps/web && npx tsc --noEmit)
```
Expected: clean. (An `eslint-disable` for an unregistered rule *is itself* a lint error — use `as never` if a cast is unavoidable.)

```bash
git add apps/web/src/components/configurationPolicies/
git commit -m "feat(web): System Protection config-policy tab (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat: system_protection config-policy feature type (#4609 W03)" --body "Wave 03 of #4609. Dark policy surface -- nothing reads the toggle yet.

- New \`system_protection\` feature type: enum migration (its own file, ALTER TYPE ADD VALUE), Drizzle enum, \`CONFIG_FEATURE_TYPES\`, \`addFeatureLinkSchema\`.
- Partner-wide-first by construction: inline settings on the already dual-axis \`configuration_policies\` parent. No new table, no new RLS policy, no new registration list, and deliberately NOT in \`ORG_SCOPED_ONLY_FEATURE_TYPES\`.
- Strict validator with legacy-parity defaults; the resolver PARSES rather than casts, so malformed stored settings raise instead of silently resolving to off.
- Editor tab with the constrained product language (never 'rollback available').

Refs #4609"
```

---

# Wave 04 — `device_restore_point_attempts` ledger + six registration lists

Independent of every other wave. Ships the table and every tenancy contract; nothing writes to it until W05.

**Table name is `device_restore_point_attempts`, NOT `device_restore_points`.** Failed and skipped rows are not restore points, and even a created point can be purged by VSS later. The table records *attempts and observations*, never a promise of recoverability.

**Tenancy shape 1** (direct `org_id`), the hot agent-write pattern. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts`, so it needs **no allowlist entry there** — but it needs **six** other registrations, all in this PR:

| List | File | Entry | Enforced by |
|---|---|---|---|
| RLS policies | the creating migration | `breeze_has_org_access(org_id)`, ENABLE + FORCE, four command-complete policies, GRANT to `breeze_app` | `rls-coverage.integration.test.ts` (**Integration Tests**) |
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts` | alphabetical; verify FK-children-before-parents (it references `devices`) | `tenantCascade.integration.test.ts` (**Integration Tests**) |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts:312` | has `device_id` | `cascadeDelete.test.ts` (**Test API**) |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts:205` | `device_id` **and** denormalized `org_id` | `moveOrg.coverage.test.ts` (**Test API**) |
| `DEVICE_ORG_FK_CASCADE_TABLES` | `routes/devices/core.ts:254` | required by the composite `(device_id, org_id)` FK — move-org must NOT issue an app-role UPDATE | `moveOrg.coverage.test.ts` (**Test API**) |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | every column classified | `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (**Integration Tests**) |
| `orgMergeRegistry` REPOINT_TABLES | `services/orgMergeRegistry.ts` | plain repoint | `orgMergeRegistry.integration.test.ts` (**Integration Tests**) |

**NOT** in `AUDIT_ADMIN_REQUIRED_TABLES` — the table is not append-only; ordinary DELETE is needed for erasure.

**Four of these seven only fail under Integration Tests**, which needs a live DB. A unit-green PR can still redden main. Run them locally before the PR (Task 4.4).

### Task 4.1: The migration

**Files:**
- Create: `apps/api/migrations/2026-10-07-100100-device-restore-point-attempts.sql`

**Interfaces:**
- Consumes: `devices(id, org_id)`, `organizations(id)`.
- Produces: the `device_restore_point_attempts` table.

- [ ] **Step 1: Re-check the migration name against `origin/main`**

Run:
```bash
git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Expected: `2026-10-07-100100-...` sorts after everything listed. If not, rename before writing — a shipped migration's name is content-hash immutable.

- [ ] **Step 2: Write the migration**

```sql
-- device_restore_point_attempts (#4609): the durable record of every Windows
-- System Restore checkpoint Breeze requested before a risky action.
--
-- This is the ONLY durable evidence. The command payload is NOT: terminal
-- processing erases it (terminalPayloadErasureSet(), routes/agentWs.ts;
-- routes/agents/commands.ts).
--
-- The row is INSERTed at command-creation time with status='requested' and
-- terminalised from the agent's result. Without the requested row, an absent
-- row would ambiguously mean policy-off, old agent, lost result, or command
-- timeout -- four very different answers to "did we take a checkpoint?".
--
-- Named ATTEMPTS, not device_restore_points: failed and skipped rows are not
-- restore points, and a created point can later be purged by VSS or rendered
-- unusable under VBS rules. The table records attempts and observations, never
-- a promise of recoverability.

CREATE TABLE IF NOT EXISTS device_restore_point_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotency key from the command's restorePoint block. The agent's command
  -- dedup map is in-memory and evicted after two minutes (heartbeat.go), so a
  -- crash can replay both the checkpoint and the risky action; this makes the
  -- ledger row idempotent under replay.
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  -- Optional, and deliberately NOT the identity: the direct non-UUID software
  -- path (routes/agentWs.ts) has no device_commands row at all.
  device_command_id uuid,
  trigger varchar(24) NOT NULL
    CONSTRAINT device_restore_point_attempts_trigger_chk
    CHECK (trigger IN ('patch', 'script', 'software_install')),
  status varchar(32) NOT NULL
    CONSTRAINT device_restore_point_attempts_status_chk
    CHECK (status IN (
      'requested',
      'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
      'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed'
    )),
  -- bigint, not integer: Windows sequence numbers are INT64. They are rendered
  -- as decimal STRINGS on the wire and in the API response because they exceed
  -- the JavaScript safe-integer range.
  sequence_number bigint,
  description text,
  message text,
  policy_revision text,
  accepted_existing_point boolean NOT NULL DEFAULT false,
  existing_point_age_minutes integer,
  frequency_minutes integer,
  duration_ms integer,
  requested_at timestamptz NOT NULL DEFAULT now(),  -- server, at command creation
  attempted_at timestamptz,                          -- agent clock
  received_at timestamptz,                           -- server, at result ingest
  script_execution_id uuid,
  software_deployment_id uuid,
  patch_job_id uuid
);

-- Composite (device_id, org_id) FK (pattern: agent_health_observations,
-- db/schema/agentHealth.ts) makes a mismatched tenant stamp impossible: a row
-- can only name a device that actually belongs to the org it claims.
--
-- DEFERRABLE INITIALLY IMMEDIATE is MANDATORY for every composite FK
-- referencing an org_id column: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- re-points parent and child org_id in separate statements, and a
-- non-deferrable constraint aborts the merge with 23503. Enforced by
-- orgLifecycleFoundations.integration.test.ts ("merge contract"), which only
-- runs under Integration Tests shard 2 -- a unit-green PR still goes red there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_restore_point_attempts_device_org_fk'
  ) THEN
    ALTER TABLE device_restore_point_attempts
      ADD CONSTRAINT device_restore_point_attempts_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Idempotency: one ledger row per requestId. The ingest path UPDATEs this row
-- rather than inserting a second one.
CREATE UNIQUE INDEX IF NOT EXISTS device_restore_point_attempts_request_uidx
  ON device_restore_point_attempts (request_id);
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_device_requested_idx
  ON device_restore_point_attempts (device_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_org_requested_idx
  ON device_restore_point_attempts (org_id, requested_at DESC);
-- Drives the prune job: rows still 'requested' long after the command's own
-- deadline are orphans (offline device, lost result, reaped command).
CREATE INDEX IF NOT EXISTS device_restore_point_attempts_pending_idx
  ON device_restore_point_attempts (requested_at)
  WHERE status = 'requested';

-- RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so there is no separate system branch.
ALTER TABLE device_restore_point_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_restore_point_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_restore_point_attempts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_restore_point_attempts;

CREATE POLICY breeze_org_isolation_select ON device_restore_point_attempts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_restore_point_attempts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_restore_point_attempts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_restore_point_attempts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_restore_point_attempts TO breeze_app;
```

**No `jsonb`, no `bytea`, no `json` column anywhere** — deliberate. Every field is typed, so the whole table classifies as `included` in the export policy with nothing in `excludedOpen`. An open container could embed credentials or capabilities and would have to be excluded.

- [ ] **Step 3: Apply and verify tenant isolation by hand as `breeze_app`**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```
Then, inside psql, forge a cross-tenant insert:
```sql
SET breeze.org_id = '<org-A-uuid>';
INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
VALUES (gen_random_uuid(), '<org-B-uuid>', '<any-device>', 'script', 'requested');
```
Expected: `ERROR: new row violates row-level security policy for table "device_restore_point_attempts"`.

Then verify the composite FK rejects a tenant mismatch:
```sql
SET breeze.org_id = '<org-A-uuid>';
INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
VALUES (gen_random_uuid(), '<org-A-uuid>', '<device-belonging-to-org-B>', 'script', 'requested');
```
Expected: `ERROR: insert or update on table ... violates foreign key constraint` (23503).

**Both must fail.** If either succeeds, stop — the tenancy contract is broken and nothing downstream is safe.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-07-100100-device-restore-point-attempts.sql
git commit -m "feat(api): device_restore_point_attempts ledger table with RLS (#4609)"
```

### Task 4.2: Drizzle schema

**Files:**
- Create: `apps/api/src/db/schema/deviceRestorePointAttempts.ts`
- Modify: `apps/api/src/db/schema/index.ts` (re-export)

**Interfaces:**
- Consumes: `devices`, `organizations`.
- Produces: `deviceRestorePointAttempts` (Drizzle table) and `type DeviceRestorePointAttempt = typeof deviceRestorePointAttempts.$inferSelect`. W05 and W06 both import it.

- [ ] **Step 1: Write the schema**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

/**
 * Every Windows System Restore checkpoint Breeze requested before a risky
 * action, and what actually happened (#4609).
 *
 * The ONLY durable record -- terminal command processing erases the payload
 * the request was stamped into. The row is created at command-creation time
 * with status 'requested' and terminalised from the agent's result, so an
 * absent row unambiguously means "we never asked".
 *
 * NO jsonb/bytea columns, deliberately: every field is typed, which is what
 * lets the whole table classify as `included` in CORE_TENANT_EXPORT_POLICY
 * with nothing in excludedOpen.
 */
export const deviceRestorePointAttempts = pgTable('device_restore_point_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  /** Optional, and NOT the identity: the direct non-UUID software path has no device_commands row. */
  deviceCommandId: uuid('device_command_id'),
  trigger: varchar('trigger', { length: 24 })
    .$type<'patch' | 'script' | 'software_install'>()
    .notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  /** INT64 on Windows -- rendered as a decimal STRING on the wire (JS safe-integer range). */
  sequenceNumber: bigint('sequence_number', { mode: 'bigint' }),
  description: text('description'),
  message: text('message'),
  policyRevision: text('policy_revision'),
  acceptedExistingPoint: boolean('accepted_existing_point').notNull().default(false),
  existingPointAgeMinutes: integer('existing_point_age_minutes'),
  frequencyMinutes: integer('frequency_minutes'),
  durationMs: integer('duration_ms'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  scriptExecutionId: uuid('script_execution_id'),
  softwareDeploymentId: uuid('software_deployment_id'),
  patchJobId: uuid('patch_job_id'),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_restore_point_attempts_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_restore_point_attempts_request_uidx').on(table.requestId),
  index('device_restore_point_attempts_device_requested_idx')
    .on(table.deviceId, table.requestedAt.desc()),
  index('device_restore_point_attempts_org_requested_idx')
    .on(table.orgId, table.requestedAt.desc()),
  check(
    'device_restore_point_attempts_trigger_chk',
    sql`${table.trigger} IN ('patch', 'script', 'software_install')`,
  ),
  check(
    'device_restore_point_attempts_status_chk',
    sql`${table.status} IN ('requested', 'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only', 'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed')`,
  ),
]);

export type DeviceRestorePointAttempt = typeof deviceRestorePointAttempts.$inferSelect;
export type NewDeviceRestorePointAttempt = typeof deviceRestorePointAttempts.$inferInsert;
```

Add the re-export to `apps/api/src/db/schema/index.ts` following the file's existing pattern.

- [ ] **Step 2: Verify no drift**

Run: `pnpm db:check-drift`
Expected: clean — the Drizzle definition matches the migration exactly. Any diff here means one of the two is wrong; fix the Drizzle side (the migration is already committed).

Note the Drizzle `foreignKey(...)` builder cannot express `DEFERRABLE INITIALLY IMMEDIATE`; the migration is authoritative for that and drift detection does not compare it. That is expected and is why the deferrable clause is called out in Task 4.1 and asserted by `orgLifecycleFoundations.integration.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/deviceRestorePointAttempts.ts apps/api/src/db/schema/index.ts
git commit -m "feat(api): Drizzle schema for device_restore_point_attempts (#4609)"
```

### Task 4.3: All six registration lists

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/routes/devices/core.ts` (three lists)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`

**Interfaces:**
- Consumes: the table name `device_restore_point_attempts`.
- Produces: nothing importable. This is a mechanical grep, not a judgement call.

**Do it as a grep, not from memory.** Missing a cascade list is a latent GDPR org-erasure bug that has shipped or blocked CI five times (#1359, #1351, #1365, #2179, #2514). Code review caught it 0/5; the contract tests caught it 5/5.

- [ ] **Step 1: Enumerate the lists mechanically**

Run:
```bash
grep -rn "'device_reliability'" apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts
grep -n '"device_reliability"' apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
```
`device_reliability` is a device-scoped `org_id` table already in every list, so its hit-set **is** the list of files and arrays this table must join. Compare against the seven-row table at the top of this wave; if the grep finds a list not in that table, add it.

- [ ] **Step 2: `CORE_ORG_CASCADE_DELETE_ORDER`**

In `apps/api/src/services/tenantCascade.ts`, insert `'device_restore_point_attempts',` in **alphabetical (`localeCompare`) order** — between `'device_registry_state'` and `'device_reliability'`. (`localeCompare` puts `restore` before `reliability`? **No** — verify it, do not assume: `'device_registry_state' < 'device_reliability' < 'device_restore_point_attempts' < 'device_sessions'` under `localeCompare`, because `reli` < `rest`. Insert after `'device_reliability_history'`.)

Then verify the FK direction: this table references `devices`, and nothing references it, so it is a pure leaf and must be deleted **before** `devices`. `devices` sorts after `device_restore_point_attempts` alphabetically, so alphabetical order happens to satisfy it here — **confirm that rather than assuming**, per the contract test's fifth property (FK children before parents).

- [ ] **Step 3: The three device lists in `routes/devices/core.ts`**

`CORE_DEVICE_ORG_DENORMALIZED_TABLES` (line ~205) — add `'device_restore_point_attempts'` next to `'device_registry_state'`.

`DEVICE_ORG_FK_CASCADE_TABLES` (line ~254) — add it. **This is the list the spec's first draft missed.** Because the org stamp is propagated by the composite `(device_id, org_id)` FK's `ON UPDATE CASCADE`, move-org must **not** issue its ordinary app-role UPDATE against this table; PostgreSQL's referential action does it.

`CORE_DEVICE_CASCADE_DELETE_TABLES` (line ~312) — add it under the "Core device tables" grouping. It is a leaf with no children, so position within the list is unconstrained; put it next to `device_registry_state` for readability.

- [ ] **Step 4: `CORE_TENANT_EXPORT_POLICY`**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add in alphabetical position:

```ts
  "device_restore_point_attempts": tablePolicy("org_id", {"included":["id","request_id","org_id","device_id","device_command_id","trigger","status","sequence_number","description","message","policy_revision","accepted_existing_point","existing_point_age_minutes","frequency_minutes","duration_ms","requested_at","attempted_at","received_at","script_execution_id","software_deployment_id","patch_job_id"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Every column is `included`: they are ordinary customer data and tenant identifiers. Nothing matches `SUSPICIOUS_NAME_PARTS`, nothing is credential material, and there is **no `json`/`jsonb`/`bytea` column** — which is exactly why `excludedOpen` is empty. **If a later PR adds a column to this table, this entry must be updated in that same PR** — the export-policy row is the only registration that fires on a new *column*, not just a new table.

- [ ] **Step 5: `orgMergeRegistry`**

In `apps/api/src/services/orgMergeRegistry.ts`, add `"device_restore_point_attempts",` to `REPOINT_TABLES` in alphabetical position (next to `"device_registry_state"` / `"device_reliability"`). A plain repoint is correct: the rows are per-device observations with no cross-org identity, no dedupe key, and no reason to block a merge.

- [ ] **Step 6: Run the unit-job contract tests**

Run:
```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
```
Expected: PASS. These two are the only registration guards that fail in the **Test API** unit job (they read the Drizzle schema statically). Everything else waits for Task 4.4.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "chore(api): register device_restore_point_attempts in all six cascade/export lists (#4609)"
```

### Task 4.4: RLS contract suite and the integration run

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceRestorePointAttemptsRls.integration.test.ts`

**Interfaces:**
- Consumes: the migration (4.1) and the registrations (4.3).
- Produces: nothing importable.

**Placement matters.** An integration test in the wrong directory runs in **zero** CI jobs and reads as green. It must live under `apps/api/src/__tests__/integration/` and match `vitest.integration.config.ts`'s include glob — verify by confirming it appears in the shard log, not just that the local run passed.

- [ ] **Step 1: Write the suite**

Copy the setup/teardown scaffolding from a sibling `*PartnerRls.integration.test.ts` or `*Rls.integration.test.ts` in the same directory, then assert:

```ts
it('rejects a cross-tenant forge as breeze_app with 42501', async () => {
  // RLS is stricter than the app layer, and this is the proof.
  await expect(
    asBreezeApp(orgA, (sql) => sql`
      INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
      VALUES (gen_random_uuid(), ${orgB}, ${deviceInOrgB}, 'script', 'requested')`),
  ).rejects.toMatchObject({ code: '42501' });
});

it('rejects a composite-FK tenant mismatch with 23503', async () => {
  await expect(
    asBreezeApp(orgA, (sql) => sql`
      INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
      VALUES (gen_random_uuid(), ${orgA}, ${deviceInOrgB}, 'script', 'requested')`),
  ).rejects.toMatchObject({ code: '23503' });
});

it('hides another org rows from SELECT', async () => {
  await seedAttempt(orgB, deviceInOrgB);
  const rows = await asBreezeApp(orgA, (sql) => sql`SELECT id FROM device_restore_point_attempts`);
  expect(rows).toHaveLength(0);
});

it('enforces one ledger row per requestId', async () => {
  const requestId = randomUUID();
  await seedAttempt(orgA, deviceInOrgA, { requestId });
  await expect(seedAttempt(orgA, deviceInOrgA, { requestId })).rejects.toMatchObject({ code: '23505' });
});

it('cascades away when the device is deleted', async () => {
  await seedAttempt(orgA, deviceInOrgA);
  await asSystem((sql) => sql`DELETE FROM devices WHERE id = ${deviceInOrgA}`);
  const rows = await asSystem((sql) => sql`SELECT id FROM device_restore_point_attempts WHERE device_id = ${deviceInOrgA}`);
  expect(rows).toHaveLength(0);
});

it('follows the device org_id via the composite FK ON UPDATE CASCADE', async () => {
  // This is why the table is in DEVICE_ORG_FK_CASCADE_TABLES: move-org must
  // NOT issue an app-role UPDATE; PostgreSQL restamps it.
  await seedAttempt(orgA, deviceInOrgA);
  await asSystem((sql) => sql`UPDATE devices SET org_id = ${orgC} WHERE id = ${deviceInOrgA}`);
  const [row] = await asSystem((sql) => sql`SELECT org_id FROM device_restore_point_attempts WHERE device_id = ${deviceInOrgA}`);
  expect(row.org_id).toBe(orgC);
});
```

- [ ] **Step 2: Run the whole contract set locally against a real DB**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceRestorePointAttemptsRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: all PASS, **7 files reported**. `pnpm test` does not run any of these; this is the only place the four Integration-Tests-only guards get exercised before CI.

If `vitest forks` hangs against a running dev stack, add `--pool=threads --maxWorkers=2`. **0 tests reported is a stall, not a pass.**

- [ ] **Step 3: Confirm `rls-coverage` needed no allowlist entry**

Shape 1 (direct `org_id`) is auto-discovered. If `rls-coverage.integration.test.ts` fails asking for an allowlist entry, the table has been given the wrong shape — stop and re-read the migration rather than adding an entry to silence it.

- [ ] **Step 4: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/deviceRestorePointAttemptsRls.integration.test.ts
git commit -m "test(api): RLS + composite-FK contract suite for device_restore_point_attempts (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(api): device_restore_point_attempts ledger (#4609 W04)" --body "Wave 04 of #4609. Table + every tenancy contract; nothing writes to it yet.

Tenancy shape 1 (direct org_id), hot agent-write pattern. Registered in ALL of:
- RLS policies in the creating migration (ENABLE + FORCE + four policies + GRANT)
- \`CORE_ORG_CASCADE_DELETE_ORDER\`
- \`CORE_DEVICE_CASCADE_DELETE_TABLES\`
- \`CORE_DEVICE_ORG_DENORMALIZED_TABLES\`
- \`DEVICE_ORG_FK_CASCADE_TABLES\` (composite (device_id, org_id) FK)
- \`CORE_TENANT_EXPORT_POLICY\` (every column classified; no jsonb, so excludedOpen is empty)
- \`orgMergeRegistry\` REPOINT_TABLES

Composite FK is DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED).
Cross-tenant forge verified by hand as \`breeze_app\` (42501) and by the new integration suite.
All seven contract suites run locally against a real DB.

Refs #4609"
```

- [ ] **Step 5: Verify the integration shard actually ran the new file**

Run: `gh pr checks --watch`, then grep the Integration Tests shard logs for `deviceRestorePointAttemptsRls`.
Expected: present and passing. A file that never ran is not a passing file — this is the #1 way an integration test silently contributes nothing.

---

# Wave 05 — Server: stamp the request block at the three creation sites

**Depends on W03 (resolver) and W04 (ledger).** Ships safely on its own: old agents ignore the block entirely, so behaviour is unchanged until W07.

**Why creation-time, not heartbeat config.** The safety decision belongs to the *operation*, not to the *machine*. The agent heartbeat runs under an org-scoped RLS context and cannot see partner-wide policy rows (#2930, #1105), so resolving server-side keeps the `withPartnerWideVisibility` escape inside one audited helper. It also removes any cache-staleness window between a policy edit and the next heartbeat.

### Task 5.1: `restorePointRequest.ts` — the single chokepoint

**Files:**
- Create: `apps/api/src/services/restorePointRequest.ts`
- Create: `apps/api/src/services/restorePointRequest.test.ts`
- Create: `packages/shared/src/types/restorePoint.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)

**Interfaces:**
- Consumes: `resolveSystemProtectionForDevice` (W03), `deviceRestorePointAttempts` (W04).
- Produces:
```ts
type RestorePointTrigger = 'patch' | 'script' | 'software_install';

interface BuildRestorePointRequestInput {
  deviceId: string;
  orgId: string;
  osType: string | null;
  trigger: RestorePointTrigger;
  label: string;
  deviceCommandId?: string | null;
  scriptExecutionId?: string | null;
  softwareDeploymentId?: string | null;
  patchJobId?: string | null;
  validForMs?: number;   // default 24h
}

/** Returns the payload block to stamp, or null when no checkpoint is requested. */
function buildRestorePointRequest(input: BuildRestorePointRequestInput): Promise<RestorePointRequestBlock | null>;
```
All three creation sites call **only** this function.

- [ ] **Step 1: Write the shared types**

`packages/shared/src/types/restorePoint.ts`:

```ts
/** Windows System Restore checkpoint reporting (#4609). */

export const RESTORE_POINT_TRIGGERS = ['patch', 'script', 'software_install'] as const;
export type RestorePointTrigger = typeof RESTORE_POINT_TRIGGERS[number];

/**
 * 'requested' is server-only: written at command-creation time so an absent
 * ledger row unambiguously means "we never asked". Every other value comes
 * from the agent.
 */
export const RESTORE_POINT_STATUSES = [
  'requested',
  'created',
  'existing_accepted',
  'skipped_disabled',
  'skipped_definition_only',
  'unsupported',
  'busy',
  'insufficient_privileges',
  'verification_failed',
  'failed',
] as const;
export type RestorePointStatus = typeof RESTORE_POINT_STATUSES[number];

/** The versioned block the server stamps into the command payload. */
export interface RestorePointRequestBlock {
  v: 1;
  requestId: string;
  enabled: boolean;
  label: string;
  resolvedAt: string;
  policyRevision: string | null;
  validUntil: string;
}

/** What the agent returns on the command result. */
export interface RestorePointOutcome {
  status: RestorePointStatus;
  requestId: string;
  /** Decimal STRING: Windows sequence numbers are INT64 and exceed the JS safe range. */
  sequenceNumber?: string;
  description?: string;
  message?: string;
  attemptedAt: string;
  durationMs: number;
  existingPointAgeMinutes?: number;
  frequencyMinutes?: number;
}
```

- [ ] **Step 2: Write the failing test**

`apps/api/src/services/restorePointRequest.test.ts`:

```ts
describe('buildRestorePointRequest', () => {
  it('returns null for a non-Windows device even when the policy says yes', async () => {
    // `enabled` is stamped true ONLY when the resolved toggle is on AND the
    // device is Windows. The agent's !windows no-op is defence in depth, not
    // the gate -- a macOS fleet must never see enabled:true.
    mockResolved({ beforeScripts: true });
    const block = await buildRestorePointRequest({ ...base, osType: 'darwin', trigger: 'script' });
    expect(block).toBeNull();
  });

  it('returns null when the resolved toggle for this trigger is off', async () => {
    mockResolved({ beforeScripts: false, beforePatching: true });
    expect(await buildRestorePointRequest({ ...base, trigger: 'script' })).toBeNull();
  });

  it('maps each trigger to its own toggle', async () => {
    mockResolved({ beforePatching: true, beforeScripts: false, beforeSoftwareInstall: true });
    expect(await buildRestorePointRequest({ ...base, trigger: 'patch' })).not.toBeNull();
    expect(await buildRestorePointRequest({ ...base, trigger: 'script' })).toBeNull();
    expect(await buildRestorePointRequest({ ...base, trigger: 'software_install' })).not.toBeNull();
  });

  it('stamps a v1 block with a fresh requestId, policyRevision and validUntil', async () => {
    mockResolved({ beforeScripts: true }, { policyRevision: 'rev-7' });
    const block = await buildRestorePointRequest({ ...base, trigger: 'script', label: 'Breeze: run script Cleanup' });
    expect(block).toMatchObject({ v: 1, enabled: true, label: 'Breeze: run script Cleanup', policyRevision: 'rev-7' });
    expect(block!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(block!.validUntil).getTime()).toBeGreaterThan(new Date(block!.resolvedAt).getTime());
  });

  it('inserts the ledger row with status=requested and the same requestId', async () => {
    mockResolved({ beforeScripts: true });
    const block = await buildRestorePointRequest({ ...base, trigger: 'script', scriptExecutionId: 'exec-1' });
    expect(insertedRows()[0]).toMatchObject({
      requestId: block!.requestId,
      orgId: base.orgId,
      deviceId: base.deviceId,
      trigger: 'script',
      status: 'requested',
      scriptExecutionId: 'exec-1',
    });
  });

  it('writes NO ledger row when no checkpoint is requested', async () => {
    mockResolved({ beforeScripts: false });
    await buildRestorePointRequest({ ...base, trigger: 'script' });
    expect(insertedRows()).toHaveLength(0);
  });

  it('propagates a resolution error rather than degrading to no-checkpoint', async () => {
    // Policy-resolution errors must FAIL COMMAND CREATION VISIBLY. Swallowing
    // them would silently downgrade protection -- the exact failure this
    // feature exists to eliminate.
    mockResolveThrows(new Error('Malformed system_protection policy settings'));
    await expect(buildRestorePointRequest({ ...base, trigger: 'script' })).rejects.toThrow(/system_protection/);
  });

  it('never sets enabled:false in the block -- absence is the off signal', async () => {
    // A stamped `enabled:false` is unenforceable on old agents (they ignore it
    // and keep the legacy patch behaviour), so the server communicates "off"
    // by OMITTING the block, which every agent version understands.
    mockResolved({ beforePatching: false });
    expect(await buildRestorePointRequest({ ...base, trigger: 'patch' })).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/restorePointRequest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`apps/api/src/services/restorePointRequest.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { RestorePointRequestBlock, RestorePointTrigger } from '@breeze/shared';
import { db } from '../db';
import { deviceRestorePointAttempts } from '../db/schema/deviceRestorePointAttempts';
import { resolveSystemProtectionForDevice } from './featureConfigResolver';

/**
 * Build the versioned `restorePoint` block for one concrete per-device command,
 * and record the request in the ledger (#4609).
 *
 * THE SINGLE CHOKEPOINT. Every command-creation site calls this and nothing
 * else -- patching, scripts, software install, and every AI-tool / automation /
 * remediation path that reaches them. A second resolution site is how a feature
 * silently stops applying to one of its three surfaces.
 *
 * ABSENCE IS THE OFF SIGNAL. This returns null rather than a block with
 * `enabled:false`, because a stamped false is unenforceable on agents that
 * predate the feature -- they ignore it and continue the legacy per-patch
 * calls. Omitting the block is understood by every agent version.
 *
 * SCHEDULED WORK resolves here, when the per-device command is created, never
 * when the schedule was authored.
 */
export async function buildRestorePointRequest(
  input: BuildRestorePointRequestInput,
): Promise<RestorePointRequestBlock | null> {
  // Windows-only, decided server-side. The agent's !windows no-op is defence
  // in depth, not the gate.
  if (!isWindows(input.osType)) return null;

  // Deliberately NOT wrapped in try/catch: a policy-resolution error must fail
  // command creation visibly rather than silently downgrade protection.
  const resolved = await resolveSystemProtectionForDevice(input.deviceId);

  const enabled =
    input.trigger === 'patch' ? resolved.settings.beforePatching
    : input.trigger === 'script' ? resolved.settings.beforeScripts
    : resolved.settings.beforeSoftwareInstall;
  if (!enabled) return null;

  const requestId = randomUUID();
  const now = new Date();
  const validUntil = new Date(now.getTime() + (input.validForMs ?? DEFAULT_VALID_FOR_MS));

  const block: RestorePointRequestBlock = {
    v: 1,
    requestId,
    enabled: true,
    label: buildLabel(resolved.settings.labelPrefix, input.label),
    resolvedAt: now.toISOString(),
    policyRevision: resolved.policyRevision,
    validUntil: validUntil.toISOString(),
  };

  // The 'requested' row is what makes an absent row unambiguous later. Without
  // it, "no row" would mean policy-off OR old agent OR lost result OR command
  // timeout -- four different answers to the tech's actual question.
  await db.insert(deviceRestorePointAttempts).values({
    requestId,
    orgId: input.orgId,
    deviceId: input.deviceId,
    deviceCommandId: input.deviceCommandId ?? null,
    trigger: input.trigger,
    status: 'requested',
    policyRevision: resolved.policyRevision,
    requestedAt: now,
    scriptExecutionId: input.scriptExecutionId ?? null,
    softwareDeploymentId: input.softwareDeploymentId ?? null,
    patchJobId: input.patchJobId ?? null,
  });

  return block;
}

/** 24 hours: long enough for an offline device to come back, short enough that
 *  a policy change is not indefinitely ignored on a queued command. */
const DEFAULT_VALID_FOR_MS = 24 * 60 * 60 * 1000;

function isWindows(osType: string | null): boolean {
  return (osType ?? '').toLowerCase().includes('windows');
}

function buildLabel(prefix: string, action: string): string {
  return `${prefix}: ${action}`.slice(0, 180);
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/services/restorePointRequest.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/restorePointRequest.ts apps/api/src/services/restorePointRequest.test.ts \
        packages/shared/src/types/restorePoint.ts packages/shared/src/types/index.ts
git commit -m "feat(api): restore-point request chokepoint + requested ledger row (#4609)"
```

### Task 5.2: Stamp at the patching creation site

**Files:**
- Modify: `apps/api/src/jobs/patchJobExecutor.ts` (`prepareDeviceExecution`, ~line 1050)
- Create: `apps/api/src/jobs/patchJobExecutor.restorePoint.test.ts`

**Interfaces:**
- Consumes: `buildRestorePointRequest` (Task 5.1).
- Produces: the `restorePoint` key on the `install_patches` payload, and `category` on each patch record (needed by W07's definitions-only skip).

- [ ] **Step 1: Write the failing test**

```ts
it('stamps the restorePoint block on the install_patches payload', async () => {
  mockRequestBlock({ v: 1, requestId: 'req-1', enabled: true, label: 'Breeze: install 6 updates', resolvedAt: 'T', policyRevision: null, validUntil: 'U' });
  await prepareDeviceExecution({ patchJobId: 'job-1', deviceId: 'dev-1', orgId: 'org-1' });
  expect(queueCommandForExecution).toHaveBeenCalledWith('dev-1', 'install_patches',
    expect.objectContaining({ restorePoint: expect.objectContaining({ v: 1, requestId: 'req-1' }) }));
});

it('omits the key entirely when no checkpoint is requested', async () => {
  mockRequestBlock(null);
  await prepareDeviceExecution({ patchJobId: 'job-1', deviceId: 'dev-1', orgId: 'org-1' });
  const payload = queueCommandForExecution.mock.calls[0][2];
  expect('restorePoint' in payload).toBe(false);
});

it('includes each patch category so the agent can skip a definitions-only command', async () => {
  // The definitions-only skip is NOT implementable without this: the payload
  // carried no category, and the agent's patch reference has none either.
  await prepareDeviceExecution({ patchJobId: 'job-1', deviceId: 'dev-1', orgId: 'org-1' });
  const payload = queueCommandForExecution.mock.calls[0][2];
  expect(payload.patches[0]).toHaveProperty('category');
});

it('fails the device execution visibly when policy resolution throws', async () => {
  mockRequestThrows(new Error('Malformed system_protection policy settings'));
  const res = await prepareDeviceExecution({ patchJobId: 'job-1', deviceId: 'dev-1', orgId: 'org-1' });
  expect(res.error).toMatch(/system_protection|restore/i);
  expect(queueCommandForExecution).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/patchJobExecutor.restorePoint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `prepareDeviceExecution`, add `category: patches.category` to the `patchRecords` select, then before `queueCommandForExecution`:

```ts
  // #4609: resolve the System Restore checkpoint decision HERE, when the
  // concrete per-device command is created -- not at schedule-authoring time,
  // and not via heartbeat config (the agent heartbeat runs under an org-scoped
  // RLS context and cannot see partner-wide policy rows, #2930).
  //
  // Not wrapped in try/catch: a resolution failure fails this device's
  // execution visibly instead of silently dispatching an unprotected install.
  let restorePoint;
  try {
    restorePoint = await buildRestorePointRequest({
      deviceId,
      orgId,
      osType: device.osType,
      trigger: 'patch',
      label: `install ${patchIds.length} update${patchIds.length === 1 ? '' : 's'}`,
      patchJobId,
    });
  } catch (err) {
    console.error(`[PatchJobExecutor] restore-point policy resolution failed for device ${deviceId}:`, err);
    await markDeviceSkipped(patchJobId, deviceId, 'error_resolving_restore_point');
    return { error: 'Failed to resolve the System Restore checkpoint policy' };
  }

  const cmdResult = await queueCommandForExecution(deviceId, 'install_patches', {
    patchIds,
    patches: patchRecords,
    ...(restorePoint ? { restorePoint } : {}),
  });
```

Then, immediately after the `commandId` is known, link it onto the ledger row:

```ts
  if (restorePoint) {
    await db.update(deviceRestorePointAttempts)
      .set({ deviceCommandId: commandId })
      .where(eq(deviceRestorePointAttempts.requestId, restorePoint.requestId));
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/jobs/patchJobExecutor.restorePoint.test.ts src/jobs/patchJobExecutor.test.ts`
Expected: PASS. Confirm the file count is 2 and no existing patch-executor test regressed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/patchJobExecutor.ts apps/api/src/jobs/patchJobExecutor.restorePoint.test.ts
git commit -m "feat(api): stamp the restorePoint block on install_patches (#4609)"
```

### Task 5.3: Stamp at the script and software creation sites

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (payload build, ~line 457)
- Modify: `apps/api/src/services/softwareDeployment.ts` (both payload builds, ~line 423 and ~line 837)
- Create: `apps/api/src/services/scriptDispatch.restorePoint.test.ts`
- Create: `apps/api/src/services/softwareDeployment.restorePoint.test.ts`

**Interfaces:**
- Consumes: `buildRestorePointRequest`.
- Produces: the `restorePoint` key on `script` and `software_install` payloads.

- [ ] **Step 1: Write the failing tests**

For `scriptDispatch`:
```ts
it('stamps the block inside the guarded payload-build region', async () => {
  mockRequestBlock(blockFor('req-1'));
  await dispatchScript(input);
  expect(queueCommand).toHaveBeenCalledWith('dev-1', 'script',
    expect.objectContaining({ restorePoint: expect.objectContaining({ requestId: 'req-1' }) }),
    expect.anything(), expect.anything());
});

it('discards the pending execution row when resolution throws', async () => {
  // The payload build lives inside the guarded region precisely so a failure
  // here discards the pending scriptExecutions row instead of orphaning it.
  mockRequestThrows(new Error('boom'));
  await expect(dispatchScript(input)).rejects.toThrow();
  expect(deletedPendingExecutions()).toContain(input.executionId);
});

it('passes the executionId so the ledger row can be joined to the run', async () => {
  mockRequestBlock(blockFor('req-1'));
  await dispatchScript(input);
  expect(buildRestorePointRequest).toHaveBeenCalledWith(
    expect.objectContaining({ trigger: 'script', scriptExecutionId: input.executionId }));
});
```

For `softwareDeployment`, the same three shapes plus:
```ts
it('stamps at BOTH payload-build sites (managed installMethod and download URL)', async () => {
  // buildAndDispatchSoftwareInstalls has two independent payload builders --
  // the manager path (installMethod) and the download path. Missing one is how
  // half a feature ships.
  await dispatchManagedInstall();
  expect(lastPayload()).toHaveProperty('restorePoint');
  await dispatchDownloadInstall();
  expect(lastPayload()).toHaveProperty('restorePoint');
});

it('re-resolves for a NEW retry attempt but not for a transport redelivery', async () => {
  // "A retry must re-resolve" is wrong as a blanket rule. A new business
  // attempt gets a new command id and re-resolves; transport redelivery of the
  // SAME command id must reuse the frozen snapshot.
  await dispatchWithRetryCount(0);
  const first = lastPayload().restorePoint.requestId;
  await dispatchWithRetryCount(1);
  expect(lastPayload().restorePoint.requestId).not.toBe(first);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.restorePoint.test.ts src/services/softwareDeployment.restorePoint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `scriptDispatch.ts`**

Inside the existing `try` block that owns payload build (so a failure flows through `discardPendingExecution`), after `reservedCommandId` is generated:

```ts
    // #4609: resolved here, inside the guarded region, so a policy-resolution
    // failure discards the pending execution row rather than orphaning it.
    const restorePoint = await buildRestorePointRequest({
      deviceId: device.id,
      orgId: device.orgId,
      osType: device.osType,
      trigger: 'script',
      label: `run script ${scriptName}`,
      deviceCommandId: reservedCommandId,
      scriptExecutionId: executionId ?? null,
    });
```

and add `...(restorePoint ? { restorePoint } : {}),` to the object passed to `encryptSensitivePayloadFields`.

**Order matters:** the block goes in *before* `encryptSensitivePayloadFields`, and `encryptSensitivePayloadFields` must pass it through untouched — it contains no secret material, so `commandSecretRedaction` is unaffected. Assert that with a test that round-trips a payload through the encryptor and checks `restorePoint` survives.

- [ ] **Step 4: Implement in `softwareDeployment.ts`**

At **both** payload-build sites (~423 managed-installMethod, ~837 download-URL), add before the `const payload` literal:

```ts
    const restorePoint = await buildRestorePointRequest({
      deviceId: device.id,
      orgId: device.orgId,
      osType: device.osType,
      trigger: 'software_install',
      label: `install ${catalogItem.name}`,
      softwareDeploymentId: deploymentId,
    });
```

and `...(restorePoint ? { restorePoint } : {}),` inside each payload object.

The retry semantics come for free: `dispatchSoftwareInstallToDevice` is called once per attempt with a `retryCount`-derived command id, so a new attempt naturally re-enters this code and gets a fresh `requestId`, while a transport redelivery of the same command id never re-enters it.

- [ ] **Step 5: Sweep every other creation site repo-wide**

Run:
```bash
grep -rn "'install_patches'\|\"install_patches\"" apps/api/src --include=*.ts | grep -v test
grep -rn "queueCommand(.*'script'\|'script'," apps/api/src --include=*.ts | grep -v test
grep -rn "software_install" apps/api/src --include=*.ts | grep -v test
```
Classify **every** hit as either (a) a command-creation site that must stamp, or (b) a reader/result path that must not. Specifically check: `aiToolsScripts*`, `aiToolsSoftware*`, the automation worker's script dispatch, `softwareRemediationWorker`, the script retry endpoint, and the mobile/portal dispatch routes.

The three sites in this task are chokepoints (`scriptDispatch.ts` is documented as the single script dispatch chokepoint; `dispatchSoftwareInstallToDevice` is the shared per-device unit), so most hits should route through them. **Record the classification in the PR body** — "hidden second readers are how features get missed" is the spec's own step-7 warning.

- [ ] **Step 6: Run the tests**

Run:
```bash
cd apps/api && npx vitest run src/services/scriptDispatch src/services/softwareDeployment
```
Note the bare substring (no trailing slash) so dotted sibling files are included. Expected: PASS; check the reported file count covers every `scriptDispatch*.test.ts` and `softwareDeployment*.test.ts`.

- [ ] **Step 7: Commit and open the PR**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/softwareDeployment.ts \
        apps/api/src/services/scriptDispatch.restorePoint.test.ts apps/api/src/services/softwareDeployment.restorePoint.test.ts
git commit -m "feat(api): stamp the restorePoint block on script and software_install (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(api): stamp restore-point requests at command creation (#4609 W05)" --body "Wave 05 of #4609. Old agents ignore the block, so behaviour is unchanged until W07.

- \`buildRestorePointRequest\` is the SINGLE chokepoint: resolves the policy, stamps a versioned v1 block, and writes the \`requested\` ledger row.
- Stamped at all three creation sites: \`patchJobExecutor.prepareDeviceExecution\`, \`scriptDispatch\` (inside the guarded region), and BOTH \`softwareDeployment\` payload builders.
- \`enabled\` is true only when the toggle is on AND the device is Windows; \"off\" is communicated by OMITTING the block, which every agent version understands.
- Policy-resolution errors fail command creation visibly; they never degrade to no-checkpoint.
- \`install_patches\` now carries each patch's \`category\`, without which the definitions-only skip is not implementable.
- Repo-wide creation-site sweep results: <paste the Step 5 classification>

Refs #4609"
```

### Task 5.4: Supersede stale queued commands

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` (the delivery-claim path)
- Create: `apps/api/src/services/restorePointStaleness.test.ts`

**Interfaces:**
- Consumes: `RestorePointRequestBlock`.
- Produces: `function isRestorePointBlockStale(block: RestorePointRequestBlock, now: Date): boolean`.

Queued commands can sit pending for days (`jobs/staleCommandReaper.ts`), so a policy change mid-queue has no effect today. `validUntil` + `policyRevision` let the delivery-claim path supersede a stale command and recreate it with a fresh snapshot.

- [ ] **Step 1: Write the failing test**

```ts
it('is not stale before validUntil', () => {
  expect(isRestorePointBlockStale(block({ validUntil: '2026-09-03T00:00:00Z' }), new Date('2026-09-02T23:59:00Z'))).toBe(false);
});

it('is stale after validUntil', () => {
  expect(isRestorePointBlockStale(block({ validUntil: '2026-09-03T00:00:00Z' }), new Date('2026-09-03T00:01:00Z'))).toBe(true);
});

it('treats a malformed validUntil as stale', () => {
  // Fail toward re-resolution: a block we cannot date is a block we cannot trust.
  expect(isRestorePointBlockStale(block({ validUntil: 'not-a-date' }), new Date())).toBe(true);
});

it('marks the superseded ledger row rather than leaving it requested forever', async () => {
  const row = await supersedeStaleRestorePoint('req-1');
  expect(row.status).toBe('failed');
  expect(row.message).toMatch(/superseded/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/restorePointStaleness.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and wire into the delivery-claim path**

Add the predicate and the supersede helper to `restorePointRequest.ts`, then in `commandQueue.ts`'s delivery-claim path: when a queued command's payload carries a `restorePoint` block that `isRestorePointBlockStale` reports true for, terminalise its ledger row with `status: 'failed'`, `message: 'superseded before delivery: the policy snapshot expired'`, and let the caller recreate the command with a fresh snapshot.

**Transport redelivery of the same command id must NOT trigger this** — only an expired `validUntil` does. Redelivery reuses the frozen snapshot by construction, because the payload is unchanged.

- [ ] **Step 4: Run the tests and commit**

Run: `cd apps/api && npx vitest run src/services/restorePointStaleness.test.ts src/services/commandQueue`
Expected: PASS.

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/restorePointRequest.ts apps/api/src/services/restorePointStaleness.test.ts
git commit -m "feat(api): supersede queued commands whose restore-point snapshot expired (#4609)"
```

---

# Wave 06 — Server: result ingest and ledger terminalisation

**Depends on W04.** Ships before the agent sends anything, and must tolerate agents that never return a `restorePoint` field — that is the whole point of landing it first.

**Transport is four API touch points, not one**, and all of them currently drop unknown fields:
- `apps/api/src/routes/agents/schemas.ts:439` — `commandResultSchema` (Zod ingest)
- `apps/api/src/routes/agentWs.ts:532` — `buildStoredCommandResult` (WS)
- `apps/api/src/routes/agents/commands.ts:105` — `buildStoredCommandResult` (REST)
- `apps/api/src/routes/agentWs.ts:1634` — the **direct non-UUID software branch**, which has no `device_commands` row and takes a separate path entirely

**Ingestion must run AFTER the authoritative terminal compare-and-set in both transports.** A single insertion inside `processCommandResult` is not sufficient — the non-UUID branch never reaches it.

### Task 6.1: Accept `restorePoint` on the wire

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agentWs.ts` (`buildStoredCommandResult`)
- Modify: `apps/api/src/routes/agents/commands.ts` (`buildStoredCommandResult`)
- Create: `apps/api/src/routes/agents/restorePointResultSchema.test.ts`

**Interfaces:**
- Consumes: `RestorePointOutcome` (W05 Task 5.1).
- Produces: `restorePointOutcomeSchema` (Zod) and an optional `restorePoint` field on `commandResultSchema`; `restorePoint` preserved on the stored result in both builders.

- [ ] **Step 1: Write the failing test**

```ts
describe('commandResultSchema restorePoint', () => {
  it('accepts a result with no restorePoint field (every agent shipped to date)', () => {
    expect(commandResultSchema.safeParse({ status: 'completed', exitCode: 0 }).success).toBe(true);
  });

  it('accepts a well-formed outcome', () => {
    const res = commandResultSchema.safeParse({
      status: 'completed', exitCode: 0,
      restorePoint: {
        status: 'existing_accepted', requestId: '3f1d1a0e-0000-4000-8000-000000000001',
        sequenceNumber: '9223372036854775807', attemptedAt: '2026-09-02T18:03:11Z',
        durationMs: 1234, existingPointAgeMinutes: 240, frequencyMinutes: 1440,
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects a numeric sequenceNumber', () => {
    // int64 exceeds the JS safe range: accepting a number would silently
    // corrupt large sequence values on the way in.
    const res = commandResultSchema.safeParse({
      status: 'completed', exitCode: 0,
      restorePoint: { status: 'created', requestId: 'r', sequenceNumber: 9223372036854775807, attemptedAt: 't', durationMs: 1 },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const res = commandResultSchema.safeParse({
      status: 'completed', exitCode: 0,
      restorePoint: { status: 'probably_fine', requestId: 'r', attemptedAt: 't', durationMs: 1 },
    });
    expect(res.success).toBe(false);
  });

  it('rejects the server-only requested status coming from an agent', () => {
    const res = commandResultSchema.safeParse({
      status: 'completed', exitCode: 0,
      restorePoint: { status: 'requested', requestId: 'r', attemptedAt: 't', durationMs: 1 },
    });
    expect(res.success).toBe(false);
  });

  it('bounds message length', () => {
    const res = commandResultSchema.safeParse({
      status: 'completed', exitCode: 0,
      restorePoint: { status: 'failed', requestId: 'r', attemptedAt: 't', durationMs: 1, message: 'x'.repeat(10_001) },
    });
    expect(res.success).toBe(false);
  });
});

describe('buildStoredCommandResult', () => {
  it('preserves restorePoint on the stored result in both transports', () => {
    const outcome = { status: 'created', requestId: 'r', attemptedAt: 't', durationMs: 1 };
    expect(wsBuildStoredCommandResult('script', { status: 'completed', exitCode: 0, restorePoint: outcome }, undefined))
      .toMatchObject({ restorePoint: outcome });
    expect(restBuildStoredCommandResult('script', { status: 'completed', exitCode: 0, restorePoint: outcome }, undefined))
      .toMatchObject({ restorePoint: outcome });
  });

  it('does not add a restorePoint key when the agent sent none', () => {
    expect('restorePoint' in wsBuildStoredCommandResult('script', { status: 'completed', exitCode: 0 }, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/agents/restorePointResultSchema.test.ts`
Expected: FAIL — `restorePoint` is stripped by the schema and absent from the stored result.

- [ ] **Step 3: Add the schema**

In `apps/api/src/routes/agents/schemas.ts`, above `commandResultSchema`:

```ts
/**
 * The agent's System Restore checkpoint outcome (#4609).
 *
 * A dedicated TOP-LEVEL field, not a key inside `result`/`stdout`: script and
 * software-install results already use stdout for their own payloads with
 * type-specific parsers, and a sub-outcome that lands in its own column has
 * precedent (`rebootRequired` on install_patches -> patch_job_results).
 */
export const restorePointOutcomeSchema = z.object({
  // 'requested' is deliberately absent: it is server-only, written at
  // command-creation time. An agent claiming it would be malformed.
  status: z.enum([
    'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
    'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed',
  ]),
  requestId: z.string().max(64),
  // STRING, never a number: Windows sequence numbers are INT64 and exceed the
  // JS safe-integer range, so a numeric field would silently round large values.
  sequenceNumber: z.string().regex(/^-?[0-9]{1,20}$/).optional(),
  description: z.string().max(512).optional(),
  message: z.string().max(10_000).optional(),
  attemptedAt: z.string().max(64),
  durationMs: z.number().int().min(0),
  existingPointAgeMinutes: z.number().int().optional(),
  frequencyMinutes: z.number().int().optional(),
});
```

and add to `commandResultSchema`:
```ts
  restorePoint: restorePointOutcomeSchema.optional(),
```

- [ ] **Step 4: Preserve it in both stored-result builders**

In **both** `buildStoredCommandResult` implementations (`agentWs.ts:532`, `agents/commands.ts:105`), add to the returned object:

```ts
    // #4609: carried through verbatim. No redaction pass -- the outcome
    // contains no agent output and no secret material, only typed status
    // fields the server itself asked for.
    ...(data.restorePoint ? { restorePoint: data.restorePoint } : {}),
```

(the WS builder's parameter is named `result`, the REST one's `data` — match each file.)

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/routes/agents/restorePointResultSchema.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agentWs.ts \
        apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/restorePointResultSchema.test.ts
git commit -m "feat(api): accept and persist the agent restorePoint outcome (#4609)"
```

### Task 6.2: Ledger terminalisation

**Files:**
- Create: `apps/api/src/services/restorePointIngest.ts`
- Create: `apps/api/src/services/restorePointIngest.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts` (after the terminal CAS, and in the non-UUID branch)
- Modify: `apps/api/src/routes/agents/commands.ts` (after the REST terminal CAS)

**Interfaces:**
- Consumes: `deviceRestorePointAttempts`, `restorePointOutcomeSchema`.
- Produces: `ingestRestorePointOutcome(outcome: RestorePointOutcome, ctx: { orgId: string; deviceId: string; deviceCommandId?: string | null }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ingestRestorePointOutcome', () => {
  it('terminalises the existing requested row rather than inserting a second one', async () => {
    await seedRequested({ requestId: 'req-1', orgId: 'org-1', deviceId: 'dev-1' });
    await ingestRestorePointOutcome(outcome({ requestId: 'req-1', status: 'created', sequenceNumber: '42' }), ctx);
    expect(await countRows('req-1')).toBe(1);
    expect(await row('req-1')).toMatchObject({ status: 'created', sequenceNumber: 42n, receivedAt: expect.any(Date) });
  });

  it('is idempotent under replay: the same requestId twice yields one row and one terminal state', async () => {
    // The agent's command dedup map is in-memory and evicted after two minutes,
    // so a crash can replay both the checkpoint AND the risky action.
    await seedRequested({ requestId: 'req-1', orgId: 'org-1', deviceId: 'dev-1' });
    await ingestRestorePointOutcome(outcome({ requestId: 'req-1', status: 'created' }), ctx);
    await ingestRestorePointOutcome(outcome({ requestId: 'req-1', status: 'created' }), ctx);
    expect(await countRows('req-1')).toBe(1);
  });

  it('sets acceptedExistingPoint and the age/frequency fields on the throttle path', async () => {
    await seedRequested({ requestId: 'req-1', orgId: 'org-1', deviceId: 'dev-1' });
    await ingestRestorePointOutcome(outcome({
      requestId: 'req-1', status: 'existing_accepted', existingPointAgeMinutes: 240, frequencyMinutes: 1440,
    }), ctx);
    expect(await row('req-1')).toMatchObject({
      status: 'existing_accepted', acceptedExistingPoint: true,
      existingPointAgeMinutes: 240, frequencyMinutes: 1440,
    });
  });

  it('stores an int64 sequence number without loss', async () => {
    await seedRequested({ requestId: 'req-1', orgId: 'org-1', deviceId: 'dev-1' });
    await ingestRestorePointOutcome(outcome({ requestId: 'req-1', status: 'created', sequenceNumber: '9223372036854775807' }), ctx);
    expect((await row('req-1')).sequenceNumber).toBe(9223372036854775807n);
  });

  it('ignores an outcome whose requestId has no ledger row, and records why', async () => {
    // A forged or stale requestId must not create a row: the ledger is the
    // record of what the SERVER asked for, not of what an agent claims.
    await ingestRestorePointOutcome(outcome({ requestId: 'never-asked', status: 'created' }), ctx);
    expect(await countRows('never-asked')).toBe(0);
    expect(warnings()).toEqual([expect.stringMatching(/no requested row/i)]);
  });

  it('refuses to terminalise a row belonging to a different org or device', async () => {
    await seedRequested({ requestId: 'req-1', orgId: 'org-OTHER', deviceId: 'dev-OTHER' });
    await ingestRestorePointOutcome(outcome({ requestId: 'req-1', status: 'created' }), ctx);
    expect((await row('req-1')).status).toBe('requested');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/restorePointIngest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Terminalise the ledger row for one agent-reported checkpoint outcome (#4609).
 *
 * UPDATE, never INSERT. The row was created at command-creation time with
 * status 'requested'; a missing row means the server never asked, and an agent
 * claiming otherwise must not be able to conjure ledger history.
 *
 * Idempotent on requestId: the agent's dedup map is in-memory and evicted after
 * two minutes, so a crash can replay a command and its checkpoint.
 *
 * Tenant-guarded on (org_id, device_id) as well as request_id, so a result
 * routed from the wrong device can never restamp another tenant's row.
 */
export async function ingestRestorePointOutcome(
  outcome: RestorePointOutcome,
  ctx: { orgId: string; deviceId: string; deviceCommandId?: string | null },
): Promise<void> {
  const updated = await db
    .update(deviceRestorePointAttempts)
    .set({
      status: outcome.status,
      sequenceNumber: outcome.sequenceNumber ? BigInt(outcome.sequenceNumber) : null,
      description: outcome.description ?? null,
      message: outcome.message ?? null,
      acceptedExistingPoint: outcome.status === 'existing_accepted',
      existingPointAgeMinutes: outcome.existingPointAgeMinutes ?? null,
      frequencyMinutes: outcome.frequencyMinutes ?? null,
      durationMs: outcome.durationMs,
      attemptedAt: parseAgentTimestamp(outcome.attemptedAt),
      receivedAt: new Date(),
      ...(ctx.deviceCommandId ? { deviceCommandId: ctx.deviceCommandId } : {}),
    })
    .where(and(
      eq(deviceRestorePointAttempts.requestId, outcome.requestId),
      eq(deviceRestorePointAttempts.orgId, ctx.orgId),
      eq(deviceRestorePointAttempts.deviceId, ctx.deviceId),
      // Only a non-terminal row is claimable, so a replayed frame is a no-op
      // rather than a second rewrite.
      eq(deviceRestorePointAttempts.status, 'requested'),
    ))
    .returning({ id: deviceRestorePointAttempts.id });

  if (updated.length === 0) {
    // Not an error: a replay, a superseded command, or an outcome for a
    // request this server never made. Logged so it is not invisible.
    console.warn(
      '[restorePointIngest] no requested row claimed for outcome',
      { requestId: outcome.requestId, deviceId: ctx.deviceId, status: outcome.status },
    );
  }
}
```

- [ ] **Step 4: Wire into the WS transport, after the terminal CAS**

In `agentWs.ts`, immediately after the `device_commands.ws_result_terminal_cas` update returns rows (i.e. inside the branch that just won the compare-and-set):

```ts
      // #4609: AFTER the authoritative terminal CAS, so a losing duplicate
      // frame never restamps the ledger. Non-throwing -- a ledger write must
      // not fail a command whose real work already completed.
      if (normalizedResult.restorePoint) {
        await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            ingestRestorePointOutcome(normalizedResult.restorePoint!, {
              orgId, deviceId: resolvedDeviceId!, deviceCommandId: result.commandId,
            }),
          ),
        ).catch((err) => {
          console.error('[AgentWs] restore-point ledger write failed', err);
          captureException(err);
        });
      }
```

- [ ] **Step 5: Wire into the direct non-UUID software branch**

In `processOrphanedCommandResult` (reached from `agentWs.ts:1634`), add the same call for `software_install`-shaped results. **This branch has no `device_commands` row at all**, so pass `deviceCommandId: null` and rely on `requestId` as the identity. A single insertion inside `processCommandResult` would miss every direct software result.

- [ ] **Step 6: Wire into the REST transport**

In `apps/api/src/routes/agents/commands.ts`, after its own terminal compare-and-set, add the identical guarded call.

- [ ] **Step 7: Write the transport-level tests**

Add to the existing agent-result test suites, one per transport:

```ts
it('terminalises the ledger after the WS terminal CAS', async () => { /* … */ });
it('does NOT terminalise when the CAS lost (duplicate frame)', async () => { /* … */ });
it('terminalises for a direct non-UUID software result (no device_commands row)', async () => { /* … */ });
it('terminalises after the REST terminal CAS', async () => { /* … */ });
it('a ledger write failure does not fail the command result', async () => { /* … */ });
```

- [ ] **Step 8: Run everything and commit**

Run:
```bash
cd apps/api && npx vitest run src/services/restorePointIngest.test.ts src/routes/agentWs src/routes/agents/commands
```
Expected: PASS. Check the reported file count includes every dotted sibling of `agentWs.test.ts`.

```bash
git add apps/api/src/services/restorePointIngest.ts apps/api/src/services/restorePointIngest.test.ts \
        apps/api/src/routes/agentWs.ts apps/api/src/routes/agents/commands.ts
git commit -m "feat(api): terminalise the restore-point ledger from both result transports (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(api): ingest agent restore-point outcomes (#4609 W06)" --body "Wave 06 of #4609. Lands before the agent sends anything; tolerant of agents that never return the field.

- \`restorePoint\` accepted on \`commandResultSchema\` as a dedicated top-level field and preserved by BOTH stored-result builders.
- \`sequenceNumber\` is a decimal STRING on the wire and \`bigint\` in Postgres -- a numeric field would round int64 values.
- Ledger terminalisation runs AFTER the authoritative terminal CAS in both transports, INCLUDING the direct non-UUID software branch that has no \`device_commands\` row.
- UPDATE-only and tenant-guarded on (request_id, org_id, device_id): an agent cannot conjure ledger history for a request the server never made.
- Idempotent under replay; a ledger write failure never fails the command result.

Refs #4609"
```

---

# Wave 07 — Agent: honour the block on all three paths

**Depends on W02 (package), W05 (payload contract), W06 (ingest).** This is **customer-machine code**: normal agent release plus the fleet-promote gate.

**Checkpoint boundary — the rule for all three paths:** create the checkpoint *after* validation, download + checksum, and no-op / "already installed" detection, and *immediately before the first mutation*. A command that never mutates must not consume the day's one restore point.

### Task 7.1: Result transport plumbing

**Files:**
- Modify: `agent/internal/remote/tools/types.go` (`CommandResult`)
- Modify: `agent/internal/websocket/client.go` (WS `CommandResult`)
- Modify: `agent/internal/heartbeat/heartbeat.go` (`toWSCommandResult`)
- Create: `agent/internal/heartbeat/restorepoint_transport_test.go`

**Interfaces:**
- Consumes: `systemrestore.Outcome`.
- Produces: `RestorePoint *systemrestore.Outcome` with JSON tag `restorePoint,omitempty` on both result structs, carried through the WS conversion.

- [ ] **Step 1: Write the failing test**

```go
func TestToWSCommandResultCarriesRestorePoint(t *testing.T) {
	out := &systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: "r1", AttemptedAt: "t", DurationMs: 5}
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed", RestorePoint: out})
	if ws.RestorePoint == nil {
		t.Fatal("RestorePoint was dropped by the WS conversion")
	}
	if ws.RestorePoint.RequestID != "r1" {
		t.Fatalf("RequestID = %q", ws.RestorePoint.RequestID)
	}
}

func TestToWSCommandResultOmitsRestorePointWhenAbsent(t *testing.T) {
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed"})
	b, _ := json.Marshal(ws)
	if bytes.Contains(b, []byte("restorePoint")) {
		t.Fatalf("absent RestorePoint must be omitted from the wire form: %s", b)
	}
}

func TestRestorePointDoesNotRideInsideResultOrStdout(t *testing.T) {
	// Script and software-install results already use Stdout for their own
	// payloads with type-specific server parsers. Smuggling the outcome in
	// there would break those parsers; it is a dedicated top-level field.
	out := &systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: "r1", AttemptedAt: "t"}
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed", Stdout: `{"success":true}`, RestorePoint: out})
	b, _ := json.Marshal(ws.Result)
	if bytes.Contains(b, []byte("restorePoint")) {
		t.Fatalf("restorePoint must not be merged into Result: %s", b)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestToWSCommandResult ./internal/heartbeat/`
Expected: FAIL — `unknown field RestorePoint`.

- [ ] **Step 3: Add the field to both structs**

`agent/internal/remote/tools/types.go`, in `CommandResult`:
```go
	// RestorePoint is the Windows System Restore checkpoint outcome for this
	// command, when the server asked for one (#4609). A DEDICATED top-level
	// field rather than a key inside Result/Stdout: script and software-install
	// results already use Stdout for their own payloads with type-specific
	// server-side parsers.
	RestorePoint *systemrestore.Outcome `json:"restorePoint,omitempty"`
```

`agent/internal/websocket/client.go`, in the WS `CommandResult`, the same field and tag.

- [ ] **Step 4: Carry it through the conversion**

In `toWSCommandResult`, after the existing field copies:
```go
	// #4609: carried verbatim. Never folded into Result -- see the field
	// comment on tools.CommandResult.RestorePoint.
	wsResult.RestorePoint = result.RestorePoint
```

- [ ] **Step 5: Run the tests and commit**

Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/websocket/... && GOOS=windows go build ./...`
Expected: PASS.

```bash
git add agent/internal/remote/tools/types.go agent/internal/websocket/client.go \
        agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/restorepoint_transport_test.go
git commit -m "feat(agent): carry the restore-point outcome on both result transports (#4609)"
```

### Task 7.2: The shared handler helper

**Files:**
- Create: `agent/internal/heartbeat/restorepoint.go`
- Create: `agent/internal/heartbeat/restorepoint_test.go`

**Interfaces:**
- Consumes: `systemrestore.ParseRequest`, `systemrestore.Create`.
- Produces: `func maybeCheckpoint(ctx context.Context, payload map[string]any, legacyDefaultEnabled bool, label string) *systemrestore.Outcome` — returns nil when no checkpoint was requested, and a terminal `Outcome` otherwise.

- [ ] **Step 1: Write the failing test**

```go
func TestMaybeCheckpointReturnsNilWhenNotRequested(t *testing.T) {
	if got := maybeCheckpoint(context.Background(), map[string]any{}, false, "run script"); got != nil {
		t.Fatalf("expected nil for a script command with no block, got %+v", got)
	}
}

func TestMaybeCheckpointAttemptsOnTheLegacyPatchDefault(t *testing.T) {
	// Global Constraint 7: a missing block on install_patches means legacy
	// best-effort ENABLED, so an old server keeps today's behaviour.
	got := maybeCheckpoint(context.Background(), map[string]any{}, true, "install 6 updates")
	if got == nil {
		t.Fatal("expected an attempt on the legacy patch path")
	}
	if !got.Status.Terminal() {
		t.Fatalf("Status %q is not terminal", got.Status)
	}
}

func TestMaybeCheckpointPrefersTheServerLabel(t *testing.T) {
	got := maybeCheckpoint(context.Background(), payloadWithBlock("r1", "Breeze: install 6 updates"), false, "fallback")
	if got == nil || got.RequestID != "r1" {
		t.Fatalf("outcome = %+v", got)
	}
}

func TestMaybeCheckpointAlwaysReturnsATerminalStatus(t *testing.T) {
	// An enabled request must NEVER vanish without an outcome -- that is the
	// invisibility problem #4609 exists to fix.
	for _, legacy := range []bool{true, false} {
		got := maybeCheckpoint(context.Background(), payloadWithBlock("r1", "x"), legacy, "x")
		if got == nil || !got.Status.Terminal() {
			t.Fatalf("legacy=%v produced %+v", legacy, got)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && go test -race -run TestMaybeCheckpoint ./internal/heartbeat/`
Expected: FAIL — `undefined: maybeCheckpoint`.

- [ ] **Step 3: Implement**

```go
package heartbeat

import (
	"context"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

// maybeCheckpoint takes at most ONE System Restore checkpoint for a command and
// returns its outcome, or nil when none was requested (#4609).
//
// legacyDefaultEnabled encodes the mixed-fleet contract: pass true for
// install_patches (a missing block means legacy best-effort enabled) and false
// for script / software_install (a missing block means disabled).
//
// An enabled request NEVER returns nil. The whole point of the feature is that
// a tech can answer "did a checkpoint actually get created for what I just
// ran?", and a silent no-outcome is the current broken state.
func maybeCheckpoint(
	ctx context.Context,
	payload map[string]any,
	legacyDefaultEnabled bool,
	fallbackLabel string,
) *systemrestore.Outcome {
	req, attempt := systemrestore.ParseRequest(payload, legacyDefaultEnabled)
	if !attempt {
		return nil
	}
	if req.Label == "" {
		req.Label = fallbackLabel
	}
	out := systemrestore.Create(ctx, req)
	if out.Status != systemrestore.StatusCreated {
		log.Info("system restore checkpoint not created",
			"status", string(out.Status), "requestId", out.RequestID, "message", out.Message)
	}
	return &out
}
```

- [ ] **Step 4: Run the tests and commit**

Run: `cd agent && go test -race ./internal/heartbeat/...`
Expected: PASS.

```bash
git add agent/internal/heartbeat/restorepoint.go agent/internal/heartbeat/restorepoint_test.go
git commit -m "feat(agent): shared per-command checkpoint helper (#4609)"
```

### Task 7.3: Patching — one checkpoint per command, definitions-only skip

**Files:**
- Modify: `agent/internal/heartbeat/handlers_patch.go` (`handleInstallPatches`)
- Modify: `agent/internal/heartbeat/heartbeat.go` (`patchCommandRef` gains `Category`; `patchRefsFromPayload`)
- Modify: `agent/internal/patching/windows.go` (remove the per-update call added in W02 Task 2.6)
- Create: `agent/internal/heartbeat/handlers_patch_restorepoint_test.go`

**Interfaces:**
- Consumes: `maybeCheckpoint`, the `category` field W05 added to the payload's patch records.
- Produces: `RestorePoint` populated on `install_patches` results; `patchCommandRef.Category`.

- [ ] **Step 1: Write the failing test**

```go
func TestInstallPatchesTakesExactlyOneCheckpointForNPatches(t *testing.T) {
	// The shipped code calls CreateRestorePoint once per non-definitions
	// update: a 12-patch job "creates" 12 checkpoints and, under the Windows
	// throttle, actually gets at most one. One per COMMAND is the honest shape.
	h, calls := heartbeatWithCheckpointCounter(t)
	res := h.dispatchInstallPatches(payloadWithPatches(12, "security"))
	if *calls != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1", *calls)
	}
	if res.RestorePoint == nil {
		t.Fatal("result carries no RestorePoint")
	}
}

func TestInstallPatchesSkipsADefinitionsOnlyCommand(t *testing.T) {
	h, calls := heartbeatWithCheckpointCounter(t)
	res := h.dispatchInstallPatches(payloadWithPatches(3, "definitions"))
	if *calls != 0 {
		t.Fatalf("checkpoint attempts = %d, want 0 for a definitions-only command", *calls)
	}
	// An enabled request must never vanish without an outcome.
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedDefinitions {
		t.Fatalf("RestorePoint = %+v, want skipped_definition_only", res.RestorePoint)
	}
}

func TestInstallPatchesCheckpointsAMixedCommand(t *testing.T) {
	h, calls := heartbeatWithCheckpointCounter(t)
	h.dispatchInstallPatches(payloadWithCategories("definitions", "security"))
	if *calls != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1 for a mixed command", *calls)
	}
}

func TestInstallPatchesTreatsAnUnknownCategoryAsRisky(t *testing.T) {
	// Fail toward protection: an unlabelled patch might be anything.
	h, calls := heartbeatWithCheckpointCounter(t)
	h.dispatchInstallPatches(payloadWithCategories(""))
	if *calls != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1 for an unknown category", *calls)
	}
}

func TestInstallPatchesCheckpointsAfterPreflightAndBeforeInstall(t *testing.T) {
	// A command rejected by preflight must not consume the day's one point.
	h, calls := heartbeatWithCheckpointCounter(t)
	h.failPreflight()
	h.dispatchInstallPatches(payloadWithPatches(2, "security"))
	if *calls != 0 {
		t.Fatalf("checkpoint attempts = %d, want 0 when preflight rejects the command", *calls)
	}
}

func TestInstallPatchesWithNoBlockStillAttempts(t *testing.T) {
	h, calls := heartbeatWithCheckpointCounter(t)
	h.dispatchInstallPatchesNoBlock(payloadWithPatches(2, "security"))
	if *calls != 1 {
		t.Fatalf("attempts = %d, want 1 -- a missing block on install_patches means legacy best-effort enabled", *calls)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && go test -race -run TestInstallPatches ./internal/heartbeat/`
Expected: FAIL.

- [ ] **Step 3: Add `Category` to the patch reference**

In `heartbeat.go`, add `Category string` to `patchCommandRef` and read `category` in `patchRefsFromPayload` (defaulting to `""`).

- [ ] **Step 4: Move the checkpoint up to `handleInstallPatches`**

After the preflight gate and before `executePatchInstallCommand`:

```go
	// #4609: ONE checkpoint per command, not per patch. The shipped per-update
	// call in patching/windows.go is removed below -- Windows throttles
	// creation to one per SystemRestorePointCreationFrequency minutes anyway,
	// so per-update calls produced N "successes" for at most one real point.
	//
	// Placed AFTER preflight so a command rejected before it mutates anything
	// does not consume the day's one restore point.
	refs := h.patchRefsFromPayload(cmd.Payload)
	var rp *systemrestore.Outcome
	if allDefinitionsOnly(refs) {
		// An enabled request must never vanish without an outcome.
		if _, attempt := systemrestore.ParseRequest(cmd.Payload, true); attempt {
			rp = &systemrestore.Outcome{
				Status:      systemrestore.StatusSkippedDefinitions,
				RequestID:   requestIDFromPayload(cmd.Payload),
				AttemptedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Message:     "every patch in this command is a definitions update",
			}
		}
	} else {
		rp = maybeCheckpoint(h.ctx, cmd.Payload, true, fmt.Sprintf("install %d update(s)", len(refs)))
	}

	result := h.executePatchInstallCommand(cmd.Payload, false)
	result.RestorePoint = rp
	return result
```

with:

```go
// allDefinitionsOnly reports whether every patch in the command is a
// definitions update. UNKNOWN CATEGORY COUNTS AS RISKY: an unlabelled patch
// might be anything, so we fail toward taking the checkpoint.
func allDefinitionsOnly(refs []patchCommandRef) bool {
	if len(refs) == 0 {
		return false
	}
	for _, r := range refs {
		if r.Category != "definitions" {
			return false
		}
	}
	return true
}
```

- [ ] **Step 5: Remove the per-update call**

In `agent/internal/patching/windows.go`, delete the `systemrestore.Create` block W02 Task 2.6 left in place, along with the now-unused `category` local if nothing else reads it, and the `context` / `systemrestore` imports if they become unused.

Run: `cd agent && grep -rn "systemrestore" internal/patching/`
Expected: no hits. The patching package no longer creates restore points at all; that responsibility now lives in the handler.

- [ ] **Step 6: Run the tests and commit**

Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/patching/... && GOOS=windows go build ./...`
Expected: PASS.

```bash
git add agent/internal/heartbeat/handlers_patch.go agent/internal/heartbeat/heartbeat.go \
        agent/internal/patching/windows.go agent/internal/heartbeat/handlers_patch_restorepoint_test.go
git commit -m "feat(agent): one restore point per install_patches command, with a definitions-only skip (#4609)"
```

### Task 7.4: Scripts and software install

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go` (`handleScriptInner`)
- Modify: `agent/internal/remote/tools/software_install.go` (`InstallSoftware`)
- Modify: `agent/internal/remote/tools/software_install_manager.go` (`installViaManager`)
- Create: `agent/internal/heartbeat/handlers_script_restorepoint_test.go`
- Create: `agent/internal/remote/tools/software_install_restorepoint_test.go`

**Interfaces:**
- Consumes: `maybeCheckpoint` (scripts) and `systemrestore.ParseRequest` + `systemrestore.Create` (software, which lives in `tools` and cannot import `heartbeat`).
- Produces: `RestorePoint` populated on `script` and `software_install` results.

- [ ] **Step 1: Write the failing tests**

Scripts:
```go
func TestScriptWithNoBlockTakesNoCheckpoint(t *testing.T) {
	h, calls := heartbeatWithCheckpointCounter(t)
	res := h.dispatchScript(scriptPayload())
	if *calls != 0 {
		t.Fatalf("attempts = %d, want 0 -- a missing block on script means DISABLED", *calls)
	}
	if res.RestorePoint != nil {
		t.Fatalf("RestorePoint = %+v, want nil", res.RestorePoint)
	}
}

func TestScriptCheckpointHappensAfterValidationAndBeforeExecution(t *testing.T) {
	// A script rejected for a malformed secretEnv must not consume a point.
	h, calls := heartbeatWithCheckpointCounter(t)
	h.dispatchScript(scriptPayloadWithBlock(withMalformedSecretEnv()))
	if *calls != 0 {
		t.Fatalf("attempts = %d, want 0 when validation rejects the command", *calls)
	}
}

func TestScriptCheckpointHappensBeforeTheUserHelperHandoff(t *testing.T) {
	// User-context scripts are checkpointed by the SERVICE process, before the
	// IPC handoff -- the helper runs unelevated and could not do it.
	h, calls := heartbeatWithCheckpointCounter(t)
	h.dispatchScript(scriptPayloadWithBlock(withRunAs("user")))
	if *calls != 1 {
		t.Fatalf("attempts = %d, want 1", *calls)
	}
	if !h.checkpointRanBeforeIPC() {
		t.Fatal("the checkpoint must precede the helper IPC handoff")
	}
}

func TestScriptCheckpointDoesNotConsumeTheScriptTimeoutBudget(t *testing.T) {
	// The checkpoint allowance must fit INSIDE the command's deadline rather
	// than eating the script's own timeoutSeconds.
	h := heartbeatWithSlowCheckpoint(t, 3*time.Second)
	res := h.dispatchScript(scriptPayloadWithBlock(withTimeoutSeconds(5)))
	if res.Status == "timeout" {
		t.Fatal("the checkpoint consumed the script's timeout budget")
	}
}
```

Software install:
```go
func TestInstallSoftwareSkipsCheckpointWhenAlreadyInstalled(t *testing.T) {
	// The pre-install detection gate returns before any mutation, so it must
	// not consume the day's one restore point.
	calls := 0
	res := installSoftwareWith(alreadyInstalledPayloadWithBlock(), countingNative(&calls))
	if calls != 0 {
		t.Fatalf("attempts = %d, want 0 for an already-installed package", calls)
	}
	if res.RestorePoint == nil {
		t.Fatal("an enabled request must still report an outcome")
	}
}

func TestInstallSoftwareSkipsCheckpointWhenValidationRejects(t *testing.T) {
	calls := 0
	installSoftwareWith(payloadWithBadChecksum(), countingNative(&calls))
	if calls != 0 {
		t.Fatalf("attempts = %d, want 0 when the checksum does not match", calls)
	}
}

func TestInstallSoftwareCheckpointsAfterDownloadAndBeforeTheInstaller(t *testing.T) {
	order := []string{}
	installSoftwareWith(validPayloadWithBlock(), recordingNative(&order))
	want := []string{"download", "checksum", "checkpoint", "installer"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
}

func TestInstallViaManagerCheckpointsBeforeTheManagerMutates(t *testing.T) {
	calls := 0
	installViaManagerWith(wingetPayloadWithBlock(), countingNative(&calls))
	if calls != 1 {
		t.Fatalf("attempts = %d, want 1", calls)
	}
}

func TestInstallSoftwareWithNoBlockTakesNoCheckpoint(t *testing.T) {
	calls := 0
	res := installSoftwareWith(validPayloadNoBlock(), countingNative(&calls))
	if calls != 0 || res.RestorePoint != nil {
		t.Fatalf("attempts = %d, RestorePoint = %+v -- a missing block means disabled", calls, res.RestorePoint)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run:
```bash
cd agent && go test -race -run 'TestScript.*Checkpoint|TestInstallSoftware|TestInstallViaManager' ./internal/heartbeat/ ./internal/remote/tools/
```
Expected: FAIL.

- [ ] **Step 3: Implement in `handlers_script.go`**

In `handleScriptInner`, after the `executor.ScriptExecution` struct is built and validated and after session selection, but **before** the executor call and **before** the `executeViaUserHelper` IPC handoff:

```go
	// #4609: after validation and session selection, immediately before the
	// first mutation. User-context scripts are checkpointed HERE, by the
	// service process, because the helper runs unelevated and could not.
	//
	// A separate context, not the script's: the checkpoint allowance must fit
	// inside the command's deadline rather than eating the script's own
	// timeoutSeconds budget.
	rpCtx, rpCancel := context.WithTimeout(h.ctx, restorePointBudget)
	rp := maybeCheckpoint(rpCtx, cmd.Payload, false, "run script "+script.ScriptID)
	rpCancel()
```

and set `res.RestorePoint = rp` on **every** return path. Do it in the `handleScript` wrapper (which already owns every exit path for redaction) rather than at the eight inner return sites — same reasoning as the existing redaction chokepoint: *a new failure path cannot silently opt out*.

Define `const restorePointBudget = 5 * time.Minute` with a comment restating that this bounds only the gate wait and verification, not the native call.

- [ ] **Step 4: Implement in `software_install.go`**

`tools` cannot import `heartbeat`, so call `systemrestore` directly. In `InstallSoftware`, after the checksum verification and **immediately before** `executeInstaller`:

```go
	// #4609: after download AND checksum, immediately before the first
	// mutation. The pre-install detection gate above returns earlier, so an
	// already-installed package never consumes the day's one restore point.
	var rp *systemrestore.Outcome
	if req, attempt := systemrestore.ParseRequest(payload, false); attempt {
		out := systemrestore.Create(context.Background(), req)
		rp = &out
	}
```

and attach `rp` to every return from that point on, including the `defer` that stamps `StartedAt` — extend that defer to also stamp `result.RestorePoint = rp` so no return path can omit it:

```go
	defer func() {
		result.StartedAt = startTime.UTC().Format(time.RFC3339Nano)
		result.RestorePoint = rp
	}()
```

(`rp` must be declared before the defer, above the early-return gates, so it is nil on those paths.)

Handle the early-return gates explicitly: when the detection gate short-circuits or validation rejects, `rp` is still nil, but an **enabled** request must report an outcome. Add, on those paths only:

```go
		if req, attempt := systemrestore.ParseRequest(payload, false); attempt {
			rp = &systemrestore.Outcome{
				Status:      systemrestore.StatusSkippedDisabled,  // see note
				RequestID:   req.RequestID,
				AttemptedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Message:     "no checkpoint taken: the command made no changes",
			}
		}
```

**Note on the status:** `skipped_disabled` is wrong for this case. Reuse `StatusSkippedDefinitions`? Also wrong. Add a tenth status in Task 7.5 (`skipped_no_mutation`) rather than overloading an existing one — the whole feature is about honest reporting, and mislabelling "we didn't need to" as "System Restore is off" would send a tech to fix the wrong thing.

- [ ] **Step 5: Implement in `software_install_manager.go`**

In `installViaManager`, after `packageID` validation and inside each `case` immediately before the manager call (`installWingetManaged` / `deps.brewEnsure`), take the checkpoint the same way. `brewEnsure` is macOS-only, so `systemrestore.Create` returns `StatusUnsupported` there with no side effects — correct and free.

- [ ] **Step 6: Run the tests and commit**

Run:
```bash
cd agent && go test -race ./internal/heartbeat/... ./internal/remote/tools/... && GOOS=windows go build ./... && go vet ./...
```
Expected: PASS.

```bash
git add agent/internal/heartbeat/handlers_script.go agent/internal/remote/tools/software_install.go \
        agent/internal/remote/tools/software_install_manager.go \
        agent/internal/heartbeat/handlers_script_restorepoint_test.go \
        agent/internal/remote/tools/software_install_restorepoint_test.go
git commit -m "feat(agent): checkpoint before script execution and software install (#4609)"
```

### Task 7.5: `skipped_no_mutation` status and the replay test

**Files:**
- Modify: `agent/internal/systemrestore/types.go`
- Modify: `apps/api/src/routes/agents/schemas.ts` (`restorePointOutcomeSchema`)
- Modify: `apps/api/migrations/` — **new** migration `2026-10-07-100200-restore-point-skipped-no-mutation.sql`
- Modify: `packages/shared/src/types/restorePoint.ts`
- Create: `agent/internal/heartbeat/restorepoint_replay_test.go`

**Interfaces:**
- Produces: `StatusSkippedNoMutation Status = "skipped_no_mutation"` plus the matching CHECK-constraint value and TS union member.

- [ ] **Step 1: Write the failing tests**

```go
func TestSkippedNoMutationIsTerminal(t *testing.T) {
	if !systemrestore.StatusSkippedNoMutation.Terminal() {
		t.Fatal("skipped_no_mutation must be terminal")
	}
}

func TestReplayedCommandProducesOneLedgerOutcomePerRequestID(t *testing.T) {
	// The agent's dedup map is in-memory and evicted after two minutes, so a
	// crash can replay both the checkpoint and the risky action. The requestId
	// is what makes the ledger row idempotent -- assert the agent reuses the
	// SAME requestId on replay rather than minting a new one.
	h, _ := heartbeatWithCheckpointCounter(t)
	payload := payloadWithBlock("req-stable", "x")
	first := h.dispatchScript(payload)
	second := h.dispatchScript(payload)
	if first.RestorePoint.RequestID != second.RestorePoint.RequestID {
		t.Fatalf("replay minted a new requestId: %q then %q",
			first.RestorePoint.RequestID, second.RestorePoint.RequestID)
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && go test -race -run 'TestSkippedNoMutation|TestReplayedCommand' ./internal/heartbeat/ ./internal/systemrestore/`
Expected: FAIL.

- [ ] **Step 3: Add the status in all four places**

Go (`types.go`):
```go
	// StatusSkippedNoMutation -- the command completed without changing
	// anything (an already-installed package, a validation rejection), so no
	// checkpoint was warranted. Deliberately NOT skipped_disabled: mislabelling
	// "we didn't need to" as "System Restore is off" would send a tech to fix
	// the wrong thing.
	StatusSkippedNoMutation Status = "skipped_no_mutation"
```
and add it to `Terminal()`.

TypeScript (`packages/shared/src/types/restorePoint.ts`): add `'skipped_no_mutation'` to `RESTORE_POINT_STATUSES`.

Zod (`schemas.ts`): add it to `restorePointOutcomeSchema`'s enum.

Postgres — a **new** migration (never edit the shipped one from W04):
```sql
-- Add 'skipped_no_mutation' to the device_restore_point_attempts status CHECK
-- (#4609 W07). Fix-forward: 2026-10-07-100100 is already shipped and its
-- content hash is immutable.
ALTER TABLE device_restore_point_attempts
  DROP CONSTRAINT IF EXISTS device_restore_point_attempts_status_chk;
ALTER TABLE device_restore_point_attempts
  ADD CONSTRAINT device_restore_point_attempts_status_chk
  CHECK (status IN (
    'requested',
    'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
    'skipped_no_mutation',
    'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed'
  ));
```
Mirror the change in the Drizzle `check(...)` in `deviceRestorePointAttempts.ts`, then run `pnpm db:check-drift`.

- [ ] **Step 4: Use it on the no-mutation paths**

Replace the placeholder `StatusSkippedDisabled` from Task 7.4 Step 4 with `StatusSkippedNoMutation` on the detection-gate and validation-rejection paths.

- [ ] **Step 5: Run everything and open the wave PR**

Run:
```bash
cd agent && go test -race ./... && GOOS=windows go build ./... && go vet ./...
cd .. && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/routes/agents/restorePointResultSchema.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceRestorePointAttemptsRls.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected: all PASS. The export-policy suite is re-run because a CHECK-constraint change touches a registered table — no column was added, so the entry is unchanged, but confirm rather than assume.

```bash
git add -A
git commit -m "feat(agent): report skipped_no_mutation and keep the requestId stable on replay (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(agent): honour the restore-point policy on all three paths (#4609 W07)" --body "Wave 07 of #4609. CUSTOMER-MACHINE CODE -- normal agent release plus the fleet-promote gate.

- \`restorePoint\` carried on both agent result transports as a dedicated top-level field.
- ONE checkpoint per command, not per patch: the shipped per-update call produced N 'successes' for at most one real point under the Windows throttle.
- Definitions-only \`install_patches\` skips and reports \`skipped_definition_only\`; an unknown category counts as risky.
- Boundary honoured on all three paths: after validation / download+checksum / no-op detection, immediately before the first mutation. A command that never mutates does not consume the day's one restore point (\`skipped_no_mutation\`).
- User-context scripts are checkpointed by the SERVICE process before the helper IPC handoff.
- Mixed-fleet contract: a missing block on \`install_patches\` means legacy best-effort enabled; on script/software it means disabled.
- The checkpoint budget is separate from the script's own \`timeoutSeconds\`.

Refs #4609"
```

- [ ] **Step 6: Verify the Windows agent job ran the new tests**

Run: `gh pr checks --watch`, then grep the Windows `test-agent` job log for `TestInstallPatchesTakesExactlyOneCheckpoint` and `TestInstallSoftwareCheckpointsAfterDownload`.
Expected: present and passing.

---

# Wave 08 — Console surfaces and the ledger read route

**Depends on W04 (table) and W06 (ingest).** All surfaces are read-only renders, so **no mutation handler is added and `runAction` does not apply**.

**Language is a hard constraint, tested.** Every string must be one of the approved forms; a test asserts no rendered string contains "rollback available".

### Task 8.1: The ledger read route

**Files:**
- Create: `apps/api/src/routes/devices/restorePoints.ts`
- Create: `apps/api/src/routes/devices/restorePoints.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts` (mount)

**Interfaces:**
- Consumes: `deviceRestorePointAttempts`.
- Produces: `GET /devices/:deviceId/restore-point-attempts?limit=&before=` returning `{ attempts: RestorePointAttemptDTO[] }` where `sequenceNumber` is a **string**.

- [ ] **Step 1: Write the failing test**

```ts
it('returns the device attempts newest first', async () => { /* … */ });

it('renders sequenceNumber as a string, never a number', async () => {
  // bigint through JSON.stringify would throw; through Number() it would
  // silently round. Both are wrong; the DTO is a string.
  await seed({ sequenceNumber: 9223372036854775807n });
  const body = await get('/devices/dev-1/restore-point-attempts');
  expect(body.attempts[0].sequenceNumber).toBe('9223372036854775807');
});

it('is scoped by RLS: another org device returns 404', async () => { /* … */ });

it('requires devices:read', async () => { /* … */ });

it('caps limit', async () => {
  const body = await get('/devices/dev-1/restore-point-attempts?limit=10000');
  expect(body.attempts.length).toBeLessThanOrEqual(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/devices/restorePoints.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement**

A standard `devices:read`-gated Hono route reading through the ambient RLS context (never `withSystemDbAccessContext` — this is a request path). Map `sequenceNumber` with `row.sequenceNumber?.toString() ?? null`, default `limit` 50, cap 200, keyset-paginate on `requestedAt`.

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/routes/devices/restorePoints.test.ts`
Expected: PASS.
```bash
git add apps/api/src/routes/devices/restorePoints.ts apps/api/src/routes/devices/restorePoints.test.ts apps/api/src/routes/devices/index.ts
git commit -m "feat(api): device restore-point attempts read route (#4609)"
```

### Task 8.2: The shared badge with the constrained copy

**Files:**
- Create: `apps/web/src/components/restorePoints/RestorePointBadge.tsx`
- Create: `apps/web/src/components/restorePoints/RestorePointBadge.test.tsx`

**Interfaces:**
- Consumes: `RestorePointOutcome`, `RestorePointStatus` (`@breeze/shared`).
- Produces: `<RestorePointBadge outcome={…} />` — the **single** renderer for every status. Three pages import it; none writes its own copy.

- [ ] **Step 1: Write the failing test**

```tsx
const CASES: Array<[RestorePointStatus, RegExp]> = [
  ['created', /restore point creation confirmed/i],
  ['existing_accepted', /existing point reused/i],
  ['skipped_disabled', /system restore is turned off/i],
  ['skipped_definition_only', /definitions[- ]only/i],
  ['skipped_no_mutation', /no changes were made/i],
  ['unsupported', /not available on this device/i],
  ['busy', /a backup was using/i],
  ['insufficient_privileges', /not enough privileges/i],
  ['verification_failed', /could not be verified/i],
  ['failed', /failed/i],
];

it.each(CASES)('renders %s with its approved copy', (status, pattern) => {
  render(<RestorePointBadge outcome={outcome({ status })} />);
  expect(screen.getByTestId('restore-point-badge').textContent).toMatch(pattern);
});

it('never renders a recoverability promise, for any status', () => {
  for (const [status] of CASES) {
    const { container, unmount } = render(<RestorePointBadge outcome={outcome({ status })} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('rollback available');
    expect(text).not.toContain('you can roll back');
    expect(text).not.toContain('backup');   // 'a backup was using' is on the busy path only
    unmount();
  }
});

it('renders existing_accepted as NEUTRAL, naming the age and the Windows limit', () => {
  // Open Decision 6: the throttle is Microsoft's protection against
  // shadow-storage thrash and Breeze never overrides it, so a reused point is
  // usually the answer the tech wanted -- not a failure.
  render(<RestorePointBadge outcome={outcome({ status: 'existing_accepted', existingPointAgeMinutes: 240, frequencyMinutes: 1440 })} />);
  const text = screen.getByTestId('restore-point-badge').textContent ?? '';
  expect(text).toMatch(/4h ago/);
  expect(text).toMatch(/every 24h/);
  expect(screen.getByTestId('restore-point-badge').className).not.toMatch(/red|destructive/);
});

it('renders nothing when there is no outcome', () => {
  const { container } = render(<RestorePointBadge outcome={undefined} />);
  expect(container.firstChild).toBeNull();
});

it('shows the requested state as pending rather than as success', () => {
  render(<RestorePointBadge outcome={outcome({ status: 'requested' })} />);
  expect(screen.getByTestId('restore-point-badge').textContent).toMatch(/awaiting the device/i);
});
```

The `'backup'` assertion needs care — adjust the `busy` copy if it collides. Prefer: *"Skipped — the volume snapshot service was in use"*.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/restorePoints/RestorePointBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A `Record<RestorePointStatus, { tone: 'neutral' | 'positive' | 'warning' | 'danger'; text: (o: RestorePointOutcome) => string }>` map, rendered as one badge. The approved copy:

| Status | Tone | Copy |
|---|---|---|
| `requested` | neutral | *Awaiting the device* |
| `created` | positive | *Restore point creation confirmed HH:MM* |
| `existing_accepted` | **neutral** | *Existing point reused — created 4h ago (Windows limit: every 24h)* |
| `skipped_disabled` | warning | *Skipped — System Restore is turned off on this device* |
| `skipped_definition_only` | neutral | *Skipped — definitions-only update* |
| `skipped_no_mutation` | neutral | *Skipped — no changes were made* |
| `unsupported` | neutral | *Not available on this device* |
| `busy` | warning | *Skipped — the volume snapshot service was in use* |
| `insufficient_privileges` | warning | *Skipped — not enough privileges* |
| `verification_failed` | warning | *Could not be verified* |
| `failed` | danger | *Failed — {message}* |

- [ ] **Step 4: Run and commit**

Run: `cd apps/web && npx vitest run src/components/restorePoints/RestorePointBadge.test.tsx`
Expected: PASS.
```bash
git add apps/web/src/components/restorePoints/
git commit -m "feat(web): shared restore-point badge with constrained copy (#4609)"
```

### Task 8.3: Inline badges on the three action pages

**Files:**
- Modify: `apps/web/src/components/scripts/ExecutionDetails.tsx`
- Modify: `apps/web/src/components/software/DeploymentProgress.tsx`
- Modify: `apps/web/src/components/patches/PatchInstallHistory.tsx`
- Modify: each file's existing `*.test.tsx`

**Interfaces:**
- Consumes: `RestorePointBadge`; the `restorePoint` field now present on stored command results.
- Produces: nothing importable.

**Render it the way `rebootRequired` is rendered today** (`PatchInstallHistory.tsx:574` is the model): a small inline block under the result summary, present only when the data is present.

- [ ] **Step 1: Write the failing tests**

One per page:
```tsx
it('renders the restore-point badge when the result carries an outcome', () => {
  render(<ExecutionDetails execution={{ ...base, result: { restorePoint: { status: 'created', requestId: 'r', attemptedAt: '2026-09-02T14:03:00Z', durationMs: 900 } } }} />);
  expect(screen.getByTestId('restore-point-badge')).toBeTruthy();
});

it('renders nothing when the agent returned no outcome (pre-#4609 agent)', () => {
  render(<ExecutionDetails execution={{ ...base, result: {} }} />);
  expect(screen.queryByTestId('restore-point-badge')).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run src/components/scripts/ExecutionDetails src/components/software/DeploymentProgress src/components/patches/PatchInstallHistory`
Expected: FAIL.

- [ ] **Step 3: Implement and re-run**

Run: same command.
Expected: PASS; check the reported file count covers all dotted siblings of the three test files.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/scripts/ apps/web/src/components/software/ apps/web/src/components/patches/
git commit -m "feat(web): show the restore-point outcome on script, software, and patch results (#4609)"
```

### Task 8.4: Device-detail attempts list and the capability signal

**Files:**
- Create: `apps/web/src/components/devices/DeviceRestorePointAttempts.tsx`
- Create: `apps/web/src/components/devices/DeviceRestorePointAttempts.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (tab)

**Interfaces:**
- Consumes: `GET /devices/:id/restore-point-attempts` (Task 8.1), `RestorePointBadge` (Task 8.2).
- Produces: a "System Restore attempts" list.

Use `window.location.hash` for the selected tab, never a query param — the repo-wide convention (`DeviceDetails.tsx`, `OrganizationsPage.tsx`).

- [ ] **Step 1: Write the failing test**

```tsx
it('lists attempts newest first with their trigger and badge', async () => { /* … */ });

it('renders an explicit empty state rather than an empty table', async () => {
  mockAttempts([]);
  render(<DeviceRestorePointAttempts deviceId="dev-1" />);
  expect(await screen.findByTestId('restore-point-attempts-empty')).toBeTruthy();
});

it('says plainly that System Restore is not a backup', async () => {
  render(<DeviceRestorePointAttempts deviceId="dev-1" />);
  expect((await screen.findByTestId('restore-point-attempts-disclaimer')).textContent?.toLowerCase())
    .toContain('not a backup');
});

it('shows a stuck requested row as pending, not as success', async () => {
  mockAttempts([{ status: 'requested', requestedAt: '2026-09-01T00:00:00Z', trigger: 'script' }]);
  render(<DeviceRestorePointAttempts deviceId="dev-1" />);
  expect((await screen.findByTestId('restore-point-badge')).textContent).toMatch(/awaiting the device/i);
});
```

- [ ] **Step 2: Run it, implement, re-run**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceRestorePointAttempts.test.tsx`
Expected: FAIL, then PASS.

- [ ] **Step 3: Add the capability signal to the device inventory**

The device carries a timestamped `system_restore_capability` inventory field: `available | disabled | unsupported | unknown`, plus `system_restore_capability_at`. It drives fleet visibility and the "explicit disable is unenforceable" warning on the policy tab.

**It is advisory only. The agent's runtime outcome stays authoritative** — inventory goes stale, and a tech acting on a stale "available" would be misled.

Scope this as its own migration + Drizzle column + agent inventory field + UI chip. Because it adds **columns to `devices`**, which is in `CORE_ORG_CASCADE_DELETE_ORDER`, the `CORE_TENANT_EXPORT_POLICY` entry for `devices` **must be updated in the same PR** — this is the one registration that fires on a new column, not just a new table. Both new columns are plain enums/timestamps and belong in `included`.

Run afterwards:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: PASS. **These are the suites that fail on a forgotten column, and they only run under Integration Tests.**

- [ ] **Step 4: Lint, typecheck, commit, open the PR**

Run:
```bash
pnpm lint && (cd apps/web && npx tsc --noEmit)
```
Expected: clean.

```bash
git add -A apps/web apps/api
git commit -m "feat(web): device System Restore attempts list and capability signal (#4609)"
git push -u origin <branch>
gh pr create --base main --title "feat(web): surface restore-point outcomes in the console (#4609 W08)" --body "Wave 08 of #4609. Read-only renders; no mutation handler, so \`runAction\` does not apply.

- \`GET /devices/:id/restore-point-attempts\` (\`devices:read\`, RLS-scoped, \`sequenceNumber\` as a STRING).
- One shared \`RestorePointBadge\` owns the copy for all eleven statuses; a test asserts no rendered string promises recoverability.
- \`existing_accepted\` renders NEUTRAL, naming the existing point's age and the Windows limit -- usually the answer the tech actually wanted.
- Inline badges on script execution, software deployment, and patch install history, rendered the way \`rebootRequired\` already is.
- Device-detail attempts list + an advisory \`system_restore_capability\` inventory signal (the agent's runtime outcome stays authoritative).
- Adding the two \`devices\` columns required updating \`CORE_TENANT_EXPORT_POLICY\` in this same PR.

Refs #4609"
```

---

# Wave 09 — Docs, support matrix, release notes

**Depends on W07 and W08.** Documentation only.

### Task 9.1: Feature documentation

**Files:**
- Modify: `apps/docs/src/content/docs/features/configuration-policies.mdx`
- Modify: `apps/docs/src/content/docs/features/patch-management.mdx`
- Modify: `apps/docs/src/content/docs/features/scripts.mdx`
- Modify: `apps/docs/src/content/docs/features/software-policies.mdx`

- [ ] **Step 1: Write the configuration-policies section**

A "System Protection" section covering the three toggles, the partner-wide "All orgs" option, and — stated plainly, not in a footnote:

> System Restore protects system files, the registry, installed programs and settings. **It is not a backup and does not protect personal files.** Windows limits restore-point creation to once every 24 hours by default, so a second action within that window reuses the existing point rather than creating a new one — Breeze reports this as *"Existing point reused"* and never as a new checkpoint. A created restore point can later be removed by Windows under storage pressure, or become unusable. Breeze reports what happened at the moment of each action; it does not promise that a rollback will succeed later.

Document each of the eleven statuses with what a tech should do about it. `skipped_disabled` gets the explicit note that **Breeze will not turn System Restore on for you** and links to a remediation script.

- [ ] **Step 2: Add the cross-references**

One short section on each of the patch-management, scripts, and software-policies pages, pointing at the configuration-policies section rather than restating it.

- [ ] **Step 3: Add the support matrix**

From the W01 Task 1.2 hardware results: OS/build, whether the provider was present, whether creation succeeded, and any Server-specific caveat. **Documentation only — Breeze never gates by SKU** (Open Decision 4). State that explicitly so a reader does not infer a gate from the table.

- [ ] **Step 4: Verify the docs build and commit**

Run: `pnpm --filter @breeze/docs build`
Expected: clean.
```bash
git add apps/docs/
git commit -m "docs: System Restore checkpoint policy (#4609)"
```

### Task 9.2: Release notes and the follow-up issue

- [ ] **Step 1: Add the release-notes entry**

Call out the patching-default decision explicitly so self-hosters can tell whether behaviour changed for them:

> **Windows System Restore checkpoints are now policy-controlled.** Patch installs continue to attempt a checkpoint by default, exactly as before, so nothing changes unless you configure the new **System Protection** tab. Scripts and software installs take no checkpoint until you opt in. Every attempt is now reported per action, including when Windows reused an existing point instead of creating a new one.

If the W01 hardware verdict was that the shipped layout was wrong, add:

> This release also corrects the native Windows call Breeze used to create restore points. On affected builds, checkpoints requested before patch installs may not have been created; they are now created and verified.

- [ ] **Step 2: File the follow-ups**

Three issues, each linking back to #4609:

1. **Out-of-process restore-point helper** (Open Decision 3 → B, deferred). `windows.Proc.Call` cannot be cancelled by a context, so the in-process call has no real timeout and inherits whatever COM security the agent process already set. A helper process would own `CoInitializeSecurity` and give a genuinely killable boundary. Note the constraint that it must not repeat the `WaitDelay` hang class.
2. **v2 strict modes** (Open Decision 2 → B). Per-action `off | best_effort | require_recent`, where `require_recent` takes `maxExistingPointAgeMinutes` and aborts on unsupported / disabled / failed / busy / timed-out / unverified / stale-inventory / unsupported-agent. Gate it on v1 telemetry: how often would abort actually have fired?
3. **Retention/prune job for `device_restore_point_attempts`.** Rows still `requested` past their command's deadline are orphans (the `device_restore_point_attempts_pending_idx` partial index exists for exactly this); terminal rows need an age-based prune consistent with the other agent-telemetry pruners.

- [ ] **Step 3: Post the completion comment on #4609**

Summarise: what shipped, the hardware verdict from W01, the statuses a tech will actually see, and the three follow-ups. If the verdict was that the shipped layout was wrong, say so plainly — the issue's framing ("we already do this for patching") was incorrect and the prospect answer changes.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a wave:

| Spec section | Wave |
|---|---|
| Advisor-quorum ABI finding / Open Decision 1 | W01 |
| §3 `agent/internal/systemrestore`, identity verification, VSS gate, privileges, non-Windows no-op | W02 |
| §1 policy feature type, inline settings, resolver, registration table, editor tab | W03 |
| §4 attempt ledger, six registration lists, RLS shape 1 | W04 |
| §2 versioned request block, three creation sites, scheduled work, staleness, resolution errors | W05 |
| §4 transport (four API touch points), both stored-result builders, ingest after the terminal CAS | W06 |
| §3 checkpoint boundary, one-per-command, definitions-only skip, agent transport | W07 |
| §5 console: policy tab (W03), inline badges, device list, capability signal | W03 + W08 |
| Test & rollout notes | distributed; hardware tests in W01, contract suites in W04, fan-out in W04/W05 |
| Open Decisions 2–6 | encoded as Global Constraints 3–6 and enforced by tests |

**Known deviations from the spec, and why:**
- The spec's `Outcome` has nine statuses; this plan ships **eleven** (`requested`, server-only; `skipped_no_mutation`, added in W07 Task 7.5). Overloading `skipped_disabled` for "the command made no changes" would send a tech to fix the wrong thing.
- Open Decision 3 resolved *"B for correctness, A only if the wave budget forces it"*. This plan ships **A**, and W02 Task 2.5 states the unbounded-call caveat in the code's own doc comment rather than claiming a timeout it does not have. The helper process is filed as follow-up 1.
- The spec's partner-wide fan-out integration test (CLAUDE.md step 5) is covered by W05's resolver tests plus W04's RLS suite rather than a dedicated `*PartnerRls.integration.test.ts`, because **no new dual-axis table is created** — the dual-axis surface is the existing `configuration_policies`, already registered in `DUAL_AXIS_TENANT_TABLES` and already covered. Add the partner-wide fan-out assertion to W05's test file: *a partner-wide policy with `beforeScripts: true` and no org-level policy makes a script enqueued for a device in any of that partner's orgs carry a stamped block.*

**Placeholder scan:** no TBD/TODO; every code step carries real code; every test step names a command and its expected output; the two "copy the scaffolding from the sibling file" instructions name the exact sibling.

**Type consistency:** `systemrestore.Status` / `Outcome` / `Request` (Go) ↔ `RestorePointStatus` / `RestorePointOutcome` / `RestorePointRequestBlock` (TS) ↔ `device_restore_point_attempts.status` CHECK values — all three enumerate the same set, and W07 Task 7.5 updates all four representations together. `sequenceNumber` is `int64` in Go, a decimal `string` on the wire and in the DTO, and `bigint` in Postgres, asserted at each boundary.
