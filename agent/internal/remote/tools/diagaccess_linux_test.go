//go:build linux

package tools

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// A bind mount keeps its mountpoint's spelling in /proc/self/fd, so only the
// mount comparison stops a read through it. Needs CAP_SYS_ADMIN (CI runs it in
// a privileged container); skips elsewhere.
func TestDiagLinuxBindMountEscapeRefused(t *testing.T) {
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	mnt := filepath.Join(root, "Logs", "archive")
	if err := os.MkdirAll(mnt, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mount(outside, mnt, "", unix.MS_BIND, ""); err != nil {
		t.Skipf("bind mount unavailable here (%v)", err)
	}
	t.Cleanup(func() { _ = unix.Unmount(mnt, unix.MNT_DETACH) })

	if got := diagCode(s.run(s.build(t, "read", filepath.Join(mnt, "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("read through a bind mount: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "list", mnt, rec(root), nil, nil, nil), "list", env)); got != DiagErrLinkRefused {
		t.Fatalf("list of a bind mount: %s", got)
	}
	// Control: the same tree without the mount is still readable.
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(root, "Logs", "app.log"), rec(root), nil, nil, nil), "read", env)); got != "OK" {
		t.Fatalf("control read failed: %s", got)
	}
}
