package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

// --- trust path ---

func TestToolInstallerMustBeSignedByTheToolPublisher(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	// A Microsoft-signed binary is a valid prerequisite signer, never the tool.
	f.deps.Verifier = verifierFunc(func(string) (string, error) { return "Microsoft Corporation", nil })
	_, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "publisher_mismatch" || len(f.exec.Calls()) != 0 {
		t.Fatalf("outcome=%q code=%q calls=%d", outcome, codeOf(err), len(f.exec.Calls()))
	}
}

func TestPrerequisiteUsesItsOwnAllowlist(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.lane.prereqs["dotnet_desktop_runtime"] = &fakePrereq{becomes: "10.0.8"}
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "dotnet_desktop_runtime", MinVersion: "10.0.8",
		URL: "https://builds.dotnet.microsoft.com/rt.exe", SHA256: strings.Repeat("b", 64)}}
	f.deps.Verifier = verifierFunc(func(path string) (string, error) {
		if strings.HasSuffix(path, "prereq-0.exe") {
			return "Microsoft Corporation", nil
		}
		return "Dell Inc", nil
	})
	if _, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps); err != nil || outcome != "" {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	if got := f.fetch.allows[spec.Prerequisites[0].URL]; strings.Join(got.Hosts, ",") != "builds.dotnet.microsoft.com" {
		t.Fatalf("prerequisite fetched with hosts %v, want its own list", got.Hosts)
	}
	if got := f.fetch.allows[spec.URL]; strings.Join(got.Hosts, ",") != "dl.dell.com" {
		t.Fatalf("tool fetched with hosts %v, want the tool's list", got.Hosts)
	}
}

func TestToolVersionIsReadFreshNotFromTheCache(t *testing.T) {
	f := newRunFixture(t)
	if r := f.run(); r.Outcome != OutcomeSuccess {
		t.Fatalf("first run = %+v", r)
	}
	// Replaced within the gate's 24 h by a signed build outside the range.
	f.lane.freshVersion = "6.1.0"
	r := f.run()
	if r.Outcome != OutcomeToolUnavailable || errCode(r) != "tool_above_supported_range" {
		t.Fatalf("second run = %+v", r)
	}
	if len(f.lane.Applied()) != 1 {
		t.Fatal("ran a tool whose fresh version is out of range")
	}
}

// --- flash path ---

// Dell dock firmware ignores -updateType, so any Dell run may flash: it holds
// the guard and is never killed, even with only drivers requested.
func TestLaneThatFlashesOutsideItsFilterHoldsTheGuardAndIsNotKilled(t *testing.T) {
	f, _ := newOverdueRunFixture(t)
	f.req.Categories = []string{CategoryDriver}
	f.lane.outsideFilter = true
	ctx, cancel := context.WithCancel(context.Background())
	var held bool
	f.lane.apply = func(actx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		_, held = f.guard.Active()
		cancel() // the agent stops mid-run
		if err := actx.Err(); err != nil {
			return RunResult{Lane: LaneDell}, err
		}
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
	}
	r := Run(ctx, f.req, f.lane, f.deps)
	if !held {
		t.Fatal("guard not held for a run that may flash a dock")
	}
	if r.Outcome != OutcomeSuccess {
		t.Fatalf("a run that may flash was killed: %+v", r)
	}
	if p, _ := readPendingVerifications(f.store); len(p) != 0 {
		t.Fatalf("pending = %+v; dock firmware needs no BitLocker verification", p)
	}
	if _, active := f.guard.Active(); active {
		t.Fatal("guard left open")
	}
}

func TestDellLaneFlashesOutsideItsFilter(t *testing.T) {
	if !testDellLane(t, nil).FlashesOutsideFilter() {
		t.Fatal("Dell docks ignore -updateType; the lane must say so")
	}
}

func TestGuardReleasedWhenApplyPanics(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		panic("lane bug")
	}
	func() {
		defer func() { _ = recover() }()
		f.run()
	}()
	if _, active := f.guard.Active(); active {
		t.Fatal("a panic left the flash section open for up to 3 h")
	}
	if release, err := AcquireRunLock(f.store); err != nil {
		t.Fatal("a panic left the run lock held")
	} else {
		release()
	}
}

func TestRunRefusedWhileAFlashSectionIsActive(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryDriver}
	release, err := f.guard.Enter(flashSectionKind, "11111111-2222-4333-8444-555555555555", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = release() }()
	r := f.run()
	if r.Outcome != OutcomeRetryLater || errCode(r) != "flash_in_progress" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v; a vendor tool must not run beside an orphaned flash", r)
	}
}

