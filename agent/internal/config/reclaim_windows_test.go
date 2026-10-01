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

// TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated: a config folder
// a standard user created before the agent was installed is taken back before
// the agent reads it: the folder and everything in it owned by SYSTEM or
// Administrators, writable by no one else, agent.yaml still readable by
// Users (the Helper reads it), secrets.yaml not. The user can write nothing
// there afterwards.
func TestReclaimConfigDirTakesBackAFolderAnotherAccountCreated(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)

	if err := reclaimConfigDir(root, false); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, p := range []string{
		root,
		filepath.Join(root, "agent.yaml"),
		filepath.Join(root, "secrets.yaml"),
		filepath.Join(root, "agent.state"),
		filepath.Join(root, "data"),
		filepath.Join(root, "data", "sub"),
		filepath.Join(root, "data", "sub", "openh264.dll"),
	} {
		assertTrustedObject(t, p)
	}
	if sddl := reclaimSDDL(t, filepath.Join(root, "agent.yaml")); !strings.Contains(sddl, "(A;;FR;;;BU)") {
		t.Errorf("agent.yaml lost the Users read the Helper needs: %s", sddl)
	}
	if sddl := reclaimSDDL(t, filepath.Join(root, "secrets.yaml")); strings.Contains(sddl, ";;;BU)") {
		t.Errorf("secrets.yaml grants Users access: %s", sddl)
	}

	reclaimAsStandardUser(t, func() {
		if f, err := os.OpenFile(filepath.Join(root, "agent.yaml"), os.O_WRONLY, 0); err == nil {
			_ = f.Close()
			t.Error("the standard user can still write agent.yaml")
		}
		if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("x"), 0o644); err == nil {
			t.Error("the standard user can still create files in the folder")
		}
		if err := os.WriteFile(filepath.Join(root, "data", "sub", "openh264.dll"), []byte("swap"), 0o644); err == nil {
			t.Error("the standard user can still replace a file in the data dir")
		}
	})
}

// TestReclaimConfigDirForEnrollRemovesConfigAnotherAccountWrote: before an
// enrollment, agent.yaml and secrets.yaml another account wrote are removed,
// not adopted (their contents would be carried into the new enrollment).
// Other content is re-secured.
func TestReclaimConfigDirForEnrollRemovesConfigAnotherAccountWrote(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	plantFolderAsStandardUser(t, root)

	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for _, name := range []string{"agent.yaml", "secrets.yaml"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s was not removed before enrolling (lstat err %v)", name, err)
		}
	}
	assertTrustedObject(t, root)
	assertTrustedObject(t, filepath.Join(root, "agent.state"))
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
// (SYSTEM/Administrators-owned, its own DACLs) is not changed.
func TestReclaimConfigDirLeavesATrustedFolderAlone(t *testing.T) {
	requireElevatedRunner(t)
	root := filepath.Join(t.TempDir(), "Breeze")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := applyWindowsDACL(root, windowsConfigDirSDDL); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(root, "agent.yaml")
	secPath := filepath.Join(root, "secrets.yaml")
	for p, sddl := range map[string]string{cfgPath: reclaimOwnerSDDL + windowsConfigFileSDDL, secPath: reclaimOwnerSDDL + windowsSecretFileSDDL} {
		if err := os.WriteFile(p, []byte("agent_id: x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := applyWindowsDACL(p, sddl); err != nil {
			t.Fatal(err)
		}
	}
	before := map[string]string{root: reclaimSDDL(t, root), cfgPath: reclaimSDDL(t, cfgPath), secPath: reclaimSDDL(t, secPath)}

	if err := reclaimConfigDir(root, true); err != nil {
		t.Fatalf("reclaimConfigDir: %v", err)
	}
	for p, sddl := range before {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s removed from a trusted folder: %v", p, err)
			continue
		}
		if after := reclaimSDDL(t, p); after != sddl {
			t.Errorf("%s changed:\nbefore %s\nafter  %s", p, sddl, after)
		}
	}
}
