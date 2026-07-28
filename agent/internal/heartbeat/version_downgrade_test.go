package heartbeat

import "testing"

// TestMainAgentUpgradeDecision exercises the agent self-update adapter over
// versionpolicy.Decide with MainAgentCurrent — the only policy granted the
// "dev" build development-compatibility exception. SECURITY: unlike the old
// numeric-tuple isDowngrade, a malformed non-"dev" current now fails CLOSED
// (previously fail-open let a corrupted/garbage current slip an update
// through unchecked).
func TestMainAgentUpgradeDecision(t *testing.T) {
	cases := []struct {
		name       string
		target     string
		current    string
		wantAllow  bool
		wantReason string
	}{
		{"older patch denied", "0.68.1", "0.68.2", false, "downgrade"},
		{"older minor denied", "0.67.9", "0.68.0", false, "downgrade"},
		{"older major denied", "0.99.9", "1.0.0", false, "downgrade"},
		{"same version allowed", "0.68.2", "0.68.2", true, "same_or_upgrade"},
		{"newer patch allowed", "0.68.3", "0.68.2", true, "same_or_upgrade"},
		{"newer minor allowed", "0.69.0", "0.68.9", true, "same_or_upgrade"},
		{"newer major allowed", "1.0.0", "0.99.9", true, "same_or_upgrade"},
		{"v-prefix older denied", "v0.68.1", "0.68.2", false, "downgrade"},
		{"v-prefix newer allowed", "v0.69.0", "v0.68.2", true, "same_or_upgrade"},

		// SECURITY (the fix): the old parser ignored prerelease/build suffixes
		// entirely, so a stable-to-prerelease "downgrade" of the same release
		// line was indistinguishable from "same version". Real SemVer
		// precedence must now catch it.
		{"prerelease suffix now compared, older patch line", "0.68.1-rc1", "0.68.2", false, "downgrade"},
		{"prerelease suffix now compared, newer patch line", "0.69.0-rc1", "0.68.2", true, "same_or_upgrade"},
		{"stable to prerelease of same version denied", "0.68.2-rc1", "0.68.2", false, "downgrade"},
		{"prerelease to stable of same version allowed", "0.68.2", "0.68.2-rc1", true, "same_or_upgrade"},

		// The "dev" build exception: only literal current == "dev".
		{"dev current allows a valid target", "0.68.2", "dev", true, "development_current"},

		// SECURITY (the fix): any OTHER malformed current now fails closed,
		// where the old fail-open isDowngrade would silently let the update
		// proceed because it could not "prove" a downgrade.
		{"malformed non-dev current denied", "0.68.2", "garbage", false, "invalid_current"},
		{"empty current denied", "0.68.2", "", false, "invalid_current"},

		// Malformed target always denies, including against a dev current.
		{"malformed target denied", "garbage", "0.68.2", false, "invalid_target"},
		{"empty target denied", "", "0.68.2", false, "invalid_target"},
		{"malformed target denied even against dev current", "garbage", "dev", false, "invalid_target"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mainAgentUpgradeDecision(tc.target, tc.current)
			if got.Allowed != tc.wantAllow {
				t.Fatalf("mainAgentUpgradeDecision(%q, %q).Allowed = %v, want %v (reason=%q)",
					tc.target, tc.current, got.Allowed, tc.wantAllow, got.Reason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("mainAgentUpgradeDecision(%q, %q).Reason = %q, want %q",
					tc.target, tc.current, got.Reason, tc.wantReason)
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

		// SECURITY: a stable-to-prerelease downgrade of the same release line
		// must be refused — the vulnerability this task closes.
		{name: "stable to prerelease of same version refused", target: "0.68.2-rc1", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},

		// Upgrades allowed.
		{name: "upgrade patch allowed", target: "0.68.3", installed: "0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "upgrade minor allowed", target: "0.69.0", installed: "0.68.9", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "upgrade major allowed", target: "1.0.0", installed: "0.99.9", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "v-prefix upgrade allowed", target: "v0.69.0", installed: "v0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},
		{name: "prerelease to stable of same version allowed", target: "0.68.2", installed: "0.68.2-rc1", installedOnDisk: true, wantAllowed: true, wantReason: false},

		// Equal version allowed through (CheckUpdate/applyPendingUpdate
		// already no-op when installed == target).
		{name: "same version allowed", target: "0.68.2", installed: "0.68.2", installedOnDisk: true, wantAllowed: true, wantReason: false},

		// Fresh install: no helper installed yet (not on disk) — not a downgrade.
		{name: "fresh install empty installed allowed", target: "0.68.2", installed: "", installedOnDisk: false, wantAllowed: true, wantReason: false},
		{name: "fresh install whitespace installed allowed", target: "0.68.2", installed: "   ", installedOnDisk: false, wantAllowed: true, wantReason: false},

		// SECURITY (the fix this preserves): helper present on disk but version
		// unreadable. Empty version + on-disk must FAIL CLOSED — we cannot
		// prove the directive isn't a downgrade replay. This must use
		// InstalledComponentCurrent, NOT the fresh-install policy.
		{name: "on-disk but version unreadable refused", target: "0.68.2", installed: "", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "on-disk but version whitespace refused", target: "0.68.2", installed: "   ", installedOnDisk: true, wantAllowed: false, wantReason: true},

		// Malformed versions fail closed.
		{name: "malformed target refused", target: "dev", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "empty target refused", target: "", installed: "0.68.2", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "malformed installed refused", target: "0.68.3", installed: "dev", installedOnDisk: true, wantAllowed: false, wantReason: true},
		{name: "both malformed refused", target: "dev", installed: "dev", installedOnDisk: true, wantAllowed: false, wantReason: true},

		// The helper never receives the main-agent "dev" exception: an
		// installed version literally reading "dev" is just as unprovable as
		// any other malformed current.
		{name: "installed dev refused, no main-agent exception", target: "0.68.3", installed: "dev", installedOnDisk: true, wantAllowed: false, wantReason: true},
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

// TestWatchdogUpgradeDecision_NoMainAgentException locks in watchdog parity
// with the helper: the watchdog's "current" is the running agent's own
// version, but it must go through InstalledComponentCurrent, not
// MainAgentCurrent — an agent dev build does not waive the watchdog's
// downgrade guard the way it waives its own self-update guard.
func TestWatchdogUpgradeDecision_NoMainAgentException(t *testing.T) {
	got := watchdogUpgradeDecision("0.68.2", "dev")
	if got.Allowed {
		t.Fatalf("watchdogUpgradeDecision(%q, %q) = %+v, want denied (no main-agent dev exception)", "0.68.2", "dev", got)
	}
	if got.Reason != "invalid_current" {
		t.Fatalf("watchdogUpgradeDecision(%q, %q).Reason = %q, want invalid_current", "0.68.2", "dev", got.Reason)
	}
}
