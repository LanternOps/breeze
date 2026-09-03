package linuxsession

import (
	"slices"
	"testing"
)

// Captured `loginctl show-session <id> -p ...` output. systemd emits one
// KEY=VALUE block per session, blocks separated by a blank line, which is what
// the parser is written against.

const waylandSession = `Id=3
Name=alice
User=1000
Type=wayland
Class=user
State=active
Display=
Remote=no
`

const x11Session = `Id=2
Name=bob
User=1001
Type=x11
Class=user
State=active
Display=:0
Remote=no
`

const ttySession = `Id=4
Name=carol
User=1002
Type=tty
Class=user
State=active
Display=
Remote=no
`

const closingSession = `Id=5
Name=dave
User=1003
Type=x11
Class=user
State=closing
Display=:0
Remote=no
`

const remoteSession = `Id=6
Name=eve
User=1004
Type=x11
Class=user
State=active
Display=:0
Remote=yes
`

const greeterSession = `Id=c1
Name=gdm
User=120
Type=wayland
Class=greeter
State=active
Display=
Remote=no
`

const rootSession = `Id=7
Name=root
User=0
Type=x11
Class=user
State=active
Display=:0
Remote=no
`

const onlineSession = `Id=8
Name=frank
User=1005
Type=x11
Class=user
State=online
Display=:1
Remote=no
`

const x11NoDisplaySession = `Id=9
Name=grace
User=1006
Type=x11
Class=user
State=active
Display=
Remote=no
`

const classlessX11Session = `Id=10
Name=heidi
User=1007
Type=x11
State=active
Display=:0
Remote=no
`

const waylandWithXwaylandDisplay = `Id=11
Name=ivan
User=1008
Type=wayland
Class=user
State=active
Display=:0
Remote=no
`

