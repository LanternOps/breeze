package heartbeat

import "testing"

// The post-uninstall re-report exists so the dashboard stops showing software
// that is genuinely gone (#3592). It must fire only when the uninstall actually
// succeeded — re-reporting after a FAILED uninstall would be harmless but
// pointless, and firing unconditionally would mask the gating logic entirely.
func TestHandleSoftwareUninstallReReportsOnlyOnSuccess(t *testing.T) {
	cases := []struct {
		name      string
		payload   map[string]any
		wantFired bool
	}{
		{
			// An invalid name fails validation before any provider runs, so the
			// result is "failed" without touching the endpoint.
			name:      "failed uninstall does not re-report",
			payload:   map[string]any{"name": ""},
			wantFired: false,
		},
		{
			name:      "rejected unsafe name does not re-report",
			payload:   map[string]any{"name": "../../etc/passwd"},
			wantFired: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fired := false
			h := &Heartbeat{sendSoftwareInventoryFn: func() { fired = true }}

			result := handleSoftwareUninstall(h, Command{Payload: tc.payload})

			if result.Status == "completed" {
				t.Fatalf("expected this payload to fail validation, got status %q", result.Status)
			}
			if fired != tc.wantFired {
				t.Errorf("re-report fired = %v, want %v", fired, tc.wantFired)
			}
		})
	}
}

// A nil Heartbeat must not panic — handlers are invoked from the command
// dispatch path and this one now dereferences h.
func TestHandleSoftwareUninstallNilHeartbeatDoesNotPanic(t *testing.T) {
	result := handleSoftwareUninstall(nil, Command{Payload: map[string]any{"name": ""}})
	if result.Status != "failed" {
		t.Errorf("Status = %q, want failed", result.Status)
	}
}
