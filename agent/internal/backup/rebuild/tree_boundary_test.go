package rebuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The rebuild phases after the restore work inside the restored tree. A
// directory or file link inside that tree must not carry their reads, writes,
// deletes or mode changes to a directory outside it.

// linuxEngineOnly skips a test of Linux-engine behaviour that asserts Unix
// mode bits or relative-link resolution, which Windows does not model.
func linuxEngineOnly(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Linux engine behaviour; Unix mode bits and relative links")
	}
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skip(err)
	}
}

func assertDirEmpty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("directory outside the tree changed: %v %v", entries, err)
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("%s: got %q %v, want %q", path, got, err, want)
	}
}

func TestIdentityTreeBoundary(t *testing.T) {
	for _, leaf := range []bool{false, true} {
		t.Run(fmt.Sprint("leaf=", leaf), func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			mustWriteFile(t, filepath.Join(other, "machine-id"), "keep")
			dst, target := filepath.Join(root, "etc"), other
			if leaf {
				mustMkdirAll(t, dst)
				dst, target = filepath.Join(dst, "machine-id"), filepath.Join(other, "machine-id")
			}
			symlinkOrSkip(t, target, dst)
			if err := applyNewIdentity(root); err == nil {
				t.Fatal("expected an error for a path that leaves the tree")
			}
			assertFileContent(t, filepath.Join(other, "machine-id"), "keep")
		})
	}
}

func TestIdentitySecretsTreeBoundary(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	mustWriteFile(t, filepath.Join(other, "secrets.yaml"), "keep")
	mustWriteFile(t, filepath.Join(other, "agent.yaml"), "agent_id: keep\n")
	mustMkdirAll(t, filepath.Join(root, "etc"))
	symlinkOrSkip(t, other, filepath.Join(root, "etc", "breeze"))
	if err := applyNewIdentity(root); err == nil {
		t.Fatal("expected an error for a path that leaves the tree")
	}
	assertFileContent(t, filepath.Join(other, "secrets.yaml"), "keep")
	assertFileContent(t, filepath.Join(other, "agent.yaml"), "agent_id: keep\n")
}

func TestRecoveryMarkerTreeBoundary(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	symlinkOrSkip(t, other, filepath.Join(root, "var"))
	r := &run{staging: root, result: &Result{}, opts: Options{
		Identity:   IdentityOriginal,
		Marker:     &Marker{RecoveryID: "recovery", Nonce: "nonce"},
		SnapshotID: "snapshot",
	}}
	if err := identity(context.Background(), r); err == nil {
		t.Fatal("expected an error for a path that leaves the tree")
	}
	assertDirEmpty(t, other)
}

func TestMountpointTreeBoundary(t *testing.T) {
	linuxEngineOnly(t)
	for _, name := range []string{"tmp", "var", "proc", "run", "mnt", "media"} {
		t.Run(name, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			if err := os.Chmod(other, 0o700); err != nil {
				t.Fatal(err)
			}
			symlinkOrSkip(t, other, filepath.Join(root, name))
			_ = ensureMountpoints(root)
			info, err := os.Stat(other)
			if err != nil || info.Mode() != os.ModeDir|0o700 {
				t.Fatalf("directory outside the tree changed mode: %v %v", info.Mode(), err)
			}
			assertDirEmpty(t, other)
		})
	}
}

// API filesystem mount points must be real directories: a link there is
// replaced by one, and the link's target is left alone.
func TestMountpointApiLinkReplaced(t *testing.T) {
	linuxEngineOnly(t)
	for _, name := range []string{"proc", "sys", "dev", "run"} {
		t.Run(name, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			symlinkOrSkip(t, other, filepath.Join(root, name))
			if err := ensureMountpoints(root); err != nil {
				t.Fatal(err)
			}
			info, err := os.Lstat(filepath.Join(root, name))
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				t.Fatalf("%s is not a real directory: %v %v", name, info, err)
			}
			assertDirEmpty(t, other)
		})
	}
}

