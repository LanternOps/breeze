---
issue: LanternOps/breeze#8258
spec: none (issue-scoped; the Open Decisions section is the design record)
status: draft
date: 2026-10-12
area: agent / api / heartbeat
---

# Heartbeat "Retain Current State" Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the API tell an agent "I made no decision about PAM / helper / remote-management this beat — keep what you have", so a failed or invisible policy read can never switch enforcement off, while agents that do not speak the protocol keep today's behaviour byte-for-byte.

**Architecture:** A new additive response field `retainState` (a list of feature names with no decision this beat) plus a new `securityCapabilities.retainStateProtocolVersion` the agent advertises. The agent honours `retainState` whenever it is present (only a new API ever sends it). The API sends it only to a beat that advertised version 1, and only for features whose decision is genuinely missing. Absence of `retainState` means exactly what it means today. No schema/migration change.

**Tech Stack:** Go agent (`agent/internal/heartbeat`), Hono/TypeScript API (`apps/api/src/routes/agents`), Vitest, Go `testing` with `-race`, real-Postgres integration suite.

## Findings that shape the plan (verified on `origin/main` 7773695ee7)

1. **PAM is the real defect; the helper half is latent.**
   - PAM: on any resolver failure or invisible device the API sends `uacInterceptionEnabled: false` explicitly (`routes/agents/heartbeat.ts`, response assembly: `pamSettings?.uacInterceptionEnabled ?? false`). `handleUACInterception(enabled *bool)` (`agent/internal/heartbeat/heartbeat.go`, ~5491) treats `nil` **and** `false` identically: it swaps the flag off **and runs `pamLifetimeManager.SetEnabled(ctx, false)` cleanup**. Re-enabling later requires `pamReconciled` + `pamVerificationAvailable` + a successful `SetEnabled(true)`. So one bad beat is a real enforcement downgrade, not a flag blip.
   - The API comment at the drain branch (`heartbeat.ts` ~461: "`uacInterceptionEnabled` is a `*bool` and handles absence correctly") is **wrong for retention**: absence means *disable + cleanup*, not *keep*. The pointer only distinguishes "server never spoke" from "server said true"; both non-true values disable.
   - Helper: `helperEnabled` is a plain bool and is zeroed on a null decision, **but `Heartbeat.IsHelperEnabled()` has no caller** (grep: definition only). The enforcement path is `HelperSettings *HelperSettings`; `helperSettings: undefined` is omitted, so `processHeartbeatResponse` skips `helperMgr.Apply` and `SetModeOverride`, i.e. helper install/lifecycle **is already retained today**. What flaps today is only the write-only flag and a misleading "helper chat disabled" log line. The plan still fixes it (one encoding, and the flag is a trap for the next reader) but does not claim a customer-visible helper outage.
   - Remote management: `manageRemoteManagement` is a plain bool, sent as `x || undefined`. A thrown `resolveRemoteAccessForDevice` (caught with `console.error` only, no Sentry, in the org-scoped block, ~2096-2108) leaves it `false`, and `tunnel.Manager.SetManagedByPolicy(false)` runs. Same class of bug, third instance.
2. **Where the "no decision" cases arise (API), and what each emits today:**

   | Case | Where | Today (to legacy and new agents alike) |
   |---|---|---|
   | Device not visible to its own org context mid-beat (`hierarchyOutcome === 'missing'`: absent / org mismatch / partner mismatch) | policy context, early `return` before any builder | `uac:false`, `helperEnabled:false`, no `helperSettings` |
   | Policy-context setup/COMMIT failure (outer `catch`) | after `withDbAccessContext` | values written before the failure are kept, the rest stay `null` → false |
   | `buildHelperConfigUpdate` throws (policy resolution or org-flag read; never cached) | helper block | `helperEnabled:false`, no `helperSettings` |
   | `buildPamConfigUpdate` throws, incl. `orgPamFallbackCache` fill failure, or an earlier statement aborted the context's transaction so the savepoint fails | pam block | `uac:false` |
   | `resolveRemoteAccessForDevice` throws | org-scoped block | `manageRemoteManagement` absent → false |
   | Uninstall-drain branch (`agent.deviceUninstallDraining`) | early return | payload omitted → `helperEnabled`/`manageRemoteManagement` false, PAM off |
   | Watchdog-role branch | early return | response consumed by the watchdog, not the main agent; out of scope |

   **Resolvers that default instead of throwing (verified in the quorum pass; narrow).** If the hierarchy load *errors* (`hierarchyOutcome === 'error'`) each resolver re-reads on its own, and for a device that has become invisible `resolveDevicePamSettings` returns `PAM_DEFAULTS` (`routes/agents/helpers.ts` ~3337), `resolveDeviceHelperSettings` returns `null` and falls through to the org flag (`services/helperSettings.ts` ~133, ~253) whose invisible-org result is `{enabled:false}`, and a `null` effective config makes `resolveRemoteAccessForDevice` return defaults (`services/remoteAccessPolicy.ts` ~255-291). These look like decisions but are not. Rule for W2: **a PAM/helper decision is trusted only when `hierarchyOutcome === 'loaded'`**; otherwise PAM and helper are both `retain` (safe direction; costs freshness only on a beat whose hierarchy read failed). For remote management, `resolveRemoteAccessForDevice` gains an additive `resolved: boolean` (false when the effective config was `null`), and only `resolved === true` counts as a decision.

