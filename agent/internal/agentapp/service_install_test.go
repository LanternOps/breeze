package agentapp

import (
	"fmt"
	"strings"
	"testing"
)

// recordingRunner captures every argv a caller issues and can be told to fail
// a specific command.
type recordingRunner struct {
	calls  []string
	failOn map[string]string // joined argv -> stderr text
}

func newRecordingRunner() *recordingRunner {
	return &recordingRunner{failOn: map[string]string{}}
}

func (r *recordingRunner) run(name string, args ...string) ([]byte, error) {
	argv := strings.TrimSpace(name + " " + strings.Join(args, " "))
	r.calls = append(r.calls, argv)
	if msg, bad := r.failOn[argv]; bad {
		return []byte(msg), fmt.Errorf("exit status 1")
	}
	return nil, nil
}

func (r *recordingRunner) sequence() string { return strings.Join(r.calls, " | ") }

// TestPlanServiceStartCoversEveryHostShape pins the decision table behind
// #5252: an install that stopped a running (or enrolled) agent must start it
// again, and a fresh un-enrolled host must not be started into a pointless
// crash-loop before it has credentials.
func TestPlanServiceStartCoversEveryHostShape(t *testing.T) {
	tests := []struct {
		name       string
		wasRunning bool
		enrolled   bool
		wantStart  bool
	}{
		{"running and enrolled (the #5252 upgrade case)", true, true, true},
		{"enrolled but stopped — upgrade of a down agent still comes back", false, true, true},
		{"running but not enrolled — never regress a running service", true, false, true},
		{"fresh host, neither running nor enrolled — enroll first", false, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := planServiceStart(tc.wasRunning, tc.enrolled)
			if got.Start != tc.wantStart {
				t.Errorf("planServiceStart(wasRunning=%v, enrolled=%v).Start = %v, want %v",
					tc.wasRunning, tc.enrolled, got.Start, tc.wantStart)
			}
			if got.Reason == "" {
				t.Error("plan must carry a printable reason so the operator can see what install decided")
			}
		})
	}
}

// TestApplySystemdUnitRestartsWhenPlanSaysStart is the direct regression guard
// for #5252: `service install` stopped breeze-agent, rewrote and enabled the
// unit, and returned WITHOUT any systemctl start — stranding a remote host
// offline. The argv sequence must now end in a restart.
func TestApplySystemdUnitRestartsWhenPlanSaysStart(t *testing.T) {
	r := newRecordingRunner()
	started, err := applySystemdUnit(r.run, "breeze-agent", serviceStartPlan{Start: true, Reason: "test"})
	if err != nil {
		t.Fatalf("applySystemdUnit returned error: %v", err)
	}
	if !started {
		t.Error("applySystemdUnit must report started=true when the plan says start")
	}
	want := "systemctl daemon-reload | systemctl enable breeze-agent | systemctl restart breeze-agent"
	if r.sequence() != want {
		t.Errorf("argv sequence = %q, want %q", r.sequence(), want)
	}
}

// TestApplySystemdUnitDoesNotStartWhenPlanSaysNo keeps the fresh-install path
// unchanged: an un-enrolled host is installed and enabled but not started.
func TestApplySystemdUnitDoesNotStartWhenPlanSaysNo(t *testing.T) {
	r := newRecordingRunner()
	started, err := applySystemdUnit(r.run, "breeze-agent", serviceStartPlan{Start: false, Reason: "test"})
	if err != nil {
		t.Fatalf("applySystemdUnit returned error: %v", err)
	}
	if started {
		t.Error("started must be false when the plan says not to start")
	}
	for _, call := range r.calls {
		if strings.Contains(call, "restart") || strings.Contains(call, "systemctl start") {
			t.Errorf("unexpected start/restart on a fresh un-enrolled host: %q", r.sequence())
		}
	}
}

// TestApplySystemdUnitSurfacesRestartFailure — a restart that fails after we
// already stopped the agent is precisely the stranded-host condition. It must
// be a hard error, never a swallowed warning.
func TestApplySystemdUnitSurfacesRestartFailure(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl restart breeze-agent"] = "Job for breeze-agent.service failed"
	started, err := applySystemdUnit(r.run, "breeze-agent", serviceStartPlan{Start: true, Reason: "test"})
	if err == nil {
		t.Fatal("a failed restart after install stopped the service must be reported as an error")
	}
	if started {
		t.Error("started must be false when the restart failed")
	}
	if !strings.Contains(err.Error(), "Job for breeze-agent.service failed") {
		t.Errorf("error must carry systemctl's own message, got: %v", err)
	}
}

