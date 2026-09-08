package main

import (
	"fmt"
	"strings"
	"testing"
)

type recordingRunner struct {
	calls  []string
	failOn map[string]string
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

// TestInstallWatchdogUnitAlwaysRestarts is the regression guard for the
// watchdog half of #5252. `breeze-watchdog service install` stopped the unit,
// rewrote it, enabled it — and returned. On the reporting host that left the
// NEW watchdog binary on disk while the OLD v0.104.0 process kept running, so
// none of the recovery behaviour in the new binary was live.
func TestInstallWatchdogUnitAlwaysRestarts(t *testing.T) {
	r := newRecordingRunner()
	if err := installWatchdogUnit(r.run, "breeze-watchdog"); err != nil {
		t.Fatalf("installWatchdogUnit returned error: %v", err)
	}
	want := "systemctl daemon-reload | systemctl enable breeze-watchdog | systemctl restart breeze-watchdog"
	if r.sequence() != want {
		t.Errorf("argv sequence = %q, want %q", r.sequence(), want)
	}
}

// TestInstallWatchdogUnitSurfacesRestartFailure — the install stopped the
// watchdog; failing to start it again leaves the host with no supervisor at
// all, so it must not exit 0.
func TestInstallWatchdogUnitSurfacesRestartFailure(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl restart breeze-watchdog"] = "Job for breeze-watchdog.service failed"
	err := installWatchdogUnit(r.run, "breeze-watchdog")
	if err == nil {
		t.Fatal("a watchdog that could not be restarted after install must be reported as an error")
	}
	if !strings.Contains(err.Error(), "Job for breeze-watchdog.service failed") {
		t.Errorf("error must carry systemctl's own message, got: %v", err)
	}
}

// TestInstallWatchdogUnitEnableFailureDoesNotBlockRestart — an un-enabled
// watchdog still supervises until reboot; refusing to start it would leave
// the host unsupervised now.
func TestInstallWatchdogUnitEnableFailureDoesNotBlockRestart(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl enable breeze-watchdog"] = "Failed to enable unit"
	if err := installWatchdogUnit(r.run, "breeze-watchdog"); err != nil {
		t.Fatalf("enable failure must not abort the install: %v", err)
	}
	if !strings.Contains(r.sequence(), "systemctl restart breeze-watchdog") {
		t.Errorf("the watchdog must still be restarted, got %q", r.sequence())
	}
}

// TestInstallWatchdogUnitDaemonReloadFailureIsFatal — starting after a failed
// reload would run the OLD unit definition.
func TestInstallWatchdogUnitDaemonReloadFailureIsFatal(t *testing.T) {
	r := newRecordingRunner()
	r.failOn["systemctl daemon-reload"] = "Failed to reload daemon"
	if err := installWatchdogUnit(r.run, "breeze-watchdog"); err == nil {
		t.Fatal("daemon-reload failure must abort the install")
	}
	if len(r.calls) != 1 {
		t.Errorf("nothing must run after a failed daemon-reload, got %q", r.sequence())
	}
}
