package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// R5: a disk: target off WinPE without ForceDisk is refused.
func TestWinPreflight_RefusesDiskTargetOutsideWinPE(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
	sys.inWinPE = false
	sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB}
	res, err := Run(context.Background(), opts)
	want := "disk targets are only supported from Breeze recovery media (WinPE); use a vhdx target on a running Windows host"
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if sys.has("WipeDisk") || sys.has("WriteGPT") {
		t.Fatalf("refusal must not write: %v", sys.cmds)
	}

	// Controller ruling B5: ForceDisk overrides ONLY the Windows-tree
	// refusal (R7), never the WinPE gate. The Global Constraint is "a live
	// Windows host may only write vhdx: targets" — ForceDisk cannot bypass
	// that.
	opts.ForceDisk = true
	res, err = Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) {
		t.Fatalf("ForceDisk must not bypass the WinPE gate: res=%+v err=%v", res, err)
	}
}

// R6: disk = system disk / media disk / read-only / offline.
func TestWinPreflight_RefusesUnsafeDiskTargets(t *testing.T) {
	for _, tt := range []struct {
		name string
		prep func(sys *fakeWinSystem)
		want string
	}{
		{"system disk", func(sys *fakeWinSystem) { sys.systemDiskNumber = 1 }, "target disk 1 holds the running system"},
		{"media disk", func(sys *fakeWinSystem) { sys.mediaDiskNumbers = []int{1} }, "target disk 1 holds the recovery media"},
		{"read-only", func(sys *fakeWinSystem) { sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB, ReadOnly: true} }, "target disk 1 is read-only or offline"},
		{"offline", func(sys *fakeWinSystem) { sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB, Offline: true} }, "target disk 1 is read-only or offline"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			withHostPlatformWindows(t)
			dir := t.TempDir()
			opts, sys := winFakeOptions(t, dir)
			opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
			sys.inWinPE = true
			sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB}
			tt.prep(sys)
			res, err := Run(context.Background(), opts)
			if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tt.want) {
				t.Fatalf("res=%+v err=%v, want refusal containing %q", res, err, tt.want)
			}
		})
	}
}

