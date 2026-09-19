package updater

import (
	"errors"
	"testing"
)

func TestProcessUpdateCoordinatorAllowsOnlyOneMutation(t *testing.T) {
	first, ok := TryBeginProcessMutation("rollback")
	if !ok || first == nil {
		t.Fatal("first mutation did not acquire coordinator")
	}
	if second, ok := TryBeginProcessMutation("watchdog-update"); ok || second != nil {
		t.Fatal("overlapping mutation acquired coordinator")
	}
	first.Release()
	first.Release()
	second, ok := TryBeginProcessMutation("helper-update")
	if !ok || second == nil {
		t.Fatal("coordinator was not released")
	}
	second.Release()
}

func TestMainAgentUpdateDefersWhileRollbackOwnsCoordinator(t *testing.T) {
	lease, ok := TryBeginProcessMutation("rollback")
	if !ok {
		t.Fatal("failed to acquire rollback lease")
	}
	defer lease.Release()
	if err := (&Updater{}).UpdateTo("2.1.0"); !errors.Is(err, ErrProcessMutationInProgress) {
		t.Fatalf("UpdateTo error = %v, want coordinator rejection", err)
	}
}
