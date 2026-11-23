package heartbeat

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/userhelpertask"
)

// The task the agent repairs starts the same executable the agent installs
// and the helper reconcile restores.
func TestUserHelperTaskStartsTheInstalledHelper(t *testing.T) {
	if got := userhelpertask.HelperPath(); got != windowsUserHelperInstallPath {
		t.Fatalf("task starts %q, agent installs the helper at %q", got, windowsUserHelperInstallPath)
	}
}

type scriptedTaskChecker struct {
	mu       sync.Mutex
	outcomes []userhelpertask.Outcome
	calls    chan userhelpertask.Outcome
}

func (s *scriptedTaskChecker) Check() (userhelpertask.Outcome, error) {
	s.mu.Lock()
	o := userhelpertask.OutcomePresent
	if len(s.outcomes) > 0 {
		o, s.outcomes = s.outcomes[0], s.outcomes[1:]
	}
	s.mu.Unlock()
	s.calls <- o
	if o == userhelpertask.OutcomeCheckFailed || o == userhelpertask.OutcomeRepairFailed {
		return o, errors.New("boom")
	}
	return o, nil
}

func (s *scriptedTaskChecker) RepairsInWindow() int { return 1 }

func waitCheck(t *testing.T, calls <-chan userhelpertask.Outcome, within time.Duration) userhelpertask.Outcome {
	t.Helper()
	select {
	case o := <-calls:
		return o
	case <-time.After(within):
		t.Fatalf("no check within %s", within)
		return ""
	}
}

func noCheck(t *testing.T, calls <-chan userhelpertask.Outcome, during time.Duration) {
	t.Helper()
	select {
	case o := <-calls:
		t.Fatalf("unexpected check (%q)", o)
	case <-time.After(during):
	}
}

func startTaskLoop(t *testing.T, h *Heartbeat, c userHelperTaskChecker, timing userHelperTaskTiming) (kick chan struct{}) {
	t.Helper()
	stop := make(chan struct{})
	done := make(chan struct{})
	kick = make(chan struct{}, 1)
	go func() {
		defer close(done)
		h.runUserHelperTaskRepair(c, timing, func(int64) int64 { return 0 }, stop, kick)
	}()
	t.Cleanup(func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("repair loop did not stop")
		}
	})
	return kick
}

func TestUserHelperTaskLoopChecksAtStartThenOnTheInterval(t *testing.T) {
	c := &scriptedTaskChecker{calls: make(chan userhelpertask.Outcome, 8)}
	h := &Heartbeat{healthMon: health.NewMonitor()}
	startTaskLoop(t, h, c, userHelperTaskTiming{startDelay: 10 * time.Millisecond, interval: 150 * time.Millisecond, retry: time.Hour})
	waitCheck(t, c.calls, time.Second)
	noCheck(t, c.calls, 80*time.Millisecond)
	waitCheck(t, c.calls, time.Second)
}

func TestUserHelperTaskLoopRetriesSoonAfterAnUnknownState(t *testing.T) {
	c := &scriptedTaskChecker{
		outcomes: []userhelpertask.Outcome{userhelpertask.OutcomeCheckFailed},
		calls:    make(chan userhelpertask.Outcome, 8),
	}
	h := &Heartbeat{healthMon: health.NewMonitor()}
	startTaskLoop(t, h, c, userHelperTaskTiming{startDelay: 10 * time.Millisecond, interval: time.Hour, retry: 20 * time.Millisecond})
	if o := waitCheck(t, c.calls, time.Second); o != userhelpertask.OutcomeCheckFailed {
		t.Fatalf("first check %q", o)
	}
	waitCheck(t, c.calls, time.Second)
}

func TestUserHelperTaskLoopChecksWhenKicked(t *testing.T) {
	c := &scriptedTaskChecker{calls: make(chan userhelpertask.Outcome, 8)}
	h := &Heartbeat{healthMon: health.NewMonitor()}
	kick := startTaskLoop(t, h, c, userHelperTaskTiming{startDelay: time.Hour, interval: time.Hour, retry: time.Hour})
	noCheck(t, c.calls, 30*time.Millisecond)
	kick <- struct{}{}
	waitCheck(t, c.calls, time.Second)
}