// Layouts that keep /mnt, /media or /var/tmp as relative links into the tree
// (ostree-style) keep them; tmp's mode is applied only to a real directory.
func TestMountpointExistingLinksKept(t *testing.T) {
	linuxEngineOnly(t)
	root := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "var", "mnt"))
	mustMkdirAll(t, filepath.Join(root, "run", "media"))
	links := map[string]string{
		"mnt":                       filepath.Join("var", "mnt"),
		"media":                     filepath.Join("run", "media"),
		filepath.Join("var", "tmp"): filepath.Join("..", "tmp"),
	}
	for name, target := range links {
		symlinkOrSkip(t, target, filepath.Join(root, name))
	}
	if err := ensureMountpoints(root); err != nil {
		t.Fatal(err)
	}
	for name, target := range links {
		if got, err := os.Readlink(filepath.Join(root, name)); err != nil || got != target {
			t.Fatalf("%s: link %q %v, want %q", name, got, err, target)
		}
	}
	info, err := os.Lstat(filepath.Join(root, "tmp"))
	if err != nil || info.Mode()&os.ModeSticky == 0 || info.Mode().Perm() != 0o777 {
		t.Fatalf("tmp: %v %v", info, err)
	}
}

func TestMountpointRegularTree(t *testing.T) {
	linuxEngineOnly(t)
	root := t.TempDir()
	if err := ensureMountpoints(root); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"proc", "sys", "dev", "run", "mnt", "media"} {
		if info, err := os.Lstat(filepath.Join(root, name)); err != nil || !info.IsDir() {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	for _, name := range []string{"tmp", filepath.Join("var", "tmp")} {
		info, err := os.Lstat(filepath.Join(root, name))
		if err != nil || info.Mode()&os.ModeSticky == 0 || info.Mode().Perm() != 0o777 {
			t.Fatalf("%s: %v %v", name, info.Mode(), err)
		}
	}
}

func TestEspFallbackCopyTreeBoundary(t *testing.T) {
	for _, side := range []string{"source", "destination"} {
		t.Run(side, func(t *testing.T) {
			esp, other := t.TempDir(), t.TempDir()
			mustWriteFile(t, filepath.Join(esp, "EFI", "Microsoft", "Boot", "bootmgfw.efi"), "loader")
			mustWriteFile(t, filepath.Join(other, "Boot", "bootmgfw.efi"), "other")
			if side == "source" {
				if err := os.RemoveAll(filepath.Join(esp, "EFI", "Microsoft")); err != nil {
					t.Fatal(err)
				}
				symlinkOrSkip(t, other, filepath.Join(esp, "EFI", "Microsoft"))
			} else {
				symlinkOrSkip(t, other, filepath.Join(esp, "EFI", "Boot"))
			}
			if err := ensureBootx64(esp); err == nil {
				t.Fatal("expected an error for a path that leaves the tree")
			}
			if _, err := os.Lstat(filepath.Join(other, "bootx64.efi")); !os.IsNotExist(err) {
				t.Fatalf("file written outside the tree: %v", err)
			}
			if side == "source" {
				if _, err := os.Lstat(filepath.Join(esp, "EFI", "Boot", "bootx64.efi")); !os.IsNotExist(err) {
					t.Fatalf("content from outside the tree was copied: %v", err)
				}
			}
		})
	}
}

func TestBootMetadataTreeBoundary(t *testing.T) {
	linuxEngineOnly(t)
	root, other := t.TempDir(), t.TempDir()
	mustWriteFile(t, filepath.Join(other, "os-release"), "ID=other\n")
	mustMkdirAll(t, filepath.Join(root, "etc"))
	release := filepath.Join(root, "etc", "os-release")
	symlinkOrSkip(t, filepath.Join(other, "os-release"), release)
	if got := bootloaderID(root); got != "linux" {
		t.Fatalf("bootloader id read from outside the tree: %s", got)
	}
	if err := os.Remove(release); err != nil {
		t.Fatal(err)
	}
	mustWriteFile(t, filepath.Join(root, "usr", "lib", "os-release"), "ID=fixture\n")
	if err := os.Symlink(filepath.Join("..", "usr", "lib", "os-release"), release); err != nil {
		t.Fatal(err)
	}
	if got := bootloaderID(root); got != "fixture" {
		t.Fatalf("bootloader id from a link inside the tree: %s", got)
	}
}

func TestWinIdentityTreeBoundary(t *testing.T) {
	for _, mode := range []IdentityMode{IdentityOriginal, IdentityNew} {
		t.Run(string(mode), func(t *testing.T) {
			sys := newFakeWinSystem(t.TempDir())
			seedFakeHives(sys)
			r := resumedWinRun(t, sys)
			seedWinTreeHives(t, r.rootVolume)
			r.opts.Identity = mode
			r.opts.Marker = &Marker{RecoveryID: "recovery", Nonce: "nonce"}
			other := t.TempDir()
			mustWriteFile(t, filepath.Join(other, "Breeze", "agent.yaml"), "agent_id: keep\n")
			mustWriteFile(t, filepath.Join(other, "Breeze", "secrets.yaml"), "keep")
			programData := filepath.Join(r.rootVolume, "ProgramData")
			if err := os.Rename(programData, programData+".saved"); err != nil {
				t.Fatal(err)
			}
			symlinkOrSkip(t, other, programData)
			if err := winIdentity(context.Background(), r); err == nil {
				t.Fatal("expected an error for a path that leaves the volume")
			}
			assertFileContent(t, filepath.Join(other, "Breeze", "agent.yaml"), "agent_id: keep\n")
			assertFileContent(t, filepath.Join(other, "Breeze", "secrets.yaml"), "keep")
			if _, err := os.Lstat(filepath.Join(other, "Breeze", "data")); !os.IsNotExist(err) {
				t.Fatalf("marker directory created outside the volume: %v", err)
			}
		})
	}
}

func TestWinEncryptionTreeBoundary(t *testing.T) {
	r := bitlockerRun(t, TargetDisk, true)
	mustMkdirAll(t, r.rootVolume)
	other := t.TempDir()
	symlinkOrSkip(t, other, filepath.Join(r.rootVolume, "ProgramData"))
	if err := winEncryption(context.Background(), r); err == nil {
		t.Fatal("expected an error for a path that leaves the volume")
	}
	assertDirEmpty(t, other)
}

// resumedWinRun is newWinIdentityRun as a resumed run sees it: the restore
// phase was skipped, so no hive is loaded yet.
func resumedWinRun(t *testing.T, sys *fakeWinSystem) *run {
	t.Helper()
	r := newWinIdentityRun(t, sys)
	r.hives, r.controlSets = nil, nil
	return r
}

// seedWinTreeHives writes placeholder SYSTEM/SOFTWARE files where a restored
// Windows tree keeps them; the fake WinSystem serves the hive contents.
func seedWinTreeHives(t *testing.T, rootVolume string) {
	t.Helper()
	for _, hive := range winStateHives {
		mustWriteFile(t, filepath.Join(rootVolume, "Windows", "System32", "config", hive), "hive")
	}
}

func TestBootloaderIDCharacters(t *testing.T) {
	for _, tc := range []struct{ osRelease, efiDir, want string }{
		{`ID=ubuntu`, "", "ubuntu"},
		{`ID="opensuse-leap"`, "", "opensuse-leap"},
		{`ID=rhel_9.4`, "", "rhel_9.4"},
		{`ID=../../etc`, "", "linux"},
		{`ID="a b"`, "", "linux"},
		{`ID=x;y`, "", "linux"},
		{`ID=` + strings.Repeat("a", 65), "", "linux"},
		{`ID=..`, "", "linux"},
		{`ID=-x`, "", "linux"},
		{`ID=../x`, "debian", "debian"},
		{"", "fedora", "fedora"},
		{"", "a b", "linux"},
		{"", "..x", "linux"},
	} {
		root := t.TempDir()
		if tc.osRelease != "" {
			mustWriteFile(t, filepath.Join(root, "etc", "os-release"), tc.osRelease+"\n")
		}
		if tc.efiDir != "" {
			mustMkdirAll(t, filepath.Join(root, "boot", "efi", "EFI", tc.efiDir))
			mustMkdirAll(t, filepath.Join(root, "boot", "efi", "EFI", "BOOT"))
		}
		if got := bootloaderID(root); got != tc.want {
			t.Errorf("os-release %q, EFI dir %q: bootloader id %q, want %q", tc.osRelease, tc.efiDir, got, tc.want)
		}
	}
}
