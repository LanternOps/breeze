package rebuild

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// withHostPlatform overrides hostPlatform for one test.
func withHostPlatform(t *testing.T, v string) {
	t.Helper()
	prev := hostPlatform
	hostPlatform = func() string { return v }
	t.Cleanup(func() { hostPlatform = prev })
}

// withHostPlatformWindows makes the engine behave as on a Windows host on
// ANY host: hostPlatform answers "windows", and package backup strips a
// drive-letter volume (C:) the way filepath.VolumeName does on Windows, so a
// fixture file whose OriginalPath is "C:/Windows/..." restores under
// <root>/Windows/... on Linux and macOS exactly as it does on Windows.
func withHostPlatformWindows(t *testing.T) {
	t.Helper()
	withHostPlatform(t, "windows")
	restore := backup.SetVolumeNameForTest(func(p string) string {
		if len(p) >= 2 && p[1] == ':' {
			return p[:2]
		}
		return ""
	})
	t.Cleanup(restore)
}

// testWindowsRootPartUUID is the recorded partition GUID for the C: volume
// in testLayoutWindows — asserted against by provision/validate tests in
// later tasks.
const testWindowsRootPartUUID = "6a1e0000-0000-4000-8000-000000000003"

// testLayoutWindows is the Windows twin of testLayout: Windows 11's default
// GPT order (ESP, MSR, C:, Recovery) — Review Focus 3 ("C: is not the last
// partition"). Sizes and attributes per this plan's Task 8 spec.
func testLayoutWindows() *layout.Manifest {
	return &layout.Manifest{
		SchemaVersion: layout.SchemaVersion, Platform: "windows", BootMode: layout.BootModeUEFI,
		OSRelease: "Windows Server 2022", Hostname: "FILESERVER01",
		Disks: []layout.Disk{{
			Name: `\\.\PHYSICALDRIVE0`, SizeBytes: 80 * GiB, SectorSize: 512, TableType: "gpt", IsSystem: true,
			GUID: "aaaaaaaa-0000-4000-8000-000000000000",
			Partitions: []layout.Partition{
				{Number: 1, Name: "ESP", TypeGUID: layout.GUIDEFISystem, PartUUID: "6a1e0000-0000-4000-8000-000000000001",
					StartBytes: MiB, SizeBytes: 100 * MiB, Filesystem: "fat32", FSUUID: "ABCD-1234", MountPoint: `\EFI`, Role: layout.RoleEFI, Encryption: layout.EncryptionNone, Attributes: 0x1},
				{Number: 2, Name: "MSR", TypeGUID: layout.GUIDMicrosoftMSR, PartUUID: "6a1e0000-0000-4000-8000-000000000002",
					StartBytes: 101 * MiB, SizeBytes: 16 * MiB, Role: layout.RoleMSR, Encryption: layout.EncryptionNone, Attributes: 0x1},
				{Number: 3, Name: "root", TypeGUID: layout.GUIDMicrosoftBasic, PartUUID: testWindowsRootPartUUID,
					StartBytes: 117 * MiB, SizeBytes: 60*GiB - 117*MiB, UsedBytes: 20 * GiB, Filesystem: "ntfs", FSUUID: "", Label: "Windows",
					MountPoint: `C:\`, Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
				{Number: 4, Name: "Recovery", TypeGUID: layout.GUIDWindowsRecovery, PartUUID: "6a1e0000-0000-4000-8000-000000000004",
					StartBytes: 60*GiB + 117*MiB, SizeBytes: 600 * MiB, Filesystem: "ntfs", Label: "Recovery",
					Role: layout.RoleRecovery, Encryption: layout.EncryptionNone, Attributes: 0x8000000000000001},
			},
		}},
	}
}

// seedWindowsSnapshot mirrors seedSnapshot (engine_test.go) for a
// Windows-shaped snapshot: SourcePath is a VSS shadow-copy device path and
// OriginalPath the stable C: location (Review Focus 2's no-VSS shape is
// exercised by tests that clear OriginalPath). Paths use `/` after the drive
// letter — a valid Windows path — so the same fixture restores into real
// directories on every test host (see withHostPlatformWindows). All four
// required hives are in the tree, so the W06c state apply never falls back.
func seedWindowsSnapshot(t *testing.T, id string, lay *layout.Manifest) *memProvider {
	t.Helper()
	p := &memProvider{files: map[string][]byte{}}
	const shadow = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1/`
	content := map[string][]byte{
		"Windows/System32/config/SYSTEM":   []byte("system-hive-bytes"),
		"Windows/System32/config/SOFTWARE": []byte("software-hive-bytes"),
		"Windows/System32/config/SAM":      []byte("sam-hive-bytes"),
		"Windows/System32/config/SECURITY": []byte("security-hive-bytes"),
		"Users/Administrator/NTUSER.DAT":   []byte("ntuser-bytes"),
		"ProgramData/Breeze/agent.yaml":    []byte("server_url: https://example.invalid\nagent_id: a1\ndevice_id: d1\n"),
	}
	var files []backup.SnapshotFile
	for rel, b := range content {
		orig := "C:/" + rel
		src := shadow + rel
		key := "snapshots/" + id + "/files/path_0/" + rel
		p.files[key] = b
		files = append(files, backup.SnapshotFile{SourcePath: src, OriginalPath: orig, BackupPath: key, Size: int64(len(b)), Checksum: sum(b), ModTime: time.Now().UTC()})
	}
	man, _ := json.Marshal(backup.Snapshot{ID: id, Timestamp: time.Now().UTC(), Files: files})
	p.files["snapshots/"+id+"/manifest.json"] = man
	lb, _ := json.Marshal(lay)
	p.files["snapshots/"+id+"/layout.json"] = lb
	sysHive := []byte("system-hive-artifact-bytes")
	p.files["snapshots/"+id+"/system-state/registry/SYSTEM"] = sysHive
	sm, _ := json.Marshal(systemstate.SystemStateManifest{Platform: "windows", SchemaVersion: 1, Artifacts: []systemstate.Artifact{
		{Name: "registry_SYSTEM", Category: "registry", Path: "registry/SYSTEM", SizeBytes: int64(len(sysHive)), Checksum: sum(sysHive)},
	}})
	p.files["snapshots/"+id+"/system-state/manifest.json"] = sm
	return p
}

// seedFakeHives pre-seeds the fake's SYSTEM and SOFTWARE hives with the
// minimum a real hive always has (Select\Default/Current, ControlSet001,
// MountedDevices, the computer name, Microsoft\Cryptography), so the W06c
// state apply and identity phases run against them without special cases.
func seedFakeHives(sys *fakeWinSystem) {
	system := winhive.NewFake()
	sel, _ := system.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_ = sel.SetDWORD("Current", 1)
	_, _ = system.CreateKey(`ControlSet001\Services`)
	cn, _ := system.CreateKey(`ControlSet001\Control\ComputerName\ComputerName`)
	_ = cn.SetString("ComputerName", "FILESERVER01")
	_, _ = system.CreateKey("MountedDevices")
	software := winhive.NewFake()
	_, _ = software.CreateKey(`Microsoft\Cryptography`)
	sys.hives["SYSTEM"] = system
	sys.hives["SOFTWARE"] = software
}

// winFakeOptions builds Options for a vhdx: target against a fresh
// fakeWinSystem with seeded hives. The run uses SkipBoot (no bcdboot).
func winFakeOptions(t *testing.T, dir string) (Options, *fakeWinSystem) {
	t.Helper()
	sys := newFakeWinSystem(dir)
	seedFakeHives(sys)
	p := seedWindowsSnapshot(t, "win-1", testLayoutWindows())
	opts := Options{
		SnapshotID: "win-1", Provider: p, Identity: IdentityNew,
		Target:   Target{Kind: TargetVHDX, Path: filepath.Join(dir, "out", "out.vhdx"), ImageSizeBytes: 80 * GiB},
		StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), WinSystem: sys, SkipBoot: true,
	}
	return opts, sys
}
