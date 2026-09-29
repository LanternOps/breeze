//go:build darwin || linux

package securefs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// fakeOwnedInfo is an os.FileInfo carrying the uid a real Lstat would
// report, so the ownership decision can be exercised for root-owned paths
// without the test process being root.
type fakeOwnedInfo struct {
	name string
	mode os.FileMode
	uid  uint32
}

func (f fakeOwnedInfo) Name() string       { return f.name }
func (f fakeOwnedInfo) Size() int64        { return 0 }
func (f fakeOwnedInfo) Mode() os.FileMode  { return f.mode }
func (f fakeOwnedInfo) ModTime() time.Time { return time.Time{} }
func (f fakeOwnedInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeOwnedInfo) Sys() any           { return &syscall.Stat_t{Uid: f.uid} }

func fakeLstat(tree map[string]fakeOwnedInfo) LstatFunc {
	return func(path string) (os.FileInfo, error) {
		info, ok := tree[path]
		if !ok {
			return nil, &fs.PathError{Op: "lstat", Path: path, Err: fs.ErrNotExist}
		}
		return info, nil
	}
}

func rootDir(name string) fakeOwnedInfo {
	return fakeOwnedInfo{name: name, mode: os.ModeDir | 0o755, uid: 0}
}

// safeLegacyTree is a stock macOS /usr/local/bin: every component root:wheel
// 0755, the binary root-owned 0755.
func safeLegacyTree() map[string]fakeOwnedInfo {
	return map[string]fakeOwnedInfo{
		"/":                           rootDir("/"),
		"/usr":                        rootDir("usr"),
		"/usr/local":                  rootDir("local"),
		"/usr/local/bin":              rootDir("bin"),
		"/usr/local/bin/breeze-agent": {name: "breeze-agent", mode: 0o755, uid: 0},
	}
}

// TestVerifyTrustedExecutablePathChainFS is the safe/unsafe decision table
// the macOS relocation keys off (#7211): only a location a non-root identity
// could tamper with justifies moving the binary and losing its path-keyed
// Full Disk Access grant.
func TestVerifyTrustedExecutablePathChainFS(t *testing.T) {
	const bin = "/usr/local/bin/breeze-agent"
	cases := []struct {
		name     string
		mutate   func(map[string]fakeOwnedInfo)
		wantSafe bool
	}{
		{
			name:     "root-owned 0755 chain is safe",
			mutate:   func(map[string]fakeOwnedInfo) {},
			wantSafe: true,
		},
		{
			name: "user-owned bin dir (Homebrew on Intel) is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m["/usr/local/bin"] = fakeOwnedInfo{name: "bin", mode: os.ModeDir | 0o755, uid: 501}
			},
		},
		{
			name: "root:admin group-writable bin dir is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m["/usr/local/bin"] = fakeOwnedInfo{name: "bin", mode: os.ModeDir | 0o775, uid: 0}
			},
		},
		{
			name: "world-writable bin dir is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m["/usr/local/bin"] = fakeOwnedInfo{name: "bin", mode: os.ModeDir | 0o757, uid: 0}
			},
		},
		{
			name: "user-owned ancestor (pre-High-Sierra Homebrew /usr/local) is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m["/usr/local"] = fakeOwnedInfo{name: "local", mode: os.ModeDir | 0o755, uid: 501}
			},
		},
		{
			name: "user-owned binary in a safe dir is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m[bin] = fakeOwnedInfo{name: "breeze-agent", mode: 0o755, uid: 501}
			},
		},
		{
			name: "symlinked bin dir is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				m["/usr/local/bin"] = fakeOwnedInfo{name: "bin", mode: os.ModeSymlink | 0o755, uid: 0}
			},
		},
		{
			name: "missing bin dir cannot be verified, so it is unsafe",
			mutate: func(m map[string]fakeOwnedInfo) {
				delete(m, "/usr/local/bin")
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tree := safeLegacyTree()
			tc.mutate(tree)
			err := VerifyTrustedExecutablePathChainFS(bin, fakeLstat(tree))
			if tc.wantSafe && err != nil {
				t.Fatalf("want safe, got %v", err)
			}
			if !tc.wantSafe && err == nil {
				t.Fatal("want unsafe, got nil")
			}
		})
	}
}

func TestVerifyTrustedExecutablePathChainFSRejectsRelativePath(t *testing.T) {
	if err := VerifyTrustedExecutablePathChainFS("bin/breeze-agent", fakeLstat(safeLegacyTree())); err == nil {
		t.Fatal("want a relative path refused")
	}
}

// TestVerifyTrustedExecutablePathChainRealFSAcceptsSystemBinary is the
// positive control against a real, root-owned system path.
func TestVerifyTrustedExecutablePathChainRealFSAcceptsSystemBinary(t *testing.T) {
	for _, c := range []string{"/usr/bin/id", "/bin/ls"} {
		resolved, err := filepath.EvalSymlinks(c)
		if err != nil {
			continue
		}
		if err := VerifyTrustedExecutablePathChain(resolved); err != nil {
			t.Fatalf("VerifyTrustedExecutablePathChain(%q) = %v, want nil", resolved, err)
		}
		return
	}
	t.Skip("no known root-owned system binary present on this host")
}

func TestVerifyTrustedExecutablePathChainRealFSRefusesUserOwnedTempDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("test process is root; cannot construct a non-root-owned fixture")
	}
	path := filepath.Join(t.TempDir(), "breeze-agent")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyTrustedExecutablePathChain(path); err == nil {
		t.Fatal("want a user-owned location refused")
	}
}

func TestRemoveRegularFileNoFollowRemovesRegularFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RemoveRegularFileNoFollow(dir, "breeze-agent"); err != nil {
		t.Fatalf("RemoveRegularFileNoFollow: %v", err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file still present after removal: %v", err)
	}
}

func TestRemoveRegularFileNoFollowMissingIsNotExist(t *testing.T) {
	err := RemoveRegularFileNoFollow(t.TempDir(), "breeze-agent")
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("want os.ErrNotExist, got %v", err)
	}
}

// A symlink at the legacy name is not a stale copy we left behind (an
// operator may have pointed it at the new location for CLI use); it must be
// left alone, and its target must never be touched.
func TestRemoveRegularFileNoFollowRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.WriteFile(target, []byte("keep"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "breeze-agent")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := RemoveRegularFileNoFollow(dir, "breeze-agent"); err == nil {
		t.Fatal("want a symlink refused")
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("symlink was removed: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("symlink target was removed: %v", err)
	}
}

// If the directory itself has been swapped for a symlink (possible when its
// parent is writable by a non-root identity), removal must refuse rather
// than unlink a same-named file wherever the link points — e.g. the trusted
// copy the daemon now runs from.
func TestRemoveRegularFileNoFollowRefusesSymlinkedDirectory(t *testing.T) {
	base := t.TempDir()
	realDir := filepath.Join(base, "trusted")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(realDir, "breeze-agent")
	if err := os.WriteFile(victim, []byte("trusted"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(base, "legacy")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatal(err)
	}
	if err := RemoveRegularFileNoFollow(linkDir, "breeze-agent"); err == nil {
		t.Fatal("want a symlinked directory refused")
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("file behind the symlinked directory was removed: %v", err)
	}
}

func TestRemoveRegularFileNoFollowRejectsNestedName(t *testing.T) {
	if err := RemoveRegularFileNoFollow(t.TempDir(), "sub/breeze-agent"); err == nil {
		t.Fatal("want a name with a separator refused")
	}
}
