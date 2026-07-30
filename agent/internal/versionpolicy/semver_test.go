package versionpolicy

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{"bare triple gets v added", "1.2.3", "v1.2.3", true},
		{"optional v accepted", "v1.2.3", "v1.2.3", true},
		{"surrounding whitespace trimmed", "  1.2.3  ", "v1.2.3", true},
		{"surrounding whitespace trimmed with v", "  v1.2.3  ", "v1.2.3", true},
		{"prerelease preserved", "1.2.3-rc1", "v1.2.3-rc1", true},
		{"build metadata preserved", "1.2.3+build5", "v1.2.3+build5", true},
		{"prerelease and build preserved", "1.2.3-rc1+build5", "v1.2.3-rc1+build5", true},
		{"uppercase V rejected", "V1.2.3", "", false},
		{"double v rejected", "vv1.2.3", "", false},
		{"leading zero in minor rejected", "1.02.3", "", false},
		{"leading zero in major rejected", "01.2.3", "", false},
		{"leading zero in patch rejected", "1.2.03", "", false},
		{"extra segment rejected", "1.2.3.4", "", false},
		// golang.org/x/mod/semver.IsValid accepts the abbreviated major.minor
		// form (missing components implicitly zero) — Normalize defers to it
		// rather than imposing a stricter three-segment rule the brief does
		// not ask for.
		{"two segments accepted per semver.IsValid", "1.2", "v1.2", true},
		{"empty string rejected", "", "", false},
		{"whitespace only rejected", "   ", "", false},
		{"non-semver word rejected", "dev", "", false},
		{"garbage rejected", "not-a-version", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Normalize(tc.raw)
			if ok != tc.ok {
				t.Fatalf("Normalize(%q) ok = %v, want %v (got %q)", tc.raw, ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestDecide(t *testing.T) {
	cases := []struct {
		name       string
		target     string
		current    string
		policy     CurrentPolicy
		wantAllow  bool
		wantReason string
	}{
		// Malformed target denies for every policy, regardless of current or dev.
		{"malformed target denies main agent", "garbage", "0.68.2", MainAgentCurrent, false, "invalid_target"},
		{"malformed target denies even with dev current", "garbage", "dev", MainAgentCurrent, false, "invalid_target"},
		{"malformed target denies helper", "garbage", "0.68.2", InstalledComponentCurrent, false, "invalid_target"},
		{"malformed target denies absent component", "garbage", "", AbsentComponentCurrent, false, "invalid_target"},
		{"empty target denies", "", "0.68.2", MainAgentCurrent, false, "invalid_target"},
		{"extra segment target denies", "1.2.3.4", "1.2.3", MainAgentCurrent, false, "invalid_target"},
		{"leading zero target denies", "1.02.3", "1.2.3", MainAgentCurrent, false, "invalid_target"},

		// The main agent's "dev" build compatibility exception.
		{"dev main current allows valid target", "1.2.3", "dev", MainAgentCurrent, true, "development_current"},
		{"dev main current allows valid target with v-prefix", "v1.2.3", "dev", MainAgentCurrent, true, "development_current"},

		// Any other malformed current (not the dev/main-agent exception, not
		// absent) fails closed.
		{"malformed non-dev main current denies", "1.2.3", "not-a-version", MainAgentCurrent, false, "invalid_current"},
		{"empty main current denies (not dev)", "1.2.3", "", MainAgentCurrent, false, "invalid_current"},
		{"unreadable installed helper denies", "0.68.2", "", InstalledComponentCurrent, false, "invalid_current"},
		{"malformed installed component denies", "0.68.2", "dev", InstalledComponentCurrent, false, "invalid_current"},

		// Absent component (fresh install) allows any valid target.
		{"absent helper allows fresh install", "0.68.2", "", AbsentComponentCurrent, true, "fresh_install"},
		{"absent helper allows fresh install ignoring current text", "0.68.2", "whatever-is-here", AbsentComponentCurrent, true, "fresh_install"},

		// Downgrade precedence, including SemVer prerelease ordering that the
		// old numeric-tuple parser got wrong.
		{"older patch denies", "0.68.1", "0.68.2", MainAgentCurrent, false, "downgrade"},
		{"older minor denies", "0.67.9", "0.68.0", MainAgentCurrent, false, "downgrade"},
		{"older major denies", "0.99.9", "1.0.0", MainAgentCurrent, false, "downgrade"},
		{"stable to prerelease of same version denies", "1.2.3-rc1", "1.2.3", MainAgentCurrent, false, "downgrade"},
		{"lower prerelease denies", "1.2.3-alpha", "1.2.3-beta", MainAgentCurrent, false, "downgrade"},

		// Upgrades and equal versions allow, including prerelease -> stable of
		// the same version number, which is a real precedence increase.
		{"newer patch allows", "0.68.3", "0.68.2", MainAgentCurrent, true, "same_or_upgrade"},
		{"newer major allows", "1.0.0", "0.99.9", MainAgentCurrent, true, "same_or_upgrade"},
		{"prerelease to stable of same version allows", "1.2.3", "1.2.3-rc1", MainAgentCurrent, true, "same_or_upgrade"},
		{"higher prerelease allows", "1.2.3-beta", "1.2.3-alpha", MainAgentCurrent, true, "same_or_upgrade"},
		{"equal version allows", "0.68.2", "0.68.2", MainAgentCurrent, true, "same_or_upgrade"},
		{"build metadata ignored for equality", "1.2.3+build2", "1.2.3+build1", MainAgentCurrent, true, "same_or_upgrade"},
		{"v-prefix optional on both sides", "v0.69.0", "0.68.2", InstalledComponentCurrent, true, "same_or_upgrade"},

		// Watchdog parity: the watchdog's "current" is the running agent's own
		// version, but the watchdog decision must NOT receive the main-agent
		// dev exception — it goes through InstalledComponentCurrent like the
		// helper, so an agent dev build still fails closed for the watchdog.
		{"watchdog denies dev current (no main-agent exception)", "1.2.3", "dev", InstalledComponentCurrent, false, "invalid_current"},
		{"watchdog allows upgrade over stale on-disk version", "0.83.0", "0.82.1", InstalledComponentCurrent, true, "same_or_upgrade"},
		{"watchdog denies downgrade", "0.69.0", "0.82.1", InstalledComponentCurrent, false, "downgrade"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.target, tc.current, tc.policy)
			if got.Allowed != tc.wantAllow {
				t.Fatalf("Decide(%q, %q, %v).Allowed = %v, want %v (reason=%q)",
					tc.target, tc.current, tc.policy, got.Allowed, tc.wantAllow, got.Reason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("Decide(%q, %q, %v).Reason = %q, want %q",
					tc.target, tc.current, tc.policy, got.Reason, tc.wantReason)
			}
		})
	}
}
