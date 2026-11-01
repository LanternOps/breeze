package tools

import (
	"github.com/breeze-rmm/agent/internal/wire"
	"testing"
)

func TestNetworkIsolationCannotUseToolsDispatch(t *testing.T) {
	r := ExecuteContainment(map[string]any{"actionType": "network_isolation"})
	if r.Status != "failed" || r.ExitCode == 0 || r.ErrorCode != wire.ErrCodeIsolationInvalidSpec || r.Error != "network_isolation dispatched outside the isolation manager" {
		t.Fatalf("unexpected refusal: %+v", r)
	}
}
