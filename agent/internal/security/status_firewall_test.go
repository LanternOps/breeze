package security

import "testing"

// interpretFirewallState is the pure mapping from a firewall tool's stdout
// to (enabled, known). Table-driven across every row of the behavior
// table in PR #751 plus the ufw-active-but-firewall-cmd-present case that
// motivated the change.
func TestInterpretFirewallState(t *testing.T) {
	cases := []struct {
		name        string
		tool        string
		state       string
		wantEnabled bool
		wantKnown   bool
	}{
		// ufw — substring match on multiline output (the actual `ufw status` output).
		{"ufw active", "ufw", "Status: active\nLogging: on (low)\n", true, true},
		{"ufw inactive", "ufw", "Status: inactive", false, true},
		{
			"ufw active with rules",
			"ufw",
			"Status: active\n\nTo                         Action      From\n--                         ------      ----\n22                         ALLOW       Anywhere",
			true,
			true,
		},
		{"ufw unrecognized output", "ufw", "ERROR: ufw needs root privileges", false, false},
		{"ufw empty", "ufw", "", false, false},
		{"ufw whitespace only", "ufw", "   \n\t  ", false, false},

		// firewall-cmd — exact-token match.
		{"firewall-cmd running", "firewall-cmd", "running", true, true},
		{"firewall-cmd not running", "firewall-cmd", "not running", false, true},
		{
			// The actual production-incident case: bus/permission error
			// trimmed into the state string. Must NOT match "not running"
			// or "running" — caller falls through.
			"firewall-cmd bus error",
			"firewall-cmd",
			"Failed to connect to bus: No such file or directory",
			false,
			false,
		},
		{
			"firewall-cmd not running prefix (deploy-drift hardening)",
			"firewall-cmd",
			"not running\nWarning: irrelevant",
			false,
			false,
		},
		{"firewall-cmd capital R", "firewall-cmd", "Running", false, false},
		{"firewall-cmd empty", "firewall-cmd", "", false, false},

		// systemctl is-active — exact-token match.
		{"systemctl active", "systemctl", "active", true, true},
		{"systemctl inactive", "systemctl", "inactive", false, true},
		{"systemctl failed", "systemctl", "failed", false, true},
		{"systemctl activating", "systemctl", "activating", false, false},
		{"systemctl unknown unit", "systemctl", "inactive\nFailed to enable", false, false},

		// Unknown tool name — always unknown, no panic.
		{"unknown tool — anything", "iptables", "anything", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotEnabled, gotKnown := interpretFirewallState(tc.tool, tc.state)
			if gotEnabled != tc.wantEnabled || gotKnown != tc.wantKnown {
				t.Fatalf(
					"interpretFirewallState(%q, %q) = (enabled=%v, known=%v); want (enabled=%v, known=%v)",
					tc.tool, tc.state, gotEnabled, gotKnown, tc.wantEnabled, tc.wantKnown,
				)
			}
		})
	}
}

// Regression guard for the exact production case from PR #751 review:
//
//	"On a host where ufw is the active backend but firewall-cmd is installed
//	 (firewalld pkg present, masked/inactive — very common on Ubuntu/Debian),
//	 firewall-cmd --state prints 'not running' / 'failed to connect to bus'
//	 and detection now returns (false, nil) — reporting an active firewall as
//	 disabled, silently, with no error."
//
// The fix path: a non-zero exit from firewall-cmd (the case in the incident)
// makes firewallStatusFromCommand return zeroExit=false, which makes
// getFirewallStatusLinux skip the interpretation and fall through to the
// next probe or the final unknown-error path. We cannot exec firewall-cmd
// here (CI doesn't have firewalld + masked) so this test pins the half
// that's testable in isolation: the interpreter never bridges the bus-error
// message to a confident `false`.
func TestInterpretFirewallState_BusErrorDoesNotMatchNotRunning(t *testing.T) {
	// These are the shapes the production incident actually produced. None
	// should bridge to a confident answer.
	for _, busError := range []string{
		"Failed to connect to bus: No such file or directory",
		"NotRunning",   // case mismatch
		"not running yet",
		"not running\nWarning: irrelevant",
	} {
		_, known := interpretFirewallState("firewall-cmd", busError)
		if known {
			t.Errorf("interpretFirewallState(firewall-cmd, %q) = known=true; want known=false (production bus-error shape)", busError)
		}
	}
	// Sanity counter-check: the genuinely-correct "not running" with a
	// trailing newline (the literal command output) IS trimmed and matches.
	// This is the *correct* path; the regression guard above is just for
	// the ambiguous shapes.
	if enabled, known := interpretFirewallState("firewall-cmd", "not running\n"); !known || enabled {
		t.Errorf("trailing-newline trim regression: got (%v, %v)", enabled, known)
	}
}
