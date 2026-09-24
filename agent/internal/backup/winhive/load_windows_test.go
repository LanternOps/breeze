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
