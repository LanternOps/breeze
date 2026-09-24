//go:build windows

package winhive

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// TestControlSetsAndMountedDevices_RealHive proves Load, ControlSets,
// RewriteMountedDevices and Close (flush + unload) against a real SYSTEM
// hive copy. Needs an elevated token (reg save + RegLoadKeyW) holding
// SeBackup/SeRestore: winhive does no privilege work (ruling B2), so the
// test enables them itself, playing the part WinSystem.LoadHive plays in
// production. The Windows CI job is elevated and runs this in a
// must-not-skip step.
func TestControlSetsAndMountedDevices_RealHive(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("SKIPPING LOUDLY: needs an elevated token (reg save + RegLoadKeyW)")
	}
	enablePrivilegesForTest(t, "SeBackupPrivilege", "SeRestorePrivilege")
	hivePath := filepath.Join(t.TempDir(), "SYSTEM")
	if out, err := exec.Command("reg", "save", `HKLM\SYSTEM`, hivePath, "/y").CombinedOutput(); err != nil {
		t.Fatalf("reg save HKLM\\SYSTEM: %v: %s", err, out)
	}
	const root = "12345678-1234-5678-9abc-def012345678"
	mount := fmt.Sprintf("BRZ_test%d_SYSTEM", os.Getpid())
	h, err := Load(hivePath, mount)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	names, err := ControlSets(h.Root())
	if err != nil || len(names) == 0 {
		_ = h.Close()
		t.Fatalf("ControlSets = %v, %v", names, err)
	}
	if _, _, err := RewriteMountedDevices(h.Root(), root, []string{root}); err != nil {
		_ = h.Close()
		t.Fatalf("RewriteMountedDevices: %v", err)
	}
	if err := h.Close(); err != nil { // fails if any key handle leaked
		t.Fatalf("Close: %v", err)
	}
	h2, err := Load(hivePath, mount)
	if err != nil {
		t.Fatalf("re-Load: %v", err)
	}
	defer func() { _ = h2.Close() }()
	md, err := h2.Root().OpenKey(`MountedDevices`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = md.Close() }()
	want, _ := guidBytes(root)
	if got, err := md.GetBinary(`\DosDevices\C:`); err != nil || string(got) != "DMIO:ID:"+string(want[:]) {
		t.Fatalf("C: after reload = % x, %v (the flush-before-unload did not persist the edit)", got, err)
	}
}
