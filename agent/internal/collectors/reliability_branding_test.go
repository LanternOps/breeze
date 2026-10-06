package collectors

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

func TestParseServiceNameWithoutBrandingIsUnchanged(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	got := parseServiceName("The Breeze Agent service terminated unexpectedly.", "Service Control Manager")
	if got != "Breeze Agent" {
		t.Fatalf("parseServiceName() = %q, want %q", got, "Breeze Agent")
	}
}

// With a brand, the SCM message quotes the branded display name; the collector
// reports the fixed service name so the API still recognises our own service.
func TestParseServiceNameNormalizesBrandedServiceNames(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		AgentServiceDisplayName:    "Example MSP Agent",
		WatchdogServiceDisplayName: "Example MSP Watchdog",
	})
	defer restore()
	tests := []struct {
		msg      string
		fallback string
		want     string
	}{
		{"The Example MSP Agent service terminated unexpectedly.", "Service Control Manager", "BreezeAgent"},
		{"The Example MSP Watchdog service terminated unexpectedly.", "Service Control Manager", "BreezeWatchdog"},
		{"The Spooler service terminated unexpectedly.", "Service Control Manager", "Spooler"},
		{"No match here", "Example MSP Agent", "BreezeAgent"},
		{"No match here", "Service Control Manager", "Service Control Manager"},
	}
	for _, tc := range tests {
		if got := parseServiceName(tc.msg, tc.fallback); got != tc.want {
			t.Errorf("parseServiceName(%q, %q) = %q, want %q", tc.msg, tc.fallback, got, tc.want)
		}
	}
}

// End to end through the classifier: a 7031 for a branded agent service is
// recorded under the fixed name.
func TestClassifyBrandedAgentFailureReportsFixedName(t *testing.T) {
	restore := branding.SetForTest(branding.Values{AgentServiceDisplayName: "Example MSP Agent"})
	defer restore()
	metrics := &ReliabilityMetrics{}
	classifyEventLogEntry(metrics, EventLogEntry{
		Timestamp: "2026-01-15T10:00:00Z",
		Level:     "error",
		Category:  "system",
		Source:    "Service Control Manager",
		EventID:   "7031:200",
		Message:   "The Example MSP Agent service terminated unexpectedly.",
		Details:   map[string]any{"eventId": 7031},
	})
	if len(metrics.ServiceFailures) != 1 {
		t.Fatalf("got %d service failures, want 1", len(metrics.ServiceFailures))
	}
	if got := metrics.ServiceFailures[0].ServiceName; got != "BreezeAgent" {
		t.Fatalf("ServiceName = %q, want %q", got, "BreezeAgent")
	}
}
