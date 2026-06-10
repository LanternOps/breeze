package heartbeat

import "testing"

func TestIsDowngrade(t *testing.T) {
	cases := []struct {
		name    string
		target  string
		current string
		want    bool
	}{
		{"older patch", "0.68.1", "0.68.2", true},
		{"older minor", "0.67.9", "0.68.0", true},
		{"older major", "0.99.9", "1.0.0", true},
		{"same version", "0.68.2", "0.68.2", false},
		{"newer patch", "0.68.3", "0.68.2", false},
		{"newer minor", "0.69.0", "0.68.9", false},
		{"newer major", "1.0.0", "0.99.9", false},
		{"v-prefix older", "v0.68.1", "0.68.2", true},
		{"v-prefix newer", "v0.69.0", "v0.68.2", false},
		{"prerelease suffix ignored, older", "0.68.1-rc1", "0.68.2", true},
		{"prerelease suffix ignored, newer", "0.69.0-rc1", "0.68.2", false},
		{"unparseable target fails open", "dev", "0.68.2", false},
		{"unparseable current fails open", "0.68.1", "dev", false},
		{"both unparseable fails open", "dev", "dev", false},
		{"empty target fails open", "", "0.68.2", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDowngrade(tc.target, tc.current); got != tc.want {
				t.Fatalf("isDowngrade(%q, %q) = %v, want %v", tc.target, tc.current, got, tc.want)
			}
		})
	}
}

func TestHelperUpgradeAllowed(t *testing.T) {
	cases := []struct {
		name        string
		target      string
		installed   string
		wantAllowed bool
		wantReason  bool // expect a non-empty refusal reason
	}{
		// Downgrades refused (the MUST-FIX: replayed older signed release).
		{"downgrade patch refused", "0.68.1", "0.68.2", false, true},
		{"downgrade minor refused", "0.67.9", "0.68.0", false, true},
		{"downgrade major refused", "0.99.9", "1.0.0", false, true},
		{"v-prefix downgrade refused", "v0.68.1", "0.68.2", false, true},

		// Upgrades allowed.
		{"upgrade patch allowed", "0.68.3", "0.68.2", true, false},
		{"upgrade minor allowed", "0.69.0", "0.68.9", true, false},
		{"upgrade major allowed", "1.0.0", "0.99.9", true, false},
		{"v-prefix upgrade allowed", "v0.69.0", "v0.68.2", true, false},

		// Equal version allowed through (CheckUpdate/applyPendingUpdate
		// already no-op when installed == target).
		{"same version allowed", "0.68.2", "0.68.2", true, false},

		// Fresh install: no helper installed yet — not a downgrade.
		{"fresh install empty installed allowed", "0.68.2", "", true, false},
		{"fresh install whitespace installed allowed", "0.68.2", "   ", true, false},

		// Malformed versions fail closed (unlike agent-path isDowngrade).
		{"malformed target refused", "dev", "0.68.2", false, true},
		{"empty target refused", "", "0.68.2", false, true},
		{"two-part target refused", "0.68", "0.68.2", false, true},
		{"malformed installed refused", "0.68.3", "dev", false, true},
		{"both malformed refused", "dev", "dev", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			allowed, reason := helperUpgradeAllowed(tc.target, tc.installed)
			if allowed != tc.wantAllowed {
				t.Fatalf("helperUpgradeAllowed(%q, %q) allowed = %v, want %v (reason=%q)",
					tc.target, tc.installed, allowed, tc.wantAllowed, reason)
			}
			if tc.wantReason && reason == "" {
				t.Fatalf("helperUpgradeAllowed(%q, %q) refused without a reason", tc.target, tc.installed)
			}
			if !tc.wantReason && reason != "" {
				t.Fatalf("helperUpgradeAllowed(%q, %q) allowed but returned reason %q", tc.target, tc.installed, reason)
			}
		})
	}
}
