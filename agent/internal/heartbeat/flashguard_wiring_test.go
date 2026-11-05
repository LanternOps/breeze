package heartbeat

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
	"github.com/breeze-rmm/agent/internal/logging"
	rollbackstate "github.com/breeze-rmm/agent/internal/rollback"
	"github.com/breeze-rmm/agent/internal/updater"
)

func useTestGuard(t *testing.T) *flashguard.Guard {
	t.Helper()
	g := flashguard.New(t.TempDir(), flashguard.WithLockWait(50*time.Millisecond))
	t.Cleanup(flashguard.SetDefault(g))
	return g
}

func enterTestSection(t *testing.T, g *flashguard.Guard) func() error {
	t.Helper()
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	return release
}

// An upgrade offer repeats every heartbeat, so a skip logs once, not per beat.
// A bare Heartbeat cannot survive the path past the check, so reaching the end
// of these calls also proves nothing past it ran: no status was sent and no
// download started.
func TestDoUpgradeSkipsDuringSection(t *testing.T) {
	g := useTestGuard(t)
	enterTestSection(t, g)
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	h := &Heartbeat{}
	for i := 0; i < 5; i++ {
		h.doUpgrade("9.9.9")
	}

	output := buf.String()
	if got := strings.Count(output, flashHoldUpgradeLog); got != 1 {
		t.Fatalf("logged the skip %d times, want once:\n%s", got, output)
	}
	if !strings.Contains(output, "level=INFO") {
		t.Fatalf("the skip should be INFO:\n%s", output)
	}
}

func TestUpgradeHoldLogsAgainForALaterSection(t *testing.T) {
	g := useTestGuard(t)
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	h := &Heartbeat{}

	if h.flashSectionBlocksUpgrade("9.9.9") {
		t.Fatal("no section must not block an upgrade")
	}
	release := enterTestSection(t, g)
	for i := 0; i < 2; i++ {
		if !h.flashSectionBlocksUpgrade("9.9.9") {
			t.Fatal("an open section must block an upgrade, on every offer")
		}
	}
	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if h.flashSectionBlocksUpgrade("9.9.9") {
		t.Fatal("a released section must stop blocking")
	}
	enterTestSection(t, g)
	if !h.flashSectionBlocksUpgrade("9.9.9") {
		t.Fatal("a second section must block")
	}
	if got := strings.Count(buf.String(), flashHoldUpgradeLog); got != 2 {
		t.Fatalf("logged %d times, want once per section:\n%s", got, buf.String())
	}
}

// Refused before anything changes: dev push also turns auto-update off.
func TestDevUpdateAgentRefusedDuringSection(t *testing.T) {
	g := useTestGuard(t)
	enterTestSection(t, g)

	result := handleDevUpdateAgent(&Heartbeat{}, time.Now(), "https://example.invalid/agent", "abc", "9.9.9", false)
	if result.Status != "failed" || !strings.Contains(result.Error, "firmware update") {
		t.Fatalf("result = %+v, want a failure naming the firmware update", result)
	}
}

func TestRollbackSwapRefusedDuringSection(t *testing.T) {
	g := useTestGuard(t)
	enterTestSection(t, g)
	backend := &agentRollbackBackend{currentVersions: func() map[rollbackstate.Component]string {
		return map[rollbackstate.Component]string{"agent": "2.0.0", "helper": "2.0.0"}
	}}

	err := backend.Swap(context.Background(), rollbackBackendDirective())
	if !errors.Is(err, flashguard.ErrFlashInProgress) {
		t.Fatalf("Swap = %v, want ErrFlashInProgress", err)
	}
	lease, ok := updater.TryBeginProcessMutation("test-after-refusal")
	if !ok {
		t.Fatal("a refused rollback leaked the process mutation lease")
	}
	lease.Release()
}

