package oemupdates

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The lanes never write a vendor tool's own settings, on any path (#12267).
// The Dell schedule takeover was dropped: the lab showed its settings export
// is refused under every agent-owned folder, and an import cannot put the
// tool's original schedule back exactly. With no write, a release has nothing
// to hand back.

// settingsArgs are the dcu-cli verbs and options that read or write the tool's
// own settings or schedule. None may appear on any lane path.
var settingsArgs = []string{
	"/configure", "-exportSettings", "-importSettings", "-scheduleManual", "-scheduleAuto",
	"-scheduleWeekly", "-scheduleMonthly", "-scheduleDaily", "-updatesNotification", "-lockSettings",
}

func assertNoSettingsCommand(t *testing.T, calls []ExecSpec) {
	t.Helper()
	for _, c := range calls {
		for _, a := range c.Args {
			for _, banned := range settingsArgs {
				if strings.HasPrefix(strings.ToLower(a), strings.ToLower(banned)) {
					t.Fatalf("the lane touched the tool's settings with %q (call %q)", a, c.Args)
				}
			}
		}
	}
}

// assertNoTakeoverState fails when the store holds anything a takeover would
// have kept: an ownership record or an export/import folder.
func assertNoTakeoverState(t *testing.T, s *memStore) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for name := range s.files {
		if strings.Contains(strings.ToLower(name), "takeover") {
			t.Fatalf("the store holds takeover state %q", name)
		}
	}
	if s.root == "" {
		return
	}
	entries, err := os.ReadDir(s.root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(strings.ToLower(e.Name()), "takeover") {
			t.Fatalf("the store holds takeover folder %q", e.Name())
		}
	}
}

func scheduledDellFixture(t *testing.T) (*runFixture, *dellLane) {
	t.Helper()
	f := newRunFixture(t)
	f.req.Trigger = TriggerScheduled
	key := "2026-11"
	f.req.OccurrenceKey = &key
	f.req.Categories = []string{CategoryDriver}
	return f, testDellLane(t, map[string]string{dcu64: "5.7.2"})
}

func TestScheduledDellRunLeavesTheToolScheduleAlone(t *testing.T) {
	f, l := scheduledDellFixture(t)
	r := Run(context.Background(), f.req, l, f.deps)
	if r.Outcome == "" {
		t.Fatal("no outcome")
	}
	calls := f.exec.Calls()
	assertNoSettingsCommand(t, calls)
	if len(calls) != 2 || calls[0].Args[0] != "/scan" || calls[1].Args[0] != "/applyUpdates" {
		t.Fatalf("calls = %+v, want a read-only /scan then one /applyUpdates, as on demand", calls)
	}
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q, want not_attempted", r.Takeover)
	}
	assertNoTakeoverState(t, f.store)
}

func TestScheduledDellRunThatFailsLeavesTheToolScheduleAlone(t *testing.T) {
	f, l := scheduledDellFixture(t)
	f.exec.run = func(_ context.Context, spec ExecSpec) (ExecResult, error) {
		return ExecResult{}, errors.New("dcu-cli did not start")
	}
	r := Run(context.Background(), f.req, l, f.deps)
	if r.Outcome == OutcomeSuccess || r.Outcome == OutcomeNoUpdates {
		t.Fatalf("outcome = %q, want a failure", r.Outcome)
	}
	assertNoSettingsCommand(t, f.exec.Calls())
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q, want not_attempted", r.Takeover)
	}
	assertNoTakeoverState(t, f.store)
}

