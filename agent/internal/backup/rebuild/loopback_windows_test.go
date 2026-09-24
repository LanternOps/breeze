//go:build windows

package rebuild

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// TestRun_WindowsVhdxRealSystem is the Windows twin of
// loopback_linux_test.go's TestRun_LoopbackVhdxTarget: a real 2 GiB dynamic
// VHDX, created and attached through the real WinSystem (winsystem_windows.go),
// provisioned, restored into, and validated — proving CreateVirtualDisk/
// AttachVirtualDisk/WriteGPT/Format/MountVolume/ReadGPT/FlushVolume/
// DetachVirtualDisk all actually work together on a real Windows host, not
// just against fakeWinSystem, and that the restore's securefs install into a
// \\?\Volume{GUID}\ base works (Ruling B1). SkipBoot is false: the host's
// own bcdboot (/p) writes the VHDX's ESP from the restored Windows\Boot,
// validate loads the ESP's BCD as a hive, and identity:new renames the
// machine in the restored SYSTEM hive. Gated on
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
	// Real hives: the state apply loads SYSTEM/SOFTWARE with RegLoadKeyW
	// and the preflight DC check loads the system-state SYSTEM artifact.
	for _, hive := range []string{"SYSTEM", "SOFTWARE"} {
		data := regSaveForTest(t, hive)
		replaceSnapshotFileForTest(t, p, "win-vhdx-real", "Windows/System32/config/"+hive, data)
		if hive == "SYSTEM" {
			p.files["snapshots/win-vhdx-real/system-state/registry/SYSTEM"] = data
			reseedStateManifestForTest(t, p, "win-vhdx-real", data)
		}
	}
	// bcdboot copies <source>\Windows\Boot\EFI\* (and Fonts, Resources),
	// loads the BCD element strings from <source>\Windows\System32\
	// bootstr.dll (+ its <lang>\bootstr.dll.mui) — without them it fails
	// with "BCD strings MUI load failure" — and uses System32\config\
	// BCD-Template when present. A synthetic tree has none of these, so take
	// them from the runner's own install (a real backup of a Windows machine
	// carries them). bcdboot and DISM are always the HOST's binaries (ruling
	// C4): the tree's bootstr.dll is loaded by bcdboot only as a resource
	// module, and nothing from the tree is executed.
	bootFiles := seedDirForTest(t, p, "win-vhdx-real", `C:\Windows\Boot`, "Windows/Boot")
	if bootFiles == 0 {
		t.Fatal(`no files seeded from C:\Windows\Boot`)
	}
	muis, _ := filepath.Glob(`C:\Windows\System32\*\bootstr.dll.mui`)
	for _, host := range append([]string{`C:\Windows\System32\bootstr.dll`, `C:\Windows\System32\config\BCD-Template`}, muis...) {
		b, err := os.ReadFile(host)
		if err != nil {
			if strings.HasSuffix(host, "BCD-Template") {
				continue // optional: bcdboot builds a store without it
			}
			t.Fatalf("boot material %s: %v", host, err)
		}
		rel := "Windows/" + filepath.ToSlash(strings.TrimPrefix(host, `C:\Windows\`))
		addWindowsSnapshotFile(t, p, "win-vhdx-real", rel, b)
		bootFiles++
	}
	out := filepath.Join(dir, "disk.vhdx")

	rec := &runRecorder{WinSystem: NewWinSystem()}
	res, err := Run(context.Background(), Options{
		WinSystem:  rec,
		SnapshotID: "win-vhdx-real", Provider: p, Identity: IdentityNew,
		Target:   Target{Kind: TargetVHDX, Path: out, ImageSizeBytes: 2 * GiB},
		StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), SkipBoot: false,
		// The hives are the HOST's own (reg save), and a lab host may be a
		// domain controller: this test proves the real-seam plumbing, not
		// DC policy. The DC refusal itself is proven on the fake
		// (TestWinPreflight_RefusesDomainControllerUnlessAllowed,
		// TestWinRestoreTree_DomainControllerInTreeFails, bmr's
		// TestRestoreSystemStateOfflineWindows_Refuses*).
		AllowDomainController: true,
	})
	if err != nil {
		t.Fatalf("run: %v\n%s", err, mustJSON(res))
	}
	if res.Status != "completed" {
		t.Fatalf("res = %s", mustJSON(res))
	}
	if !res.StateApplied {
		t.Fatalf("StateApplied = false: the offline state apply did not run against the real hives\n%s", mustJSON(res))
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
	for _, ph := range res.Phases {
		if ph.Phase == PhaseBoot && ph.Status != PhaseCompleted {
			t.Fatalf("boot phase = %+v, want completed (bcdboot ran)", ph)
		}
	}
	for _, argv := range rec.argv {
		t.Logf("external tool: %s", argv)
	}
	t.Logf("warnings: %q", res.Warnings)
	bcdboot := hostSystemTool("bcdboot.exe")
	var bcdbootRuns []string
	for _, argv := range rec.argv {
		if strings.HasPrefix(strings.ToLower(argv), strings.ToLower(bcdboot)+" ") {
			bcdbootRuns = append(bcdbootRuns, argv)
		}
	}
	if len(bcdbootRuns) != 1 || !strings.HasSuffix(bcdbootRuns[0], " /f UEFI /v /p") {
		t.Fatalf("bcdboot runs = %q, want one host %s ... /f UEFI /v /p", bcdbootRuns, bcdboot)
	}
	if res.FilesRestored != 6+bootFiles {
		t.Fatalf("FilesRestored = %d, want %d (6 fixture files + %d boot files)", res.FilesRestored, 6+bootFiles, bootFiles)
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

	// ESP (partition 1), read through its volume path: bcdboot's output,
	// the fallback loader, and a BCD whose default boot-manager entry
	// exists. Hive loads go through the real seam (LoadHiveReadOnly for
	// the admin-read-only BCD store), which holds SeBackup/SeRestore
	// (ruling B2/C2).
	var espVol string
	for _, v := range vols {
		if v.PartitionNumber == 1 {
			espVol = v.GUIDPath
		}
	}
	if espVol == "" {
		t.Fatalf("no ESP volume after re-attach: %+v", vols)
	}
	for _, rel := range []string{`EFI\Microsoft\Boot\bootmgfw.efi`, `EFI\Boot\bootx64.efi`, `EFI\Microsoft\Boot\BCD`} {
		if _, err := os.Stat(filepath.Join(espVol, rel)); err != nil {
			t.Fatalf("ESP %s: %v", rel, err)
		}
	}
	bcd, err := sys.LoadHiveReadOnly(filepath.Join(espVol, "EFI", "Microsoft", "Boot", "BCD"), "BRZ_verify_BCD")
	if err != nil {
		t.Fatalf("load rebuilt BCD: %v", err)
	}
	ok, err := winhive.DefaultBCDEntryExists(bcd.Root())
	if cerr := bcd.Close(); cerr != nil {
		t.Fatalf("unload rebuilt BCD: %v", cerr)
	}
	if err != nil || !ok {
		t.Fatalf("rebuilt BCD default entry: ok=%v err=%v", ok, err)
	}

	// Root: identity:new renamed the machine in the offline SYSTEM hive
	// and stripped the enrollment from agent.yaml.
	system, err := sys.LoadHive(filepath.Join(rootVol, "Windows", "System32", "config", "SYSTEM"), "BRZ_verify_SYSTEM")
	if err != nil {
		t.Fatalf("load rebuilt SYSTEM: %v", err)
	}
	name, err := func() (string, error) {
		defer func() {
			if cerr := system.Close(); cerr != nil {
				t.Errorf("unload rebuilt SYSTEM: %v", cerr)
			}
		}()
		sets, err := winhive.ControlSets(system.Root())
		if err != nil || len(sets) == 0 {
			return "", fmt.Errorf("control sets %v: %w", sets, err)
		}
		cn, err := system.Root().OpenKey(sets[0] + `\Control\ComputerName\ComputerName`)
		if err != nil {
			return "", err
		}
		defer func() { _ = cn.Close() }()
		return cn.GetString("ComputerName")
	}()
	if err != nil || !strings.HasSuffix(name, "-RESTORED") || len(name) > 15 {
		t.Fatalf("rebuilt ComputerName = %q, %v; want <=15 chars ending -RESTORED", name, err)
	}
	yml, err := os.ReadFile(filepath.Join(rootVol, "ProgramData", "Breeze", "agent.yaml"))
	if err != nil || strings.Contains(string(yml), "agent_id") || strings.Contains(string(yml), "device_id") {
		t.Fatalf("rebuilt agent.yaml = %q, %v; want enrollment stripped", yml, err)
	}
}

// runRecorder records every external tool the engine runs through the
// real seam (argv joined by spaces).
type runRecorder struct {
	WinSystem
	argv []string
}

func (r *runRecorder) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	r.argv = append(r.argv, strings.Join(append([]string{name}, args...), " "))
	return r.WinSystem.Run(ctx, name, args...)
}

// seedDirForTest adds every readable regular file under hostDir to the
// snapshot at relRoot (forward-slash) and returns how many it added.
func seedDirForTest(t *testing.T, p *memProvider, id, hostDir, relRoot string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(hostDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return err
		}
		rel, err := filepath.Rel(hostDir, path)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil // a locked file under Windows\Boot is not boot material bcdboot needs
		}
		addWindowsSnapshotFile(t, p, id, relRoot+"/"+filepath.ToSlash(rel), b)
		n++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func mustJSON(v any) string { b, _ := json.MarshalIndent(v, "", "  "); return string(b) }

// regSaveForTest captures a live HKLM hive (the Windows CI runner is
// elevated) as real hive bytes.
func regSaveForTest(t *testing.T, hive string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), hive)
	if out, err := exec.Command("reg", "save", `HKLM\`+hive, path, "/y").CombinedOutput(); err != nil {
		t.Fatalf("reg save HKLM\\%s: %v: %s", hive, err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// replaceSnapshotFileForTest swaps one file's content in a seeded snapshot
// and fixes its manifest entry's size and checksum.
func replaceSnapshotFileForTest(t *testing.T, p *memProvider, id, rel string, data []byte) {
	t.Helper()
	p.files["snapshots/"+id+"/files/path_0/"+rel] = data
	var man backup.Snapshot
	if err := json.Unmarshal(p.files["snapshots/"+id+"/manifest.json"], &man); err != nil {
		t.Fatal(err)
	}
	for i := range man.Files {
		if man.Files[i].OriginalPath == "C:/"+rel {
			man.Files[i].Size, man.Files[i].Checksum = int64(len(data)), sum(data)
		}
	}
	b, _ := json.Marshal(man)
	p.files["snapshots/"+id+"/manifest.json"] = b
}

func reseedStateManifestForTest(t *testing.T, p *memProvider, id string, system []byte) {
	t.Helper()
	sm, _ := json.Marshal(systemstate.SystemStateManifest{Platform: "windows", SchemaVersion: 1, Artifacts: []systemstate.Artifact{
		{Name: "registry_SYSTEM", Category: "registry", Path: "registry/SYSTEM", SizeBytes: int64(len(system)), Checksum: sum(system)},
	}})
	p.files["snapshots/"+id+"/system-state/manifest.json"] = sm
}