func TestParseLoginctlSessions(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []GraphicalSession
	}{
		{
			name:  "wayland session defaults to the wayland-0 socket",
			input: waylandSession,
			want:  []GraphicalSession{{ID: "3", Username: "alice", UID: "1000", Type: "wayland", Display: "wayland-0"}},
		},
		{
			name:  "x11 session carries its DISPLAY",
			input: x11Session,
			want:  []GraphicalSession{{ID: "2", Username: "bob", UID: "1001", Type: "x11", Display: ":0"}},
		},
		{name: "tty session is excluded", input: ttySession, want: nil},
		{name: "closing session is excluded", input: closingSession, want: nil},
		{
			// A remote (SSH/RDP) session has no local display to draw on; a
			// dialog there would render nowhere and block the reboot ladder.
			name: "remote session is excluded", input: remoteSession, want: nil,
		},
		{
			// The display manager's own greeter is graphical and active, but
			// nobody is signed in behind it: a postponement clicked there is
			// not a user decision about their own work.
			name: "greeter session is excluded", input: greeterSession, want: nil,
		},
		{
			// Never render a dialog as uid 0; the whole point of the exec path
			// is that zenity does not run with the daemon's privileges.
			name: "root session is excluded", input: rootSession, want: nil,
		},
		{
			// State=online is a signed-in user on a background VT. They will
			// see the dialog when they switch back, so it still counts.
			name:  "online session is included",
			input: onlineSession,
			want:  []GraphicalSession{{ID: "8", Username: "frank", UID: "1005", Type: "x11", Display: ":1"}},
		},
		{
			name: "x11 session with no DISPLAY is excluded", input: x11NoDisplaySession, want: nil,
		},
		{
			// Older systemd may not report Class at all. Absent must not mean
			// "greeter" — that would silence the prompt on every such box.
			name:  "session with no Class is treated as a user session",
			input: classlessX11Session,
			want:  []GraphicalSession{{ID: "10", Username: "heidi", UID: "1007", Type: "x11", Display: ":0"}},
		},
		{
			// logind's Display property is the X11 display. On a Wayland
			// session it may hold the XWayland display, which is NOT a valid
			// WAYLAND_DISPLAY — using it would point the toolkit at nothing.
			name:  "wayland session ignores an XWayland DISPLAY value",
			input: waylandWithXwaylandDisplay,
			want:  []GraphicalSession{{ID: "11", Username: "ivan", UID: "1008", Type: "wayland", Display: "wayland-0"}},
		},
		{name: "empty input yields nothing", input: "", want: nil},
		{name: "malformed input yields nothing and does not panic", input: "=\n==\nType\n", want: nil},
		{
			name:  "multiple sessions are all returned",
			input: x11Session + "\n" + waylandSession,
			want: []GraphicalSession{
				{ID: "2", Username: "bob", UID: "1001", Type: "x11", Display: ":0"},
				{ID: "3", Username: "alice", UID: "1000", Type: "wayland", Display: "wayland-0"},
			},
		},
		{
			name:  "graphical sessions survive being mixed with excluded ones",
			input: ttySession + "\n" + greeterSession + "\n" + x11Session + "\n" + remoteSession,
			want:  []GraphicalSession{{ID: "2", Username: "bob", UID: "1001", Type: "x11", Display: ":0"}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseLoginctlSessions(tc.input)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d sessions %+v, want %d (%+v)", len(got), got, len(tc.want), tc.want)
			}
			for i := range got {
				if got[i].ID != tc.want[i].ID ||
					got[i].Username != tc.want[i].Username ||
					got[i].UID != tc.want[i].UID ||
					got[i].Type != tc.want[i].Type ||
					got[i].Display != tc.want[i].Display {
					t.Errorf("session %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestParseLoginctlSessionsCapsRunawayInput(t *testing.T) {
	// loginctl output is attacker-adjacent only in the sense that a local user
	// can open sessions; a cap keeps a fork bomb of logins from turning into a
	// fork bomb of dialogs.
	blob := ""
	for i := 0; i < maxSessions*3; i++ {
		blob += x11Session + "\n"
	}
	if got := len(ParseLoginctlSessions(blob)); got != maxSessions {
		t.Fatalf("parsed %d sessions, want the cap of %d", got, maxSessions)
	}
}

func TestCommandEnvCarriesDisplayAndBus(t *testing.T) {
	s := GraphicalSession{Username: "alice", UID: "1000", Type: "x11", Display: ":0"}
	env := s.CommandEnv()
	assertHasEnv(t, env, "DISPLAY=:0")
	// The session bus address is derived from the UID when logind does not
	// report one; without it notify-send and zenity talk to root's bus and
	// render nothing.
	assertHasEnv(t, env, "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus")
	assertHasEnv(t, env, "XDG_RUNTIME_DIR=/run/user/1000")
	assertHasEnv(t, env, "USER=alice")
	assertHasEnv(t, env, "LOGNAME=alice")
	assertHasEnv(t, env, "XDG_SESSION_TYPE=x11")
	// A fixed PATH, never the daemon's: an inherited PATH is the one input a
	// local attacker could aim at a zenity of their choosing.
	assertHasEnv(t, env, "PATH="+safeExecPath)
	assertNoEnvKey(t, env, "WAYLAND_DISPLAY")
	// HOME is omitted when unknown rather than guessed or inherited: the
	// daemon's HOME is /root, and pointing a user's toolkit at /root is worse
	// than letting glibc resolve it from the passwd database.
	assertNoEnvKey(t, env, "HOME")
}

func TestCommandEnvUsesWaylandDisplayForWaylandSessions(t *testing.T) {
	s := GraphicalSession{Username: "alice", UID: "1000", Type: "wayland", Display: "wayland-0", Home: "/home/alice"}
	env := s.CommandEnv()
	assertHasEnv(t, env, "WAYLAND_DISPLAY=wayland-0")
	assertHasEnv(t, env, "HOME=/home/alice")
	assertNoEnvKey(t, env, "DISPLAY")
}

func TestCommandEnvDoesNotInheritTheDaemonEnvironment(t *testing.T) {
	t.Setenv("BREEZE_LINUXSESSION_CANARY", "leaked")
	s := GraphicalSession{Username: "alice", UID: "1000", Type: "x11", Display: ":0"}
	for _, kv := range s.CommandEnv() {
		if kv == "BREEZE_LINUXSESSION_CANARY=leaked" {
			t.Fatalf("CommandEnv leaked the daemon's environment: %v", s.CommandEnv())
		}
	}
}

func assertHasEnv(t *testing.T, env []string, want string) {
	t.Helper()
	if !slices.Contains(env, want) {
		t.Errorf("env %v is missing %q", env, want)
	}
}

func assertNoEnvKey(t *testing.T, env []string, key string) {
	t.Helper()
	for _, kv := range env {
		if len(kv) > len(key) && kv[:len(key)+1] == key+"=" {
			t.Errorf("env %v unexpectedly sets %s", env, key)
		}
	}
}
