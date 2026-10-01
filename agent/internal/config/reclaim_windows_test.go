//go:build windows

package config

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// These tests need an elevated runner: the folder is planted as a simulated
// standard user, then taken back with the runner's administrator token, as
// the installed agent (SYSTEM) or an elevated `breeze-agent enroll` would.

var reclaimProcCreateRestrictedToken = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")

const reclaimDisableMaxPrivilege = 0x1

// reclaimAsStandardUser runs fn on this OS thread impersonating a filtered
// copy of the process token: Administrators deny-only, no privileges but
// SeChangeNotify. Objects fn creates are owned by the user, not
// Administrators, exactly as a standard user's would be.
func reclaimAsStandardUser(t *testing.T, fn func()) {
	t.Helper()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	var proc windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_IMPERSONATE, &proc); err != nil {
		t.Fatalf("open process token: %v", err)
	}
	defer func() { _ = proc.Close() }()
	disable := []windows.SIDAndAttributes{{Sid: admins}}
	var restricted windows.Token
	r, _, callErr := reclaimProcCreateRestrictedToken.Call(
		uintptr(proc), reclaimDisableMaxPrivilege,
		uintptr(len(disable)), uintptr(unsafe.Pointer(&disable[0])),
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(&restricted)),
	)
	if r == 0 {
		t.Fatalf("CreateRestrictedToken: %v", callErr)
	}
	defer func() { _ = restricted.Close() }()
	var imp windows.Token
	if err := windows.DuplicateTokenEx(restricted, windows.TOKEN_IMPERSONATE|windows.TOKEN_QUERY,
		nil, windows.SecurityImpersonation, windows.TokenImpersonation, &imp); err != nil {
		t.Fatalf("duplicate impersonation token: %v", err)
	}
	defer func() { _ = imp.Close() }()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.SetThreadToken(nil, imp); err != nil {
		t.Fatalf("impersonate filtered token: %v", err)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			panic("RevertToSelf failed: " + err.Error())
		}
	}()
	if member, err := windows.Token(0).IsMember(admins); err != nil || member {
		t.Fatalf("impersonation did not take effect (Administrators enabled=%v, err=%v)", member, err)
	}
	fn()
}

func requireElevatedRunner(t *testing.T) {
	t.Helper()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if member, err := windows.Token(0).IsMember(admins); err != nil || !member {
		t.Skip("needs an elevated runner token (Administrators enabled)")
	}
}

