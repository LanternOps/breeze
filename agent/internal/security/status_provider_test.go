package security

import "testing"

func TestProviderFromName(t *testing.T) {
	cases := []struct {
		name     string
		display  string
		expected string
	}{
		{"microsoft defender", "Windows Defender", "windows_defender"},
		{"sentinelone", "SentinelOne", "sentinelone"},
		{"crowdstrike", "CrowdStrike Falcon", "crowdstrike"},
		{"elastic defend", "Elastic Defend", "elastic_defend"},
		{"elastic endpoint security", "Elastic Endpoint Security", "elastic_defend"},
		{"elastic agent", "Elastic Agent", "elastic_defend"},
		// Locks the elastic-before-defender ordering: an "Elastic Defender"-style
		// name must not fall through to the broad "defender" → windows_defender case.
		{"elastic defender", "Elastic Defender", "elastic_defend"},
		// Locks the bitdefender-before-defender ordering: "Bitdefender" contains
		// the substring "defender", so these must not fall through to the broad
		// "defender" → windows_defender case (#2075).
		{"bitdefender", "Bitdefender", "bitdefender"},
		{"bitdefender endpoint security", "Bitdefender Endpoint Security", "bitdefender"},
		{"unknown product", "Acme Shield", "other"},
		{"empty", "", "other"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := providerFromName(tc.display); got != tc.expected {
				t.Fatalf("providerFromName(%q) = %q, want %q", tc.display, got, tc.expected)
			}
		})
	}
}
