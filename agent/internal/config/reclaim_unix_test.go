//go:build !windows

package config

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// fakeRoot makes reclaim see every entry as owned by uid (the test runs as an
// unprivileged user, so it cannot create root-owned files) and records the
// chowns instead of performing them.
func fakeRoot(t *testing.T, uid uint32) *[]string {
	t.Helper()
	origEUID, origOwner, origChown := reclaimGeteuidFn, reclaimOwnerUIDFn, reclaimLchownFn
	t.Cleanup(func() { reclaimGeteuidFn, reclaimOwnerUIDFn, reclaimLchownFn = origEUID, origOwner, origChown })
	reclaimGeteuidFn = func() int { return 0 }
	owners := map[string]uint32{}
	reclaimOwnerUIDFn = func(path string, _ os.FileInfo) uint32 {
		if u, ok := owners[path]; ok {
			return u
		}
		return uid
	}
	var chowned []string
	reclaimLchownFn = func(path string) error {
		chowned = append(chowned, path)
		owners[path] = 0
		return nil
	}
	return &chowned
}

func writeMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func mkdirMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func modeOfPath(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

// plantUnixConfigDir lays out a config dir another (non-root) account
// created: everything group/world-writable.
func plantUnixConfigDir(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o777)
	writeMode(t, filepath.Join(root, "agent.yaml"), 0o666)
	writeMode(t, filepath.Join(root, "secrets.yaml"), 0o666)
	writeMode(t, filepath.Join(root, "agent.state"), 0o666)
	mkdirMode(t, filepath.Join(root, "data"), 0o777)
	writeMode(t, filepath.Join(root, "data", "audit.jsonl"), 0o666)
	return root
}

// TestReclaimConfigDirUnixTakesBackAFolderAnotherAccountCreated: run as root,
// the agent takes back a config dir another account created before it reads
// anything from it: every entry becomes root-owned and nothing stays
// group/world-writable.
func TestReclaimConfigDirUnixTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	root := plantUnixConfigDir(t)
	chowned := fakeRoot(t, 1000)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	want := []string{
		root,
		filepath.Join(root, "agent.state"),
		filepath.Join(root, "agent.yaml"),
		filepath.Join(root, "data"),
		filepath.Join(root, "data", "audit.jsonl"),
		filepath.Join(root, "secrets.yaml"),
	}
	got := append([]string(nil), (*chowned)...)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("chowned %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("chowned %v, want %v", got, want)
		}
	}
	for _, p := range want {
		if m := modeOfPath(t, p); m&0o022 != 0 {
			t.Errorf("%s mode %o is still group/world-writable", p, m)
		}
	}
	if m := modeOfPath(t, filepath.Join(root, "secrets.yaml")); m != 0o600 {
		t.Errorf("secrets.yaml mode %o, want 600", m)
	}
}

// TestReclaimConfigDirUnixForEnrollRemovesConfigAnotherAccountWrote: before
// enrolling, a config file another account could have written is removed,
// not adopted: enrollment writes a new one, and the old contents (pinned keys,
// tool dirs, a backup server) must not be carried into it.
func TestReclaimConfigDirUnixForEnrollRemovesConfigAnotherAccountWrote(t *testing.T) {
	root := plantUnixConfigDir(t)
	fakeRoot(t, 1000)
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, name := range []string{"agent.yaml", "secrets.yaml"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Errorf("%s was not removed before enrolling (stat err %v)", name, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, "agent.state")); err != nil {
		t.Errorf("agent.state should be re-secured, not removed: %v", err)
	}
}

// TestReclaimConfigDirUnixRefusesALinkedFolder: a symlink where the config
// dir should be is refused, not followed.
func TestReclaimConfigDirUnixRefusesALinkedFolder(t *testing.T) {
	target := t.TempDir()
	root := filepath.Join(t.TempDir(), "breeze")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	chowned := fakeRoot(t, 1000)
	err := reclaimConfigDir(root, false)
	if !errors.Is(err, ErrConfigDirUntrusted) || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("err = %v, want ErrConfigDirUntrusted naming the symbolic link", err)
	}
	if len(*chowned) != 0 {
		t.Errorf("chowned %v through a refused link", *chowned)
	}
}

// TestReclaimConfigDirUnixRemovesAPlantedLink: a symlink inside the config
// dir that another account owns is removed (the link only, not its target).
func TestReclaimConfigDirUnixRemovesAPlantedLink(t *testing.T) {
	root := plantUnixConfigDir(t)
	target := filepath.Join(t.TempDir(), "elsewhere")
	writeMode(t, target, 0o644)
	link := filepath.Join(root, "run")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	fakeRoot(t, 1000)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Errorf("planted link not removed (lstat err %v)", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Errorf("the link's target was touched: %v", err)
	}
}

// TestReclaimConfigDirUnixLeavesATrustedFolderAlone: a root-owned dir with
// sane modes is not changed.
func TestReclaimConfigDirUnixLeavesATrustedFolderAlone(t *testing.T) {
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o755)
	writeMode(t, filepath.Join(root, "agent.yaml"), 0o644)
	writeMode(t, filepath.Join(root, "secrets.yaml"), 0o600)
	writeMode(t, filepath.Join(root, "helper_token.yaml"), 0o640)
	chowned := fakeRoot(t, 0)
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 0 {
		t.Errorf("chowned %v in a trusted dir", *chowned)
	}
	for name, want := range map[string]os.FileMode{"agent.yaml": 0o644, "secrets.yaml": 0o600, "helper_token.yaml": 0o640} {
		if m := modeOfPath(t, filepath.Join(root, name)); m != want {
			t.Errorf("%s mode %o, want unchanged %o", name, m, want)
		}
	}
}

// TestReclaimConfigDirUnixIsANoOpWhenNotRoot: only root can take a folder
// back, and a non-root run is never the installed agent.
func TestReclaimConfigDirUnixIsANoOpWhenNotRoot(t *testing.T) {
	root := plantUnixConfigDir(t)
	chowned := fakeRoot(t, 1000)
	reclaimGeteuidFn = func() int { return 1000 }
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 0 || modeOfPath(t, root) != 0o777 {
		t.Errorf("a non-root run changed the folder (chowned %v, mode %o)", *chowned, modeOfPath(t, root))
	}
	if _, err := os.Lstat(filepath.Join(root, "agent.yaml")); err != nil {
		t.Errorf("a non-root run removed agent.yaml: %v", err)
	}
}
