//go:build !windows

package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRoot runs reclaim as root with every path owned by defaultUID unless
// owners names it (the test is unprivileged: it can neither create root-owned
// files nor chown), and records the chowns instead of performing them.
func fakeRoot(t *testing.T, defaultUID uint32, owners map[string]uint32) *[]string {
	t.Helper()
	origEUID, origOwner, origChown := reclaimGeteuidFn, reclaimOwnerUIDFn, reclaimLchownFn
	t.Cleanup(func() { reclaimGeteuidFn, reclaimOwnerUIDFn, reclaimLchownFn = origEUID, origOwner, origChown })
	reclaimGeteuidFn = func() int { return 0 }
	if owners == nil {
		owners = map[string]uint32{}
	}
	reclaimOwnerUIDFn = func(path string, _ os.FileInfo) uint32 {
		if u, ok := owners[path]; ok {
			return u
		}
		return defaultUID
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
	if err := os.WriteFile(path, []byte("server_url: https://elsewhere.example\n"), 0o600); err != nil {
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

func gone(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	return errors.Is(err, os.ErrNotExist)
}

// quarantined reports whether name was set aside into root's quarantine.
func quarantined(t *testing.T, root, name string) bool {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(root, reclaimQuarantineDir, "*", name))
	if err != nil {
		t.Fatal(err)
	}
	return len(matches) == 1
}

// plantUnixConfigDir lays out a config dir another account created and
// filled, everything world-writable.
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

// TestReclaimConfigDirUnixTakesBackAFolderAnotherAccountCreated: at start,
// the folder is taken back, the config files are replaced by fresh copies
// (contents kept, modes explicit, a new file so the other account's handles
// no longer reach it) and everything else that account owns is set aside
// without being walked into or chowned.
func TestReclaimConfigDirUnixTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	root := plantUnixConfigDir(t)
	before, err := os.Stat(filepath.Join(root, "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	chowned := fakeRoot(t, 1000, nil)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 1 || (*chowned)[0] != root {
		t.Errorf("chowned %v, want only the folder itself (nothing inside it is chowned)", *chowned)
	}
	if m := modeOfPath(t, root); m&0o002 != 0 {
		t.Errorf("folder mode %o still world-writable", m)
	}
	for name, want := range map[string]os.FileMode{"agent.yaml": 0o644, "secrets.yaml": 0o600} {
		p := filepath.Join(root, name)
		if m := modeOfPath(t, p); m != want {
			t.Errorf("%s mode %o, want %o", name, m, want)
		}
		if b, err := os.ReadFile(p); err != nil || !strings.Contains(string(b), "server_url") {
			t.Errorf("%s contents not kept: %q, %v", name, b, err)
		}
	}
	after, err := os.Stat(filepath.Join(root, "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Error("agent.yaml is the same file: a handle the other account holds still reaches it")
	}
	for _, name := range []string{"agent.state", "data"} {
		if !gone(t, filepath.Join(root, name)) || !quarantined(t, root, name) {
			t.Errorf("%s was not set aside into quarantine", name)
		}
	}
}

// TestReclaimConfigDirUnixForEnrollSetsAsideConfigAnotherAccountWrote:
// before enrolling, config files another account owns are set aside, not
// adopted: their contents (a server, pinned keys, tool dirs) must not carry
// into the new identity.
func TestReclaimConfigDirUnixForEnrollSetsAsideConfigAnotherAccountWrote(t *testing.T) {
	root := plantUnixConfigDir(t)
	fakeRoot(t, 1000, nil)
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, name := range []string{"agent.yaml", "secrets.yaml"} {
		if !gone(t, filepath.Join(root, name)) || !quarantined(t, root, name) {
			t.Errorf("%s was not set aside before enrolling", name)
		}
	}
}

// TestReclaimConfigDirUnixRefusesAnotherAccountsLink: a symlink in place of
// the folder that another account owns is refused, not followed.
func TestReclaimConfigDirUnixRefusesAnotherAccountsLink(t *testing.T) {
	target := t.TempDir()
	root := filepath.Join(t.TempDir(), "breeze")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	chowned := fakeRoot(t, 1000, nil)
	err := reclaimConfigDir(root, false)
	if !errors.Is(err, ErrConfigDirUntrusted) || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("err = %v, want ErrConfigDirUntrusted naming the symbolic link", err)
	}
	if len(*chowned) != 0 {
		t.Errorf("chowned %v through a refused link", *chowned)
	}
}

// TestReclaimConfigDirUnixFollowsRootsOwnLink: an administrator may move the
// folder and leave a root-owned symlink (e.g. /var/lib/breeze on another
// volume); that is followed, and the target is checked instead.
func TestReclaimConfigDirUnixFollowsRootsOwnLink(t *testing.T) {
	target := filepath.Join(t.TempDir(), "breeze-data")
	mkdirMode(t, target, 0o755)
	writeMode(t, filepath.Join(target, "agent.yaml"), 0o644)
	root := filepath.Join(t.TempDir(), "breeze")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	chowned := fakeRoot(t, 0, nil)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("a root-owned symlink must be followed: %v", err)
	}
	if len(*chowned) != 0 || gone(t, filepath.Join(resolved, "agent.yaml")) {
		t.Errorf("a trusted target was changed (chowned %v)", *chowned)
	}
}

// TestReclaimConfigDirUnixRemovesAPlantedLink: a symlink another account
// planted inside the folder is removed (the link, not its target).
func TestReclaimConfigDirUnixRemovesAPlantedLink(t *testing.T) {
	root := plantUnixConfigDir(t)
	target := filepath.Join(t.TempDir(), "elsewhere")
	writeMode(t, target, 0o644)
	link := filepath.Join(root, "run")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	fakeRoot(t, 1000, nil)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if !gone(t, link) {
		t.Error("planted link not removed")
	}
	if _, err := os.Stat(target); err != nil {
		t.Errorf("the link's target was touched: %v", err)
	}
}

// TestReclaimConfigDirUnixLeavesATrustedFolderAlone: the agent's own layout
// is not changed, including what is group-writable by design (the macOS
// installer's 0770 folder, the 0660 IPC socket), the helper token's 0640 and
// a session dir the session's user owns.
func TestReclaimConfigDirUnixLeavesATrustedFolderAlone(t *testing.T) {
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o770)
	modes := map[string]os.FileMode{"agent.yaml": 0o644, "secrets.yaml": 0o600, "helper_token.yaml": 0o640, "agent.sock": 0o660}
	for name, m := range modes {
		writeMode(t, filepath.Join(root, name), m)
	}
	mkdirMode(t, filepath.Join(root, "sessions"), 0o755)
	userSession := filepath.Join(root, "sessions", "abc")
	mkdirMode(t, userSession, 0o700)

	chowned := fakeRoot(t, 0, map[string]uint32{userSession: 501})
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 0 {
		t.Errorf("chowned %v in a trusted folder", *chowned)
	}
	if m := modeOfPath(t, root); m != 0o770 {
		t.Errorf("folder mode %o, want unchanged 770", m)
	}
	for name, want := range modes {
		if m := modeOfPath(t, filepath.Join(root, name)); m != want {
			t.Errorf("%s mode %o, want unchanged %o", name, m, want)
		}
	}
	if gone(t, userSession) || !gone(t, filepath.Join(root, reclaimQuarantineDir)) {
		t.Error("a trusted folder had entries set aside")
	}
}

// TestReclaimConfigDirUnixClearsWorldWriteOnRootsOwnEntry: an entry root owns
// that is only world-writable is fixed in place (its path cannot be swapped:
// it and its parent are root's), not set aside.
func TestReclaimConfigDirUnixClearsWorldWriteOnRootsOwnEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o755)
	state := filepath.Join(root, "agent.state")
	writeMode(t, state, 0o666)
	fakeRoot(t, 0, nil)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if m := modeOfPath(t, state); m != 0o664 {
		t.Errorf("agent.state mode %o, want 664", m)
	}
}

// TestReclaimConfigDirUnixIsANoOpWhenNotRoot: only root can take a folder
// back, and a non-root run is never the installed agent.
func TestReclaimConfigDirUnixIsANoOpWhenNotRoot(t *testing.T) {
	root := plantUnixConfigDir(t)
	chowned := fakeRoot(t, 1000, nil)
	reclaimGeteuidFn = func() int { return 1000 }
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 0 || modeOfPath(t, root) != 0o777 || gone(t, filepath.Join(root, "agent.yaml")) {
		t.Errorf("a non-root run changed the folder (chowned %v)", *chowned)
	}
}
