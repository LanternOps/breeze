// Enumeration of the local graphical login sessions that a root daemon may put
// a dialog in front of (issue #3207, wave 4).
//
// Why this exists at all: no desktop helper binary ships for Linux —
// release.yml builds the helper for darwin only — so the session broker's
// BroadcastNotification reaches nobody there, and every interactive rung of the
// reboot warning ladder is silently swallowed. The Linux vehicle therefore has
// to be the daemon spawning zenity/notify-send itself, which means the daemon
// has to know which sessions exist, which are graphical, and what environment
// and credentials a process in one of them needs.
//
// Untagged on purpose, for the same reason reboot_plan.go and reboot_deferral.go
// are: everything a build tag hides is tested nowhere in CI. The parsing and the
// environment construction — the two places this can silently be wrong — live
// here and run on every platform's test job. Only the exec itself, which needs
// syscall.Credential, is behind //go:build linux (exec_linux.go).
package linuxsession

import (
	"strconv"
	"strings"
)

// maxSessions caps how many graphical sessions one enumeration will return.
// Every returned session becomes a spawned dialog process, so an unbounded
// count turns a pile of logins into a pile of zenity processes.
const maxSessions = 8

// defaultWaylandDisplay is the socket every mainstream compositor opens in
// XDG_RUNTIME_DIR. logind does not report it — its Display property is the X11
// display — so it is assumed rather than read.
const defaultWaylandDisplay = "wayland-0"

// safeExecPath is the PATH handed to the child. A fixed list rather than the
// daemon's own PATH, and the same directories ResolveSystemBinary searches: an
// inherited PATH is the one input a local user could aim at a binary of their
// choosing. /usr/local/bin is excluded for the reason given on
// systemBinaryDirs — it is group-writable by default on Debian and Ubuntu.
const safeExecPath = "/usr/bin:/bin"

// GraphicalSession is one local, graphical, non-greeter login session belonging
// to a real user.
type GraphicalSession struct {
	// ID is logind's session id, used only for logging and XDG_SESSION_ID.
	ID string
	// Username and UID identify the account to drop to. UID is kept as the
	// string logind reported so the parser stays free of error returns; the
	// exec path re-parses it and refuses anything that is not a plain number.
	Username string
	UID      string
	// Home is filled in by List from the passwd database, not by the parser —
	// logind does not report it. Empty is a valid value; see CommandEnv.
	Home string
	// Type is "x11" or "wayland" and decides which display variable is set.
	Type string
	// Display is the DISPLAY value for an x11 session, or the Wayland socket
	// name for a wayland one.
	Display string
	// XAuthority is the X11 cookie file, filled in by List rather than by the
	// parser — logind does not report it. Empty is valid and common: Xlib then
	// falls back to $HOME/.Xauthority, which is right for a classic session.
	// It matters for display-manager-started sessions (GDM keeps the cookie in
	// /run/user/<uid>/gdm/Xauthority), where an unset XAUTHORITY means the
	// toolkit is refused by the X server and the dialog never renders.
	XAuthority string
}

// Session types this package can draw on. "mir" is deliberately absent: logind
// reports it, but no zenity build targets it, so advertising it would produce a
// dialog that renders nowhere while reporting that it was shown.
const (
	TypeX11     = "x11"
	TypeWayland = "wayland"
)

// ParseLoginctlSessions turns the output of
//
//	loginctl show-session <id...> -p Id -p Name -p User -p Type -p Class -p State -p Display -p Remote
//
// into the sessions a dialog may be shown in. Pure, so every exclusion rule
// below is asserted directly instead of inferred from a running systemd.
//
// A session is excluded when any of these holds, and each exclusion is a
// correctness rule rather than a nicety:
//
//   - Type is not x11 or wayland — a tty or ssh session has no display, and a
//     dialog "shown" there would report success while rendering nowhere.
//   - State is closing — the session is being torn down; a dialog would race it.
//   - Remote=yes — an SSH or RDP session's display is not on this machine.
//   - Class is present and not "user" — the display manager's greeter is
//     graphical and active, but nobody is signed in behind it, so a
//     postponement clicked there is not a user's decision about their own work.
//     Absent Class is treated as "user": older systemd may not report it, and
//     defaulting the other way would silence the prompt on those boxes.
//   - The UID is unparseable or zero — the entire point of the exec path is
//     that the dialog does not run with the daemon's privileges.
//   - An x11 session with no Display — there is nothing to connect to.
func ParseLoginctlSessions(showSessionOutput string) []GraphicalSession {
	var sessions []GraphicalSession
	for _, block := range splitBlocks(showSessionOutput) {
		s, ok := parseBlock(block)
		if !ok {
			continue
		}
		sessions = append(sessions, s)
		if len(sessions) >= maxSessions {
			break
		}
	}
	return sessions
}

