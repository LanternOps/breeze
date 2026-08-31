package heartbeat

import (
	"context"
	"errors"
	"strings"
	"testing"

	rollbackstate "github.com/breeze-rmm/agent/internal/rollback"
	"github.com/breeze-rmm/agent/internal/updater"
)

func rollbackBackendDirective() rollbackstate.Directive {
	return rollbackstate.Directive{
		RollbackID: "rollback-1",
		ComponentVersions: map[string]rollbackstate.ComponentVersion{
			"agent":  {Current: "2.0.0", Target: "1.9.0"},
			"helper": {Current: "2.0.0", Target: "1.9.0"},
		},
	}
}

func TestRollbackBackendSwapRejectsChangedLiveComponentBeforeMutation(t *testing.T) {
	backend := &agentRollbackBackend{currentVersions: func() map[rollbackstate.Component]string {
		return map[rollbackstate.Component]string{"agent": "2.0.0", "helper": "2.1.0"}
	}}
	err := backend.Swap(context.Background(), rollbackBackendDirective())
	if err == nil || !strings.Contains(err.Error(), "helper") {
		t.Fatalf("Swap error = %v, want changed helper version", err)
	}
	lease, ok := updater.TryBeginProcessMutation("test-after-rejection")
	if !ok {
		t.Fatal("rejected rollback leaked process mutation coordinator")
	}
	lease.Release()
}

func TestRollbackBackendPrepareFailsWhileOrdinaryUpdateOwnsCoordinator(t *testing.T) {
	lease, ok := updater.TryBeginProcessMutation("ordinary-update")
	if !ok {
		t.Fatal("failed to acquire ordinary update lease")
	}
	defer lease.Release()
	backend := &agentRollbackBackend{currentVersions: func() map[rollbackstate.Component]string {
		return map[rollbackstate.Component]string{"agent": "2.0.0", "helper": "2.0.0"}
	}}
	err := backend.Prepare(context.Background(), rollbackBackendDirective())
	if !errors.Is(err, updater.ErrProcessMutationInProgress) {
		t.Fatalf("Prepare error = %v, want coordinator rejection", err)
	}
}
