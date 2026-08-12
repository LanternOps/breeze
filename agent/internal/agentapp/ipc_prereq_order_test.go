package agentapp

import (
	"errors"
	"testing"
)

// Untagged so this runs on the required `test-agent` (ubuntu) job. The ordering
// it pins is the exact regression that shipped in #3133/#3134/#3137, and the
// darwin caller itself is only reachable on the non-blocking macOS job.

func TestInstallIPCPrereqsThenHelpersOrdering(t *testing.T) {
	var calls []string
	err := installIPCPrereqsThenHelpers(
		func() error { calls = append(calls, "group"); return nil },
		func() { calls = append(calls, "members") },
		func() { calls = append(calls, "helpers") },
	)
	if err != nil {
		t.Fatalf("installIPCPrereqsThenHelpers: %v", err)
	}
	want := []string{"group", "members", "helpers"}
	if len(calls) != len(want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v — a helper bootstrapped before group membership "+
				"exists inherits no breeze group and is denied the IPC socket (#3137)", calls, want)
		}
	}
}

func TestInstallIPCPrereqsThenHelpersAbortsWhenTheGroupCannotBeCreated(t *testing.T) {
	sentinel := errors.New("no free gid")
	membersCalled := false
	helpersCalled := false
	err := installIPCPrereqsThenHelpers(
		func() error { return sentinel },
		func() { membersCalled = true },
		func() { helpersCalled = true },
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want it to wrap %v", err, sentinel)
	}
	// Without a group there is nothing to add members to and nothing for the
	// socket to belong to; continuing would produce a silently broken install.
	if membersCalled {
		t.Error("membership was attempted after the group could not be created")
	}
	if helpersCalled {
		t.Error("helpers were bootstrapped after the group could not be created")
	}
}

func TestInstallIPCPrereqsThenHelpersStillBootstrapsWhenMembershipIsBestEffort(t *testing.T) {
	// ensureMembers has no error return by design: one unresolvable console user
	// must not fail an install that works for everyone else, and the daemon
	// retries membership on every helper start. Assert the helpers still get
	// bootstrapped so a partial membership result cannot strand remote desktop.
	helpersCalled := false
	err := installIPCPrereqsThenHelpers(
		func() error { return nil },
		func() {},
		func() { helpersCalled = true },
	)
	if err != nil {
		t.Fatalf("installIPCPrereqsThenHelpers: %v", err)
	}
	if !helpersCalled {
		t.Error("helpers were not bootstrapped")
	}
}
