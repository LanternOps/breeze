//go:build !windows

package sessionbroker

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// These exercise the real chown/chmod syscalls against a real unix socket, so
// they prove the production path rather than just the decision logic. They run
// on the ubuntu `test-agent` CI job (the file is !windows, not darwin), which is
// the only Unix runner CI has.

// newTestSocketPath returns a short-enough path for a unix socket. sun_path caps
// at 104 bytes on darwin / 108 on linux, and t.TempDir() under macOS's
// /var/folders TMPDIR plus a long test name can exceed that.
func newTestSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bzsock")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "agent.sock")
}

// chownTargetGID returns a GID this unprivileged test process is allowed to
// chown a file it owns to, and which is NOT the process's primary GID.
//
// The distinctness matters: a socket is created with the process's primary GID
// already, so asserting the socket ends up with that GID would pass even if the
// chown never happened — the exact bug under test. A supplementary group makes
// the assertion real.
func chownTargetGID(t *testing.T) (int, bool) {
	t.Helper()
	groups, err := os.Getgroups()
	if err != nil {
		t.Logf("os.Getgroups: %v", err)
		return 0, false
	}
	primary := os.Getgid()
	for _, g := range groups {
		if g != primary && g >= 0 {
			return g, true
		}
	}
	return 0, false
}

func statSocket(t *testing.T, path string) (os.FileMode, int) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if fi.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket (mode %v)", path, fi.Mode())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("stat %s: unexpected Sys() type %T", path, fi.Sys())
	}
	return fi.Mode().Perm(), int(st.Gid)
}

func TestSetupSocketAppliesGroupAndRestrictiveMode(t *testing.T) {
	// Chowning to a group the test process already belongs to is permitted
	// without root, so this works as an unprivileged CI user.
	gid, ok := chownTargetGID(t)
	if !ok {
		t.Skip("no supplementary group available to chown to; the gid assertion would be vacuous")
	}
	orig := ipcGroupIDLookup
	t.Cleanup(func() { ipcGroupIDLookup = orig })
	ipcGroupIDLookup = func(name string) (int, error) {
		if name != IPCGroupName {
			t.Errorf("looked up group %q, want %q", name, IPCGroupName)
		}
		return gid, nil
	}

	path := newTestSocketPath(t)
	b := New(path, nil)
	l, err := b.setupSocket()
	if err != nil {
		t.Fatalf("setupSocket: %v", err)
	}
	defer l.Close()

	mode, gotGID := statSocket(t, path)
	if mode != 0o660 {
		t.Errorf("socket mode = %#o, want 0660", mode)
	}
	if gotGID != gid {
		t.Errorf("socket gid = %d, want %d — the breeze group was never applied, which is the #3137 bug", gotGID, gid)
	}
}

func TestSetupSocketStillTightensModeWhenGroupIsMissing(t *testing.T) {
	// A host with no breeze group (pre-group agent build, or an admin removed it)
	// must still come up with a working socket rather than no IPC at all: losing
	// the broker would take remote desktop, backup IPC and the watchdog link with
	// it, which is strictly worse than the pre-fix root-only socket.
	orig := ipcGroupIDLookup
	t.Cleanup(func() { ipcGroupIDLookup = orig })
	ipcGroupIDLookup = func(string) (int, error) { return 0, errors.New("no such group") }

	path := newTestSocketPath(t)
	b := New(path, nil)
	l, err := b.setupSocket()
	if err != nil {
		t.Fatalf("setupSocket must not fail when the group is missing: %v", err)
	}
	defer l.Close()

	mode, _ := statSocket(t, path)
	if mode != 0o660 {
		t.Errorf("socket mode = %#o, want 0660 even without a resolvable group", mode)
	}
	if mode&0o007 != 0 {
		t.Errorf("socket mode = %#o is world-accessible; a missing group must never widen the socket", mode)
	}
}

func TestSetupSocketCreatesTraversableParentDirectory(t *testing.T) {
	// The helper runs as a non-root user and has to traverse the socket's parent
	// directory to reach it, so the directory needs its execute bit for others.
	orig := ipcGroupIDLookup
	t.Cleanup(func() { ipcGroupIDLookup = orig })
	ipcGroupIDLookup = func(string) (int, error) { return os.Getgid(), nil }

	base := newTestSocketPath(t)
	path := filepath.Join(filepath.Dir(base), "nested", "agent.sock")
	b := New(path, nil)
	l, err := b.setupSocket()
	if err != nil {
		t.Fatalf("setupSocket: %v", err)
	}
	defer l.Close()

	fi, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat socket dir: %v", err)
	}
	if fi.Mode().Perm()&0o001 == 0 {
		t.Errorf("socket dir mode = %#o; a non-root helper cannot traverse it", fi.Mode().Perm())
	}
}

func TestSetupSocketReplacesAStaleSocket(t *testing.T) {
	// The daemon restarts (reboot, `launchctl kickstart -k
	// system/com.breeze.agent`, self-update) leave a stale socket file behind.
	// The reporter expected it to "recreate tight again" — assert the second bind
	// re-applies ownership rather than inheriting whatever the stale file had.
	gid, ok := chownTargetGID(t)
	if !ok {
		t.Skip("no supplementary group available to chown to; the gid assertion would be vacuous")
	}
	orig := ipcGroupIDLookup
	t.Cleanup(func() { ipcGroupIDLookup = orig })
	ipcGroupIDLookup = func(string) (int, error) { return gid, nil }

	path := newTestSocketPath(t)
	b := New(path, nil)

	first, err := b.setupSocket()
	if err != nil {
		t.Fatalf("first setupSocket: %v", err)
	}
	// Simulate a daemon that died without unlinking: Go's unix listener removes
	// the socket file on Close, so disable that to leave the file behind.
	ul, isUnix := first.(*net.UnixListener)
	if !isUnix {
		t.Fatalf("listener is %T, want *net.UnixListener", first)
	}
	ul.SetUnlinkOnClose(false)
	if err := ul.Close(); err != nil {
		t.Fatalf("close first listener: %v", err)
	}
	if err := os.Chmod(path, 0o777); err != nil {
		t.Fatalf("chmod stale socket: %v", err)
	}

	second, err := b.setupSocket()
	if err != nil {
		t.Fatalf("second setupSocket: %v", err)
	}
	defer second.Close()

	mode, gotGID := statSocket(t, path)
	if mode != 0o660 {
		t.Errorf("socket mode after restart = %#o, want 0660", mode)
	}
	if gotGID != gid {
		t.Errorf("socket gid after restart = %d, want %d", gotGID, gid)
	}
}