type errGuard struct{ err error }

func (g errGuard) Enter(string, string, time.Duration) (func() error, error) { return nil, g.err }
func (g errGuard) Active() (flashguard.Section, bool)                        { return flashguard.Section{}, false }

func TestGuardRefusalCodes(t *testing.T) {
	for _, c := range []struct {
		err     error
		outcome Outcome
		code    string
	}{
		{flashguard.ErrPowerActionPending, OutcomeBlockedRebootPending, "flash_guard_busy"},
		{fmt.Errorf("%w: other", flashguard.ErrSectionActive), OutcomeBlockedRebootPending, "flash_guard_busy"},
		{errors.New("state directory unwritable"), OutcomeFailed, "flash_guard_unavailable"},
	} {
		f := newRunFixture(t)
		f.deps.Guard = errGuard{err: c.err}
		r := f.run()
		if r.Outcome != c.outcome || errCode(r) != c.code || len(f.lane.Applied()) != 0 {
			t.Errorf("%v: result = %+v", c.err, r)
		}
	}
}

func TestFailedFlashKeepsPendingVerification(t *testing.T) {
	for _, o := range []Outcome{OutcomeFailed, OutcomePartial, OutcomeSuccessRebootRequired} {
		f := newRunFixture(t)
		f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
			return RunResult{Lane: LaneDell, Outcome: o}, nil
		}
		f.run()
		if p, _ := readPendingVerifications(f.store); len(p) != 1 {
			t.Errorf("%s: pending = %+v; a flash that may have run must be verified", o, p)
		}
	}
}

// --- gate signals ---

func TestAllSkippedForUnreadablePowerSaysSo(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	f.deps.Power = fakePower{err: errors.New("GetSystemPowerStatus failed")}
	if r := f.run(); r.Outcome != OutcomeBlockedOnBattery || errCode(r) != "power_unreadable" {
		t.Fatalf("result = %+v", r)
	}
}

func TestAllSkippedForUnreadableBitLockerSaysSo(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryBIOS}
	f.prot.err = errors.New("bitlocker module missing")
	if r := f.run(); r.Outcome != OutcomeBlockedNoRecoveryKey || errCode(r) != "bitlocker_unreadable" {
		t.Fatalf("result = %+v", r)
	}
}

// --- request and lane invariants ---

