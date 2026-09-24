//go:build windows

package rebuild

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestRun_WindowsVhdxRealSystem is the Windows twin of
// loopback_linux_test.go's TestRun_LoopbackVhdxTarget: a real 2 GiB dynamic
// VHDX, created and attached through the real WinSystem (winsystem_windows.go),
// provisioned, restored into, and validated — proving CreateVirtualDisk/
// AttachVirtualDisk/WriteGPT/Format/MountVolume/ReadGPT/FlushVolume/
// DetachVirtualDisk all actually work together on a real Windows host, not
// just against fakeWinSystem, and that the restore's securefs install into a
// \\?\Volume{GUID}\ base works (Ruling B1). Gated on
// BREEZE_REBUILD_VHDX_TEST=1 — the CI step "Run Windows real-VHDX rebuild
// engine test (must not skip)" is the only place this runs for real; it
// must never silently skip there (a `go test` without that env var t.Skips —
// see that step's own must-not-skip assertion for why that is caught).
func TestRun_WindowsVhdxRealSystem(t *testing.T) {
	if os.Getenv("BREEZE_REBUILD_VHDX_TEST") != "1" {
		t.Skip("needs BREEZE_REBUILD_VHDX_TEST=1 (elevated Windows host with virtdisk.dll)")
	}
	requireElevatedForTest(t)
	withHostPlatform(t, "windows") // TestMain pins "linux" for the Linux-engine tests
	dir := t.TempDir()
	lay := testLayoutWindows()
	d := &lay.Disks[0]
	d.SizeBytes = 2 * GiB
	d.Partitions[0].SizeBytes = 100 * MiB // ESP
	d.Partitions[1].SizeBytes = 16 * MiB  // MSR
	d.Partitions[2].SizeBytes = 2*GiB - 100*MiB - 16*MiB - 300*MiB - 2*MiB
	d.Partitions[2].UsedBytes = 256 * MiB
	d.Partitions[3].SizeBytes = 300 * MiB // Recovery
	p := seedWindowsSnapshot(t, "win-vhdx-real", lay)
	out := filepath.Join(dir, "disk.vhdx")

	res, err := Run(context.Background(), Options{
		SnapshotID: "win-vhdx-real", Provider: p, Identity: IdentityNew,
		Target:   Target{Kind: TargetVHDX, Path: out, ImageSizeBytes: 2 * GiB},
		StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), SkipBoot: true,
		// The fixture's system-state registry/SYSTEM artifact is stub bytes,
		// not a hive, so the preflight DC check cannot load it; W06c
		// (Part C Task 14) seeds real hives and drops this.
		AllowDomainController: true,
	})
	if err != nil {
		t.Fatalf("run: %v\n%s", err, mustJSON(res))
	}
	if res.Status != "completed" {
		t.Fatalf("res = %s", mustJSON(res))
	}
	if res.Platform != "windows" {
		t.Fatalf("res.Platform = %q, want windows", res.Platform)
	}
	if len(res.Phases) != 8 {
		t.Fatalf("phases = %+v, want 8", res.Phases)
	}
	if res.Phases[7].Phase != PhaseConvert || res.Phases[7].Status != PhaseSkipped {
		t.Fatalf("convert phase = %+v, want skipped", res.Phases[7])
	}
	if res.FilesRestored != 6 {
		t.Fatalf("FilesRestored = %d, want 6", res.FilesRestored)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("vhdx missing: %v", err)
	}

	sys := NewWinSystem()
	diskNumber, detach, err := sys.AttachVHDX(out)
	if err != nil {
		t.Fatalf("re-attach for verification: %v", err)
	}
	defer func() { _ = detach() }()
	guid, parts, err := sys.ReadGPT(diskNumber)
	if err != nil {
		t.Fatalf("ReadGPT: %v", err)
	}
	if guid != lay.Disks[0].GUID || len(parts) != 4 {
		t.Fatalf("guid=%q (want %q) parts=%+v", guid, lay.Disks[0].GUID, parts)
	}
	for i, want := range lay.Disks[0].Partitions {
		if parts[i].PartGUID != want.PartUUID {
			t.Fatalf("partition %d GUID = %s, want %s (source layout GUID not preserved)", i+1, parts[i].PartGUID, want.PartUUID)
		}
	}
	// validate's last layout write: root lost the no-drive-letter bit,
	// Recovery kept it.
	if parts[2].Attributes&gptAttrNoDriveLetter != 0 {
		t.Fatalf("root attributes = %#x, want the no-drive-letter bit cleared", parts[2].Attributes)
	}
	if parts[3].Attributes != 0x8000000000000001 {
		t.Fatalf("recovery attributes = %#x, want 0x8000000000000001", parts[3].Attributes)
	}
	// The restored bytes are on the VHDX's root volume, read back through a
	// fresh attach (the run's own attach is gone).
	vols, err := sys.WaitForVolumes(context.Background(), diskNumber, 3)
	if err != nil {
		t.Fatalf("WaitForVolumes after re-attach: %v", err)
	}
	// No automount surprises: the run assigned letters only transiently
	// (format.com, the ESP), so none survives it on the rebuilt disk. The
	// fresh attach above did not assign any either — the no-letter bit on
	// ESP/MSR/Recovery and the host's automount policy for a VHDX decide
	// what re-attach does, so this is read before any test-side mount.
	for _, v := range vols {
		if v.DriveLetter != "" {
			t.Fatalf("partition %d has drive letter %s after the run: %+v", v.PartitionNumber, v.DriveLetter, vols)
		}
	}
	var rootVol string
	for _, v := range vols {
		if v.PartitionNumber == 3 {
			rootVol = v.GUIDPath
		}
	}
	if rootVol == "" {
		t.Fatalf("no root volume after re-attach: %+v", vols)
	}
	got, err := os.ReadFile(filepath.Join(rootVol, "Users", "Administrator", "NTUSER.DAT"))
	if err != nil || string(got) != "ntuser-bytes" {
		t.Fatalf("restored NTUSER.DAT on the rebuilt volume = %q, %v", got, err)
	}
}

func mustJSON(v any) string { b, _ := json.MarshalIndent(v, "", "  "); return string(b) }
