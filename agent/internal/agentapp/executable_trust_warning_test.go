package agentapp

import (
	"errors"
	"testing"
)

// TestEnforceExecutableTrustAtStartupIsDisabledThisRelease pins the
// intentional warn-only default: an executable-trust failure must not
// refuse to start until the install/updater migration has had a release to
// run on the fleet. Flipping this constant is how enforcement gets turned
// back on later — this test exists so that flip is a deliberate, visible
// change rather than an accidental one.
func TestEnforceExecutableTrustAtStartupIsDisabledThisRelease(t *testing.T) {
	if enforceExecutableTrustAtStartup {
		t.Fatal("enforceExecutableTrustAtStartup = true; expected false for this release " +
			"(see the constant's doc comment for the required precondition before flipping it)")
	}
}

// TestReportExecutableTrustWarningDoesNotExit proves the warning path never
// terminates the process. If reportExecutableTrustWarning called os.Exit,
// this test's process would end before reaching the final assertion below —
// that non-termination is the thing under test, not any return value.
func TestReportExecutableTrustWarningDoesNotExit(t *testing.T) {
	reportExecutableTrustWarning(errors.New("not owned by root"))
	// Reaching here proves reportExecutableTrustWarning returned normally.
}
