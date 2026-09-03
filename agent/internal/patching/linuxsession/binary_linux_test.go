//go:build linux

package linuxsession

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRootOwnedAndNotGroupOrWorldWritable drives the real predicate against
// real files. It cannot assert the root-owned half unless the test runs as
// root — but it can always assert the writability half, which is the one that
// catches a directory left group-writable by a careless install.
func TestRootOwnedAndNotGroupOrWorldWritable(t *testing.T) {
	dir := t.TempDir()

	cases := []struct {
		name string
		mode os.FileMode
		want bool
	}{
		{name: "0755 is acceptable", mode: 0o755, want: true},
		{name: "0700 is acceptable", mode: 0o700, want: true},
		{name: "group-writable is refused", mode: 0o775, want: false},
		{name: "world-writable is refused", mode: 0o757, want: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, "bin-"+tc.name)
			if err := os.WriteFile(path, []byte("#!/bin/sh\n"), tc.mode); err != nil {
				t.Fatal(err)
			}
			// WriteFile is subject to umask; force the mode we are asserting on.
			if err := os.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			got := rootOwnedAndNotGroupOrWorldWritable(info)
			if os.Geteuid() != 0 {
				// Not root, so the file is not root-owned and the predicate must
				// refuse it whatever its mode — which is itself the assertion.
				if got {
					t.Errorf("accepted a binary owned by uid %d", os.Geteuid())
				}
				return
			}
			if got != tc.want {
				t.Errorf("rootOwnedAndNotGroupOrWorldWritable(mode %v) = %v, want %v", tc.mode, got, tc.want)
			}
		})
	}
}

// TestRootOwnedRejectsAnUnknownStatShape pins the fail-closed default: a
// FileInfo whose Sys() is not a *syscall.Stat_t tells us nothing about
// ownership, and "nothing" must not read as "fine".
func TestRootOwnedRejectsAnUnknownStatShape(t *testing.T) {
	if rootOwnedAndNotGroupOrWorldWritable(fakeFileInfo{mode: 0o755}) {
		t.Error("accepted a binary whose ownership could not be determined")
	}
}
