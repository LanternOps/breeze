//go:build linux || darwin

package securefs

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #5520 added symlink and directory manifest entries to restore. They must go
// through the same pinned-parent boundary as file entries: created with
// symlinkat/mkdirat relative to a descriptor, never by pathname, and never
// through an ancestor an earlier pass recreated as a link.
func TestInstallSymlinkBoundary(t *testing.T) {
	t.Run("positive control creates the link with the recorded target", func(t *testing.T) {
		base := t.TempDir()
		if _, err := InstallSymlink(base, filepath.Join("nested", "bin"), "usr/bin", nil); err != nil {
			t.Fatal(err)
		}
		got, err := os.Readlink(filepath.Join(base, "nested", "bin"))
		if err != nil {
			t.Fatal(err)
		}
		if got != "usr/bin" {
			t.Fatalf("link target = %q, want usr/bin", got)
		}
	})

	t.Run("refuses to write through a symlinked ancestor", func(t *testing.T) {
		base := t.TempDir()
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(base, "escape")); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSymlink(base, filepath.Join("escape", "link"), "anywhere", nil); err == nil {
			t.Fatal("symlink was created through a symlinked ancestor")
		}
		entries, err := os.ReadDir(outside)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("escaped through the ancestor link: %v", entries)
		}
	})

	t.Run("replaces a stale link but refuses a regular file", func(t *testing.T) {
		base := t.TempDir()
		if err := os.Symlink("old/target", filepath.Join(base, "link")); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSymlink(base, "link", "new/target", nil); err != nil {
			t.Fatal(err)
		}
		got, err := os.Readlink(filepath.Join(base, "link"))
		if err != nil || got != "new/target" {
			t.Fatalf("link target = %q err=%v, want new/target", got, err)
		}

		real := filepath.Join(base, "regular")
		if err := os.WriteFile(real, []byte("precious"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSymlink(base, "regular", "somewhere", nil); err == nil {
			t.Fatal("a regular file was replaced by a symlink")
		}
		content, err := os.ReadFile(real)
		if err != nil || string(content) != "precious" {
			t.Fatalf("regular file was damaged: %q err=%v", content, err)
		}
	})

	t.Run("an already-correct link is left alone (resume)", func(t *testing.T) {
		base := t.TempDir()
		if _, err := InstallSymlink(base, "link", "target", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSymlink(base, "link", "target", nil); err != nil {
			t.Fatalf("re-installing an identical link failed: %v", err)
		}
	})

	t.Run("invalid relative paths are refused", func(t *testing.T) {
		base := t.TempDir()
		for _, relative := range []string{"", "..", filepath.Join("..", "escape"), "/absolute"} {
			if _, err := InstallSymlink(base, relative, "target", nil); err == nil {
				t.Fatalf("relative path %q was accepted", relative)
			}
		}
	})
}

func TestInstallDirBoundary(t *testing.T) {
	t.Run("positive control creates the directory with the recorded mode", func(t *testing.T) {
		base := t.TempDir()
		if err := InstallDir(base, filepath.Join("var", "empty"), 0o700, true, nil, time.Time{}); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(base, "var", "empty"))
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() {
			t.Fatal("not a directory")
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("mode = %v, want 0700", info.Mode().Perm())
		}
	})

	t.Run("sticky and setgid survive the os.FileMode translation", func(t *testing.T) {
		base := t.TempDir()
		want := os.ModeSticky | 0o777
		if err := InstallDir(base, "sticky", want, true, nil, time.Time{}); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(base, "sticky"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&os.ModeSticky == 0 {
			t.Fatalf("sticky bit was dropped: mode = %v", info.Mode())
		}
		if info.Mode().Perm() != 0o777 {
			t.Fatalf("perm = %v, want 0777", info.Mode().Perm())
		}
	})

	t.Run("refuses to create through a symlinked ancestor", func(t *testing.T) {
		base := t.TempDir()
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(base, "escape")); err != nil {
			t.Fatal(err)
		}
		if err := InstallDir(base, filepath.Join("escape", "made"), 0o700, true, nil, time.Time{}); err == nil {
			t.Fatal("directory was created through a symlinked ancestor")
		}
		entries, err := os.ReadDir(outside)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("escaped through the ancestor link: %v", entries)
		}
	})

	t.Run("applying an existing directory again is idempotent", func(t *testing.T) {
		base := t.TempDir()
		if err := InstallDir(base, "d", 0o700, true, nil, time.Time{}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(base, "d", "child"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := InstallDir(base, "d", 0o755, true, nil, time.Time{}); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(base, "d", "child")); err != nil {
			t.Fatalf("existing child was lost: %v", err)
		}
	})
}

// Ownership must reach the pinned descriptor, and setuid/setgid/sticky must
// survive the os.FileMode -> Unix mode translation on a FILE too. Both are
// #5520 fidelity that the descriptor path has to carry, not drop.
func TestInstallFileAppliesFullModeBitsAndOwner(t *testing.T) {
	t.Run("setgid survives the mode translation", func(t *testing.T) {
		base := t.TempDir()
		if _, err := InstallFile(base, "setgid.bin", writeSource(t, "payload"), os.ModeSetgid|0o750, time.Time{}, nil); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(base, "setgid.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&os.ModeSetgid == 0 {
			t.Fatalf("setgid bit was dropped: mode = %v", info.Mode())
		}
		if info.Mode().Perm() != 0o750 {
			t.Fatalf("perm = %v, want 0750", info.Mode().Perm())
		}
	})

	t.Run("owner is applied to the pinned descriptor", func(t *testing.T) {
		if os.Geteuid() != 0 {
			t.Skip("applying a foreign owner requires root")
		}
		base := t.TempDir()
		if _, err := InstallFile(base, "owned.bin", writeSource(t, "payload"), 0o600, time.Time{}, &Owner{UID: 65534, GID: 65534}); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(base, "owned.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if got := fileUID(info); got != 65534 {
			t.Fatalf("owner uid = %d, want 65534", got)
		}
	})

	t.Run("symlink ownership is applied to the link, not its target", func(t *testing.T) {
		if os.Geteuid() != 0 {
			t.Skip("applying a foreign owner requires root")
		}
		base := t.TempDir()
		target := filepath.Join(base, "target")
		if err := os.WriteFile(target, []byte("payload"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSymlink(base, "link", "target", &Owner{UID: 65534, GID: 65534}); err != nil {
			t.Fatal(err)
		}
		link, err := os.Lstat(filepath.Join(base, "link"))
		if err != nil {
			t.Fatal(err)
		}
		if got := fileUID(link); got != 65534 {
			t.Fatalf("link owner uid = %d, want 65534", got)
		}
		targetInfo, err := os.Stat(target)
		if err != nil {
			t.Fatal(err)
		}
		if got := fileUID(targetInfo); got == 65534 {
			t.Fatal("chown followed the link and re-owned its target")
		}
	})
}

// chown on a non-directory clears setuid/setgid — POSIX mandates it, and Linux
// does it even for root. So the order matters: chown FIRST, then chmod.
// Applying them the other way round silently drops the setuid bit off every
// restored binary while the restore still reports "completed".
//
// The strip reproduces with a SAME-uid chown, so the control below runs
// everywhere, not only as root — which is what let this survive: the suite had
// a mode test with no owner and an owner test with no special mode bits, and
// nothing crossed the two.
func TestInstallFileKeepsSetuidWhenOwnerIsAlsoApplied(t *testing.T) {
	self := &Owner{UID: os.Geteuid(), GID: os.Getegid()}
	cases := []struct {
		name  string
		mode  os.FileMode
		owner *Owner
		want  os.FileMode
	}{
		{"setuid with a same-uid owner", os.ModeSetuid | 0o755, self, os.ModeSetuid},
		{"setgid with a same-uid owner", os.ModeSetgid | 0o750, self, os.ModeSetgid},
		{"setuid and setgid together", os.ModeSetuid | os.ModeSetgid | 0o755, self, os.ModeSetuid | os.ModeSetgid},
		{"setuid with no owner at all", os.ModeSetuid | 0o755, nil, os.ModeSetuid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			if _, err := InstallFile(base, "tool", writeSource(t, "payload"), tc.mode, time.Time{}, tc.owner); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(filepath.Join(base, "tool"))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode()&tc.want != tc.want {
				t.Fatalf("mode = %v, want %v set (chown after chmod strips these)", info.Mode(), tc.want)
			}
			if info.Mode().Perm() != tc.mode.Perm() {
				t.Fatalf("perm = %v, want %v", info.Mode().Perm(), tc.mode.Perm())
			}
		})
	}
}

// Same crossing for a directory entry: setgid/sticky on a directory that also
// carries an owner.
func TestInstallDirKeepsSpecialBitsWhenOwnerIsAlsoApplied(t *testing.T) {
	self := &Owner{UID: os.Geteuid(), GID: os.Getegid()}
	base := t.TempDir()
	want := os.ModeSetgid | os.ModeSticky | 0o770
	if err := InstallDir(base, "shared", want, true, self, time.Time{}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(base, "shared"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSetgid == 0 || info.Mode()&os.ModeSticky == 0 {
		t.Fatalf("mode = %v, want setgid and sticky set", info.Mode())
	}
}
