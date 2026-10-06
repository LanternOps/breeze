package branding

import "testing"

// Without a brand, the collector reports exactly what it reports today.
func TestCanonicalServiceNameWithoutBrandingIsUnchanged(t *testing.T) {
	restore := SetForTest(Values{})
	defer restore()
	for _, name := range []string{"Breeze Agent", "Breeze RMM Agent", "Breeze RMM Watchdog", "Print Spooler", ""} {
		if got := CanonicalServiceName(name); got != name {
			t.Errorf("CanonicalServiceName(%q) = %q, want it unchanged", name, got)
		}
	}
}

func TestCanonicalServiceNameMapsBrandedDisplayNames(t *testing.T) {
	restore := SetForTest(Values{
		AgentServiceDisplayName:    "Example MSP Agent",
		WatchdogServiceDisplayName: "Example MSP Watchdog",
	})
	defer restore()
	cases := []struct{ in, want string }{
		{"Example MSP Agent", AgentServiceName},
		{"example msp agent", AgentServiceName},
		{"  Example MSP Agent ", AgentServiceName},
		{"Example MSP Watchdog", WatchdogServiceName},
		{"Print Spooler", "Print Spooler"},
		{"Example MSP Agent Helper", "Example MSP Agent Helper"},
		{"BreezeAgent", "BreezeAgent"},
	}
	for _, tc := range cases {
		if got := CanonicalServiceName(tc.in); got != tc.want {
			t.Errorf("CanonicalServiceName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A blank brand is "unset": nothing is mapped.
func TestCanonicalServiceNameBlankBrandMapsNothing(t *testing.T) {
	restore := SetForTest(Values{AgentServiceDisplayName: "   "})
	defer restore()
	if got := CanonicalServiceName("   "); got != "   " {
		t.Errorf("CanonicalServiceName(blank) = %q, want it unchanged", got)
	}
	if got := CanonicalServiceName("Breeze Agent"); got != "Breeze Agent" {
		t.Errorf("CanonicalServiceName(%q) = %q, want it unchanged", "Breeze Agent", got)
	}
}