// The rollback owns its admission from the swap until the mutation lease goes,
// across the restart: a flash cannot start on the old binary and then have the
// restart take the agent away from under it.
func TestRollbackAdmissionEndsWithTheMutationLease(t *testing.T) {
	g := useTestGuard(t)
	done, err := g.AdmitPowerAction("test")
	if err != nil {
		t.Fatalf("AdmitPowerAction: %v", err)
	}
	backend := &agentRollbackBackend{powerAdmission: done}
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, flashguard.ErrPowerActionPending) {
		t.Fatalf("Enter while the rollback holds admission = %v, want ErrPowerActionPending", err)
	}
	backend.releaseMutationLease()
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter after the lease was released: %v", err)
	}
	_ = release()
}

func TestIdentityAssertionIsDeferredDuringASection(t *testing.T) {
	s := withIdentitySeams(t, nil)
	g := useTestGuard(t)
	release := enterTestSection(t, g)
	h := identityTestHeartbeat()

	if h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("scheduled an identity restart during a firmware section")
	}
	if s.persisted.Load() != 0 || h.beatSkipReason() != "" {
		t.Fatalf("an open section must schedule nothing: persisted=%d skip=%q", s.persisted.Load(), h.beatSkipReason())
	}
	if _, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatal("a restart marker was written for a restart that was never scheduled")
	}
	expectNoRestart(t, s, 50*time.Millisecond)

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("the identity was not applied after the section ended")
	}
	waitForRestart(t, s)
}

// A section can open during the jitter or the in-flight wait. The restart checks
// again right before it fires and yields, exactly as it does for a rollback.
func TestIdentityRestartYieldsToASectionThatOpensDuringTheWait(t *testing.T) {
	s := withIdentitySeams(t, nil)
	g := useTestGuard(t)
	h := identityTestHeartbeat()

	running := h.trackInFlight(time.Now(), time.Hour)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("assertion not accepted")
	}
	release := enterTestSection(t, g)
	h.untrackInFlight(running)

	expectNoRestart(t, s, 100*time.Millisecond)
	waitForIdentityCondition(t, "the gate reopens", func() bool { return !h.identitySync.restartRequested.Load() })
	if m, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatalf("the restart that yielded left a marker counting it as an attempt: %+v", m)
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("the identity was not re-applied after the section")
	}
	waitForRestart(t, s)
}

func TestSelfUninstallRefusedDuringSection(t *testing.T) {
	g := useTestGuard(t)
	release := enterTestSection(t, g)

	origRelease, origPrepare, origSchedule := releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn
	t.Cleanup(func() {
		releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn = origRelease, origPrepare, origSchedule
	})
	touched := false
	releaseIsolationForUninstallFn = func(*Heartbeat) error { touched = true; return nil }
	prepareSelfUninstallFn = func(bool) error { touched = true; return nil }
	scheduleSelfUninstallShutdownFn = func(*Heartbeat) { touched = true }

	result := handleSelfUninstall(&Heartbeat{}, Command{ID: "cmd-2", Payload: map[string]any{}})
	if result.Status != "failed" || !strings.Contains(result.Error, "firmware update") {
		t.Fatalf("result = %+v, want a failure naming the firmware update", result)
	}
	if touched {
		t.Fatal("a refused uninstall must touch nothing")
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if result := handleSelfUninstall(&Heartbeat{}, Command{ID: "cmd-3", Payload: map[string]any{}}); result.Status != "completed" {
		t.Fatalf("uninstall with no section = %+v", result)
	}
	if !touched {
		t.Fatal("uninstall with no section did not run")
	}
}

// A failed handoff leaves the agent installed and running, so it must let go.
func TestFailedSelfUninstallReleasesItsAdmission(t *testing.T) {
	g := useTestGuard(t)
	origRelease, origPrepare := releaseIsolationForUninstallFn, prepareSelfUninstallFn
	t.Cleanup(func() { releaseIsolationForUninstallFn, prepareSelfUninstallFn = origRelease, origPrepare })
	releaseIsolationForUninstallFn = func(*Heartbeat) error { return nil }
	prepareSelfUninstallFn = func(bool) error { return errors.New("handoff failed") }

	if result := handleSelfUninstall(&Heartbeat{}, Command{ID: "cmd-2", Payload: map[string]any{}}); result.Status != "failed" {
		t.Fatalf("result = %+v", result)
	}
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter after a failed uninstall: %v", err)
	}
	_ = release()
}
