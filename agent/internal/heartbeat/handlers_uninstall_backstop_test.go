package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

type backstopRecorder struct {
	restored  bool
	submitted []tools.CommandResult
	ids       []string
	exitCode  *int
}

func installBackstopSeams(t *testing.T) *backstopRecorder {
	t.Helper()
	r := &backstopRecorder{}
	origRestore, origSubmit, origExit := restoreWindowsAgentServiceFn, submitUninstallFailureFn, selfUninstallExitFn
	t.Cleanup(func() {
		restoreWindowsAgentServiceFn, submitUninstallFailureFn, selfUninstallExitFn = origRestore, origSubmit, origExit
		uninstallHelperWatch.Store(nil)
	})
	restoreWindowsAgentServiceFn = func() { r.restored = true }
	submitUninstallFailureFn = func(_ *Heartbeat, id string, res tools.CommandResult) error {
		r.ids = append(r.ids, id)
		r.submitted = append(r.submitted, res)
		return nil
	}
	selfUninstallExitFn = func(code int) { r.exitCode = &code }
	return r
}

// #11154: a helper that exits while the agent is still running never reached
// the agent's stop (EDR killed it, or it failed and could not restore). The
// agent must not then exit disabled and silent: it reports the command failed,
// undoes phase 1, and exits as a crash so the SCM restarts it.
func TestUninstallBackstopRecoversFromAHelperThatDiedEarly(t *testing.T) {
	r := installBackstopSeams(t)
	exited := make(chan int, 1)
	exited <- 5
	close(exited)
	uninstallHelperWatch.Store(&uninstallHelperState{commandID: "cmd-9", exited: exited})

	if handled := checkUninstallHelperAtDeadline(&Heartbeat{}); !handled {
		t.Fatal("a dead helper was not handled")
	}
	if !r.restored {
		t.Fatal("phase 1 was not undone")
	}
	if len(r.submitted) != 1 || r.ids[0] != "cmd-9" || r.submitted[0].Status != "failed" ||
		!strings.Contains(r.submitted[0].Error, "exited (code 5)") {
		t.Fatalf("submitted = %+v ids=%v, want one failed result naming the helper exit", r.submitted, r.ids)
	}
	if r.exitCode == nil || *r.exitCode == 0 {
		t.Fatalf("exit code = %v, want a nonzero (crash) exit so the SCM restarts the agent", r.exitCode)
	}
}

// A helper still running at the deadline is merely slow: the normal backstop
// proceeds and nothing is reported from here.
func TestUninstallBackstopLeavesARunningHelperAlone(t *testing.T) {
	r := installBackstopSeams(t)
	uninstallHelperWatch.Store(&uninstallHelperState{commandID: "cmd-9", exited: make(chan int)})
	if checkUninstallHelperAtDeadline(&Heartbeat{}) {
		t.Fatal("a running helper was treated as dead")
	}
	if r.restored || len(r.submitted) != 0 || r.exitCode != nil {
		t.Fatalf("side effects for a running helper: %+v", r)
	}
}

// macOS/Linux (no watched helper) are untouched.
func TestUninstallBackstopWithoutAWatchedHelper(t *testing.T) {
	r := installBackstopSeams(t)
	if checkUninstallHelperAtDeadline(&Heartbeat{}) || r.restored || r.exitCode != nil {
		t.Fatalf("backstop acted with no watched helper: %+v", r)
	}
}
