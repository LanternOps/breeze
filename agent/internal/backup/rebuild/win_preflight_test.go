package rebuild

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

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
	res, _ := Run(context.Background(), opts) // at this task's commit the run stops at the staged winProvision
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

// R15: a domain-controller source (Services\NTDS in the staged SYSTEM
// artifact) is refused unless AllowDomainController.
func TestWinPreflight_RefusesDomainControllerUnlessAllowed(t *testing.T) {
	withHostPlatformWindows(t)
	dir := t.TempDir()
	opts, sys := winFakeOptions(t, dir)
	dcHive := winhiveDCFake()
	sys.hives["SYSTEM"] = dcHive
	res, err := Run(context.Background(), opts)
	want := "source is a domain controller (Services\\NTDS present); pass --allow-domain-controller"
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
// Select\Default=1 and ControlSet001\Services\NTDS present.
func winhiveDCFake() *winhive.Fake {
	h := winhive.NewFake()
	sel, _ := h.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_, _ = h.CreateKey(`ControlSet001\Services\NTDS`)
	return h
}
