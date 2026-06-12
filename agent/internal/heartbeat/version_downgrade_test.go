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
		name            string
		target          string
		installed       string
		installedOnDisk bool
		wantAllowed     bool
		wantReason      bool // expect a non-empty refusal reason
	}{
		// Downgrades refused (the MUST-FIX: replayed older signed release).
		{name: "downgrade patch refused", target: "0.68.1", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "downgrade minor refused", target: "0.67.9", installed: "0.68.0", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "downgrade major refused", target: "0.99.9", installed: "1.0.0", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "v-prefix downgrade refused", target: "v0.68.1", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},

		// Upgrades allowed.
		{name: "upgrade patch allowed", target: "0.68.3", installed: "0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "upgrade minor allowed", target: "0.69.0", installed: "0.68.9", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "upgrade major allowed", target: "1.0.0", installed: "0.99.9", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "v-prefix upgrade allowed", target: "v0.69.0", installed: "v0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},

		// Equal version allowed through (CheckUpdate/applyPendingUpdate
		// already no-op when installed == target).
		{name: "same version allowed", target: "0.68.2", installed: "0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},

		// Fresh install: no helper installed yet (not on disk) — not a downgrade.
		{name: "fresh install empty installed allowed", target: "0.68.2", installed: "", installedOnDisk: false, wantAllowed: true, wantReason: false},
		{name: "fresh install whitespace installed allowed", target: "0.68.2", installed: "   ", installedOnDisk: false, wantAllowed: true, wantReason: false},

		// SECURITY (the fix): helper present on disk but version unreadable.
		// Empty version + on-disk must FAIL CLOSED — we cannot prove the
		// directive isn't a downgrade replay.
		{name: "on-disk but version unreadable refused", target: "0.68.2", installed: "", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "on-disk but version whitespace refused", target: "0.68.2", installed: "   ", installedOnDisk: true, wantAllowed: false, wantReason: true},

		// Malformed versions fail closed (unlike agent-path isDowngrade).
		{name: "malformed target refused", target: "dev", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "empty target refused", target: "", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "two-part target refused", target: "0.68", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "malformed installed refused", target: "0.68.3", installed: "dev", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "both malformed refused", target: "dev", installed: "dev", installedOnDisk: true, wantAllowed: false, wantReason: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			allowed, reason := helperUpgradeAllowed(tc.target, tc.installed, tc.installedOnDisk)
			if allowed != tc.wantAllowed {
				t.Fatalf("helperUpgradeAllowed(%q, %q, %v) allowed = %v, want %v (reason=%q)",
					tc.target, tc.installed, tc.installedOnDisk, allowed, tc.wantAllowed, reason)
			}
			if tc.wantReason && reason == "" {
				t.Fatalf("helperUpgradeAllowed(%q, %q, %v) refused without a reason", tc.target, tc.installed, tc.installedOnDisk)
			}
			if !tc.wantReason && reason != "" {
				t.Fatalf("helperUpgradeAllowed(%q, %q, %v) allowed but returned reason %q", tc.target, tc.installed, tc.installedOnDisk, reason)
			}
		})
	}
}
