package tools

import (
	"runtime"
	"slices"
	"strconv"
	"testing"
)

// The `delay` payload for reboot/shutdown is MINUTES on every platform
// (docs/agents/commands.mdx). Windows `shutdown /t` takes seconds, so the
// Windows branch must scale by 60; linux/darwin `shutdown +N` is already
// minutes. Regression coverage for issue #3252, where a `delay: 15` rebooted
// Linux in 15 minutes and Windows in 15 seconds.
func TestShutdownArgs_PerPlatformArgv(t *testing.T) {
	tests := []struct {
		name        string
		goos        string
		isReboot    bool
		delayMinute int
		wantArgs    []string
	}{
		// ── Windows: minutes → seconds ──────────────────────────────────────
		{"windows reboot immediate", "windows", true, 0, []string{"/r", "/t", "0"}},
		{"windows reboot 1min", "windows", true, 1, []string{"/r", "/t", "60"}},
		{"windows reboot 15min", "windows", true, 15, []string{"/r", "/t", "900"}},
		{"windows shutdown immediate", "windows", false, 0, []string{"/s", "/t", "0"}},
		{"windows shutdown 15min", "windows", false, 15, []string{"/s", "/t", "900"}},
		{"windows reboot max 1440min", "windows", true, 1440, []string{"/r", "/t", "86400"}},

		// ── linux/darwin: minutes passed through ────────────────────────────
		{"linux reboot immediate", "linux", true, 0, []string{"-r", "+0"}},
		{"linux reboot 15min", "linux", true, 15, []string{"-r", "+15"}},
		{"linux shutdown 15min", "linux", false, 15, []string{"-h", "+15"}},
		{"linux reboot max 1440min", "linux", true, 1440, []string{"-r", "+1440"}},
		{"darwin reboot 15min", "darwin", true, 15, []string{"-r", "+15"}},
		{"darwin shutdown immediate", "darwin", false, 0, []string{"-h", "+0"}},

		// ── clamping happens before conversion ──────────────────────────────
		{"windows negative clamps to 0", "windows", true, -5, []string{"/r", "/t", "0"}},
		{"linux negative clamps to 0", "linux", true, -5, []string{"-r", "+0"}},
		{"windows over-max clamps to 1440", "windows", true, 99999, []string{"/r", "/t", "86400"}},
		{"linux over-max clamps to 1440", "linux", true, 99999, []string{"-r", "+1440"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			name, args, err := shutdownArgs(tt.goos, tt.isReboot, tt.delayMinute)
			if err != nil {
				t.Fatalf("shutdownArgs(%q, %v, %d): unexpected error %v",
					tt.goos, tt.isReboot, tt.delayMinute, err)
			}
			if name != "shutdown" {
				t.Errorf("binary: got %q, want %q", name, "shutdown")
			}
			if !slices.Equal(args, tt.wantArgs) {
				t.Errorf("argv: got %v, want %v", args, tt.wantArgs)
			}
		})
	}
}

// The same delay must resolve to the same wall-clock time on every supported
// platform. This is the invariant issue #3252 violated.
func TestShutdownArgs_DelayIsMinutesOnEveryPlatform(t *testing.T) {
	for _, delayMinutes := range []int{0, 1, 5, 15, 60, 1440} {
		t.Run(strconv.Itoa(delayMinutes)+"min", func(t *testing.T) {
			_, winArgs, err := shutdownArgs("windows", true, delayMinutes)
			if err != nil {
				t.Fatalf("windows: %v", err)
			}
			// Windows argv is [action, "/t", seconds].
			winSeconds, err := strconv.Atoi(winArgs[2])
			if err != nil {
				t.Fatalf("windows /t value %q is not an integer: %v", winArgs[2], err)
			}

			for _, goos := range []string{"linux", "darwin"} {
				_, args, err := shutdownArgs(goos, true, delayMinutes)
				if err != nil {
					t.Fatalf("%s: %v", goos, err)
				}
				// Unix argv is [action, "+minutes"].
				unixMinutes, err := strconv.Atoi(args[1][1:])
				if err != nil {
					t.Fatalf("%s delay %q is not a +integer: %v", goos, args[1], err)
				}
				if unixMinutes*60 != winSeconds {
					t.Errorf("delay %d min: %s schedules %d s but windows schedules %d s",
						delayMinutes, goos, unixMinutes*60, winSeconds)
				}
			}
		})
	}
}

func TestShutdownArgs_UnsupportedOS(t *testing.T) {
	for _, goos := range []string{"freebsd", "plan9", ""} {
		t.Run("goos="+goos, func(t *testing.T) {
			name, args, err := shutdownArgs(goos, true, 15)
			if err == nil {
				t.Fatalf("expected error for goos %q, got name=%q args=%v", goos, name, args)
			}
			if name != "" || args != nil {
				t.Errorf("expected zero-value argv on error, got name=%q args=%v", name, args)
			}
		})
	}
}

func TestClampShutdownDelayMinutes(t *testing.T) {
	tests := []struct {
		in   int
		want int
	}{
		{-1000, 0},
		{-1, 0},
		{0, 0},
		{15, 15},
		{1440, 1440},
		{1441, 1440},
		{1 << 30, 1440},
	}

	for _, tt := range tests {
		if got := clampShutdownDelayMinutes(tt.in); got != tt.want {
			t.Errorf("clampShutdownDelayMinutes(%d): got %d, want %d", tt.in, got, tt.want)
		}
	}
}

// buildShutdownCommand must delegate to shutdownArgs for the host platform
// rather than constructing argv independently.
func TestBuildShutdownCommand_MatchesShutdownArgsForHostOS(t *testing.T) {
	const delayMinutes = 15

	wantName, wantArgs, wantErr := shutdownArgs(runtime.GOOS, true, delayMinutes)

	cmd, err := buildShutdownCommand(true, delayMinutes)
	if wantErr != nil {
		if err == nil {
			t.Fatalf("expected error on unsupported host %q, got cmd %v", runtime.GOOS, cmd)
		}
		return
	}
	if err != nil {
		t.Fatalf("buildShutdownCommand: %v", err)
	}

	// exec.Cmd.Args[0] is the binary name; the remainder is the argv tail.
	if len(cmd.Args) == 0 || cmd.Args[0] != wantName {
		t.Fatalf("argv[0]: got %v, want %q", cmd.Args, wantName)
	}
	if !slices.Equal(cmd.Args[1:], wantArgs) {
		t.Errorf("argv tail: got %v, want %v", cmd.Args[1:], wantArgs)
	}
}
