//go:build windows

package winhive

import (
	"path/filepath"
	"strings"
	"testing"

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

// Load of a hive file that does not exist fails and leaves no HKLM mount
// behind (the error path must not strand a half-loaded key).
func TestLoad_MissingFileFailsWithoutMount(t *testing.T) {
	const mount = "BRZ_winhive_test_missing"
	h, err := Load(filepath.Join(t.TempDir(), "no-such-hive"), mount)
	if err == nil {
		_ = h.Close()
		t.Fatal("Load of a missing hive file succeeded")
	}
	if h != nil {
		t.Fatalf("Load returned a non-nil handle with error %v", err)
	}
	if !strings.Contains(err.Error(), "RegLoadKeyW") {
		t.Fatalf("error = %v, want the RegLoadKeyW failure", err)
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, mount, registry.QUERY_VALUE); err == nil {
		_ = k.Close()
		t.Fatalf("HKLM\\%s exists after a failed Load", mount)
	}
}