// A release runs no tool, even when an older agent left an ownership record
// behind, and still acks so the API clears its state.
func TestReleaseRunsNoToolAndAcks(t *testing.T) {
	exec, store := &fakeExec{}, newMemStore()
	legacy := []byte(`{"version":1,"lane":"dell","changed":{"Settings/Schedule/ScheduleMode":{"beforePresent":false,"ours":"x","oursPresent":true}}}`)
	if err := store.WriteFile("dell-takeover.json", legacy); err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		Exec:     exec,
		Verifier: &fakeVerifier{publisher: "Dell Technologies Inc."},
		Store:    store,
		Elevated: func() bool { return true },
	}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, testDellLane(t, map[string]string{dcu64: "5.7.2"}), deps)
	if r.Outcome != ReleaseNothingToRestore || r.ErrorCode != nil || !r.Acked() {
		t.Fatalf("release = %+v, want nothing_to_restore, acked", r)
	}
	if calls := exec.Calls(); len(calls) != 0 {
		t.Fatalf("a release ran the tool: %+v", calls)
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

// The scan succeeds and the install fails: still no settings command after it.
func TestScheduledDellRunWhoseInstallFailsLeavesTheToolScheduleAlone(t *testing.T) {
	f, l := scheduledDellFixture(t)
	f.exec.run = func(_ context.Context, spec ExecSpec) (ExecResult, error) {
		if len(spec.Args) > 0 && spec.Args[0] == "/applyUpdates" {
			return ExecResult{ExitCode: 1}, nil
		}
		return ExecResult{}, nil
	}
	r := Run(context.Background(), f.req, l, f.deps)
	calls := f.exec.Calls()
	assertNoSettingsCommand(t, calls)
	if len(calls) != 2 || calls[1].Args[0] != "/applyUpdates" {
		t.Fatalf("calls = %+v, want the scan then the failed install and nothing after", calls)
	}
	if r.Outcome == OutcomeSuccess || r.Outcome == OutcomeNoUpdates {
		t.Fatalf("outcome = %q, want a failure", r.Outcome)
	}
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q, want not_attempted", r.Takeover)
	}
	assertNoTakeoverState(t, f.store)
}

// A lane result that claims a takeover is corrected, and said so.
func TestALaneClaimingATakeoverIsReportedNotAttempted(t *testing.T) {
	logs := captureLogs(t)
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		return RunResult{Lane: LaneDell, Outcome: OutcomeNoUpdates, Takeover: TakeoverOK}, nil
	}
	r := f.run()
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q, want not_attempted", r.Takeover)
	}
	if !strings.Contains(logs.String(), "lane result claimed a vendor schedule takeover") {
		t.Fatalf("no warning for the corrected takeover value; logs:\n%s", logs.String())
	}
}

// A record an older agent's takeover left is not deleted or acted on, but it
// is logged: the tool's schedule may still be manual, and nothing else would
// say so once the API clears its state.
func TestReleaseLogsALegacyTakeoverRecord(t *testing.T) {
	logs := captureLogs(t)
	store := newMemStore()
	legacy := []byte(`{"version":1,"lane":"dell","changed":{}}`)
	if err := store.WriteFile("dell-takeover.json", legacy); err != nil {
		t.Fatal(err)
	}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, testDellLane(t, nil), Deps{Store: store})
	if r.Outcome != ReleaseNothingToRestore || !r.Acked() {
		t.Fatalf("release = %+v, want nothing_to_restore, acked", r)
	}
	if !strings.Contains(logs.String(), "older agent's vendor schedule takeover record") {
		t.Fatalf("no warning for the legacy record; logs:\n%s", logs.String())
	}
	if got, err := store.ReadFile("dell-takeover.json"); err != nil || string(got) != string(legacy) {
		t.Fatalf("the legacy record was changed or removed: %q, %v", got, err)
	}
}

// With no legacy record there is nothing to warn about.
func TestReleaseWithoutALegacyRecordIsQuiet(t *testing.T) {
	logs := captureLogs(t)
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, testDellLane(t, nil), Deps{Store: newMemStore()})
	if r.Outcome != ReleaseNothingToRestore {
		t.Fatalf("release = %+v", r)
	}
	if strings.Contains(logs.String(), "takeover record") {
		t.Fatalf("warned with no legacy record; logs:\n%s", logs.String())
	}
}

// No lane carries a takeover or restore step any more.
func TestNoLaneTakesOverAVendorSchedule(t *testing.T) {
	for _, id := range allLanes {
		l, ok := LaneFor(id)
		if !ok {
			continue
		}
		typ := reflect.TypeOf(l)
		for _, m := range []string{"Takeover", "Restore"} {
			if _, has := typ.MethodByName(m); has {
				t.Errorf("lane %s still has a %s method", id, m)
			}
		}
	}
}