// R7: disk holds a Windows tree, no ForceDisk.
func TestWinPreflight_RefusesDiskWithWindowsTreeUnlessForced(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Target = Target{Kind: TargetDisk, Path: `\\.\PhysicalDrive1`}
	sys.inWinPE = true
	sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB}
	sys.volumes = append(sys.volumes, fakeVolume{guidPath: `\\?\Volume{existing}\`, diskNumber: 1, partitionNumber: 1})
	sys.hasWindowsTree[`\\?\Volume{existing}\`] = true

	res, err := Run(context.Background(), opts)
	want := "target disk 1 contains a Windows installation; pass --force-disk to overwrite it"
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) {
		t.Fatalf("res=%+v err=%v", res, err)
	}

	opts.ForceDisk = true
	res, err = Run(context.Background(), opts)
	if res != nil && res.Status == "refused" && strings.Contains(res.Refusal, "contains a Windows installation") {
		t.Fatalf("ForceDisk should bypass the Windows-tree refusal, got %+v (err=%v)", res, err)
	}
}

// R10: vhdx free space below the minimum is refused before any write.
func TestWinPreflight_RefusesVhdxBelowFreeSpace(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	opts.Target.ImageSizeBytes = 80 * GiB
	sys.freeSpace = 10 * GiB
	res, err := Run(context.Background(), opts)
	want := "not enough free space for the VHDX: need"
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if sys.has("CreateVHDX") {
		t.Fatalf("refusal must not create the VHDX: %v", sys.cmds)
	}
}

// R12: vhdx on Windows needs no qemu-img and records convert as skipped.
func TestWinPreflight_VhdxNeedsNoQemuImg(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	sys.lookPathErr["qemu-img"] = errNotFoundForTest
	res, _ := Run(context.Background(), opts) // SkipBoot run: completes; only the preflight row is under test
	if res == nil {
		t.Fatal("expected a Result")
	}
	if res.Status == "refused" && strings.Contains(res.Refusal, "qemu-img") {
		t.Fatalf("the Windows engine must not require qemu-img: %s", res.Refusal)
	}
	if len(res.Phases) == 0 || res.Phases[0].Phase != PhasePreflight || res.Phases[0].Status != PhaseCompleted {
		t.Fatalf("preflight must complete for a vhdx: target with no qemu-img: %+v", res.Phases)
	}
}

// R13: the shared ObjectAdmission refusal fires exactly as on Linux.
func TestWinPreflight_RefusesUnadmittedObjects(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, _ := winFakeOptions(t, dir)
	opts.Provider = &admissionDenyingProvider{memProvider: opts.Provider.(*memProvider)}
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, "outside the authorized download scope") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

// R14: ExpectSystemState with no manifest is refused.
func TestWinPreflight_RefusesExpectSystemStateWithoutManifest(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	p := &memProvider{files: map[string][]byte{}}
	lay := testLayoutWindows()
	lb, _ := jsonMarshalForTest(lay)
	p.files["snapshots/win-nostate/layout.json"] = lb
	man, _ := jsonMarshalForTest(struct{ ID string }{"win-nostate"})
	p.files["snapshots/win-nostate/manifest.json"] = man
	sys := newFakeWinSystem(dir)
	sys.diskInfo[1] = WinDiskInfo{SizeBytes: 80 * GiB}
	res, err := Run(context.Background(), Options{
		SnapshotID: "win-nostate", Provider: p, Identity: IdentityNew,
		Target:   Target{Kind: TargetVHDX, Path: dir + "/out.vhdx", ImageSizeBytes: 80 * GiB},
		StateDir: dir, StagingRoot: dir + "/mnt", WinSystem: sys, SkipBoot: true, ExpectSystemState: true,
	})
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, "system state expected but system-state/manifest.json is missing") {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

// R15: a domain-controller source (ProductType LanmanNt in the staged
// SYSTEM artifact) is refused unless AllowDomainController.
func TestWinPreflight_RefusesDomainControllerUnlessAllowed(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	dcHive := winhiveDCFake()
	sys.hives["SYSTEM"] = dcHive
	res, err := Run(context.Background(), opts)
	want := "source is a domain controller (ControlSet001\\Control\\ProductOptions\\ProductType is LanmanNt); pass --allow-domain-controller"
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) {
		t.Fatalf("res=%+v err=%v", res, err)
	}

	opts.AllowDomainController = true
	res, err = Run(context.Background(), opts)
	if res != nil && res.Status == "refused" && strings.Contains(res.Refusal, "domain controller") {
		t.Fatalf("AllowDomainController should bypass the refusal, got %+v (err=%v)", res, err)
	}
}

func TestParseDiskTargetPath(t *testing.T) {
	n, err := parseDiskTargetPath(`\\.\PhysicalDrive3`)
	if err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if _, err := parseDiskTargetPath(`/dev/sdb`); err == nil {
		t.Fatal("expected an error for a non-Windows disk path")
	}
}

var errNotFoundForTest = fmt.Errorf("not found")

func jsonMarshalForTest(v any) ([]byte, error) { return json.Marshal(v) }

// admissionDenyingProvider wraps a *memProvider and implements
// ObjectAdmission, refusing every key — mirrors preflight_test.go's Linux
// equivalent fixture pattern (this package has none reusable, since the
// Linux ObjectAdmission test lives inline in engine_system_state_test.go
// against a different fixture shape).
type admissionDenyingProvider struct{ *memProvider }

func (a *admissionDenyingProvider) Admits(string) bool { return false }

// winhiveDCFake returns a winhive.Fake pre-seeded with
// Select\Default=1 and ControlSet001 ProductType LanmanNt.
func winhiveDCFake() *winhive.Fake {
	return winhiveProductTypeFake("LanmanNt")
}

// winhiveProductTypeFake returns a SYSTEM hive with Select\Default=1,
// ControlSet001\Control\ProductOptions\ProductType = productType (unset
// when empty) and the empty ControlSet001\Services\NTDS\RID Values key a
// standalone Server 2022 carries without AD DS.
func winhiveProductTypeFake(productType string) *winhive.Fake {
	h := winhive.NewFake()
	sel, _ := h.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_, _ = h.CreateKey(`ControlSet001\Services\NTDS\RID Values`)
	if productType != "" {
		po, _ := h.CreateKey(`ControlSet001\Control\ProductOptions`)
		_ = po.SetString("ProductType", productType)
	}
	return h
}

// Bug C (native lab run): a standalone Server 2022 (ProductType ServerNT)
// with an empty Services\NTDS key is not a DC and must not be refused.
func TestWinPreflight_StandaloneServerWithEmptyNTDSIsNotRefused(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	system := sys.hives["SYSTEM"]
	po, _ := system.CreateKey(`ControlSet001\Control\ProductOptions`)
	_ = po.SetString("ProductType", "ServerNT")
	_, _ = system.CreateKey(`ControlSet001\Services\NTDS\RID Values`)
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("standalone server must rebuild, got res=%+v err=%v", res, err)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w, "domain-controller") {
			t.Fatalf("a conclusive ServerNT hive must not warn: %v", res.Warnings)
		}
	}
}

// An inconclusive hive (no ProductType, no AD DS database value) is not
// refused, but the operator is told the check was inconclusive.
func TestIsDomainController_InconclusiveHiveWarns(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "state")
	if err := os.MkdirAll(filepath.Join(staging, "registry"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "registry", "SYSTEM"), []byte("hive"), 0o644); err != nil {
		t.Fatal(err)
	}
	sys := newFakeWinSystem(dir)
	sys.hives["SYSTEM"] = winhiveProductTypeFake("")
	r := &run{opts: Options{WinSystem: sys, Target: Target{Kind: TargetVHDX, Path: "x.vhdx"}}, stateStaging: staging}
	dc, err := r.isDomainController()
	if err != nil || dc.IsDC {
		t.Fatalf("isDomainController = %+v, %v; want not a DC", dc, err)
	}
	if len(r.warnings) != 1 || !strings.Contains(r.warnings[0], "domain-controller check inconclusive") {
		t.Fatalf("warnings = %v, want the inconclusive warning", r.warnings)
	}
}

// Final-review Imp 3: a restore into the root volume flattens every drive
// into it (backup.RestoreKey strips the volume), so a snapshot holding
// entries from another volume is refused before anything is written.
func TestWinPreflight_RefusesEntriesFromOtherVolumes(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	p := opts.Provider.(*memProvider)
	var snap backup.Snapshot
	if err := json.Unmarshal(p.files["snapshots/win-1/manifest.json"], &snap); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"data/a.txt", "data/b.txt"} {
		b := []byte("d-drive " + rel)
		key := "snapshots/win-1/files/path_1/" + rel
		p.files[key] = b
		snap.Files = append(snap.Files, backup.SnapshotFile{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy2/` + rel, OriginalPath: "D:/" + rel, BackupPath: key, Size: int64(len(b)), Checksum: sum(b)})
	}
	// A lower-case c: entry is the root volume, not another one.
	snap.Files = append(snap.Files, backup.SnapshotFile{SourcePath: "c:/Temp/x", BackupPath: "snapshots/win-1/files/path_0/Temp/x"})
	man, _ := json.Marshal(snap)
	p.files["snapshots/win-1/manifest.json"] = man

	res, err := Run(context.Background(), opts)
	want := "snapshot contains 2 files from volume D:; multi-volume Windows rebuilds are not supported in this build"
	if err == nil || res == nil || res.Status != "refused" || res.Refusal != want {
		t.Fatalf("res=%+v err=%v, want refused with %q", res, err, want)
	}
	if sys.has("CreateVHDX") || sys.has("WriteGPT") {
		t.Fatalf("refusal must not write: %v", sys.cmds)
	}
}

