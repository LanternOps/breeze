package main

import (
	"errors"
	"testing"
)

// TestEnforceExecutableTrustAtStartupIsDisabledThisRelease mirrors the
// identical test in internal/agentapp; see there for the rationale.
func TestEnforceExecutableTrustAtStartupIsDisabledThisRelease(t *testing.T) {
	if enforceExecutableTrustAtStartup {
		t.Fatal("enforceExecutableTrustAtStartup = true; expected false for this release " +
			"(see the constant's doc comment for the required precondition before flipping it)")
	}
}

// TestReportExecutableTrustWarningDoesNotExit mirrors the identical test in
// internal/agentapp; see there for the rationale.
func TestReportExecutableTrustWarningDoesNotExit(t *testing.T) {
	reportExecutableTrustWarning(errors.New("not owned by root"))
}
