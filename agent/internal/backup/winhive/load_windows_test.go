//go:build windows

package winhive

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// UnloadStale with a prefix no mount can have finds nothing and does not
// error — the enumeration of HKLM itself works under the runner's token
// (no privileges needed: nothing matches, so RegUnLoadKeyW never runs).
func TestUnloadStale_NoMatches(t *testing.T) {
	n, err := UnloadStale("BRZ_no_such_mount_")
	if err != nil || n != 0 {
		t.Fatalf("UnloadStale = %d, %v", n, err)
	}
}

// enablePrivilegesForTest enables names on the process token for the rest
// of the test (package winhive itself does no privilege work — ruling B2 —
// so the test plays the caller's part) and restores the prior state in
// Cleanup. Skips loudly when the token does not hold them.
func enablePrivilegesForTest(t *testing.T, names ...string) {
	t.Helper()
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = token.Close() })
	for _, name := range names {
		np, _ := windows.UTF16PtrFromString(name)
		var luid windows.LUID
		if err := windows.LookupPrivilegeValue(nil, np, &luid); err != nil {
			t.Fatalf("LookupPrivilegeValue(%s): %v", name, err)
		}
		tp := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}}
		var prev windows.Tokenprivileges
		var n uint32
		// Raw proc, not x/sys's wrapper: ERROR_NOT_ALL_ASSIGNED (token lacks
		// the privilege) arrives as a SUCCESS return with a last-error the
		// wrapper discards.
		r1, _, callErr := procAdjustTokenPrivilegesForTest.Call(uintptr(token), 0, uintptr(unsafe.Pointer(&tp)), unsafe.Sizeof(prev), uintptr(unsafe.Pointer(&prev)), uintptr(unsafe.Pointer(&n)))
		if r1 == 0 {
			t.Fatalf("AdjustTokenPrivileges(%s): %v", name, callErr)
		}
		if errors.Is(callErr, windows.ERROR_NOT_ALL_ASSIGNED) {
			t.Skipf("process token does not hold %s (non-elevated runner): the missing-file check would not be reached discriminatingly — run elevated", name)
		}
		if prev.PrivilegeCount == 1 { // state changed: it was disabled before
			restore := prev
			t.Cleanup(func() { _ = windows.AdjustTokenPrivileges(token, false, &restore, 0, nil, nil) })
		}
	}
}

var procAdjustTokenPrivilegesForTest = windows.NewLazySystemDLL("advapi32.dll").NewProc("AdjustTokenPrivileges")

func hklmKeyExists(name string) bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, name, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	_ = k.Close()
	return true
}

// Load of a hive file that does not exist is refused with fs.ErrNotExist
// and leaves no HKLM mount and no file behind. SeBackup/SeRestore are
// enabled first: with them, RegLoadKeyW on a missing path would CREATE an
// empty hive and load it, so only Load's own existence check can make this
// pass — and a privilege failure cannot masquerade as the refusal, because
// it would not satisfy errors.Is(err, fs.ErrNotExist).
func TestLoad_MissingFileFailsWithoutMount(t *testing.T) {
	enablePrivilegesForTest(t, "SeBackupPrivilege", "SeRestorePrivilege")
	const mount = "BRZ_winhive_test_missing"
	t.Cleanup(func() { _, _ = UnloadStale(mount) })
	hiveFile := filepath.Join(t.TempDir(), "no-such-hive")
	h, err := Load(hiveFile, mount)
	if err == nil {
		_ = h.Close()
		t.Fatal("Load of a missing hive file succeeded")
	}
	if h != nil {
		t.Fatalf("Load returned a non-nil handle with error %v", err)
	}
	if !errors.Is(err, fs.ErrNotExist) || !strings.Contains(err.Error(), "RegLoadKeyW") {
		t.Fatalf("error = %v, want a RegLoadKeyW error wrapping fs.ErrNotExist", err)
	}
	if hklmKeyExists(mount) {
		t.Fatalf("HKLM\\%s exists after a failed Load", mount)
	}
	if _, err := os.Stat(hiveFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Load created %s (stat err %v)", hiveFile, err)
	}
}

// A BCD store built from BCD-Template (what bcdboot writes on a real ESP)
// grants BUILTIN\Administrators only ReadKey + WRITE_DAC: Load (root opened
// KEY_ALL_ACCESS) is denied even with SeBackup/SeRestore held, and
// LoadReadOnly (KEY_READ throughout) reads it — lab-proven on Server 2022.
// Writes through a read-only handle fail; Close still flushes and unloads.
func TestLoadReadOnly_ReadsAnAdminReadOnlyBCDStore(t *testing.T) {
	enablePrivilegesForTest(t, "SeBackupPrivilege", "SeRestorePrivilege")
	tmpl, err := os.ReadFile(filepath.Join(os.Getenv("SystemRoot"), "System32", "config", "BCD-Template"))
	if err != nil {
		t.Skipf("host has no readable BCD-Template: %v", err)
	}
	hiveFile := filepath.Join(t.TempDir(), "BCD")
	if err := os.WriteFile(hiveFile, tmpl, 0o600); err != nil {
		t.Fatal(err)
	}
	const mount = "BRZ_winhive_test_bcd_ro"
	t.Cleanup(func() { _, _ = UnloadStale(mount) })

	if h, err := Load(hiveFile, mount); err == nil {
		_ = h.Close()
		t.Log("Load (read-write) of BCD-Template succeeded on this host; the read-only path is still exercised below")
	} else if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("Load = %v, want success or ERROR_ACCESS_DENIED", err)
	}
	if hklmKeyExists(mount) {
		t.Fatalf("HKLM\\%s left mounted after the read-write attempt", mount)
	}

	h, err := LoadReadOnly(hiveFile, mount)
	if err != nil {
		t.Fatalf("LoadReadOnly: %v", err)
	}
	names, err := h.Root().SubKeyNames()
	if err != nil || !containsFold(names, "Objects") {
		_ = h.Close()
		t.Fatalf("root subkeys = %v, %v; want Objects", names, err)
	}
	objects, err := h.Root().OpenKey("Objects")
	if err != nil {
		_ = h.Close()
		t.Fatalf("open Objects read-only: %v", err)
	}
	werr := objects.SetString("BRZ_write_probe", "x")
	_ = objects.Close()
	if _, cerr := h.Root().CreateKey("BRZ_create_probe"); cerr == nil {
		t.Error("CreateKey through a read-only hive succeeded")
	}
	if err := h.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if werr == nil {
		t.Error("SetString through a read-only hive succeeded")
	}
	if hklmKeyExists(mount) {
		t.Fatalf("HKLM\\%s still mounted after Close", mount)
	}
}

func containsFold(names []string, want string) bool {
	for _, n := range names {
		if strings.EqualFold(n, want) {
			return true
		}
	}
	return false
}