func TestUserHelperTaskReportsHealthComponent(t *testing.T) {
	cases := []struct {
		outcome    userhelpertask.Outcome
		wantStatus health.Status
		wantReason string
	}{
		{userhelpertask.OutcomePresent, health.Healthy, ""},
		{userhelpertask.OutcomeRepaired, health.Degraded, "repaired"},
		{userhelpertask.OutcomeHelperMissing, health.Degraded, "helper_missing"},
		{userhelpertask.OutcomeBackedOff, health.Unhealthy, "backed_off"},
		{userhelpertask.OutcomeRepairFailed, health.Unhealthy, "repair_failed"},
		{userhelpertask.OutcomeCheckFailed, health.Degraded, "check_failed"},
	}
	for _, tc := range cases {
		t.Run(string(tc.outcome), func(t *testing.T) {
			h := &Heartbeat{healthMon: health.NewMonitor()}
			// Error text never reaches the server: only the closed code does.
			h.reportUserHelperTask(&scriptedTaskChecker{}, tc.outcome, errors.New(`schtasks: C:\secret path`), "")
			got, ok := h.healthMon.Get(userHelperTaskComponent)
			if !ok {
				t.Fatal("no health component reported")
			}
			if got.Status != tc.wantStatus || got.Message != tc.wantReason {
				t.Fatalf("component = %s/%q, want %s/%q", got.Status, got.Message, tc.wantStatus, tc.wantReason)
			}
		})
	}
}

func TestUserHelperTaskUninstallingLeavesHealthAlone(t *testing.T) {
	h := &Heartbeat{healthMon: health.NewMonitor()}
	h.reportUserHelperTask(&scriptedTaskChecker{}, userhelpertask.OutcomeUninstalling, nil, "")
	if _, ok := h.healthMon.Get(userHelperTaskComponent); ok {
		t.Fatal("an uninstall in progress must not report a task state")
	}
}

// A helper executable restored by the reconcile kicks a task check.
func TestReconcileUserHelperInstallKicksTheTaskCheck(t *testing.T) {
	dir := t.TempDir()
	dl := filepath.Join(t.TempDir(), "dl")
	if err := os.WriteFile(dl, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{
		config:               &config.Config{},
		agentVersion:         "1.2.3",
		userHelperGOOS:       "windows",
		userHelperTaskKick:   make(chan struct{}, 1),
		userHelperDownloader: func(string) (string, error) { return dl, nil },
		userHelperInstaller:  func(string, string, string) error { return nil },
	}
	h.reconcileUserHelper(filepath.Join(dir, "breeze-agent.exe"))
	select {
	case <-h.userHelperTaskKick:
	default:
		t.Fatal("restoring the helper did not kick a task check")
	}
}

func TestReconcileUserHelperPresentDoesNotKick(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "breeze-user-helper.exe"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{
		config:             &config.Config{},
		userHelperGOOS:     "windows",
		userHelperTaskKick: make(chan struct{}, 1),
	}
	h.reconcileUserHelper(filepath.Join(dir, "breeze-agent.exe"))
	select {
	case <-h.userHelperTaskKick:
		t.Fatal("kicked a task check with nothing restored")
	default:
	}
}

func TestKickWithoutALoopNeverBlocks(t *testing.T) {
	(&Heartbeat{}).kickUserHelperTaskCheck()
	h := &Heartbeat{userHelperTaskKick: make(chan struct{}, 1)}
	h.kickUserHelperTaskCheck()
	h.kickUserHelperTaskCheck() // buffer full: dropped, not blocked
}

// self_uninstall marks itself in progress before it touches anything, and
// clears the mark only when the hand-off fails.
func TestSelfUninstallMarksTaskRepairOff(t *testing.T) {
	origRelease, origPrepare, origSchedule := releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn
	t.Cleanup(func() {
		releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn = origRelease, origPrepare, origSchedule
		selfUninstallInProgress.Store(false)
	})
	scheduleSelfUninstallShutdownFn = func(*Heartbeat) {}
	cmd := Command{ID: "cmd-1", Type: tools.CmdSelfUninstall, Payload: map[string]any{}}

	t.Run("release fails", func(t *testing.T) {
		selfUninstallInProgress.Store(false)
		releaseIsolationForUninstallFn = func(*Heartbeat) error {
			if !selfUninstallInProgress.Load() {
				t.Error("not marked in progress while releasing isolation")
			}
			return errors.New("no")
		}
		handleSelfUninstall(&Heartbeat{}, cmd)
		if selfUninstallInProgress.Load() {
			t.Fatal("still marked in progress after a refused uninstall")
		}
	})
	releaseIsolationForUninstallFn = func(*Heartbeat) error { return nil }
	t.Run("hand-off fails", func(t *testing.T) {
		selfUninstallInProgress.Store(false)
		prepareSelfUninstallFn = func(selfUninstallRequest) (bool, error) {
			if !selfUninstallInProgress.Load() {
				t.Error("not marked in progress during the hand-off")
			}
			return false, errors.New("spawn failed")
		}
		handleSelfUninstall(&Heartbeat{}, cmd)
		if selfUninstallInProgress.Load() {
			t.Fatal("still marked in progress after a failed hand-off")
		}
	})
	t.Run("handed off", func(t *testing.T) {
		selfUninstallInProgress.Store(false)
		prepareSelfUninstallFn = func(selfUninstallRequest) (bool, error) { return true, nil }
		handleSelfUninstall(&Heartbeat{}, cmd)
		if !selfUninstallInProgress.Load() {
			t.Fatal("not marked in progress after the hand-off")
		}
	})
}
