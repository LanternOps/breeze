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
// the folder is taken back (root owner, no group/world write) and everything
// the other account owns in it, config files included, is set aside unread:
// nothing inside is chowned, walked into or adopted.
func TestReclaimConfigDirUnixTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	root := plantUnixConfigDir(t)
	chowned := fakeRoot(t, 1000, nil)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if len(*chowned) != 1 || (*chowned)[0] != root {
		t.Errorf("chowned %v, want only the folder itself", *chowned)
	}
	if m := modeOfPath(t, root); m != 0o755 {
		t.Errorf("folder mode %o, want 755 (no group/world write)", m)
	}
	for _, name := range []string{"agent.yaml", "secrets.yaml", "agent.state", "data"} {
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
// it and its parent are root's), not set aside; a config file gets its mode.
func TestReclaimConfigDirUnixClearsWorldWriteOnRootsOwnEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o755)
	state := filepath.Join(root, "agent.state")
	cfg := filepath.Join(root, "agent.yaml")
	writeMode(t, state, 0o666)
	writeMode(t, cfg, 0o666)
	fakeRoot(t, 0, nil)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if m := modeOfPath(t, state); m != 0o664 {
		t.Errorf("agent.state mode %o, want 664", m)
	}
	if m := modeOfPath(t, cfg); m != 0o644 {
		t.Errorf("agent.yaml mode %o, want 644", m)
	}
}

// TestReclaimConfigDirUnixSkipsOnlyRealRootOwnedSpecialDirs: sessions and
// quarantine are left alone only as real directories root owns. Another
// account's symlink by either name is removed (never followed by the later
// MkdirAll/Rename into quarantine, or the helper's chown into sessions), and
// another account's sessions dir is set aside. A helper.log the Assist helper
// wrote as the user stays.
func TestReclaimConfigDirUnixSkipsOnlyRealRootOwnedSpecialDirs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "breeze")
	mkdirMode(t, root, 0o755)
	elsewhere := t.TempDir()
	quarantineLink := filepath.Join(root, reclaimQuarantineDir)
	if err := os.Symlink(elsewhere, quarantineLink); err != nil {
		t.Fatal(err)
	}
	sessions := filepath.Join(root, "sessions")
	mkdirMode(t, sessions, 0o777)
	helperLog := filepath.Join(root, "helper.log")
	writeMode(t, helperLog, 0o644)
	writeMode(t, filepath.Join(root, "agent.state"), 0o644)

	fakeRoot(t, 0, map[string]uint32{quarantineLink: 1000, sessions: 1000, helperLog: 501, filepath.Join(root, "agent.state"): 1000})
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if fi, err := os.Lstat(quarantineLink); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		t.Error("another account's quarantine symlink was kept")
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("entries were moved through a planted quarantine link into %s", elsewhere)
	}
	if !gone(t, sessions) || !quarantined(t, root, "sessions") {
		t.Error("another account's sessions dir was not set aside")
	}
	if gone(t, helperLog) {
		t.Error("the helper's log was set aside")
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
