package sessionbroker

import (
	"strings"
	"testing"
)

// TestBuildUserHelperCmdLine_AlwaysExplicitRole guards against the spawn-path
// regressions that have shipped twice now:
//
//   - PR #549 (v0.64.x): Scheduled Task on Windows ran user-helper without
//     --role, inherited cobra default "system", and crash-looped because the
//     task identity was BUILTIN\Users (not SYSTEM). Fix: cobra default
//     flipped to "user".
//   - v0.64.3 mirror bug: SpawnHelperInSession (SYSTEM-context capture
//     helper) also omitted --role, so flipping the cobra default sent it the
//     wrong role and the SYSTEM helper crash-looped with "user role requires
//     non-SYSTEM identity".
//
// Both spawn paths must always pass --role explicitly so the cobra default is
// never load-bearing again.
func TestBuildUserHelperCmdLine_AlwaysExplicitRole(t *testing.T) {
	cases := []struct {
		role       string
		wantSubstr string
	}{
		{"system", "--role system"},
		{"user", "--role user"},
	}
	for _, tc := range cases {
		t.Run(tc.role, func(t *testing.T) {
			got := buildUserHelperCmdLine(`C:\Program Files\Breeze\breeze-agent.exe`, tc.role)
			if !strings.Contains(got, tc.wantSubstr) {
				t.Fatalf("cmdline missing %q: got %q", tc.wantSubstr, got)
			}
			if !strings.Contains(got, "user-helper") {
				t.Fatalf("cmdline missing user-helper subcommand: got %q", got)
			}
			// Quoting around the exe path matters — the path contains a space.
			if !strings.HasPrefix(got, `"C:\Program Files\Breeze\breeze-agent.exe"`) {
				t.Fatalf("exe path not quoted: got %q", got)
			}
		})
	}
}
