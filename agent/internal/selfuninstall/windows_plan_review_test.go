package selfuninstall

import (
	"errors"
	"strings"
	"testing"
)

// Once the agent service is down, any breeze-agent.exe still running (the
// user-helper fallback on installs without breeze-user-helper.exe runs as
// `breeze-agent.exe user-helper`) is killed, as the old PowerShell teardown
// did; otherwise its locked binary fails verify-processes.
func TestWindowsKillListIncludesTheAgentImage(t *testing.T) {
	for _, name := range windowsHelperProcesses {
		if strings.EqualFold(name, "breeze-agent.exe") {
			return
		}
	}
	t.Fatalf("windowsHelperProcesses %v does not kill breeze-agent.exe", windowsHelperProcesses)
}

// After the services are removed there is nothing to restore: a later failure
// is reported without claiming the agent is coming back, and no restore runs.
func TestWindowsPlanFailureAfterServiceRemovalDoesNotClaimARestore(t *testing.T) {
	ops := &fakeOps{running: []string{"breeze-agent.exe"}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusFailed || out.FailedStep != StepVerifyProcesses {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepVerifyProcesses)
	}
	assertNotLogged(t, ops.log, "restore")
	res := ResultFor(out, 1)
	if strings.Contains(res.Error, "being restored") || !strings.Contains(res.Error, "services were already removed") {
		t.Fatalf("error = %q, want it to say the services are gone and nothing is restored", res.Error)
	}

	// A failure while removing the services (one still registered) restores.
	ops = &fakeOps{deleteErr: map[string]error{"BreezeAgent": errors.New("access denied")}}
	out = run(t, testOptions(), ops)
	assertInOrder(t, ops.log, "REPORT failed", "restore BreezeAgent")
	if res := ResultFor(out, 1); !strings.Contains(res.Error, "being restored") {
		t.Fatalf("error = %q, want the restore announced", res.Error)
	}
}