// plantFolderAsStandardUser creates root and its content as a standard user
// would have: the folder, agent.yaml, secrets.yaml, agent.state and a data
// subtree, all owned by that user.
func plantFolderAsStandardUser(t *testing.T, root string) {
	t.Helper()
	reclaimAsStandardUser(t, func() {
		if err := os.Mkdir(root, 0o755); err != nil {
			t.Fatalf("mkdir as a standard user: %v", err)
		}
		for _, name := range []string{"agent.yaml", "secrets.yaml", "agent.state"} {
			if err := os.WriteFile(filepath.Join(root, name), []byte("server_url: https://elsewhere.example\n"), 0o644); err != nil {
				t.Fatalf("write %s as a standard user: %v", name, err)
			}
		}
		if err := os.MkdirAll(filepath.Join(root, "data", "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "data", "sub", "openh264.dll"), []byte("planted"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	if untrusted, err := ownerUntrusted(root); err != nil || !untrusted {
		t.Fatalf("planted folder owner not untrusted (untrusted=%v err=%v): the test plants nothing", untrusted, err)
	}
}

func assertTrustedObject(t *testing.T, path string) {
	t.Helper()
	sec, err := readProgramDataPathSecurity(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := checkProgramDataObject(path, sec); err != nil {
		t.Errorf("%s not trusted after reclaim: %v", path, err)
	}
}

func reclaimSDDL(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("read SD of %s: %v", path, err)
	}
	return sd.String()
}

func setAsideDir(t *testing.T, root string) string {
	t.Helper()
	matches, err := filepath.Glob(root + ".untrusted-*")
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("set-aside folders next to %s: %v, want exactly one", root, matches)
	}
	return matches[0]
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// openAsStandardUser opens path as the simulated standard user and returns a
// func closing the handle (once; also run at cleanup) and the handle, which
// outlives the impersonation.
func openAsStandardUser(t *testing.T, path string, access, share, flags uint32) (func(), windows.Handle) {
	t.Helper()
	var h windows.Handle
	reclaimAsStandardUser(t, func() {
		p16, _ := windows.UTF16PtrFromString(path)
		var err error
		h, err = windows.CreateFile(p16, access, share, nil, windows.OPEN_EXISTING, flags, 0)
		if err != nil {
			t.Fatalf("open %s as the standard user: %v", path, err)
		}
	})
	var once sync.Once
	closeHandle := func() { once.Do(func() { _ = windows.CloseHandle(h) }) }
	t.Cleanup(closeHandle)
	return closeHandle, h
}

const reclaimFileAddFile = 0x0002 // FILE_ADD_FILE

const shareAll = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

// TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated: a config folder
// a standard user created before the agent was installed is replaced before
// the agent reads it, not repaired in place (a handle the user opened while
// owning it would keep its access). The user's config files are not adopted
// (kept in the set-aside folder), and the user can write nothing in the new
// folder.
func TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	assertTrustedObject(t, root)
	aside := setAsideDir(t, root)
	for _, name := range []string{"agent.yaml", "secrets.yaml", "agent.state", "data"} {
		if exists(filepath.Join(root, name)) {
			t.Errorf("%s the other account owned is in the agent's folder", name)
		}
		if !exists(filepath.Join(aside, name)) {
			t.Errorf("%s was not kept in the set-aside folder %s", name, aside)
		}
	}
	reclaimAsStandardUser(t, func() {
		if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("x"), 0o644); err == nil {
			t.Error("the standard user can create files in the new folder")
		}
	})
	if matches, _ := filepath.Glob(root + ".new-*"); len(matches) != 0 {
		t.Errorf("staging folder left behind: %v", matches)
	}
}

// TestReclaimConfigDirCarriesTheAgentsOwnConfig: in a folder another account
// controlled, a config file an administrator wrote (Administrators owner) is
// carried into the new folder with its contents and the agent's DACL (Users
// read on agent.yaml only); the other account's secrets.yaml is not.
func TestReclaimConfigDirCarriesTheAgentsOwnConfig(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	cfgPath := filepath.Join(root, "agent.yaml")
	if err := os.Remove(cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte("agent_id: admin-written\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if untrusted, err := ownerUntrusted(cfgPath); err != nil || untrusted {
		t.Fatalf("admin-written agent.yaml owner untrusted=%v err=%v", untrusted, err)
	}

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if b, err := os.ReadFile(cfgPath); err != nil || string(b) != "agent_id: admin-written\n" {
		t.Fatalf("agent.yaml not carried over: %q, %v", b, err)
	}
	assertTrustedObject(t, cfgPath)
	if sddl := reclaimSDDL(t, cfgPath); !strings.Contains(sddl, "(A;;FR;;;BU)") {
		t.Errorf("agent.yaml lacks the Users read the Helper needs: %s", sddl)
	}
	if exists(filepath.Join(root, "secrets.yaml")) {
		t.Error("the other account's secrets.yaml was carried over")
	}
}

// TestReclaimConfigDirDoesNotCarryAHardLinkedConfig: a config file with
// another hard link is not copied: the link could make the agent copy some
// other file's contents into its (Users-readable) agent.yaml.
func TestReclaimConfigDirDoesNotCarryAHardLinkedConfig(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	cfgPath := filepath.Join(root, "agent.yaml")
	if err := os.Remove(cfgPath); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "system-only.txt")
	if err := os.WriteFile(other, []byte("not for Users\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(other, cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	if exists(cfgPath) {
		t.Error("a hard-linked agent.yaml was copied into the new folder")
	}
}

// TestReclaimConfigDirForEnrollSetsAsideConfigAnotherAccountWrote: before an
// enrollment, the other account's config files are not carried over either;
// enrollment writes new ones.
func TestReclaimConfigDirForEnrollSetsAsideConfigAnotherAccountWrote(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	aside := setAsideDir(t, root)
	for _, name := range []string{"agent.yaml", "secrets.yaml"} {
		if exists(filepath.Join(root, name)) || !exists(filepath.Join(aside, name)) {
			t.Errorf("%s was not set aside before enrolling", name)
		}
	}
	assertTrustedObject(t, root)
}

// TestReclaimConfigDirRefusesALinkedFolder: a junction where the config
// folder should be is refused, and its target is not re-permissioned.
func TestReclaimConfigDirRefusesALinkedFolder(t *testing.T) {
	requireElevatedRunner(t)
	target := filepath.Join(t.TempDir(), "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "Breeze")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", root, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
	before := reclaimSDDL(t, target)
	if err := reclaimConfigDir(root, false); !errors.Is(err, ErrConfigDirUntrusted) {
		t.Fatalf("err = %v, want ErrConfigDirUntrusted", err)
	}
	if after := reclaimSDDL(t, target); after != before {
		t.Errorf("the junction target was re-permissioned:\nbefore %s\nafter  %s", before, after)
	}
}

// TestReclaimConfigDirLeavesATrustedFolderAlone: a folder the agent created
// is not replaced; its config files are untouched and a second run changes
// nothing.
func TestReclaimConfigDirLeavesATrustedFolderAlone(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	if err := createMainAgentDirectory(root, windowsConfigDirCreateSDDL); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(root, "agent.yaml")
	secPath := filepath.Join(root, "secrets.yaml")
	for p, sddl := range map[string]string{cfgPath: windowsConfigFileSDDL, secPath: windowsSecretFileSDDL} {
		if err := os.WriteFile(p, []byte("agent_id: x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := applyWindowsDACL(p, sddl); err != nil {
			t.Fatal(err)
		}
	}
	before := map[string]string{cfgPath: reclaimSDDL(t, cfgPath), secPath: reclaimSDDL(t, secPath)}
	beforeInfo, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for p, sddl := range before {
		if after := reclaimSDDL(t, p); after != sddl {
			t.Errorf("%s changed:\nbefore %s\nafter  %s", p, sddl, after)
		}
	}
	if afterInfo, err := os.Stat(cfgPath); err != nil || !os.SameFile(beforeInfo, afterInfo) {
		t.Errorf("agent.yaml in a trusted folder was replaced or removed (err %v)", err)
	}
	if matches, _ := filepath.Glob(root + ".untrusted-*"); len(matches) != 0 {
		t.Errorf("a trusted folder was replaced: %v", matches)
	}
	assertTrustedObject(t, root)
	rootSDDL := reclaimSDDL(t, root)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("second reclaimConfigDir: %v", err)
	}
	if after := reclaimSDDL(t, root); after != rootSDDL {
		t.Errorf("a second run changed the folder:\nbefore %s\nafter  %s", rootSDDL, after)
	}
}

// TestReclaimConfigDirRefusesWhileAnotherAccountHoldsAFileOpen: a handle the
// other account opened while it owned the folder keeps its access after any
// owner or DACL change. NTFS will not rename the folder while a file in it is
// open (whatever the sharing), so the agent refuses (the folder stays as it
// was, no staging folder is left) rather than run in a folder that account
// can still change; once the handle is gone (at the latest after a reboot, as
// services start before any user logon) the folder is replaced.
func TestReclaimConfigDirRefusesWhileAnotherAccountHoldsAFileOpen(t *testing.T) {
	requireElevatedRunner(t)
	for name, share := range map[string]uint32{
		"shared for delete":     shareAll,
		"not shared for delete": windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE,
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Breeze")
			plantFolderAsStandardUser(t, root)
			closeHandle, _ := openAsStandardUser(t, filepath.Join(root, "agent.state"), windows.GENERIC_WRITE, share, 0)

			if err := reclaimConfigDir(root, false); !errors.Is(err, ErrConfigDirUntrusted) {
				t.Fatalf("err = %v while another account holds a file open, want ErrConfigDirUntrusted", err)
			}
			if matches, _ := filepath.Glob(root + ".new-*"); len(matches) != 0 {
				t.Errorf("staging folder left behind: %v", matches)
			}
			if !exists(filepath.Join(root, "agent.state")) {
				t.Error("the folder was changed by a refused reclaim")
			}
			closeHandle()
			if err := reclaimConfigDir(root, false); err != nil {
				t.Fatalf("reclaimConfigDir once the handle is closed: %v", err)
			}
			assertTrustedObject(t, root)
		})
	}
}

// TestReclaimConfigDirLeavesAHeldFolderHandleBehind: a handle to the folder
// itself that the other account opened (for adding files) while it owned the
// folder does not block the replacement, and afterwards reaches the
// set-aside folder, not the agent's.
func TestReclaimConfigDirLeavesAHeldFolderHandleBehind(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	_, h := openAsStandardUser(t, root, reclaimFileAddFile|windows.FILE_LIST_DIRECTORY, shareAll, windows.FILE_FLAG_BACKUP_SEMANTICS)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		t.Fatalf("GetFinalPathNameByHandle: %v", err)
	}
	if p := windows.UTF16ToString(buf[:n]); !strings.Contains(strings.ToLower(p), ".untrusted-") {
		t.Errorf("the other account's folder handle reaches %s, not the set-aside folder", p)
	}
	assertTrustedObject(t, root)
}