// splitBlocks divides systemd's multi-object `show` output into per-object
// property blocks. systemd separates them with a blank line.
func splitBlocks(out string) []string {
	lines := strings.Split(out, "\n")
	var blocks []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			blocks = append(blocks, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		cur = append(cur, line)
	}
	flush()
	return blocks
}

func parseBlock(block string) (GraphicalSession, bool) {
	props := map[string]string{}
	for _, line := range strings.Split(block, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			continue
		}
		props[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}

	sessionType := props["Type"]
	if sessionType != TypeX11 && sessionType != TypeWayland {
		return GraphicalSession{}, false
	}
	if props["State"] == "closing" {
		return GraphicalSession{}, false
	}
	if props["Remote"] == "yes" {
		return GraphicalSession{}, false
	}
	if class := props["Class"]; class != "" && class != "user" {
		return GraphicalSession{}, false
	}
	uid, err := strconv.ParseUint(props["User"], 10, 32)
	if err != nil || uid == 0 {
		return GraphicalSession{}, false
	}

	display := props["Display"]
	if sessionType == TypeWayland {
		// logind's Display property holds the X11 display. On a Wayland session
		// that is either empty or the XWayland display, and neither is a valid
		// WAYLAND_DISPLAY — so the socket name is assumed rather than read.
		display = defaultWaylandDisplay
	}
	if display == "" {
		return GraphicalSession{}, false
	}

	return GraphicalSession{
		ID:       props["Id"],
		Username: props["Name"],
		UID:      props["User"],
		Type:     sessionType,
		Display:  display,
	}, true
}

// DisplayVar names the environment variable that carries Display.
func (s GraphicalSession) DisplayVar() string {
	if s.Type == TypeWayland {
		return "WAYLAND_DISPLAY"
	}
	return "DISPLAY"
}

// RuntimeDir is the session's XDG_RUNTIME_DIR. Derived from the UID because
// that is how systemd-logind names it, and because the daemon's own runtime dir
// (root's) would point the toolkit at the wrong bus.
func (s GraphicalSession) RuntimeDir() string {
	return "/run/user/" + s.UID
}

// BusAddress is the session's D-Bus address. notify-send and zenity both talk
// to the session bus; without this they reach root's bus, where nothing is
// listening, and render nothing while reporting success.
func (s GraphicalSession) BusAddress() string {
	return "unix:path=" + s.RuntimeDir() + "/bus"
}

// CommandEnv builds the complete environment for a process in this session.
//
// It is built from scratch and never from os.Environ(): the daemon runs as root
// with root's HOME, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS and PATH, every
// one of which would either break the dialog or aim it at the wrong bus.
//
// HOME is omitted when unknown rather than guessed. An unset HOME makes glibc
// resolve it from the passwd database, which is right; a guessed /home/<name>
// can be wrong, and the daemon's /root is always wrong.
func (s GraphicalSession) CommandEnv() []string {
	env := []string{
		"PATH=" + safeExecPath,
		"XDG_RUNTIME_DIR=" + s.RuntimeDir(),
		"DBUS_SESSION_BUS_ADDRESS=" + s.BusAddress(),
		"XDG_SESSION_TYPE=" + s.Type,
		s.DisplayVar() + "=" + s.Display,
	}
	if s.Username != "" {
		env = append(env, "USER="+s.Username, "LOGNAME="+s.Username)
	}
	if s.Home != "" {
		env = append(env, "HOME="+s.Home)
	}
	if s.ID != "" {
		env = append(env, "XDG_SESSION_ID="+s.ID)
	}
	// Only meaningful for X11. A Wayland client authenticates through the
	// compositor socket in XDG_RUNTIME_DIR, and a stray XAUTHORITY there is
	// noise at best.
	if s.XAuthority != "" && s.Type == TypeX11 {
		env = append(env, "XAUTHORITY="+s.XAuthority)
	}
	return env
}

// XAuthorityCandidates lists, in resolution order, where an x11 session's
// cookie may live. Pure so the ordering is asserted without a display manager;
// List stats them and takes the first that exists.
//
// The order matters: a display manager's own copy is authoritative for a
// session it started, and the home-directory copy can be stale after a
// re-login. Mirrors the resolution order in remote/desktop/x11/resolve_linux.go.
func (s GraphicalSession) XAuthorityCandidates() []string {
	if s.Type != TypeX11 || s.UID == "" {
		return nil
	}
	runtimeDir := s.RuntimeDir()
	candidates := []string{
		runtimeDir + "/gdm/Xauthority",
		runtimeDir + "/.mutter-Xwaylandauth",
		runtimeDir + "/Xauthority",
	}
	if s.Home != "" {
		candidates = append(candidates, s.Home+"/.Xauthority")
	}
	return candidates
}
