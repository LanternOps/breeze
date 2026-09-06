//go:build linux

// The only part of this package that touches systemd or drops privileges.
// Everything decidable without a running logind lives in session.go, untagged,
// so it is covered by the test job on every platform.
package linuxsession

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// loginctlTimeout bounds each loginctl invocation. logind can wedge; the reboot
// ladder must not.
const loginctlTimeout = 5 * time.Second

// childWaitDelay bounds how long Wait will linger after the context kills a
// child that is still holding its output pipes open.
const childWaitDelay = 5 * time.Second

// maxEnumeratedSessions bounds how many logind sessions are QUERIED, as
// distinct from how many graphical ones are returned (maxSessions). The two
// differ on purpose: tty, ssh and greeter sessions are all enumerated and then
// filtered out, so a single cap would let cheap non-graphical logins crowd the
// real desktops out of the list.
const maxEnumeratedSessions = 64

// List enumerates the local graphical sessions a dialog may be shown in.
//
// Returns an empty slice with a nil error on a headless box — that is the
// ordinary answer on a server, not a failure, and the caller turns it into
// shown=false so the reboot proceeds on schedule with the existing warnings.
func List(ctx context.Context) ([]GraphicalSession, error) {
	loginctl, err := ResolveSystemBinary("loginctl")
	if err != nil {
		// No systemd-logind on this box (or a non-systemd init). Not an error
		// worth propagating: there is simply no session to draw on.
		return nil, nil
	}

	ids, err := listSessionIDs(ctx, loginctl)
	if err != nil {
		return nil, err
	}

	sessions := make([]GraphicalSession, 0, len(ids))
	queryFailures := 0
	for _, id := range ids {
		out, err := runLoginctl(ctx, loginctl, "show-session", id,
			"-p", "Id", "-p", "Name", "-p", "User", "-p", "Type",
			"-p", "Class", "-p", "State", "-p", "Display", "-p", "Remote")
		if err != nil {
			// Usually the session went away between listing and querying it,
			// which is ordinary and not worth a line each. Counted, though: if
			// EVERY query fails, that is logind being broken rather than a box
			// with nobody signed in, and the two are otherwise indistinguishable
			// from the empty slice this returns.
			queryFailures++
			continue
		}
		parsed := ParseLoginctlSessions(out)
		if len(parsed) == 0 {
			continue
		}
		s := parsed[0]
		if s.ID == "" {
			s.ID = id
		}
		s.Home = homeDirFor(s.UID)
		s.XAuthority = resolveXAuthority(s)
		if s.Type == TypeWayland {
			if socket := resolveWaylandSocket(s); socket != "" {
				s.Display = socket
			}
		}
		sessions = append(sessions, s)
		if len(sessions) >= maxSessions {
			break
		}
	}
	if len(sessions) == 0 && queryFailures > 0 && queryFailures == len(ids) {
		return nil, fmt.Errorf("loginctl reported %d sessions but none could be queried", len(ids))
	}
	return sessions, nil
}

// resolveXAuthority picks the first X11 cookie file that exists. Best-effort:
// an empty result leaves XAUTHORITY unset, which is correct for a classic
// session where Xlib finds $HOME/.Xauthority on its own.
func resolveXAuthority(s GraphicalSession) string {
	for _, candidate := range s.XAuthorityCandidates() {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

// resolveWaylandSocket finds the compositor socket actually present in the
// session's runtime directory.
//
// The parser assumes "wayland-0" because logind does not report the socket at
// all, and that assumption is right almost always — but a second compositor, a
// nested session, or a restarted one lands on wayland-1, and a WAYLAND_DISPLAY
// pointing at a socket that is not there is a dialog that never renders.
// Returns "" when nothing is found, leaving the assumed default in place.
func resolveWaylandSocket(s GraphicalSession) string {
	entries, err := os.ReadDir(s.RuntimeDir())
	if err != nil {
		return ""
	}
	best := ""
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "wayland-") || strings.HasSuffix(name, ".lock") {
			continue
		}
		// Prefer the assumed default when it is genuinely there; otherwise take
		// the lowest-numbered socket, which is deterministic across runs.
		if name == defaultWaylandDisplay {
			return name
		}
		if best == "" || name < best {
			best = name
		}
	}
	return best
}

// listSessionIDs returns the ids `loginctl list-sessions` reports, capped.
func listSessionIDs(ctx context.Context, loginctl string) ([]string, error) {
	out, err := runLoginctl(ctx, loginctl, "list-sessions", "--no-legend", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("loginctl list-sessions: %w", err)
	}
	var ids []string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		ids = append(ids, fields[0])
		// Capped at the ENUMERATION limit, not the graphical one. Capping the
		// raw list at maxSessions would let a local user hide every real
		// desktop behind eight tty or ssh logins, silently suppressing the
		// reboot dialog for everyone else on the box.
		if len(ids) >= maxEnumeratedSessions {
			break
		}
	}
	return ids, nil
}

