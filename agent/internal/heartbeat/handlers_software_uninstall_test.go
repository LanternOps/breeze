package heartbeat

import (
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The post-uninstall re-report exists so the dashboard stops showing software
// that is genuinely gone (#3592). It must fire on a completed uninstall and NOT
// on a failed one — a failed uninstall means the software is still there, and
// re-reporting would just re-assert it.
func TestHandleSoftwareUninstallReReportsOnlyOnSuccess(t *testing.T) {
	cases := []struct {
		name      string
		result    tools.CommandResult
		wantFired bool
	}{
		{
			name:      "completed uninstall re-reports",
			result:    tools.NewSuccessResult(map[string]any{"action": "uninstall"}, 1),
			wantFired: true,
		},
		{
			name:      "failed uninstall does not re-report",
			result:    tools.NewErrorResult(fmt.Errorf("still present in inventory"), 1),
			wantFired: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig := uninstallSoftware
			t.Cleanup(func() { uninstallSoftware = orig })
			uninstallSoftware = func(map[string]any) tools.CommandResult { return tc.result }

			fired := false
			h := &Heartbeat{sendSoftwareInventoryFn: func() { fired = true }}

			handleSoftwareUninstall(h, Command{Payload: map[string]any{"name": "Some App"}})

			if fired != tc.wantFired {
				t.Errorf("re-report fired = %v, want %v", fired, tc.wantFired)
			}
		})
	}
}

// A nil Heartbeat must not panic — handlers are invoked from the command
// dispatch path and this one now dereferences h.
func TestHandleSoftwareUninstallNilHeartbeatDoesNotPanic(t *testing.T) {
	orig := uninstallSoftware
	t.Cleanup(func() { uninstallSoftware = orig })
	uninstallSoftware = func(map[string]any) tools.CommandResult {
		return tools.NewSuccessResult(map[string]any{"action": "uninstall"}, 1)
	}

	result := handleSoftwareUninstall(nil, Command{Payload: map[string]any{"name": "Some App"}})
	if result.Status != "completed" {
		t.Errorf("Status = %q, want completed", result.Status)
	}
}