// 18b row 9e: a snapshot with a staging dir but no system-state/registry/
// SYSTEM artifact (files-only, or the artifact was itself missing) means
// isDomainController genuinely cannot tell — it must not pass that silently as "not a
// DC"; it must warn so the operator knows the DC refusal did not run.
func TestIsDomainController_NoSystemStateArtifactWarns(t *testing.T) {
	staging := t.TempDir() // no registry/SYSTEM under here
	r := &run{opts: Options{WinSystem: newFakeWinSystem(t.TempDir())}, stateStaging: staging}
	dc, err := r.isDomainController()
	if err != nil || dc.IsDC {
		t.Fatalf("isDomainController = %+v, %v; want not a DC, nil (cannot tell, not a positive DC finding)", dc, err)
	}
	found := false
	for _, w := range r.warnings {
		if strings.Contains(w, "system-state") {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings = %v, want one about the missing system-state artifact", r.warnings)
	}
}

// Final-review Imp 5: isDomainController fails closed — no staging dir is an error,
// never "not a DC".
func TestIsDomainController_EmptyStagingIsAnError(t *testing.T) {
	r := &run{opts: Options{WinSystem: newFakeWinSystem(t.TempDir())}}
	if dc, err := r.isDomainController(); err == nil || dc.IsDC {
		t.Fatalf("isDomainController with no staging dir = %+v, %v; want an error", dc, err)
	}
}

// Final-review Imp 5: a hive that will not unload is an error, not a
// silently dropped Close.
func TestIsDomainController_CloseErrorIsReturned(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "state")
	if err := os.MkdirAll(filepath.Join(staging, "registry"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "registry", "SYSTEM"), []byte("hive"), 0o644); err != nil {
		t.Fatal(err)
	}
	sys := newFakeWinSystem(dir)
	sys.hives["SYSTEM"] = winhive.NewFake()
	sys.hiveCloseErr = errors.New("RegUnLoadKeyW: access denied")
	r := &run{opts: Options{WinSystem: sys, Target: Target{Kind: TargetVHDX, Path: "x.vhdx"}}, stateStaging: staging}
	if _, err := r.isDomainController(); err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("isDomainController err = %v, want the unload failure", err)
	}
}

