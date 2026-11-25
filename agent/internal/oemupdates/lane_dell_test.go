package oemupdates

import (
	"context"
	"strings"
	"testing"
)

// Windows paths here are fixtures: the lane is tested on any OS with injected
// stat and version readers. Real detection runs only in the Dell lab (W10).

func testDellLane(t *testing.T, present map[string]string) *dellLane {
	t.Helper()
	l := newDellLane(dellHost{
		programFiles: func() []string { return []string{`C:\Program Files`, `C:\Program Files (x86)`} },
		exists:       func(p string) bool { _, ok := present[p]; return ok },
		fileVersion:  func(p string) (string, error) { return present[p], nil },
		dotnetDesktopVersions: func() []string {
			return nil
		},
	})
	return l
}

const (
	dcu64 = `C:\Program Files\Dell\CommandUpdate\dcu-cli.exe`
	dcu32 = `C:\Program Files (x86)\Dell\CommandUpdate\dcu-cli.exe`
)

func dellPlan(t *testing.T, l *dellLane, cats, blocked []string) FilterPlan {
	t.Helper()
	plan, err := l.Filter(cats, blocked)
	if err != nil {
		t.Fatal(err)
	}
	plan.WorkDir = t.TempDir()
	return plan
}

func TestDellFilterRefusesUnsafeBlockedIDs(t *testing.T) {
	l := testDellLane(t, nil)
	for _, id := range []string{"A,B", "A B", `"A"`, "-reboot=enable", "A;B", "ü"} {
		if _, err := l.Filter([]string{CategoryDriver}, []string{id}); err == nil || codeOf(err) != "invalid_blocked_id" {
			t.Errorf("blocked id %q accepted (err=%v)", id, err)
		}
	}
	if _, err := l.Filter([]string{"bootloader"}, nil); err == nil {
		t.Fatal("unknown category accepted")
	}
}

func TestDellExitMap(t *testing.T) {
	cases := map[int64]Outcome{
		0: OutcomeSuccess, 1: OutcomeSuccessRebootRequired, 5: OutcomeBlockedRebootPending, 500: OutcomeNoUpdates,
		3: OutcomeNotSupported, 7: OutcomeNotSupported,
		6: OutcomeRetryLater, 3003: OutcomeRetryLater, 3004: OutcomeRetryLater, 3005: OutcomeRetryLater,
		1000: OutcomeFailed, 1001: OutcomeFailed, 1002: OutcomeFailed, 501: OutcomeFailed, 502: OutcomeFailed, 503: OutcomeFailed,
		4242: OutcomeFailed, -1: OutcomeFailed,
	}
	for code, want := range cases {
		l := testDellLane(t, map[string]string{dcu64: "5.7.2"})
		ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) { return ExecResult{ExitCode: code}, nil }}
		plan := dellPlan(t, l, []string{CategoryDriver}, nil)
		r, err := l.Apply(context.Background(), ToolState{Present: true, Path: dcu64, Version: "5.7.2"}, plan, ex)
		if err != nil {
			t.Fatalf("exit %d: %v", code, err)
		}
		if r.Outcome != want {
			t.Errorf("exit %d = %s, want %s", code, r.Outcome, want)
		}
		if r.RawExitCode == nil || *r.RawExitCode != code {
			t.Errorf("exit %d: rawExitCode = %v", code, r.RawExitCode)
		}
		if wantReboot := code == 1 || code == 5; r.RebootRequired != wantReboot {
			t.Errorf("exit %d: rebootRequired = %v", code, r.RebootRequired)
		}
	}
	l := testDellLane(t, nil)
	ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) { return ExecResult{ExitCode: 4242}, nil }}
	r, _ := l.Apply(context.Background(), ToolState{Present: true, Path: dcu64, Version: "5.7.2"}, dellPlan(t, l, []string{CategoryDriver}, nil), ex)
	if errCode(r) != "unmapped_exit_code" {
		t.Fatalf("unmapped exit errorCode = %q", errCode(r))
	}
}

func TestDellExitTableKeyedByMajorVersion(t *testing.T) {
	l := testDellLane(t, nil)
	ex := &fakeExec{}
	r, err := l.Apply(context.Background(), ToolState{Present: true, Path: dcu64, Version: "6.0.0"}, dellPlan(t, l, []string{CategoryDriver}, nil), ex)
	if err == nil || r.Outcome != OutcomeFailed || errCode(r) != "unknown_tool_major" {
		t.Fatalf("result = %+v err=%v", r, err)
	}
	if len(ex.Calls()) != 0 {
		t.Fatal("ran a tool whose exit codes the lane cannot read")
	}
}

