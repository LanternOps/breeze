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
	for _, id := range ids {
		out, err := runLoginctl(ctx, loginctl, "show-session", id,
			"-p", "Id", "-p", "Name", "-p", "User", "-p", "Type",
			"-p", "Class", "-p", "State", "-p", "Display", "-p", "Remote")
		if err != nil {
			// The session went away between listing and querying it. Ordinary.
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
		sessions = append(sessions, s)
		if len(sessions) >= maxSessions {
			break
		}
	}
	return sessions, nil
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
		if len(ids) >= maxSessions {
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
//     kernel at fork time via SysProcAttr.Credential (setgid + setgroups +
//     setuid, in that order — Go's fork/exec does them correctly, which is why
//     this uses Credential rather than a su/sudo wrapper that would drag in
//     PAM, a shell, and an interpolation surface).
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

// credentialFor builds the uid/gid/groups the child will run under.
func credentialFor(uid string) (*syscall.Credential, error) {
	u, err := user.LookupId(uid)
	if err != nil {
		return nil, fmt.Errorf("look up uid %s: %w", uid, err)
	}
	uidN, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse uid %q: %w", u.Uid, err)
	}
	if uidN == 0 {
		return nil, ErrRefusedRootSession
	}
	gidN, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse gid %q: %w", u.Gid, err)
	}
	cred := &syscall.Credential{Uid: uint32(uidN), Gid: uint32(gidN)}

	// Supplementary groups, best-effort. Without cgo this reads /etc/group, so
	// a directory-backed user may come back with only their primary group —
	// which is a smaller privilege set, never a larger one, so a failure here
	// is safe to ignore.
	gids, err := u.GroupIds()
	if err != nil {
		return cred, nil
	}
	for _, g := range gids {
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
