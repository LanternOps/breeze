package oemupdates

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// The Dell lane requires Dell Command | Update to be in manual-updates mode
// before it installs, replaces or runs the tool (#12267): two schedulers must
// not update firmware on one machine. These tests drive the real runner with
// the real Dell lane over a fake registry.

func testDellLaneWithRegistry(t *testing.T, present map[string]string, reg *fakeRegistry) *dellLane {
	t.Helper()
	l := testDellLane(t, present)
	l.host.registry = reg.read
	return l
}

func notManualRegistries() map[string]*fakeRegistry {
	return map[string]*fakeRegistry{
		"absent":                newFakeRegistry(),
		"empty key":             newFakeRegistry().setKeyOnly(dellScheduleKey, dellScheduleModeValue),
		"Auto":                  newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto"),
		"Daily":                 newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Daily"),
		"Weekly":                newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Weekly"),
		"Monthly":               newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Monthly"),
		"unknown":               newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Sometimes"),
		"wrong type":            newFakeRegistry().setWrongType(dellScheduleKey, dellScheduleModeValue),
		"denied":                newFakeRegistry().fail(dellScheduleKey, dellScheduleModeValue, errAccessDenied),
		"policy Auto":           manualDellRegistry().setString(dellPolicyKey, dellScheduleModeValue, "Auto"),
		"policy error":          manualDellRegistry().fail(dellPolicyKey, dellScheduleModeValue, errAccessDenied),
		"policy unknown layout": manualDellRegistry().setKeyOnly(dellPolicyKey, dellScheduleModeValue),
		"embedded NUL":          newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "ManualUpdates\x00Auto"),
	}
}

// notManualCode is the errorCode each notManualRegistries entry must report.
func notManualCode(name string) string {
	switch name {
	case "denied", "policy error":
		return codeScheduleUnreadable
	case "policy Auto":
		return codeSchedulePolicyNotManual
	case "policy unknown layout":
		return codeSchedulePolicyUnknown
	}
	return codeScheduleNotManual
}

func TestDellRunRefusesWhenTheToolIsNotInManualMode(t *testing.T) {
	for _, trigger := range []string{TriggerScheduled, TriggerOnDemand} {
		for name, reg := range notManualRegistries() {
			t.Run(trigger+"/"+name, func(t *testing.T) {
				f := newRunFixture(t)
				f.req.Trigger = trigger
				if trigger == TriggerScheduled {
					key := "2026-11"
					f.req.OccurrenceKey = &key
				}
				l := testDellLaneWithRegistry(t, map[string]string{dcu64: "5.7.2"}, reg)
				r := Run(context.Background(), f.req, l, f.deps)
				if calls := f.exec.Calls(); len(calls) != 0 {
					t.Fatalf("the vendor tool was launched %d time(s): %+v", len(calls), calls)
				}
				if r.Outcome != OutcomeToolUnavailable {
					t.Fatalf("outcome = %q, want tool_unavailable", r.Outcome)
				}
				want := notManualCode(name)
				if got := errCode(r); got != want {
					t.Fatalf("errorCode = %q, want %q", got, want)
				}
				if r.Takeover != TakeoverNotAttempted || r.RebootRequired || len(r.Items) != 0 {
					t.Fatalf("result = %+v", r)
				}
				if err := r.Validate(); err != nil {
					t.Fatal(err)
				}
				if _, active := f.guard.Active(); active {
					t.Fatal("a refused run left a flash-guard section open")
				}
				if p, _ := readPendingVerifications(f.store); len(p) != 0 {
					t.Fatalf("a refused run left a pending verification: %+v", p)
				}
				assertNoTakeoverState(t, f.store)
			})
		}
	}
}

func TestDellRunInManualModeRunsAsBefore(t *testing.T) {
	for _, trigger := range []string{TriggerScheduled, TriggerOnDemand} {
		t.Run(trigger, func(t *testing.T) {
			f := newRunFixture(t)
			f.req.Trigger = trigger
			if trigger == TriggerScheduled {
				key := "2026-11"
				f.req.OccurrenceKey = &key
			}
			f.req.Categories = []string{CategoryDriver}
			reg := manualDellRegistry()
			l := testDellLaneWithRegistry(t, map[string]string{dcu64: "5.7.2"}, reg)
			r := Run(context.Background(), f.req, l, f.deps)
			calls := f.exec.Calls()
			if len(calls) != 2 || calls[0].Args[0] != "/scan" || calls[1].Args[0] != "/applyUpdates" {
				t.Fatalf("calls = %+v, want /scan then /applyUpdates", calls)
			}
			assertNoSettingsCommand(t, calls)
			if r.Outcome != OutcomeSuccess || errCode(r) == codeScheduleNotManual {
				t.Fatalf("result = %+v", r)
			}
			// Read before the tool step and again before the launch.
			if n := countReads(reg, dellScheduleKey); n != 2 {
				t.Fatalf("settings key read %d times, want 2", n)
			}
		})
	}
}

