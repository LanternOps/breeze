package branding

import (
	"strings"
	"testing"
)

// With no -ldflags -X, every branding variable is empty, so each call site
// keeps its own default and official output stays exactly as it is today.
func TestDefaultsAreEmpty(t *testing.T) {
	vars := map[string]string{
		"AgentServiceDisplayName":    AgentServiceDisplayName,
		"AgentServiceDescription":    AgentServiceDescription,
		"WatchdogServiceDisplayName": WatchdogServiceDisplayName,
		"WatchdogServiceDescription": WatchdogServiceDescription,
		"AgentCLIShort":              AgentCLIShort,
		"WatchdogCLIShort":           WatchdogCLIShort,
	}
	for name, v := range vars {
		if v != "" {
			t.Errorf("%s = %q, want empty by default", name, v)
		}
	}
}

// The fixed service names are identifiers, not display strings: the updater,
// the MSI and the API key on them, so they must never change.
func TestFixedServiceNames(t *testing.T) {
	if AgentServiceName != "BreezeAgent" {
		t.Errorf("AgentServiceName = %q, want BreezeAgent", AgentServiceName)
	}
	if WatchdogServiceName != "BreezeWatchdog" {
		t.Errorf("WatchdogServiceName = %q, want BreezeWatchdog", WatchdogServiceName)
	}
}

func TestOr(t *testing.T) {
	cases := []struct {
		name     string
		value    string
		fallback string
		want     string
	}{
		{"empty uses the path default", "", "Breeze RMM Agent", "Breeze RMM Agent"},
		{"blank uses the path default", "   ", "Breeze RMM Agent", "Breeze RMM Agent"},
		{"value wins", "Example MSP Agent", "Breeze RMM Agent", "Example MSP Agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Or(tc.value, tc.fallback); got != tc.want {
				t.Fatalf("Or(%q, %q) = %q, want %q", tc.value, tc.fallback, got, tc.want)
			}
		})
	}
}

func TestValid(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{"empty means unset", "", true},
		{"plain", "Example MSP Agent", true},
		{"unicode", "Agente Exemplo — Monitoramento", true},
		{"max length in characters", strings.Repeat("é", MaxLen), true},
		{"over max length", strings.Repeat("a", MaxLen+1), false},
		{"newline injects unit directives", "Example\nExecStart=/bin/sh", false},
		{"carriage return", "Example\r", false},
		{"tab", "Example\tAgent", false},
		{"nul", "Example\x00", false},
		{"del", "Example\x7f", false},
		{"single quote breaks -ldflags quoting", "Example's Agent", false},
		{"backslash", `Example\Agent`, false},
		{"percent is a systemd specifier", "100% Agent", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Valid(tc.value); got != tc.want {
				t.Fatalf("Valid(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestSetForTestAndRestore(t *testing.T) {
	restore := SetForTest(Values{
		AgentServiceDisplayName:    "Example MSP Agent",
		WatchdogServiceDisplayName: "Example MSP Watchdog",
	})
	if AgentServiceDisplayName != "Example MSP Agent" || WatchdogServiceDisplayName != "Example MSP Watchdog" {
		t.Fatalf("SetForTest did not apply: %q / %q", AgentServiceDisplayName, WatchdogServiceDisplayName)
	}
	if AgentServiceDescription != "" {
		t.Errorf("SetForTest must clear unspecified fields, got %q", AgentServiceDescription)
	}
	restore()
	if AgentServiceDisplayName != "" || WatchdogServiceDisplayName != "" {
		t.Fatalf("restore did not reset: %q / %q", AgentServiceDisplayName, WatchdogServiceDisplayName)
	}
}