// TestApplySystemdUnitEnableFailureDoesNotBlockStart — an un-enabled unit
// still runs until the next reboot; refusing to start it would turn a
// cosmetic failure into an offline host.
func TestApplySystemdUnitEnableFailureDoesNotBlockStart(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl enable breeze-agent"] = "Failed to enable unit"
	started, err := applySystemdUnit(r.run, "breeze-agent", serviceStartPlan{Start: true, Reason: "test"})
	if err != nil {
		t.Fatalf("enable failure must not abort the install: %v", err)
	}
	if !started {
		t.Error("the service must still be started when only enable failed")
	}
}

// TestApplySystemdUnitDaemonReloadFailureIsFatal keeps the pre-existing
// contract: systemd cannot pick up the rewritten unit, so starting it would
// run the OLD unit definition.
func TestApplySystemdUnitDaemonReloadFailureIsFatal(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl daemon-reload"] = "Failed to reload daemon"
	if _, err := applySystemdUnit(r.run, "breeze-agent", serviceStartPlan{Start: true, Reason: "test"}); err == nil {
		t.Fatal("daemon-reload failure must abort before the unit is enabled or started")
	}
	if len(r.calls) != 1 {
		t.Errorf("nothing must run after a failed daemon-reload, got: %q", r.sequence())
	}
}

// TestApplyLaunchdJobRestartsALoadedJob — macOS had the same #5252 shape:
// install `launchctl unload`ed the daemon and never bootstrapped it back.
// A job that is still loaded must be kickstarted with -k, because a plain
// kickstart would leave the OLD process (and therefore the old binary) running.
func TestApplyLaunchdJobRestartsALoadedJob(t *testing.T) {
	r := newRecordingRunner()
	started, err := applyLaunchdJob(r.run, "com.breeze.agent", "/Library/LaunchDaemons/com.breeze.agent.plist",
		true, serviceStartPlan{Start: true, Reason: "test"})
	if err != nil {
		t.Fatalf("applyLaunchdJob returned error: %v", err)
	}
	if !started {
		t.Error("started must be true")
	}
	want := "launchctl kickstart -k system/com.breeze.agent"
	if r.sequence() != want {
		t.Errorf("argv = %q, want %q", r.sequence(), want)
	}
}

func TestApplyLaunchdJobBootstrapsAnUnloadedJob(t *testing.T) {
	r := newRecordingRunner()
	started, err := applyLaunchdJob(r.run, "com.breeze.agent", "/Library/LaunchDaemons/com.breeze.agent.plist",
		false, serviceStartPlan{Start: true, Reason: "test"})
	if err != nil || !started {
		t.Fatalf("applyLaunchdJob = (%v, %v), want (true, nil)", started, err)
	}
	want := "launchctl bootstrap system /Library/LaunchDaemons/com.breeze.agent.plist"
	if r.sequence() != want {
		t.Errorf("argv = %q, want %q", r.sequence(), want)
	}
}

// TestApplyLaunchdJobFallsBackToLegacyLoad keeps older macOS working.
func TestApplyLaunchdJobFallsBackToLegacyLoad(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["launchctl bootstrap system /p.plist"] = "Bootstrap failed: 5: Input/output error"
	started, err := applyLaunchdJob(r.run, "com.breeze.agent", "/p.plist", false,
		serviceStartPlan{Start: true, Reason: "test"})
	if err != nil || !started {
		t.Fatalf("applyLaunchdJob = (%v, %v), want (true, nil) via the legacy load fallback", started, err)
	}
	if !strings.Contains(r.sequence(), "launchctl load /p.plist") {
		t.Errorf("expected a legacy load fallback, got %q", r.sequence())
	}
}

// TestApplyLaunchdJobSurfacesTotalFailure — both loaders failing after install
// already unloaded the daemon is the stranded-host condition on macOS.
func TestApplyLaunchdJobSurfacesTotalFailure(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["launchctl bootstrap system /p.plist"] = "boom"
	r.failOn["launchctl load /p.plist"] = "also boom"
	started, err := applyLaunchdJob(r.run, "com.breeze.agent", "/p.plist", false,
		serviceStartPlan{Start: true, Reason: "test"})
	if err == nil {
		t.Fatal("a daemon that could not be started after install must be an error")
	}
	if started {
		t.Error("started must be false")
	}
}

func TestApplyLaunchdJobDoesNothingWhenPlanSaysNo(t *testing.T) {
	r := newRecordingRunner()
	started, err := applyLaunchdJob(r.run, "com.breeze.agent", "/p.plist", false,
		serviceStartPlan{Start: false, Reason: "test"})
	if err != nil || started {
		t.Fatalf("applyLaunchdJob = (%v, %v), want (false, nil)", started, err)
	}
	if len(r.calls) != 0 {
		t.Errorf("nothing must run on a fresh un-enrolled host, got %q", r.sequence())
	}
}