// A machine without the tool is not given one: a fresh install is in
// automatic mode, and Breeze may not change the tool's schedule. The absence is
// its own reason, so the admin is told to install the tool, not to change a
// schedule that does not exist yet. It is found by a file stat, before the
// registry is read, whatever the registry holds.
func TestDellRunRefusesWhenTheToolIsNotInstalled(t *testing.T) {
	regs := map[string]*fakeRegistry{
		"manual left by an earlier install": manualDellRegistry(),
		"absent":                            newFakeRegistry(),
		"Auto":                              newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto"),
		"policy unknown layout":             manualDellRegistry().setKeyOnly(dellPolicyKey, dellScheduleModeValue),
	}
	for _, trigger := range []string{TriggerScheduled, TriggerOnDemand} {
		for name, reg := range regs {
			t.Run(trigger+"/"+name, func(t *testing.T) {
				f := newRunFixture(t)
				f.req.Trigger = trigger
				if trigger == TriggerScheduled {
					key := "2026-11"
					f.req.OccurrenceKey = &key
				}
				fetch := &fakeFetcher{}
				f.deps.Fetcher = fetch
				f.req.Tool = toolSpec()
				l := testDellLaneWithRegistry(t, map[string]string{}, reg)
				r := Run(context.Background(), f.req, l, f.deps)
				if got := fetch.Fetched(); len(got) != 0 {
					t.Fatalf("fetched %v for a device without the tool", got)
				}
				if calls := f.exec.Calls(); len(calls) != 0 {
					t.Fatalf("ran %+v", calls)
				}
				if r.Outcome != OutcomeToolUnavailable || errCode(r) != codeToolNotInstalled {
					t.Fatalf("result = %+v, want tool_unavailable / %s", r, codeToolNotInstalled)
				}
				if err := r.Validate(); err != nil {
					t.Fatal(err)
				}
				if n := countReads(reg, ""); n != 0 {
					t.Fatalf("read the registry %q for a device without the tool", reg.reads)
				}
				if _, active := f.guard.Active(); active {
					t.Fatal("a refused run left a flash-guard section open")
				}
			})
		}
	}
}

// The tool under the 32-bit Program Files counts as installed.
func TestDellToolUnderProgramFilesX86IsInstalled(t *testing.T) {
	l := testDellLaneWithRegistry(t, map[string]string{dcu32: "5.7.2"}, manualDellRegistry())
	if outcome, err := l.CheckToolConfig(); outcome != "" || err != nil {
		t.Fatalf("CheckToolConfig = %q, %v", outcome, err)
	}
}

// Nor is an old tool replaced while the tool is not in manual mode.
func TestDellNotManualNeverReplacesAnOldTool(t *testing.T) {
	f := newRunFixture(t)
	fetch := &fakeFetcher{}
	f.deps.Fetcher = fetch
	f.req.Tool = toolSpec()
	reg := newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto")
	l := testDellLaneWithRegistry(t, map[string]string{dcu64: "5.7.0"}, reg)
	r := Run(context.Background(), f.req, l, f.deps)
	if len(fetch.Fetched()) != 0 || len(f.exec.Calls()) != 0 {
		t.Fatalf("fetched %v, ran %+v", fetch.Fetched(), f.exec.Calls())
	}
	if r.Outcome != OutcomeToolUnavailable || errCode(r) != codeScheduleNotManual {
		t.Fatalf("result = %+v", r)
	}
}