Not "no decision": a Redis cache **hit** (`readCachedHelperSettings`, per-device PAM key, per-org `orgHelperSettingsCache`/`orgPamFallbackCache`). Those hold values that were produced by a *successful* resolution (builders throw before caching; `DeferredCacheFills` flushes only after a real COMMIT) and expire in ≤120 s. A hit is a decision; a fill that fails throws and becomes RETAIN. The retain decision is derived from "did the resolver return a value", never from where the value came from.
3. **Capability mechanism.** `securityCapabilities` keys are parsed tolerantly in `routes/agents/schemas.ts` (`z.number().int().optional().catch(undefined)`) and normalised by exported `normalizeXProtocolVersion` helpers in `heartbeat.ts`. Most are persisted non-sticky as device columns; `desktopWsFenceProtocolVersion` is precedent for **parse-only, no column**. The agent declares them in `compiledSecurityCapabilities()` (`heartbeat.go` ~8152) with a `*_capability_test.go` pinning the JSON key. This plan needs same-beat truth only, so it follows the parse-only precedent: **no migration, no new column, no cascade/export/org-move registration, no new RLS surface.**
4. **State across agent restart.** `helperEnabled` and `uacInterceptionEnabled` are in-memory atomics defaulting to `false`; helper install state lives on disk (the manager is idempotent), the PAM lifetime ledger persists lifecycle but not the enable flag. So "retain" after restart means *stay at the boot default* (PAM off, no helper change) until the first beat that carries a real decision. That matches today's boot behaviour and never enables anything unverified.
5. **Response decode hazard.** `HeartbeatResponse` is decoded with `json.NewDecoder(...).Decode`. A typed `[]string` field would fail the **whole** response decode on a non-string element and drop the beat's commands. The new field must use a tolerant type whose `UnmarshalJSON` never errors.

## Wire design

Response (new API → new agent), only when the beat advertised `securityCapabilities.retainStateProtocolVersion` exactly `1`:

```json
{ "retainState": ["pam", "helper", "remoteManagement"], "commands": [], "...": "..." }
```

- Names are a closed set: `pam`, `helper`, `remoteManagement`. The API emits a feature name only when it has **no decision** for it, and in that case **omits that feature's legacy keys** (`uacInterceptionEnabled`; `helperEnabled` + `helperSettings`; `manageRemoteManagement`). The agent also ignores a retained feature's legacy keys if both arrive (retain wins).
- A decided "off" is still sent explicitly as today (`uacInterceptionEnabled:false`, `helperSettings:{enabled:false,...}`) and is **not** in the list. Representability of "explicit false vs absent" is therefore never needed on a plain Go bool: the list carries the third state.
- Agent bounds: only a JSON array is read (token-streamed, stopping after 16 entries, so parse work is bounded by the cap; the whole response body is already decoded in memory by the existing decoder, so this bounds semantics and CPU, not allocation); each entry a string ≤ 32 bytes; unknown names ignored; any other shape → empty set (= today's semantics). Never panics, never errors the decode.

### Protocol-compat matrix

| Agent \ API | Old API (no `retainState`) | New API |
|---|---|---|
| **Old agent** (no capability, ignores unknown field) | Today. Failure beats send explicit `uac:false`, `helperEnabled:false`, `manageRemoteManagement` absent. | Capability absent or not exactly 1 → API sends **the identical legacy shape**, including on failure. Residual risk remains for un-upgraded agents (see OD7); omitting keys does **not** help them because absent PAM also means "disable + cleanup". |
| **New agent** (advertises v1) | Agent never sees `retainState`, so nothing changes: absent legacy keys mean what they mean today. The agent never infers "retain" from absence. | Failure beats carry `retainState`; agent keeps current helper/PAM/remote-management state for the named features; decided features apply as normal. |

Other cases:
- **Rollback of the agent** (new → old build): old build stops advertising; the very next beat is served the legacy shape (capability is same-beat truth, never sticky or stored). The old build ignores `retainState` as an unknown JSON field.
- **API rollback / mid-deploy skew:** each beat is self-contained — the API reads the capability from the request it is answering. A rolling deploy mixes old and new API instances; a new agent just sees `retainState` on some beats and not others. No stored state to go stale.
- **Agent restarts mid-retain:** boot defaults apply (finding 4).
- **Known residual (skew/rollback/kill switch):** a protocol-aware agent is protected only by the API instance that answers its beat. During a rolling API deploy, after an API rollback, or with the kill switch on, a failing *old* instance (or the legacy path) still sends `uac:false`, which disables PAM and runs cleanup even though a prior beat retained it. The exposure window is bounded by the deploy/rollback duration and the failing-resolver condition; it is not removable without the agent inferring retention itself, which this plan rejects (it would change legacy semantics).
- **Kill switch:** `HEARTBEAT_RETAIN_STATE_ENABLED=false` makes the API behave as an old API for all agents (default on).

## File Structure

- Modify `agent/internal/heartbeat/heartbeat.go`: `HeartbeatResponse.RetainState`, `SecurityCapabilities.RetainStateProtocolVersion`, `compiledSecurityCapabilities()`, `processHeartbeatResponse` apply sites.
- Create `agent/internal/heartbeat/retain_state.go`: tolerant `RetainState` type + `UnmarshalJSON`, `retainStateProtocolVersion` const, streak tracker. (Keeps `heartbeat.go`, already >8k lines, from growing.)
- Create `agent/internal/heartbeat/retain_state_test.go`, `retain_state_capability_test.go`.
- Modify `apps/api/src/routes/agents/schemas.ts` (capability key), `heartbeat.ts` (normaliser, call site), Create `apps/api/src/routes/agents/heartbeatSettingsDecision.ts` (pure builder of the legacy-or-retain fields) and its test.
- Create `apps/api/src/__tests__/integration/heartbeatRetainState.integration.test.ts`.
- Modify tests: `apps/api/src/routes/agents/heartbeat.test.ts`, `schemas.heartbeatTolerance.test.ts`.
- Correct the misleading comment in `heartbeat.ts` (drain branch) and the `handleUACInterception` doc comment.

## Global Constraints

- **High blast radius (ships to customer machines + PAM enforcement).** Full rigor: red-first tests, one independent review round, `go test -race`.
- Wave PRs are **sequential off `main`**, never stacked: `ci.yml` triggers only on PRs to `main`, so a stacked PR gets no CI. If a stack is unavoidable, dispatch `gh workflow run CI --ref <branch>` per branch.
- No new statement or transaction is added to the heartbeat path; `agentHotPathQueryBudget.integration.test.ts` budgets must stay green unchanged (it is the check that this holds).
- Test commands carry no `--` before flags: `cd apps/api && npx vitest run <files>`, `cd agent && go test -race ./internal/heartbeat/... ./internal/helper/...`.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code; never pipe to `tail`.
- No migration is added. Newest committed migration is `2026-12-23-100000-tier1-sweep-indexes.sql`; if a later task discovers a column is needed, use slot `2026-12-23-210000-<slug>.sql` after re-checking `git ls-tree origin/main apps/api/migrations/`, and add the export-policy classification (`CORE_TENANT_EXPORT_POLICY`; jsonb ⇒ `excludedOpen`), enforced only by the **Integration Tests** job.
- Public repo: no hostnames, IPs, customer names in code, tests or PR text.

## Review Focus

- A response with `retainState` malformed (object, number, mixed array, 10k entries, nested) must neither fail the decode nor retain anything unintended.
- A decided `uacInterceptionEnabled:false` (admin disabled PAM) must still turn PAM off for a protocol-aware agent — retain must not swallow explicit off.
- `retainState` containing `pam` **and** a stray `uacInterceptionEnabled:true` must not enable PAM (retain wins).
- First beat after agent boot with `retainState:["pam"]` must leave PAM off (the same idempotent disable that runs today) and never enable; an off state with unfinished disable cleanup keeps retrying it.
- Capability value `2`, `"1"`, `true`, `-1` from a beat must be treated as 0 (legacy shape).
- Policy context that fails *after* PAM succeeded must still send PAM's decision and retain only what is missing.
- A long retain streak must be visible (log) and must not silently freeze a stale policy forever.

---

## Wave 1 — Agent understands the signal (API unchanged)

**Mergeable alone:** yes. Old API never sends `retainState`; the agent behaves identically. The new capability key is an unknown field to the current API schema (zod object strips/ignores it; the tolerant `.catch` keys are for known keys) — verified by Task 1.3.
**If W2 never ships:** agents advertise a capability nobody uses and carry ~80 lines of dormant parsing. No behaviour change, no risk. Safe resting state.

### Task 1.1: Tolerant `RetainState` type

**Files:**
- Create: `agent/internal/heartbeat/retain_state.go`
- Test: `agent/internal/heartbeat/retain_state_test.go`

**Interfaces:**
- Produces: `type RetainState struct{ PAM, Helper, RemoteManagement bool }`; `func (r *RetainState) UnmarshalJSON([]byte) error` (always returns nil); `const retainStateProtocolVersion = 1`.

- [ ] **Step 1: Write the failing test**

```go
package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeRetain(t *testing.T, raw string) RetainState {
	t.Helper()
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[],"retainState":`+raw+`}`), &resp); err != nil {
		t.Fatalf("response decode must never fail on retainState %s: %v", raw, err)
	}
	return resp.RetainState
}