func TestDellGateFindsEitherProgramFilesPath(t *testing.T) {
	for _, path := range []string{dcu64, dcu32} {
		l := testDellLane(t, map[string]string{path: "5.7.2"})
		s := l.Gate().Get()
		if !s.Present || s.Path != path || s.Version != "5.7.2" {
			t.Errorf("gate = %+v, want %s", s, path)
		}
	}
	l := testDellLane(t, map[string]string{dcu64: "5.7.2", dcu32: "5.6.0"})
	if s := l.Gate().Get(); s.Path != dcu64 {
		t.Fatalf("64-bit path must win, got %s", s.Path)
	}
}

func TestDellGateQuietWhenAbsent(t *testing.T) {
	buf := captureLogs(t)
	l := testDellLane(t, nil)
	for i := 0; i < 3; i++ {
		if l.Gate().Get().Present {
			t.Fatal("absent tool reported present")
		}
	}
	if s := buf.String(); strings.Contains(s, "level=WARN") || strings.Contains(s, "level=INFO") {
		t.Fatalf("an absent tool logged above DEBUG:\n%s", s)
	}
}

func TestDellInstallerArgs(t *testing.T) {
	l := testDellLane(t, nil)
	got := l.InstallArgs(`C:\x\tool.exe`, `C:\x\install.log`)
	if strings.Join(got, " ") != `/s /l=C:\x\install.log` {
		t.Fatalf("args = %q", got)
	}
	h, ok := l.Prerequisite(dotnetDesktopRuntime)
	if !ok {
		t.Fatal("no .NET prerequisite")
	}
	if got := h.InstallArgs(`C:\x\rt.exe`, `C:\x\rt.log`); strings.Join(got, " ") != `/install /quiet /norestart /log C:\x\rt.log` {
		t.Fatalf("prereq args = %q", got)
	}
	if _, ok := l.Prerequisite("something_else"); ok {
		t.Fatal("an unknown prerequisite is known")
	}
}

func TestDellDotnetDetection(t *testing.T) {
	l := newDellLane(dellHost{
		programFiles:          func() []string { return nil },
		exists:                func(string) bool { return false },
		fileVersion:           func(string) (string, error) { return "", nil },
		dotnetDesktopVersions: func() []string { return []string{"8.0.11", "10.0.8", "garbage", "10.0.10-preview"} },
	})
	h, _ := l.Prerequisite(dotnetDesktopRuntime)
	if got := h.Installed(); got != "10.0.8" {
		t.Fatalf("installed = %q, want the highest readable version", got)
	}
}

func TestDellRangeIsTheSecurityFloor(t *testing.T) {
	r := testDellLane(t, nil).Range()
	if r.position("5.7.0") != belowRange || r.position("5.7.1") != inRange || r.position("6.0.0") != aboveRange {
		t.Fatalf("range = %+v", r)
	}
}

// Run Now never changes the tool's own settings. A scheduled run does not either (schedule_untouched_test.go).
func TestRunNowChangesNoToolSettings(t *testing.T) {
	f := newRunFixture(t)
	l := testDellLane(t, map[string]string{dcu64: "5.7.2"})
	f.req.Trigger = TriggerOnDemand
	r := Run(context.Background(), f.req, l, f.deps)
	if r.Outcome == "" {
		t.Fatal("no outcome")
	}
	calls := f.exec.Calls()
	if len(calls) != 2 || calls[0].Args[0] != "/scan" || calls[1].Args[0] != "/applyUpdates" {
		t.Fatalf("calls = %+v, want a read-only /scan then one /applyUpdates", calls)
	}
	for _, c := range calls {
		if c.Path != dcu64 {
			t.Fatalf("ran %q", c.Path)
		}
		for _, a := range c.Args {
			for _, banned := range []string{"/configure", "-exportSettings", "-importSettings", "-scheduleManual", "-lockSettings"} {
				if strings.EqualFold(a, banned) || strings.HasPrefix(strings.ToLower(a), strings.ToLower(banned)) {
					t.Fatalf("on-demand run changed tool settings with %q", a)
				}
			}
		}
	}
	if r.Takeover != TakeoverNotAttempted {
		t.Fatalf("takeover = %q", r.Takeover)
	}
}

func TestLaneRegistry(t *testing.T) {
	l, ok := LaneFor(LaneDell)
	if !ok || l.ID() != LaneDell {
		t.Fatal("no dell lane")
	}
	again, _ := LaneFor(LaneDell)
	if again.Gate() != l.Gate() {
		t.Fatal("the lane must be a singleton so its availability gate stays cached")
	}
	for _, id := range []string{LaneLenovo, "acme"} {
		if _, ok := LaneFor(id); ok {
			t.Errorf("lane %s is not built", id)
		}
	}
	a, ok := laneAllowlist(LaneDell)
	if !ok || strings.Join(l.Allow().Hosts, ",") != strings.Join(a.Hosts, ",") {
		t.Fatal("the dell lane must use the compiled allowlist")
	}
}