// 18b row 8: isDomainController only inspects the staged SYSTEM hive — it never edits
// it — so it must load it read-only, like validate's BCD check, not
// read-write.
func TestIsDomainController_LoadsHiveReadOnly(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "state")
	if err := os.MkdirAll(filepath.Join(staging, "registry"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "registry", "SYSTEM"), []byte("hive"), 0o644); err != nil {
		t.Fatal(err)
	}
	sys := newFakeWinSystem(dir)
	h := winhive.NewFake()
	sel, _ := h.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_, _ = h.CreateKey("ControlSet001")
	sys.hives["SYSTEM"] = h
	target := Target{Kind: TargetVHDX, Path: "x.vhdx"}
	r := &run{opts: Options{WinSystem: sys, Target: target}, stateStaging: staging}
	if _, err := r.isDomainController(); err != nil {
		t.Fatal(err)
	}
	want := "LoadHiveReadOnly " + filepath.Join(staging, "registry", "SYSTEM") + " BRZ_" + targetKey(target) + "_PRE"
	if got := countCalls(sys.cmds, "LoadHiveReadOnly"); len(got) != 1 || got[0] != want {
		t.Fatalf("cmds = %v, want exactly %q", sys.cmds, want)
	}
	if got := countCalls(sys.cmds, "LoadHive "); len(got) != 0 {
		t.Fatalf("cmds = %v, isDomainController must never load read-write", sys.cmds)
	}
}

// #7325: a junction from another volume would be flattened into the root
// volume exactly like a file, so it is refused the same way.
func TestWinPreflight_RefusesJunctionsFromOtherVolumes(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	p := opts.Provider.(*memProvider)
	var snap backup.Snapshot
	if err := json.Unmarshal(p.files["snapshots/win-1/manifest.json"], &snap); err != nil {
		t.Fatal(err)
	}
	snap.Junctions = append(snap.Junctions,
		backup.SnapshotJunction{SourcePath: `D:\Shares\Link`, Target: `D:\Shares\Real`},
		// A root-volume junction is fine.
		backup.SnapshotJunction{SourcePath: `c:\Users\a\My Music`, Target: `C:\Users\a\Music`},
	)
	man, _ := json.Marshal(snap)
	p.files["snapshots/win-1/manifest.json"] = man

	res, err := Run(context.Background(), opts)
	want := "snapshot contains 0 files and 1 junctions from volume D:; multi-volume Windows rebuilds are not supported in this build"
	if err == nil || res == nil || res.Status != "refused" || res.Refusal != want {
		t.Fatalf("res=%+v err=%v, want refused with %q", res, err, want)
	}
	if sys.has("CreateVHDX") || sys.has("WriteGPT") {
		t.Fatalf("refusal must not write: %v", sys.cmds)
	}
}
