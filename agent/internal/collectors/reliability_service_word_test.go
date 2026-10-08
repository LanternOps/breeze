package collectors

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// A brand whose display name contains the word "service" (for example
// "Acme Service Desk Agent") used to be cut at the first "service" by the lazy
// match, so it never mapped to the fixed service name and a restart of our own
// service counted as a device failure.
func TestParseServiceNameMapsABrandThatContainsTheWordService(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		AgentServiceDisplayName:    "Acme Service Desk Agent",
		WatchdogServiceDisplayName: "Acme Service Desk Watchdog",
	})
	defer restore()

	cases := []struct {
		msg  string
		want string
	}{
		{"The Acme Service Desk Agent service terminated unexpectedly. It has done this 1 time(s).", branding.AgentServiceName},
		{"The Acme Service Desk Watchdog service terminated unexpectedly. It has done this 2 time(s).", branding.WatchdogServiceName},
	}
	for _, tc := range cases {
		if got := parseServiceName(tc.msg, "Service Control Manager"); got != tc.want {
			t.Errorf("parseServiceName(%q) = %q, want %q", tc.msg, got, tc.want)
		}
	}
}
