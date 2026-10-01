//go:build windows

package config

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

func quarantinedWin(t *testing.T, root, name string) bool {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(root, reclaimQuarantineDir, "*", name))
	if err != nil {
		t.Fatal(err)
	}
	return len(matches) == 1
}

// TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated: a config folder
// a standard user created before the agent was installed is taken back before
// the agent reads it. The folder is the agent's; agent.yaml and secrets.yaml
// are fresh copies (contents kept, the agent's owner and DACL, Users read on
// agent.yaml only), so a write handle that user opened beforehand no longer
// reaches them; everything else the user owned is set aside, unread. The user
// can write nothing there afterwards.
func TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	cfgPath := filepath.Join(root, "agent.yaml")

	// A write handle the standard user opened beforehand, shared for
	// delete (so the agent can replace the file): afterwards it must no
	// longer reach agent.yaml.
	var held windows.Handle
	reclaimAsStandardUser(t, func() {
		p16, _ := windows.UTF16PtrFromString(cfgPath)
		h, err := windows.CreateFile(p16, windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
		if err != nil {
			t.Fatalf("open agent.yaml for write as the standard user: %v", err)
		}
		held = h
	})
	defer func() { _ = windows.CloseHandle(held) }()

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, p := range []string{root, cfgPath, filepath.Join(root, "secrets.yaml")} {
		assertTrustedObject(t, p)
	}
	if b, err := os.ReadFile(cfgPath); err != nil || !strings.Contains(string(b), "server_url") {
		t.Errorf("agent.yaml contents not kept: %q, %v", b, err)
	}
	if sddl := reclaimSDDL(t, cfgPath); !strings.Contains(sddl, "(A;;FR;;;BU)") {
		t.Errorf("agent.yaml lost the Users read the Helper needs: %s", sddl)
	}
	if sddl := reclaimSDDL(t, filepath.Join(root, "secrets.yaml")); strings.Contains(sddl, ";;;BU)") {
		t.Errorf("secrets.yaml grants Users access: %s", sddl)
	}
	for _, name := range []string{"agent.state", "data"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) || !quarantinedWin(t, root, name) {
			t.Errorf("%s was not set aside into quarantine (lstat err %v)", name, err)
		}
	}

	var n uint32
	if err := windows.WriteFile(held, []byte("server_url: https://attacker.example\n"), &n, nil); err == nil {
		if b, _ := os.ReadFile(cfgPath); strings.Contains(string(b), "attacker") {
			t.Error("a write handle opened before the reclaim still changes agent.yaml")
		}
	}
	reclaimAsStandardUser(t, func() {
		if f, err := os.OpenFile(cfgPath, os.O_WRONLY, 0); err == nil {
			_ = f.Close()
			t.Error("the standard user can still write agent.yaml")
		}
		if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("x"), 0o644); err == nil {
			t.Error("the standard user can still create files in the folder")
		}
	})
}

// TestReclaimConfigDirForEnrollSetsAsideConfigAnotherAccountWrote: before an
// enrollment, agent.yaml and secrets.yaml another account owns are set aside,
// not adopted (their contents would carry into the new enrollment).
func TestReclaimConfigDirForEnrollSetsAsideConfigAnotherAccountWrote(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)

	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, name := range []string{"agent.yaml", "secrets.yaml"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) || !quarantinedWin(t, root, name) {
			t.Errorf("%s was not set aside before enrolling (lstat err %v)", name, err)
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
// (its own owner and DACLs) is not changed and nothing is set aside.
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
	if _, err := os.Lstat(filepath.Join(root, reclaimQuarantineDir)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a trusted folder had entries set aside (lstat err %v)", err)
	}
	// The folder itself is re-hardened through its handle on every run (as
	// the instance guard does); that is stable: a second run changes nothing.
	assertTrustedObject(t, root)
	rootSDDL := reclaimSDDL(t, root)
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("second reclaimConfigDir: %v", err)
	}
	if after := reclaimSDDL(t, root); after != rootSDDL {
		t.Errorf("a second run changed the folder:\nbefore %s\nafter  %s", rootSDDL, after)
	}
}

// TestReclaimConfigDirRefusesWhileAnotherAccountHoldsAConfigFile: a config
// file another account holds open without delete sharing cannot be replaced
// by a fresh copy; the agent refuses rather than re-secure it in place, which
// would leave that handle able to write the agent's config. Once the handle
// is gone the folder is taken back.
func TestReclaimConfigDirRefusesWhileAnotherAccountHoldsAConfigFile(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)
	cfgPath := filepath.Join(root, "agent.yaml")
	var held *os.File
	reclaimAsStandardUser(t, func() {
		f, err := os.OpenFile(cfgPath, os.O_WRONLY, 0)
		if err != nil {
			t.Fatalf("open agent.yaml as the standard user: %v", err)
		}
		held = f
	})
	if err := reclaimConfigDir(root, false); !errors.Is(err, ErrConfigDirUntrusted) {
		_ = held.Close()
		t.Fatalf("err = %v while another account holds agent.yaml open, want ErrConfigDirUntrusted", err)
	}
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir once the handle is closed: %v", err)
	}
	assertTrustedObject(t, cfgPath)
}