// The mode is read again after the tool step: an upgrade that leaves the
// tool in its default (automatic) mode is caught before the tool runs.
func TestDellUpgradeThatResetsTheModeIsCaughtBeforeTheRun(t *testing.T) {
	f := newRunFixture(t)
	f.req.Tool = toolSpec()
	f.req.Categories = []string{CategoryDriver}
	present := map[string]string{dcu64: "5.7.0"} // below the floor: replaced
	reg := manualDellRegistry()
	l := testDellLaneWithRegistry(t, present, reg)
	f.exec.run = func(_ context.Context, spec ExecSpec) (ExecResult, error) {
		if filepath.Base(spec.Path) == "tool.exe" {
			present[dcu64] = "5.7.2"
			delete(reg.values, regKey(dellScheduleKey, dellScheduleModeValue))
		}
		return ExecResult{}, nil
	}
	r := Run(context.Background(), f.req, l, f.deps)
	calls := f.exec.Calls()
	if len(calls) != 1 || filepath.Base(calls[0].Path) != "tool.exe" {
		t.Fatalf("calls = %+v, want the installer and no dcu-cli", calls)
	}
	if r.Outcome != OutcomeToolUnavailable || errCode(r) != codeScheduleNotManual {
		t.Fatalf("result = %+v", r)
	}
}

// A mode that changes between the tool step and the launch is caught too.
func TestDellModeChangedBeforeTheLaunchRefuses(t *testing.T) {
	f := newRunFixture(t)
	f.req.Categories = []string{CategoryDriver, CategoryBIOS}
	reg := manualDellRegistry()
	l := testDellLaneWithRegistry(t, map[string]string{dcu64: "5.7.2"}, reg)
	// The protectors are read after the tool step and before the launch:
	// switch the mode there.
	f.deps.Protectors = hookProtectors{Protectors: f.prot, onLive: func() {
		reg.setString(dellScheduleKey, dellScheduleModeValue, "Auto")
	}}
	r := Run(context.Background(), f.req, l, f.deps)
	if calls := f.exec.Calls(); len(calls) != 0 {
		t.Fatalf("ran %+v", calls)
	}
	if r.Outcome != OutcomeToolUnavailable || errCode(r) != codeScheduleNotManual {
		t.Fatalf("result = %+v", r)
	}
	if _, active := f.guard.Active(); active {
		t.Fatal("flash-guard section left open")
	}
}

// A release still answers as before and reads nothing.
func TestDellReleaseIgnoresTheScheduleMode(t *testing.T) {
	exec, store := &fakeExec{}, newMemStore()
	reg := newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto")
	deps := Deps{Exec: exec, Verifier: &fakeVerifier{publisher: "Dell Technologies Inc."}, Store: store, Elevated: func() bool { return true }}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, testDellLaneWithRegistry(t, map[string]string{dcu64: "5.7.2"}, reg), deps)
	if r.Outcome != ReleaseNothingToRestore || r.ErrorCode != nil || !r.Acked() {
		t.Fatalf("release = %+v", r)
	}
	if len(exec.Calls()) != 0 || len(reg.reads) != 0 {
		t.Fatalf("release ran %+v, read %q", exec.Calls(), reg.reads)
	}
}

// The check is the lane's, through the runner seam: a lane that does not
// implement it is unaffected.
func TestDellLaneIsToolConfigChecked(t *testing.T) {
	var lane Lane = testDellLane(t, nil)
	if _, ok := lane.(ToolConfigCheckedLane); !ok {
		t.Fatal("the Dell lane does not check the tool's configuration")
	}
	var fake Lane = newFakeLane()
	if _, ok := fake.(ToolConfigCheckedLane); ok {
		t.Fatal("the fake lane should not be config-checked")
	}
}

// The production lane carries the real registry reader. Every other test
// injects a fake, so without this a dropped wiring line would refuse every
// real Dell run and no test would notice.
func TestProductionDellHostReadsTheRegistry(t *testing.T) {
	if systemDellHost().registry == nil {
		t.Fatal("the production Dell host has no registry reader")
	}
	l, ok := LaneFor(LaneDell)
	if !ok {
		t.Fatal("no dell lane")
	}
	if l.(*dellLane).host.registry == nil {
		t.Fatal("the built-in Dell lane has no registry reader")
	}
}

func countReads(reg *fakeRegistry, key string) int {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	n := 0
	for _, r := range reg.reads {
		if key == "" || strings.HasPrefix(r, key+"|") {
			n++
		}
	}
	return n
}

type hookProtectors struct {
	Protectors
	onLive func()
}

func (p hookProtectors) Live() (LiveProtectors, error) {
	p.onLive()
	return p.Protectors.Live()
}
