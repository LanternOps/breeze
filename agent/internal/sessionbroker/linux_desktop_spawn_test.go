package sessionbroker

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

const testSpawnTicket = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 43 base64url chars

func validSpawnSpec() LinuxDesktopSpawnSpec {
	return LinuxDesktopSpawnSpec{
		Binding:        LinuxDesktopBinding{UID: 1000, Username: "alice", LogindSessionID: "3", Generation: 7},
		Ticket:         testSpawnTicket,
		AgentExe:       "/usr/local/bin/breeze-agent",
		SocketPath:     "/run/breeze/desktop/1000.sock",
		RuntimeDir:     "/run/user/1000",
		WaylandDisplay: "wayland-0",
	}
}

func TestBuildSystemdRunArgv_Exact(t *testing.T) {
	spec := validSpawnSpec()
	unit := "breeze-desktop-helper-3-g7-0a0b0c0d.service"
	got := buildSystemdRunArgv(spec, unit)
	want := []string{
		"-M", "alice@", "--user", "--collect", "--quiet",
		"--unit=" + unit, "--service-type=exec",
		"--property=NoNewPrivileges=yes",
		"--setenv=XDG_RUNTIME_DIR=/run/user/1000",
		"--setenv=WAYLAND_DISPLAY=wayland-0",
		"--setenv=XDG_SESSION_ID=3",
		"--setenv=XDG_SESSION_TYPE=wayland",
		"--setenv=BREEZE_LOGIND_SESSION=3",
		// The ticket is passed through systemd-run's own environment, never
		// argv: a process command line is readable by every local user.
		"--setenv=BREEZE_SPAWN_TICKET",
		"--setenv=BREEZE_IPC_SOCKET=/run/breeze/desktop/1000.sock",
		"--", "/usr/local/bin/breeze-agent", "desktop-helper",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("argv mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestBuildSystemdRunArgv_NoPipeOrWait(t *testing.T) {
	for _, arg := range buildSystemdRunArgv(validSpawnSpec(), "u.service") {
		for _, banned := range []string{"--pipe", "--wait", "--pty", "-P", "-t", "--scope", "import-environment"} {
			if arg == banned || strings.HasPrefix(arg, banned+"=") {
				t.Fatalf("argv contains %q", arg)
			}
		}
	}
}

func TestBuildSystemctlStopArgv(t *testing.T) {
	got := buildSystemctlStopArgv("alice", "breeze-desktop-helper-3-g7-0a0b0c0d.service")
	want := []string{"-M", "alice@", "--user", "stop", "breeze-desktop-helper-3-g7-0a0b0c0d.service"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestBuildSystemctlListUnitsArgv(t *testing.T) {
	got := buildSystemctlListUnitsArgv("alice")
	want := []string{"-M", "alice@", "--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager", "breeze-desktop-helper-*"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestValidLinuxUsername_RejectsRootAndMetachars(t *testing.T) {
	for _, ok := range []string{"alice", "a.b", "_svc", "user-1", "A9", strings.Repeat("a", 64)} {
		if !validLinuxUsername(ok) {
			t.Errorf("validLinuxUsername(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"root", "", "a b", "x;y", "-flag", strings.Repeat("a", 65), "a@b", "a/b", ".", "..", "a\nb", "$(id)"} {
		if validLinuxUsername(bad) {
			t.Errorf("validLinuxUsername(%q) = true, want false", bad)
		}
	}
}

func TestLinuxDesktopUnitName_Sanitized(t *testing.T) {
	got := linuxDesktopUnitName("c12", 42, [4]byte{0xde, 0xad, 0xbe, 0xef})
	if got != "breeze-desktop-helper-c12-g42-deadbeef.service" {
		t.Fatalf("unit = %q", got)
	}
	if !isLinuxDesktopUnitName(got) {
		t.Fatalf("isLinuxDesktopUnitName(%q) = false", got)
	}
	// An id outside [A-Za-z0-9] must never reach a unit name.
	if got := linuxDesktopUnitName("3;rm", 1, [4]byte{}); got != "" {
		t.Fatalf("unit for invalid id = %q, want empty", got)
	}
	for _, bad := range []string{"", "breeze-desktop-helper-3-g1-00000000.service;x", "other.service",
		"breeze-desktop-helper-3-g1-0000000.service", "breeze-desktop-helper--g1-00000000.service",
		"breeze-desktop-helper-3-g-00000000.service", "breeze-desktop-helper-3-g1-0000000G.service"} {
		if isLinuxDesktopUnitName(bad) {
			t.Errorf("isLinuxDesktopUnitName(%q) = true", bad)
		}
	}
}

func TestSystemdMajorVersion_Parse(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"systemd 255 (255.4-1ubuntu8)\n+PAM +AUDIT\n", 255, true},
		{"systemd 248\n", 248, true},
		{"systemd 249 (249.11-0ubuntu3.12)", 249, true},
		{"", 0, false},
		{"garbage", 0, false},
		{"systemd x (1)", 0, false},
		{"systemd -5", 0, false},
		{"notsystemd 255", 0, false},
	}
	for _, tc := range cases {
		got, err := systemdMajorVersion(tc.in)
		if tc.ok != (err == nil) || got != tc.want {
			t.Errorf("systemdMajorVersion(%q) = %d, %v; want %d ok=%v", tc.in, got, err, tc.want, tc.ok)
		}
	}
}

func TestValidateLinuxDesktopSpawnSpec(t *testing.T) {
	if err := validateLinuxDesktopSpawnSpec(validSpawnSpec()); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	mutations := map[string]func(*LinuxDesktopSpawnSpec){
		"root uid":             func(s *LinuxDesktopSpawnSpec) { s.Binding.UID = 0 },
		"root user":            func(s *LinuxDesktopSpawnSpec) { s.Binding.Username = "root" },
		"bad user":             func(s *LinuxDesktopSpawnSpec) { s.Binding.Username = "a b" },
		"bad session":          func(s *LinuxDesktopSpawnSpec) { s.Binding.LogindSessionID = "3 4" },
		"zero gen":             func(s *LinuxDesktopSpawnSpec) { s.Binding.Generation = 0 },
		"short ticket":         func(s *LinuxDesktopSpawnSpec) { s.Ticket = testSpawnTicket[:42] },
		"ticket alphabet":      func(s *LinuxDesktopSpawnSpec) { s.Ticket = testSpawnTicket[:42] + "+" },
		"relative exe":         func(s *LinuxDesktopSpawnSpec) { s.AgentExe = "breeze-agent" },
		"windows exe":          func(s *LinuxDesktopSpawnSpec) { s.AgentExe = `C:\breeze\breeze-agent.exe` },
		"windows socket":       func(s *LinuxDesktopSpawnSpec) { s.SocketPath = `C:\run\breeze\desktop\1000.sock` },
		"exe with dots":        func(s *LinuxDesktopSpawnSpec) { s.AgentExe = "/usr/../tmp/breeze-agent" },
		"socket other uid":     func(s *LinuxDesktopSpawnSpec) { s.SocketPath = "/run/breeze/desktop/1001.sock" },
		"socket outside":       func(s *LinuxDesktopSpawnSpec) { s.SocketPath = "/tmp/1000.sock" },
		"runtime dir mismatch": func(s *LinuxDesktopSpawnSpec) { s.RuntimeDir = "/run/user/1001" },
		"wayland display bad":  func(s *LinuxDesktopSpawnSpec) { s.WaylandDisplay = "../x" },
		"wayland display long": func(s *LinuxDesktopSpawnSpec) { s.WaylandDisplay = strings.Repeat("w", 65) },
		"wayland display none": func(s *LinuxDesktopSpawnSpec) { s.WaylandDisplay = "" },
	}
	for name, mutate := range mutations {
		spec := validSpawnSpec()
		mutate(&spec)
		err := validateLinuxDesktopSpawnSpec(spec)
		if !errors.Is(err, ErrLinuxDesktopSpawnSpecInvalid) {
			t.Errorf("%s: err = %v, want ErrLinuxDesktopSpawnSpecInvalid", name, err)
		}
		if err != nil && strings.Contains(err.Error(), testSpawnTicket[:20]) {
			t.Errorf("%s: error leaks the ticket: %v", name, err)
		}
	}
}

func TestBuildSystemdRunArgv_TicketNotInArgv(t *testing.T) {
	for _, arg := range buildSystemdRunArgv(validSpawnSpec(), "u.service") {
		if strings.Contains(arg, testSpawnTicket) {
			t.Fatalf("argv carries the ticket: %q", arg)
		}
	}
}

func TestLinuxDesktopSpawnEnv_MinimalWithTicket(t *testing.T) {
	got := linuxDesktopSpawnEnv(testSpawnTicket)
	want := []string{"PATH=/usr/bin:/bin", "LANG=C", "BREEZE_SPAWN_TICKET=" + testSpawnTicket}
	if !slices.Equal(got, want) {
		t.Fatalf("env %q, want %q", got, want)
	}
	if got := linuxDesktopSpawnEnv(""); !slices.Equal(got, want[:2]) {
		t.Fatalf("env without ticket %q, want %q", got, want[:2])
	}
}

func TestClassifySystemdRunFailure(t *testing.T) {
	cases := []struct {
		stderr string
		want   error
	}{
		{"Failed to start transient service unit: Unit breeze-desktop-helper-3-g1-00000000.service already exists.", ErrLinuxDesktopUnitExists},
		{"Failed to connect to bus: No such file or directory", ErrLinuxDesktopUserManagerUnavailable},
		{"Failed to connect to user scope bus via local transport: Connection refused", ErrLinuxDesktopUserManagerUnavailable},
		{"Failed to start transient service unit: Access denied", nil},
	}
	for _, tc := range cases {
		got := classifySystemdRunFailure(tc.stderr)
		if tc.want == nil {
			if got != nil {
				t.Errorf("classify(%q) = %v, want nil", tc.stderr, got)
			}
			continue
		}
		if !errors.Is(got, tc.want) {
			t.Errorf("classify(%q) = %v, want %v", tc.stderr, got, tc.want)
		}
	}
}

func TestSpawnStderrForError_TruncatesAndRedacts(t *testing.T) {
	long := strings.Repeat("x", 2000) + testSpawnTicket
	got := spawnStderrForError([]byte("err "+testSpawnTicket+" "+long), testSpawnTicket)
	if len(got) > maxSpawnStderrBytes {
		t.Fatalf("stderr kept %d bytes, cap %d", len(got), maxSpawnStderrBytes)
	}
	if strings.Contains(got, testSpawnTicket) {
		t.Fatal("stderr kept the ticket")
	}
}

func TestParseLinuxDesktopUnitList(t *testing.T) {
	out := "breeze-desktop-helper-3-g1-deadbeef.service loaded active running /usr/bin/x\n" +
		"breeze-desktop-helper-4-g2-00000000.service loaded failed failed y\n" +
		"evil.service loaded active running z\n" +
		"breeze-desktop-helper-3;x-g1-deadbeef.service loaded active running\n\n"
	got := parseLinuxDesktopUnitList(out)
	want := []string{"breeze-desktop-helper-3-g1-deadbeef.service", "breeze-desktop-helper-4-g2-00000000.service"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
	var many strings.Builder
	for range 200 {
		many.WriteString("breeze-desktop-helper-3-g1-deadbeef.service loaded active running\n")
	}
	if n := len(parseLinuxDesktopUnitList(many.String())); n != maxLinuxDesktopOrphanUnits {
		t.Fatalf("parsed %d units, want cap %d", n, maxLinuxDesktopOrphanUnits)
	}
}