func TestRetainStateDecode(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want RetainState
	}{
		{"all", `["pam","helper","remoteManagement"]`, RetainState{true, true, true}},
		{"pam only", `["pam"]`, RetainState{PAM: true}},
		{"unknown names ignored", `["pam","futureThing"]`, RetainState{PAM: true}},
		{"mixed scalars keep valid strings", `["helper",7,null,"pam"]`, RetainState{Helper: true, PAM: true}},
		{"nested value stops parsing", `["helper",{"a":1},"pam"]`, RetainState{Helper: true}},
		{"object is empty", `{"pam":true}`, RetainState{}},
		{"number is empty", `3`, RetainState{}},
		{"string is empty", `"pam"`, RetainState{}},
		{"null is empty", `null`, RetainState{}},
		{"case sensitive", `["PAM"]`, RetainState{}},
		{"oversized entry ignored", `["` + strings.Repeat("a", 4096) + `"]`, RetainState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeRetain(t, tc.raw); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func TestRetainStateDecodeBoundsEntries(t *testing.T) {
	// 10k entries with "pam" past the bound must not be honoured.
	raw := "[" + strings.Repeat(`"x",`, 5000) + `"pam"]`
	if got := decodeRetain(t, raw); got.PAM {
		t.Fatal("entries beyond the cap must be ignored")
	}
}

func TestRetainStateAbsentIsZero(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RetainState != (RetainState{}) {
		t.Fatalf("absent retainState must be the zero value, got %+v", resp.RetainState)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestRetainState' -count=1`
Expected: FAIL to compile (`RetainState` undefined).

- [ ] **Step 3: Implement**

```go
package heartbeat

import (
	"bytes"
	"encoding/json"
)

// retainStateProtocolVersion is declared in securityCapabilities. Version 1:
// the build honours HeartbeatResponse.RetainState (#8258).
const retainStateProtocolVersion = 1

const (
	retainStateMaxEntries = 16
	retainStateMaxNameLen = 32
)

// RetainState names the features the server made NO decision about this beat.
// For each, the agent keeps its current state instead of treating the
// missing legacy key as "off" (#8258). The zero value means "no feature
// retained", which is exactly the pre-protocol behaviour.
type RetainState struct {
	PAM              bool
	Helper           bool
	RemoteManagement bool
}

// UnmarshalJSON never returns an error: this field rides on the heartbeat
// response, and a decode failure would drop the beat's commands and upgrade
// instructions. Anything that is not an array of strings degrades to "retain
// nothing" (legacy semantics); unknown names, oversized names and entries
// beyond retainStateMaxEntries are ignored.
func (r *RetainState) UnmarshalJSON(data []byte) error {
	*r = RetainState{}
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil // not an array: retain nothing
	}
	// Stream tokens and stop after retainStateMaxEntries, so parse work is
	// bounded by the cap rather than by the array length. A nested value
	// (object/array) ends parsing: it is not a list of names.
	for i := 0; i < retainStateMaxEntries && dec.More(); i++ {
		tok, err := dec.Token()
		if err != nil {
			return nil
		}
		if _, nested := tok.(json.Delim); nested {
			return nil
		}
		name, ok := tok.(string)
		if !ok || len(name) > retainStateMaxNameLen {
			continue
		}
		switch name {
		case "pam":
			r.PAM = true
		case "helper":
			r.Helper = true
		case "remoteManagement":
			r.RemoteManagement = true
		}
	}
	return nil
}
```

Add to `HeartbeatResponse` (after `ManageRemoteManagement`):

```go
	// RetainState (#8258) lists features the server made no decision about this
	// beat; see retain_state.go. Absent = today's semantics.
	RetainState RetainState `json:"retainState,omitempty"`
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestRetainState' -count=1`
Expected: PASS. Mutation check: change the cap to 100000 and confirm `TestRetainStateDecodeBoundsEntries` goes red, then revert.

- [ ] **Step 5: Commit** — `git add agent/internal/heartbeat/retain_state*.go agent/internal/heartbeat/heartbeat.go && git commit -m "feat(agent): tolerant retainState response field (#8258)"` (+ Co-Authored-By footer).

### Task 1.2: Honour `RetainState` in `processHeartbeatResponse`

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`processHeartbeatResponse`, ~5244; PAM call ~5262; remote-management/helper block ~5439-5460; doc comment on `handleUACInterception` ~5487)
- Test: `agent/internal/heartbeat/retain_state_test.go`

**Interfaces:**
- Consumes: `RetainState` (Task 1.1), existing `boolPtr`, `newTestHeartbeat*` helpers (`uac_interception_test.go`, `handlers_actuate_test.go:1009`).
- Produces: `func (h *Heartbeat) applySettingsDecisions(resp *HeartbeatResponse)` extracted so it is unit-testable without the whole response pipeline. Order is preserved: PAM stays before command admission; helper/remote-management stay where they are.

- [ ] **Step 1: Write the failing tests** (use the same PAM test heartbeat constructor as `uac_interception_test.go`; read it first and copy its setup for an enabled-then-observe sequence)

```go
func TestRetainStatePAMKeepsEnabledState(t *testing.T) {
	h := newPamEnabledTestHeartbeat(t) // see uac_interception_test.go: enable via handleUACInterception(boolPtr(true))
	h.handleUACInterception(boolPtr(true))
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("precondition: PAM enabled")
	}
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}})
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("retain must keep PAM enabled; today an absent value disables it")
	}
}

func TestRetainStatePAMIgnoresStrayLegacyTrue(t *testing.T) {
	h := newPamEnabledTestHeartbeat(t)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}, UacInterceptionEnabled: boolPtr(true)})
	if h.IsUACInterceptionEnabled() {
		t.Fatal("retain wins: a retained feature's legacy value must be ignored")
	}
}

func TestRetainStatePAMExplicitFalseStillDisables(t *testing.T) {
	h := newPamEnabledTestHeartbeat(t)
	h.handleUACInterception(boolPtr(true))
	h.applySettingsDecisions(&HeartbeatResponse{UacInterceptionEnabled: boolPtr(false)}) // PAM not in RetainState
	if h.IsUACInterceptionEnabled() {
		t.Fatal("a decided false must still disable PAM")
	}
}

func TestRetainStatePAMWhileOffKeepsRetryingDisableNeverEnables(t *testing.T) {
	// Boot state / failed-cleanup state: PAM is off. Retain must keep the
	// idempotent disable (cleanup retry) running and must never call
	// SetEnabled(true).
	h, mgr := newPamTestHeartbeatWithRecordingManager(t) // fake pamlifetime.Manager recording SetEnabled(arg)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}, UacInterceptionEnabled: boolPtr(true)})
	if mgr.enableCalls != 0 {
		t.Fatalf("retain must never enable, got %d SetEnabled(true)", mgr.enableCalls)
	}
	if mgr.disableCalls == 0 {
		t.Fatal("while off, retain must keep the disable/cleanup path running (same as an absent value today)")
	}
	if h.IsUACInterceptionEnabled() {
		t.Fatal("boot default stays off")
	}
}

func TestRetainStatePAMWhileOnDoesNotTouchLifetimeManager(t *testing.T) {
	h, mgr := newPamTestHeartbeatWithRecordingManager(t)
	h.handleUACInterception(boolPtr(true))
	before := mgr.disableCalls
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}})
	if mgr.disableCalls != before || !h.IsUACInterceptionEnabled() {
		t.Fatal("retain while enabled must leave PAM and the lifetime manager untouched")
	}
}

func TestRetainStateHelperKeepsFlagAndSkipsApply(t *testing.T) {
	h := newRetainTestHeartbeat()
	h.handleHelperEnabled(true)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{Helper: true}})
	if !h.IsHelperEnabled() {
		t.Fatal("retain must keep the helper flag")
	}
}

func TestRetainStateRemoteManagementKeepsPolicyFlag(t *testing.T) {
	h := newRetainTestHeartbeat()
	h.tunnelMgr.SetManagedByPolicy(true)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	if !h.tunnelMgr.IsManagedByPolicy() {
		t.Fatal("retain must keep managedByPolicy")
	}
}

func TestLegacyShapeUnchangedWithoutRetainState(t *testing.T) {
	// Old-API compatibility: absent keys keep meaning "off", exactly as today.
	h := newPamEnabledTestHeartbeat(t)
	h.tunnelMgr = tunnel.NewManager(false)
	h.handleUACInterception(boolPtr(true))
	h.tunnelMgr.SetManagedByPolicy(true)
	h.handleHelperEnabled(true)
	h.applySettingsDecisions(&HeartbeatResponse{})
	if h.IsUACInterceptionEnabled() || h.tunnelMgr.IsManagedByPolicy() || h.IsHelperEnabled() {
		t.Fatal("without retainState the legacy semantics (absent = off) must be preserved")
	}
}
```

`newRetainTestHeartbeat()` returns `&Heartbeat{tunnelMgr: tunnel.NewManager(false)}` (every apply path dereferences `tunnelMgr`; `newTestHeartbeat(nil)` leaves it nil and would panic; `helperMgr` is touched only when `HelperSettings != nil`, so helper-settings cases must build `helper.NewManager` as the existing helper tests do). Helpers `newPamEnabledTestHeartbeat` / `newPamTestHeartbeatWithRecordingManager`: build from the existing constructors; if `pamLifetimeManager` is a concrete type, introduce a minimal test double through the existing `pamlifetime.Manager` interface (check `agent/internal/pamlifetime` for the interface; do not widen production code just for the test).

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestRetainState|TestLegacyShape' -count=1`
Expected: FAIL (`applySettingsDecisions` undefined; once stubbed, the retain tests fail because absent PAM disables).

- [ ] **Step 3: Implement.** Extract and gate:

```go
// applySettingsDecisions applies PAM, remote-management and helper decisions.
// A feature named in resp.RetainState has NO decision this beat: its state is
// left exactly as it is — including at agent boot, where "current" is the
// boot default (PAM off). Legacy keys for a retained feature are ignored.
func (h *Heartbeat) applySettingsDecisions(resp *HeartbeatResponse) {
	retain := resp.RetainState
	h.noteRetainStreak(retain)
	// Retain keeps an ENABLED PAM state untouched. When PAM is currently off
	// (boot default, or a disable whose verified cleanup may still be
	// pending — handleUACInterception retries that cleanup every beat) the
	// disable path keeps running: it is idempotent, identical to today's
	// behaviour for an off state, and can never enable anything.
	if retain.PAM {
		if !h.uacInterceptionEnabled.Load() {
			h.handleUACInterception(boolPtr(false))
		}
	} else {
		h.handleUACInterception(resp.UacInterceptionEnabled)
	}
	if !retain.RemoteManagement {
		h.tunnelMgr.SetManagedByPolicy(resp.ManageRemoteManagement)
	}
	if !retain.Helper {
		h.handleHelperEnabled(resp.HelperEnabled)
		h.applyHelperSettings(resp.HelperSettings) // the existing helperMgr.Apply + SetModeOverride block, moved verbatim
	}
}
```

Call sites keep today's ordering: `handleUACInterception` must still run *before* command submission (the existing comment at ~5258-5262), so call `applySettingsDecisions` at the PAM site **only for the PAM leg**, and the other legs at their current position. Concretely: split into `applyPAMDecision(resp)` (called at the PAM site) and `applyHelperAndRemoteManagement(resp)` (called at ~5439), with `applySettingsDecisions` kept as a thin test-facing wrapper calling both in that order. `noteRetainStreak` (Task 1.4) is called once from the PAM-site function.

- [ ] **Step 4: Run to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/helper/... -count=1`
Expected: PASS, including every pre-existing `uac_interception_test.go` / `handlers_actuate_test.go` case unchanged.

- [ ] **Step 5: Commit** — `feat(agent): honour retainState for PAM, helper, remote management (#8258)`.

### Task 1.3: Declare the capability

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`SecurityCapabilities` ~239-290, `compiledSecurityCapabilities` ~8152)
- Test: `agent/internal/heartbeat/retain_state_capability_test.go` (clone `consent_prompt_capability_test.go`)
- Test: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`

- [ ] **Step 1: Write the failing tests.** Go: `compiledSecurityCapabilities().RetainStateProtocolVersion == 1` and the marshalled JSON key is exactly `retainStateProtocolVersion` (same shape as the consent test). API: a heartbeat body with `securityCapabilities: { retainStateProtocolVersion: 1 }` parses with the field preserved (after Wave 2 adds it to the schema) **and, in this wave, with the current schema the unknown key must not 400 the beat** — add the assertion to `schemas.heartbeatTolerance.test.ts` as a pure old-schema guard before touching the schema.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run RetainStateCapability -count=1` → FAIL; `cd apps/api && npx vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts` → PASS today (proves the old API tolerates the new key; this is the W1 safety evidence).
- [ ] **Step 3: Implement.** Add `RetainStateProtocolVersion int \`json:"retainStateProtocolVersion,omitempty"\`` with a doc comment ("this build honours HeartbeatResponse.RetainState; the API sends it only to agents declaring exactly 1") and `RetainStateProtocolVersion: retainStateProtocolVersion` in `compiledSecurityCapabilities()`.
- [ ] **Step 4: Run** both commands; Expected: PASS.
- [ ] **Step 5: Commit** — `feat(agent): declare retainStateProtocolVersion 1 (#8258)`.

### Task 1.4: Bounded retain-streak visibility

**Files:**
- Modify: `agent/internal/heartbeat/retain_state.go`; Test: `retain_state_test.go`

**Interfaces:** `func (h *Heartbeat) noteRetainStreak(r RetainState)`; per-feature consecutive counters (atomics); a decided beat resets that feature's counter; threshold const `retainStreakWarnBeats = 30`.

- [ ] **Step 1: Failing test** — 29 consecutive `RetainState{PAM:true}` beats log nothing; the 30th logs exactly one `warn` per streak (capture via the package's test log hook; if none exists, expose the counter value and assert on it); a decided beat resets.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (log only; **never auto-revert** — reverting would reintroduce the downgrade). **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... -count=1` → PASS. **Step 5: Commit.**

### Wave 1 exit checks

- `cd agent && go test -race ./internal/heartbeat/... ./internal/helper/... ./internal/tunnel/... -count=1`; `go vet ./...`; cross-compile `GOOS=windows go vet ./internal/heartbeat/...` and `GOOS=darwin` (PAM/UAC code is platform-split).
- CI jobs: `test-agent` (blocks). No API job is affected.
- Release: this ships in the next agent release. **Adoption is only measurable after promote** — see W2 gate.

---

## Wave 2 — API emits `retainState` to agents that advertise v1

**Mergeable alone:** yes, and inert until an agent advertising v1 exists in the field. Merge **after** the W1 agent release is promoted (OD3, OD8).
**If W3 never ships:** old agents keep today's residual risk; protocol-aware agents are protected. Everything is additive; the kill switch returns the exact old shape.

### Task 2.1: Capability parse + normaliser

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` (next to `consentPromptProtocolVersion`, ~377), `apps/api/src/routes/agents/heartbeat.ts` (next to `normalizeConsentPromptProtocolVersion`, ~304)
- Test: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`, `heartbeat.test.ts`

**Interfaces:** `export function normalizeRetainStateProtocolVersion(value: unknown): 0 | 1` (exactly `1` → 1, everything else → 0). **Not persisted** (parse-only, like `desktopWsFenceProtocolVersion`); the beat's own value is used.

- [ ] **Step 1: Failing tests**: `normalizeRetainStateProtocolVersion` table — `1→1`; `0, 2, -1, 1.5, "1", true, null, undefined, {}→0`. Schema: `{retainStateProtocolVersion:"x"}` drops the field without 400 (`.catch(undefined)`), valid `1` survives.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agents/heartbeat.test.ts` → FAIL.
- [ ] **Step 3: Implement** the schema key (`z.number().int().optional().catch(undefined)`) and the normaliser.
- [ ] **Step 4:** same command → PASS. **Step 5: Commit.**

### Task 2.2: Pure decision builder

**Files:**
- Create: `apps/api/src/routes/agents/heartbeatSettingsDecision.ts`
- Test: `apps/api/src/routes/agents/heartbeatSettingsDecision.test.ts`

**Interfaces:**
- Produces:
```ts
export type RetainFeature = 'pam' | 'helper' | 'remoteManagement';
export interface SettingsDecisionInput {
  retainProtocol: 0 | 1;          // normalised from THIS beat
  enabled: boolean;               // kill switch (HEARTBEAT_RETAIN_STATE_ENABLED !== 'false')
  pamSettings: { uacInterceptionEnabled: boolean } | null;   // null = no decision
  helperSettings: HelperSettings | null;                     // null = no decision
  remoteManagement: { resolved: boolean; value: boolean };
}
export function buildSettingsDecisionFields(i: SettingsDecisionInput): {
  uacInterceptionEnabled?: boolean;
  helperEnabled?: boolean;
  helperSettings?: HelperSettings;
  manageRemoteManagement?: boolean;
  retainState?: RetainFeature[];
};
```
Behaviour: **legacy mode** (`retainProtocol !== 1 || !enabled`) reproduces today exactly: `uacInterceptionEnabled: pam?.uac ?? false`, `helperEnabled: helper?.enabled ?? false`, `helperSettings: helper ?? undefined`, `manageRemoteManagement: value || undefined`. **Retain mode** emits a feature's legacy keys only when decided and lists it in `retainState` when not.

- [ ] **Step 1: Failing tests** (table-driven): legacy mode with every null/non-null combination equals the old expressions (copy them into the test as the oracle); retain mode: all decided → no `retainState`, keys as legacy; pam null → `retainState:['pam']`, no `uacInterceptionEnabled` key at all (`'uacInterceptionEnabled' in out === false`); decided `uac:false` → key present and `false`, not retained; helper null → `retainState` has `helper`, no `helperEnabled`/`helperSettings`; remote unresolved → `remoteManagement`; kill switch off + protocol 1 → legacy.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/agents/heartbeatSettingsDecision.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the function (≈40 lines). **Step 4:** PASS. **Step 5: Commit.**

### Task 2.3: Wire it into the heartbeat response

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` — org-scoped block (~2096-2108: record `remoteManagementResolved`; carry it out of the `scoped` result, which today returns `{deviceOrgId, deviceSiteId, deviceId, mainResponse}` at ~693/2168; add a field), `mainResponse.manageRemoteManagement` (~2182: stop spreading it; the decision builder owns it), final `c.json` (~2690-2703: replace the three inline `??` expressions with `...buildSettingsDecisionFields(...)`), the drain-branch comment (~461).
- Test: `apps/api/src/routes/agents/heartbeat.test.ts` (existing cases at ~985, ~4009-4021, ~4425-4447 are the legacy oracle and must stay green **unchanged**).

Also in this task: gate PAM/helper decisions on `hierarchyOutcome === 'loaded'` (retain both otherwise) and add `resolved: boolean` to `resolveRemoteAccessForDevice`'s result (`services/remoteAccessPolicy.ts`; additive — grep callers first).

- [ ] **Step 1: Write failing tests** next to the existing "fails closed … when the pam resolver throws" case (~4009), using the same mocks (`buildPamConfigUpdate`, `buildHelperConfigUpdate`, hierarchy loader):
  1. beat advertises `retainStateProtocolVersion:1`, `buildPamConfigUpdate` rejects → `body.retainState` contains `'pam'`, `'uacInterceptionEnabled' in body === false`.
  2. same failure, beat without the capability → `body.uacInterceptionEnabled === false` and no `retainState` key (the existing test, kept).
  3. capability `2` / `"1"` → legacy.
  4. hierarchy `missing` (device vanished mid-beat) + v1 → `retainState` ⊇ `['pam','helper']`, other policy blocks still omitted.
  5. helper throws, PAM decided `true` → `uacInterceptionEnabled:true` present, `retainState:['helper']`.
  6. PAM decided `false` (disabled) + v1 → `uacInterceptionEnabled:false` present, **no** `retainState`.
  7. `resolveRemoteAccessForDevice` throws + v1 → `retainState` has `remoteManagement`, no `manageRemoteManagement`; legacy beat keeps today's absent key.
  8. `HEARTBEAT_RETAIN_STATE_ENABLED=false` + v1 → legacy shape.
  9. Sentry: `captureException` still called once per failure (assert the existing calls are not removed); add `captureException` to the remote-access catch (today `console.error` only).
  11. hierarchy load *errors* (`hierarchyOutcome==='error'`) while the resolver mocks would return defaults (PAM mock returns `{uacInterceptionEnabled:false}`) + v1 → `retainState` ⊇ `['pam','helper']`, not a decided false; remote-access `resolved:false` + v1 → `remoteManagement` retained.
  10. cache-hit path: `readCachedHelperSettings` returns a value → decided, not retained.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts` → FAIL on 1, 4, 5, 7, 8, 9.
- [ ] **Step 3: Implement.** Also correct the drain-branch comment: absence of `uacInterceptionEnabled` disables PAM (and runs cleanup), and note the drain branch intentionally does not emit `retainState` (OD6).
- [ ] **Step 4:** `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/heartbeatSettingsDecision.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts` → PASS; typecheck per Global Constraints (exit code 0).
- [ ] **Step 5: Commit.**

### Task 2.4: Real-Postgres integration test

**Files:**
- Create: `apps/api/src/__tests__/integration/heartbeatRetainState.integration.test.ts` (copy the harness of `agentHotPathQueryBudget.integration.test.ts`: `import './setup'`, `app.route('/agents', heartbeatRoutes)`, its `heartbeat(device, body)` helper and enrolled-device fixture)

- [ ] **Step 1: Write the failing test.** Enrol a device in an org with a PAM policy that enables UAC interception (assert the happy beat returns `uacInterceptionEnabled:true`). Then force a failure with `vi.spyOn(helpersModule, 'buildPamConfigUpdate').mockRejectedValueOnce(new Error('forced'))` (and, in a second case, delete the device row's org visibility by moving it to another org between the org transaction and the policy context is not reproducible deterministically, so the forced-resolver spy is the contract: real route, real RLS contexts, real Redis-less path). Assert: (a) body for a beat with `securityCapabilities.retainStateProtocolVersion:1` has `retainState` containing `pam` and no `uacInterceptionEnabled`; (b) the same forced failure for a beat **without** the capability returns `uacInterceptionEnabled:false` (legacy); (c) the next un-forced v1 beat returns `uacInterceptionEnabled:true` again and no `retainState`; (d) a policy that explicitly disables PAM returns `uacInterceptionEnabled:false` with no `retainState` to a v1 agent.
- [ ] **Step 2: Run to verify red** against the pre-Task-2.3 tree if practicable (`git stash` is forbidden here — use a WIP commit or run the test before committing 2.3), else assert (a) fails when the decision builder is stubbed to legacy mode. Command: `pnpm test-stack up` then the integration runner documented in `docs/agents/testing.md` for a single file; `pnpm test-stack down` when finished.
- [ ] **Step 3/4:** green after 2.3. Also run `agentHotPathQueryBudget.integration.test.ts` — statement and transaction budgets must be unchanged.
- [ ] **Step 5: Commit.**

### Wave 2 exit checks

- CI: `test-api`, `integration-test` (8 shards; the new file plus the budget suite). Contract suites for tenancy/cascade are untouched (no table/column), but run the usual full set before opening the PR.
- **File-conflict risk:** Task 2.3 edits the same ~2320-2530 policy-context region and the final response assembly that **#8139 W03** (shared policy context, per-org caches, `orgHelperSettingsCache`/`orgPamFallbackCache`) owns. Sequence: land #8139 W03 first, then rebase W2; W1 (agent only) has no conflict and can ship in parallel. If W03 is not yet merged when W2 is ready, the pure builder file (Task 2.2) and the normaliser (2.1) can merge first and 2.3 follows.
- Rollout order: **agent release (W1) promoted → measure adoption → merge W2 → deploy API.** Because emission is capability-gated per beat, deploying W2 before adoption is safe, merely pointless; the order exists so the first protocol-aware beats are already protected.

---

## Wave 3 (optional) — Last-known-decision fallback for legacy agents

**Mergeable alone:** yes; only worthwhile if adoption data (OD8) shows a long tail of pre-v1 agents. **Skip it if the tail is small.**
**Why it exists:** omitting keys cannot protect an old agent (absent PAM = disable). The only server-side mitigation is to send a *stale-but-safe* value: the last real decision for that device, instead of `false`. This is a scaling-sensitive change (one extra Redis write per cache-miss resolution) and touches the same hot path as #8139, so it is gated on measurements, not assumed.

### Task 3.1: Last-known decision store

**Files:** Modify `apps/api/src/services/helperSettings.ts` and `routes/agents/helpers.ts` (`buildPamConfigUpdate`) — write `…:lastknown:` keys (TTL 24 h) only on a **successful fresh resolution** (the existing cache-miss branch), never on a cache hit; read only on the legacy-agent failure path. Tests: failure + legacy agent returns the last-known value; no last-known → today's `false`; value older than TTL → `false`; a successful fresh decision always overwrites; protocol-aware agents never read it. `integration-test` budget suite: confirm the extra write is Redis-only (zero added Postgres statements).
- [ ] Steps follow the red-first pattern above; commit separately.

### Not planned (and why)

- **Removing the legacy shape.** Agents never all upgrade; the legacy shape is retained until a minimum supported agent version ≥ the W1 release is enforced by the update-policy machinery, which is a separate decision tracked outside this plan. Nothing in W1–W3 is blocked on it.
- **Converting other response bools** (`renewCert`, `rotateToken`, `confirmTokenRotation`, `recoveryMarkerAck`): these are one-shot triggers where absent = "do nothing" is correct.

---

## Open Decisions

Each: options, **recommendation**, one-line why. "Quorum" notes record where the independent Codex read differed (see the end of this section).

1. **Wire encoding.**
   (a) `*bool` for `helperEnabled` / `manageRemoteManagement`, absent = retain. Pro: smallest diff. Con: an old API *already* omits `manageRemoteManagement` when false and omits everything on the drain beat, so a new agent could not tell "old API said off" from "new API says retain"; changes semantics for new-agent/old-API.
   (b) A separate `retainState: [...]` list. Pro: additive, self-describing, new-agent/old-API is unchanged by construction, extensible, "explicit false" never needs to be distinguished from absent on a plain bool.
   (c) `configUpdate` map keys like OneDrive. Pro: has a precedent. Con: OneDrive's "omitted = keep" works because that key was *always* `configUpdate`-only; PAM/helper/remote-management are top-level fields with legacy semantics, so a configUpdate key would sit beside contradictory top-level values and still need a gate.
   **Recommend (b)** — it is the only option that cannot change meaning for any old/new pairing.
2. **Protocol key, location, floor.** Options: new `securityCapabilities.retainStateProtocolVersion` (parse-only, no column) / reuse `pamLifetimeProtocolVersion` / agent-version string comparison. **Recommend the new key, floor 1, matched as exactly `1`** (the existing normaliser convention: a future v2 is spoken only after the API learns it, as with consent v2), declared in `compiledSecurityCapabilities()`, normalised to exactly-1, read from the same beat — reusing an unrelated version couples two rollouts, and version-string gating is what the capability mechanism exists to avoid.
3. **Ordering.** Agent-first (W1 then W2) vs API-first. **Recommend agent-first, confirmed necessary**: an API-first rollout is inert (nothing advertises v1) and an API that emitted unconditionally would be sending an unknown field to old agents; with capability gating agent-first is also the only order in which the first emitted `retainState` is already honoured.
4. **Meaning of "retain" after agent restart.** Options: persisted last state / boot default. **Recommend boot default (PAM off with the same idempotent disable-cleanup retry that runs today; helper untouched on disk)** — PAM enable needs reconciliation + verification before it may turn on, so persisting "on" would bypass that gate; boot default equals today's behaviour.
5. **`manageRemoteManagement` and other plain bools.** Options: fix now with the same list / follow-up. **Recommend fix now for `manageRemoteManagement` only** — it is a real instance of the same defect (thrown resolver → `SetManagedByPolicy(false)`), the list encoding makes it nearly free, and the other plain bools are one-shot triggers where absent is correct. Fallback if the reviewer wants W1 smaller: ship `pam` + `helper` and add `remoteManagement` in a later agent release.
6. **Uninstall-drain branch.** Options: leave / send `retainState` for all three to protocol-aware agents. **Recommend leave unchanged** — that branch's documented invariant is "claim the uninstall and return nothing else"; the machine is being removed, PAM capture stopping there is benign, and keeping the branch minimal is its security property. Only fix the false comment.
7. **Server-side mitigation for old agents.** Options: none / omit keys / last-known-decision fallback (W3). Omitting keys was checked and is **ineffective** (absent PAM still disables). **Recommend none in W2; W3 only if adoption data shows a material tail**, because last-known adds Redis writes on the hot path that #8139 is trying to shrink.
8. **Adoption gate before emission.** Options: none (per-beat capability self-gates) / fleet percentage threshold / env kill switch. **Recommend no threshold plus `HEARTBEAT_RETAIN_STATE_ENABLED` kill switch (default on)** — emission is safe at any adoption level because old agents get the identical legacy shape; adoption data (devices by agent version ≥ the W1 release, from the existing agent-version rollup) decides only whether W3 is worth doing.
9. **Wave cut.** Options: W1 agent / W2 API / W3 cleanup (suggested) vs W1 agent / W2 API / W3 legacy mitigation. **Recommend the latter**: "cleanup" has nothing safe to remove until a minimum agent version is enforced, so the third wave is the optional mitigation and removal is explicitly out of scope.
10. **Unbounded retain.** If the API fails persistently, retained state can go stale (e.g. an admin disables PAM and the agent never hears it). Options: retain forever with a visible warning / auto-revert to off after N beats / agent reports streak to the API. **Recommend visible warning only (30 consecutive beats ≈ 30 min, log once per streak)**, because auto-revert reintroduces the exact downgrade this plan removes, and a persistent resolver outage is already a Sentry-visible incident on the API side. Server-side streak reporting is a possible follow-up.
11. **Where "retain" is decided.** Options: derive from the resolver result being absent (this plan) / add an explicit tri-state to each builder. **Recommend derive from absence** — the main builders throw on failure (and never cache failures), with the exceptions listed in Finding 2, so `null` in the response assembly is "no decision" — **plus** the hierarchy-loaded gate and the remote-access `resolved` flag for the resolvers that default instead of throwing (see Finding 2); the pure builder keeps that rule in one tested place.
12. **Integration-test forcing method.** The integration test forces failure by spying on the resolver rather than inducing a real DB fault (a mid-beat org move is not deterministic). Accepted trade-off; the unit layer covers the `missing` hierarchy path.

### Quorum

Independent read-only Codex pass (medium effort). Eight findings, each re-verified against the cited file before acting:

- **Folded in (verified):** resolvers that default instead of throwing when the device/org is invisible, in the hierarchy-error fallback (PAM defaults, helper org flag `{enabled:false}`, remote-access defaults) → hierarchy-loaded gate + remote `resolved` flag (Finding 2, Task 2.3, OD11); retain must keep the idempotent PAM disable/cleanup retry while PAM is off (Task 1.2 code and tests); streaming parser to bound parse work (Task 1.1); version-contract wording made consistently "exactly 1" (OD2); test constructors must build `tunnelMgr` (Task 1.2); skew/rollback/kill-switch residual stated (compat section).
- **Partially accepted:** "bounds do not bound allocation" — the whole response body is already decoded in memory, so the plan now says the bound is semantic/CPU only, not memory.
- **Unresolved disagreements:** none.