func runLoginctl(ctx context.Context, loginctl string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, loginctlTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, loginctl, args...)
	// A fixed environment for the same reason CommandEnv builds one: loginctl
	// reads $XDG_SESSION_ID and friends, and the daemon's copies are not the
	// ones we are asking about.
	cmd.Env = []string{"PATH=" + safeExecPath, "LC_ALL=C"}
	cmd.WaitDelay = childWaitDelay
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// homeDirFor resolves a uid's home from the passwd database. Best-effort: an
// empty result makes CommandEnv omit HOME, which lets glibc resolve it the same
// way, so a lookup failure costs nothing.
func homeDirFor(uid string) string {
	u, err := user.LookupId(uid)
	if err != nil {
		return ""
	}
	return u.HomeDir
}

// Command builds a command that runs as the session's user, inside the
// session's graphical environment.
//
// This is the security-load-bearing function in the wave. The daemon runs as
// root; zenity and notify-send must not. Three things enforce that:
//
//   - The child's real and effective uid/gid are the session user's, set by the
//     kernel between fork and exec via SysProcAttr.Credential. Go's own
//     fork/exec issues setgroups, then setgid, then setuid — the order that
//     matters, since setuid first would drop the privilege needed for the other
//     two. Credential rather than a su/sudo wrapper because that would drag in
//     PAM, a shell, and an argument-interpolation surface for nothing. Linux
//     also clears the capability sets on a setuid away from 0, and
//     PR_SET_KEEPCAPS is never set here.
//   - Supplementary groups are set explicitly to the user's own, with gid 0
//     filtered out. Passing an empty list would be safe too (Go then calls
//     setgroups(0, NULL), dropping root's), but a user's own groups are what a
//     real login session has, and the toolkit occasionally needs them.
//   - The environment is built from scratch (CommandEnv), never inherited, and
//     the binary is resolved from a fixed root-owned search path
//     (ResolveSystemBinary) rather than $PATH.
//
// Arguments are passed as argv. No shell is involved anywhere on this path, so
// there is nothing for a quote or a semicolon in a title or body to escape.
func (s GraphicalSession) Command(ctx context.Context, name string, args ...string) (*exec.Cmd, error) {
	uid, err := strconv.ParseUint(s.UID, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("session %q has an unparseable uid %q: %w", s.ID, s.UID, err)
	}
	if uid == 0 {
		return nil, ErrRefusedRootSession
	}

	path, err := ResolveSystemBinary(name)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = s.CommandEnv()
	// Never the user's home, and never the daemon's cwd. This path writes no
	// files at all; "/" is simply the least interesting place to stand.
	cmd.Dir = "/"
	cmd.WaitDelay = childWaitDelay

	euid := os.Geteuid()
	switch {
	case euid == 0:
		cred, err := credentialFor(s.UID)
		if err != nil {
			return nil, err
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	case uint64(euid) == uid:
		// Already the session user — a user-mode agent, or a developer run.
		// Nothing to drop.
	default:
		return nil, fmt.Errorf("agent runs as uid %d, session belongs to uid %d: %w",
			euid, uid, ErrCannotDropPrivileges)
	}
	return cmd, nil
}

// credentialFor builds the uid/gid/groups the child will run under, resolving
// the account from the passwd/group database.
func credentialFor(uid string) (*syscall.Credential, error) {
	u, err := user.LookupId(uid)
	if err != nil {
		return nil, fmt.Errorf("look up uid %s: %w", uid, err)
	}
	// Supplementary groups, best-effort. Without cgo this reads /etc/group, so
	// a directory-backed user may come back with only their primary group —
	// which is a smaller privilege set, never a larger one, so a failure here
	// is safe to ignore.
	gids, gidErr := u.GroupIds()
	if gidErr != nil {
		gids = nil
	}
	return credentialFromIDs(u.Uid, u.Gid, gids)
}

// credentialFromIDs is the whole of the privilege decision, split from the
// passwd lookup so that both refusals below can be asserted directly. Testing
// them through user.LookupId would need an account with root's primary group to
// exist on the test machine, which is exactly the configuration nobody has and
// everybody's gate should still handle.
func credentialFromIDs(uid, gid string, groupIDs []string) (*syscall.Credential, error) {
	uidN, err := strconv.ParseUint(uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse uid %q: %w", uid, err)
	}
	if uidN == 0 {
		return nil, ErrRefusedRootSession
	}
	gidN, err := strconv.ParseUint(gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse gid %q: %w", gid, err)
	}
	// A primary gid of 0 is refused for the same reason uid 0 is. The
	// supplementary-group filter below strips gid 0, and leaving the PRIMARY
	// gid unchecked would make that filtering decorative: the child would run
	// with real and effective gid 0 while this code claimed a complete drop.
	// Rare — it takes an account deliberately given root's group — but "rare"
	// is not the standard a privilege drop is held to.
	if gidN == 0 {
		return nil, fmt.Errorf("uid %s has root as its primary group: %w", uid, ErrRefusedRootSession)
	}
	cred := &syscall.Credential{Uid: uint32(uidN), Gid: uint32(gidN)}

	for _, g := range groupIDs {
		n, err := strconv.ParseUint(g, 10, 32)
		if err != nil {
			continue
		}
		// gid 0 is never carried across. A user genuinely in the root group
		// would keep that membership on a normal login, but this child exists
		// only to draw a dialog, and root group access is not part of that.
		if n == 0 {
			continue
		}
		cred.Groups = append(cred.Groups, uint32(n))
	}
	return cred, nil
}
