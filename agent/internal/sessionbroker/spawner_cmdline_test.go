package sessionbroker

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
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
		role       ipc.HelperRole
		wantSubstr string
	}{
		{"system", "--role system"},
		{"user", "--role user"},
	}
	for _, tc := range cases {
		t.Run(string(tc.role), func(t *testing.T) {
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

func TestSpawnedHelperDiagnosticsRetainRoleProvenance(t *testing.T) {
	helper := &SpawnedHelper{
		PID:                42,
		BinaryPath:         `C:\Program Files\Breeze\breeze-agent.exe`,
		CommandMode:        "user-helper",
		Role:               "user",
		WindowsSessionID:   7,
		MainBinaryFallback: true,
	}

	if helper.CommandMode != "user-helper" || helper.Role != "user" || helper.WindowsSessionID != 7 {
		t.Fatalf("spawn role provenance = command:%q role:%q session:%d", helper.CommandMode, helper.Role, helper.WindowsSessionID)
	}
	if helper.BinaryPath != `C:\Program Files\Breeze\breeze-agent.exe` || !helper.MainBinaryFallback {
		t.Fatalf("spawn executable provenance = path:%q fallback:%v", helper.BinaryPath, helper.MainBinaryFallback)
	}
}

// TestHelperRoleSpawnableRejectsNonLifecycleRoles guards the privilege boundary
// in the spawn path. The role selects the token: before this gate,
// createHelperSuspended sent anything that was not exactly "user" down the
// SYSTEM-token branch, so a zero-value HelperKey (Role: "") or a misspelled
// role silently escalated to SYSTEM.
func TestHelperRoleSpawnableRejectsNonLifecycleRoles(t *testing.T) {
	tests := []struct {
		name string
		role ipc.HelperRole
		want bool
	}{
		{"system role spawnable", ipc.HelperRoleSystem, true},
		{"user role spawnable", ipc.HelperRoleUser, true},
		{"zero-value role is not spawnable", "", false},
		{"wrong case is not spawnable", "User", false},
		{"assist is not a lifecycle role", ipc.HelperRoleAssist, false},
		{"watchdog is not a lifecycle role", ipc.HelperRoleWatchdog, false},
		{"unknown role is not spawnable", "banana", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := helperRoleSpawnable(tc.role); got != tc.want {
				t.Fatalf("helperRoleSpawnable(%q) = %v, want %v", tc.role, got, tc.want)
			}
		})
	}
}