func TestRunRefusesAnInvalidRequest(t *testing.T) {
	for name, mutate := range map[string]func(*RunRequest){
		"non-uuid command id": func(r *RunRequest) { r.CommandID = "dev-push-1" },
		"lane mismatch":       func(r *RunRequest) { r.Lane = LaneHP },
		"no categories":       func(r *RunRequest) { r.Categories = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := newRunFixture(t)
			mutate(&f.req)
			r := f.run()
			if r.Outcome != OutcomeFailed || errCode(r) != "invalid_request" || len(f.lane.Applied()) != 0 {
				t.Fatalf("result = %+v", r)
			}
			if err := r.Validate(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLaneCannotWidenTheRequest(t *testing.T) {
	for name, filter := range map[string]func(cats, blocked []string) (FilterPlan, error){
		"extra category": func(cats, blocked []string) (FilterPlan, error) {
			return FilterPlan{Categories: append(append([]string(nil), cats...), CategoryBIOS), BlockedIDs: blocked}, nil
		},
		"dropped blocked id": func(cats, blocked []string) (FilterPlan, error) {
			return FilterPlan{Categories: cats}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newRunFixture(t)
			f.req.Categories = []string{CategoryDriver}
			f.req.BlockedUpdateIDs = []string{"AB12C"}
			f.lane.filter = filter
			r := f.run()
			if r.Outcome != OutcomeFailed || errCode(r) != "lane_filter_widened" || len(f.lane.Applied()) != 0 {
				t.Fatalf("result = %+v", r)
			}
		})
	}
}

func TestFilterErrorEndsTheRunFailed(t *testing.T) {
	f := newRunFixture(t)
	f.lane.filter = func(cats, blocked []string) (FilterPlan, error) {
		return FilterPlan{}, runErr("invalid_blocked_id", errors.New("bad id"))
	}
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "invalid_blocked_id" {
		t.Fatalf("result = %+v", r)
	}
	if m, err := ReadMarker(f.store); err != nil || m.EndedAt == nil {
		t.Fatalf("marker not ended: %+v %v", m, err)
	}
}

func TestInvalidResultFallbackCarriesNothingUnchecked(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess, RawExitCode: int64Ptr(1 << 40),
			SkippedCategories: []SkippedCategory{{Category: CategoryDriver, Reason: "because"}}}, nil
	}
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "result_invalid" || r.RawExitCode != nil || len(r.SkippedCategories) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBadErrorCodeIsReplaced(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Preflight = func() error { return runErr("has a space and is far too long to be an identifier", errors.New("x")) }
	f.req.Categories = []string{CategoryDriver}
	r := f.run()
	if err := r.Validate(); err != nil {
		t.Fatalf("Run returned a result the contract rejects: %v (%+v)", err, r)
	}
}

// An early refusal carries the request's lane; one the contract rejects must
// still come out of Run as a valid result.
func TestEarlyRefusalWithAnUnknownLaneIsStillValid(t *testing.T) {
	f := newRunFixture(t)
	f.req.Lane = "acme"
	f.deps.Store = nil
	r := f.run()
	if err := r.Validate(); err != nil {
		t.Fatalf("Run returned %+v, which the contract rejects: %v", r, err)
	}
	if r.Outcome != OutcomeFailed || r.Lane != LaneDell {
		t.Fatalf("result = %+v", r)
	}
}

func TestRunWithoutRequiredSeamsFails(t *testing.T) {
	for name, mutate := range map[string]func(*Deps){
		"no store":    func(d *Deps) { d.Store = nil },
		"no exec":     func(d *Deps) { d.Exec = nil },
		"no verifier": func(d *Deps) { d.Verifier = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := newRunFixture(t)
			mutate(&f.deps)
			if r := f.run(); r.Outcome != OutcomeFailed || errCode(r) != "deps_missing" {
				t.Fatalf("result = %+v", r)
			}
		})
	}
}

// --- pending verifications ---

func TestCorruptPendingFileIsQuarantinedNotLost(t *testing.T) {
	f := newRunFixture(t)
	_ = f.store.WriteFile(pendingFile, []byte("{not json"))
	if err := addPendingVerification(f.store, PendingVerification{CommandID: testCommandID, VerifyAfter: f.clock.Now()}); err != nil {
		t.Fatal(err)
	}
	kept, err := f.store.ReadFile(pendingCorruptFile)
	if err != nil || string(kept) != "{not json" {
		t.Fatalf("quarantined = %q, %v", kept, err)
	}
	if p, _ := readPendingVerifications(f.store); len(p) != 1 {
		t.Fatalf("pending = %+v", p)
	}
}

func TestBlankBitLockerStateReportsUnknown(t *testing.T) {
	noSleep(t)
	f := newRunFixture(t)
	ended := f.clock.Now()
	addPending(t, f, testCommandID, ended)
	f.sys.boot = ended.Add(time.Minute)
	f.prot.state = ""
	var got Verification
	if err := ResumePending(context.Background(), f.deps, func(v Verification) error { got = v; return nil }); err != nil {
		t.Fatal(err)
	}
	if got.BitlockerAfter != BitLockerUnknown {
		t.Fatalf("reported %q, want unknown rather than dropping the check", got.BitlockerAfter)
	}
}

// --- contract strictness ---

func TestParseRunRequestRejectsCaseVariantKeys(t *testing.T) {
	for name, payload := range map[string]string{
		"top level":     strings.Replace(validPayload, `"lane":`, `"Lane":`, 1),
		"tool":          strings.Replace(validPayload, `"minSafeVersion":`, `"MinSafeVersion":`, 1),
		"range":         strings.Replace(validPayload, `"maxExclusive":`, `"MAXEXCLUSIVE":`, 1),
		"prerequisite":  strings.Replace(validPayload, `"name":`, `"Name":`, 1),
		"duplicate key": strings.Replace(validPayload, `"lane": "dell",`, `"lane": "dell", "lane": "hp",`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseRunRequest([]byte(payload)); err == nil {
				t.Fatal("accepted a key zod's strict schema rejects")
			}
		})
	}
}

func TestUUIDsAreStrict(t *testing.T) {
	bad := "4f1c2a9e-1b2c-0d5e-8f90-0123456789ab" // version nibble 0
	if _, err := ParseRunRequest([]byte(strings.Replace(validPayload, testProtectorID, bad, 1))); err == nil {
		t.Fatal("a version-0 uuid accepted")
	}
	if err := (Verification{CommandID: bad, BitlockerAfter: BitLockerOn}).Validate(); err == nil {
		t.Fatal("verification with a non-RFC uuid accepted")
	}
	if err := (Verification{CommandID: testCommandID, BitlockerAfter: BitLockerOn}).Validate(); err != nil {
		t.Fatal(err)
	}
}
