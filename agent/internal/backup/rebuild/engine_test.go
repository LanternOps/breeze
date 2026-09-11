package rebuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// bmrCall records one invocation through bmr's own exec seam
// (bmr.SetRunCommandForTest). RestoreSystemStateOffline (called from
// restoreTree during a real Run()) shells out through THAT seam, not
// through this package's fakeSystem — a fakeSystem swapped into
// Options.System cannot see it. TestMain below installs a package-wide
// override for the whole test binary so nothing in this file ever risks
// invoking a real systemctl.
type bmrCall struct {
	name string
	args []string
}

var (
	bmrCallsMu sync.Mutex
	bmrCalls   []bmrCall
)

func TestMain(m *testing.M) {
	bmr.SetRunCommandForTest(func(_ context.Context, name string, args ...string) ([]byte, error) {
		bmrCallsMu.Lock()
		bmrCalls = append(bmrCalls, bmrCall{name: name, args: args})
		bmrCallsMu.Unlock()
		return []byte("ok"), nil
	})
	os.Exit(m.Run())
}

func resetBmrCalls() {
	bmrCallsMu.Lock()
	bmrCalls = nil
	bmrCallsMu.Unlock()
}

func bmrCallsSnapshot() []bmrCall {
	bmrCallsMu.Lock()
	defer bmrCallsMu.Unlock()
	out := make([]bmrCall, len(bmrCalls))
	copy(out, bmrCalls)
	return out
}

// skipUnlessLinuxSystemState skips a full round-trip Run() test off Linux:
// bmr.RestoreSystemStateOffline (restore_offline_other.go) is Linux-only by
// design — same precedent as applySystemState's real restore work — so a
// Run() that reaches the restore phase always fails off Linux regardless of
// this package's own fakeSystem being cross-platform. Verified for real
// against golang:1.26 on Linux; see the wave's PR description.
func skipUnlessLinuxSystemState(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("full Run() round-trip needs bmr.RestoreSystemStateOffline, which is Linux-only")
	}
}

func hasBmrCall(calls []bmrCall, full string) bool {
	for _, c := range calls {
		joined := strings.TrimSpace(c.name + " " + strings.Join(c.args, " "))
		if joined == full {
			return true
		}
	}
	return false
}

type memProvider struct {
	files map[string][]byte
	// failKey, when set for a given remote key, makes Download return that
	// error verbatim instead of consulting files — for simulating a
	// transport failure (as opposed to a confirmed-absent object) on a
	// specific object.
	failKey map[string]error
}

func (m *memProvider) Upload(local, remote string) error {
	b, err := os.ReadFile(local)
	if err != nil {
		return err
	}
	m.files[remote] = b
	return nil
}
func (m *memProvider) Download(remote, local string) error {
	if m.failKey != nil {
		if err, ok := m.failKey[remote]; ok {
			return err
		}
	}
	b, ok := m.files[remote]
	if !ok {
		// Mirrors providers.LocalProvider/S3Provider: wrap with
		// ErrObjectNotFound only when positively confirming absence — see
		// providers.ErrObjectNotFound's doc comment.
		return fmt.Errorf("%w: %s", providers.ErrObjectNotFound, remote)
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return err
	}
	return os.WriteFile(local, b, 0o600)
}
func (m *memProvider) List(prefix string) ([]string, error) {
	var out []string
	for k := range m.files {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	return out, nil
}
func (m *memProvider) Delete(remote string) error { delete(m.files, remote); return nil }

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// seedSnapshot builds a whole-machine-shaped snapshot: files, a symlink, the
// restored EFI tree, fstab with the recorded UUIDs, a Debian-style
// update-grub, plus layout.json and a system-state manifest.
func seedSnapshot(t *testing.T, id string, lay *layout.Manifest) *memProvider {
	t.Helper()
	p := &memProvider{files: map[string][]byte{}}
	content := map[string][]byte{
		"/etc/hostname":                    []byte("srv-1\n"),
		"/etc/fstab":                       []byte("UUID=" + testRootFSUUID + " / ext4 defaults 0 1\nUUID=ABCD-1234 /boot/efi vfat umask=0077 0 1\n"),
		"/etc/machine-id":                  []byte("0123456789abcdef0123456789abcdef\n"),
		"/etc/breeze/agent.yaml":           []byte("server_url: https://example.invalid\nagent_id: a1\ndevice_id: d1\nauth_token: t\n"),
		"/etc/breeze/secrets.yaml":         []byte("auth_token: t\n"),
		"/usr/sbin/update-grub":            []byte("#!/bin/sh\n"),
		"/usr/bin/tool":                    []byte("#!/bin/sh\n"),
		"/boot/efi/EFI/ubuntu/shimx64.efi": []byte("shim"),
		"/boot/efi/EFI/ubuntu/grubx64.efi": []byte("grub"),
		"/boot/efi/EFI/BOOT/BOOTX64.EFI":   []byte("shim"),
		"/boot/grub/grub.cfg":              []byte("set default=0\n"),
	}
	var files []backup.SnapshotFile
	for src, b := range content {
		key := "snapshots/" + id + "/files/path_0" + src
		p.files[key] = b
		files = append(files, backup.SnapshotFile{SourcePath: src, BackupPath: key, Size: int64(len(b)), Checksum: sum(b), Mode: 0o644, ModTime: time.Now().UTC()})
	}
	files = append(files, backup.SnapshotFile{SourcePath: "/bin", Kind: backup.KindSymlink, LinkTarget: "usr/bin", ModTime: time.Now().UTC()})
	man, _ := json.Marshal(backup.Snapshot{ID: id, Timestamp: time.Now().UTC(), Files: files})
	p.files["snapshots/"+id+"/manifest.json"] = man
	lb, _ := json.Marshal(lay)
	p.files["snapshots/"+id+"/layout.json"] = lb
	svc := []byte("ssh.service enabled\n")
	p.files["snapshots/"+id+"/system-state/services/systemd.txt"] = svc
	sm, _ := json.Marshal(systemstate.SystemStateManifest{Platform: "linux", SchemaVersion: 1, Artifacts: []systemstate.Artifact{{Name: "services", Category: "services", Path: "services/systemd.txt", SizeBytes: int64(len(svc)), Checksum: sum(svc)}}})
	p.files["snapshots/"+id+"/system-state/manifest.json"] = sm
	return p
}

func testLayout() *layout.Manifest {
	d := srcDisk()
	return &layout.Manifest{SchemaVersion: layout.SchemaVersion, Platform: "linux", BootMode: layout.BootModeUEFI, OSRelease: "Ubuntu 24.04", Hostname: "srv-1", Disks: []layout.Disk{*d}}
}

func TestRun_DryRunProducesPlanWithoutWrites(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), DryRun: true, System: sys})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.Plan == nil || len(res.Plan.Partitions) != 3 || res.PhaseReached != PhasePreflight {
		t.Fatalf("res = %+v", res)
	}
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "sgdisk") || strings.HasPrefix(c, "mkfs") || strings.HasPrefix(c, "mount") {
			t.Fatalf("dry run wrote: %s\n%s", c, sys.dump())
		}
	}
}

func TestRun_PreflightRefusals(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(sys *fakeSystem, p *memProvider, lay *layout.Manifest)
		want   string
	}{
		{"unsupported layout", func(_ *fakeSystem, _ *memProvider, lay *layout.Manifest) { lay.BootMode = layout.BootModeBIOS }, layout.ReasonBIOSBoot},
		{"target mounted", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.mounted = []string{"/dev/sdb2"} }, "target disk /dev/sdb is in use"},
		{"target is the running system", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.rootSrcs = []string{"/dev/sdb1"} }, "running system"},
		{"target too small", func(sys *fakeSystem, _ *memProvider, _ *layout.Manifest) { sys.diskSize = 4 * GiB }, "target is too small"},
		{"layout schema from the future", func(_ *fakeSystem, _ *memProvider, lay *layout.Manifest) { lay.SchemaVersion = 99 }, "layout schema version 99"},
		{"missing layout.json", func(_ *fakeSystem, p *memProvider, _ *layout.Manifest) {
			delete(p.files, "snapshots/snap-1/layout.json")
		}, "no disk layout was captured"},
		{"tampered system state", func(_ *fakeSystem, p *memProvider, _ *layout.Manifest) {
			p.files["snapshots/snap-1/system-state/services/systemd.txt"] = []byte("evil")
		}, "services/systemd.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			lay := testLayout()
			p := seedSnapshot(t, "snap-1", lay)
			tt.mutate(sys, p, lay)
			lb, _ := json.Marshal(lay)
			if _, ok := p.files["snapshots/snap-1/layout.json"]; ok {
				p.files["snapshots/snap-1/layout.json"] = lb
			}
			res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys})
			if err == nil {
				t.Fatalf("expected refusal, got %+v", res)
			}
			if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tt.want) || res.PhaseReached != PhasePreflight {
				t.Fatalf("res = %+v err=%v", res, err)
			}
			if sys.has("sgdisk") || sys.has("mkfs") {
				t.Fatalf("refusal must not write: %s", sys.dump())
			}
		})
	}
}

// TestRun_PreflightRefusesOnSystemStateTransportError proves the review fix
// for bmr.DownloadSystemState: a mere transport failure fetching
// system-state/manifest.json (NOT a confirmed-absent object) must refuse
// the whole run rather than being silently treated as "this snapshot has
// no system state, proceed with files only."
func TestRun_PreflightRefusesOnSystemStateTransportError(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	p.failKey = map[string]error{
		"snapshots/snap-1/system-state/manifest.json": errors.New("timeout talking to storage"),
	}
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys})
	if err == nil {
		t.Fatalf("expected refusal, got %+v", res)
	}
	if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, "system state could not be verified") || !strings.Contains(res.Refusal, "timeout talking to storage") || res.PhaseReached != PhasePreflight {
		t.Fatalf("res = %+v err=%v", res, err)
	}
	if sys.has("sgdisk") || sys.has("mkfs") || sys.has("mount") {
		t.Fatalf("refusal must not write: %s", sys.dump())
	}
}

func phaseNames(ps []Phase) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = string(p)
	}
	return out
}

func TestRun_FullLinuxFlowOnFakeSystem(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	staging := filepath.Join(dir, "mnt")
	var phases []Phase
	res, err := Run(context.Background(), Options{
		SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetImage, Path: filepath.Join(dir, "t.img"), ImageSizeBytes: 100 * GiB},
		Identity: IdentityOriginal, Marker: &Marker{RecoveryID: "rec-1", Nonce: "n-1"}, StateDir: dir, StagingRoot: staging, System: sys,
		RegenerateInitramfs: true,
		Progress: func(ph Phase, _ string, _, _ int64) {
			if len(phases) == 0 || phases[len(phases)-1] != ph {
				phases = append(phases, ph)
			}
		},
	})
	if err != nil {
		t.Fatalf("err=%v\n%s", err, sys.dump())
	}
	if res.Status != "completed" || res.PhaseReached != PhaseValidate || len(res.Phases) != 7 {
		t.Fatalf("res = %+v\n%s", res, sys.dump())
	}
	// Provision: zap, three partitions with type GUIDs + partition GUIDs, rescan, formats with UUIDs.
	for _, want := range []string{
		"sgdisk --zap-all /dev/loop7",
		"sgdisk --new=1:2048:", "--typecode=1:" + layout.GUIDEFISystem, "--partition-guid=1:" + testEFIPartUUID,
		"sgdisk --new=3:",
		"partprobe /dev/loop7",
		"mkfs.vfat -F 32 -i ABCD1234 /dev/loop7p1",
		"mkfs.ext4 -F -q -U " + testBootFSUUID + " /dev/loop7p2",
		"mkfs.ext4 -F -q -U " + testRootFSUUID + " -L rootfs /dev/loop7p3",
	} {
		if !sys.has(want) && !strings.Contains(strings.Join(sys.cmds, "\n"), want) {
			t.Errorf("missing command containing %q\n%s", want, sys.dump())
		}
	}
	if sys.indexOf("sgdisk --zap-all") < 0 || sys.indexOf("mkfs.ext4 -F -q -U "+testRootFSUUID) < sys.indexOf("partprobe") {
		t.Errorf("format must follow rescan\n%s", sys.dump())
	}
	// Mount order: root, then /boot, then /boot/efi.
	if len(sys.mountLog) < 3 || !strings.HasSuffix(sys.mountLog[0], " "+staging) || !strings.HasSuffix(sys.mountLog[1], filepath.Join(staging, "boot")) || !strings.HasSuffix(sys.mountLog[2], filepath.Join(staging, "boot", "efi")) {
		t.Errorf("mount order = %v", sys.mountLog)
	}
	// Restore landed under the staging root, including the symlink.
	if b, err := os.ReadFile(filepath.Join(staging, "etc", "hostname")); err != nil || string(b) != "srv-1\n" {
		t.Errorf("hostname = %q err=%v", b, err)
	}
	if got, err := os.Readlink(filepath.Join(staging, "bin")); err != nil || got != "usr/bin" {
		t.Errorf("symlink = %q err=%v", got, err)
	}
	// System state applied offline, through bmr's own exec seam (not
	// visible to fakeSystem — see bmrCall's doc comment above).
	if !hasBmrCall(bmrCallsSnapshot(), "systemctl --root="+staging+" enable ssh.service") {
		t.Errorf("services not enabled offline via bmr seam: %+v", bmrCallsSnapshot())
	}
	// Boot: bind mounts, grub-install in chroot with the EFI target, config regen, initramfs.
	for _, want := range []string{
		"mount --bind /dev " + filepath.Join(staging, "dev"),
		"mount --bind /proc " + filepath.Join(staging, "proc"),
		"mount --bind /sys " + filepath.Join(staging, "sys"),
		"chroot " + staging + " grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck --no-nvram --force-extra-removable",
		"chroot " + staging + " update-grub",
		"chroot " + staging + " update-initramfs -u -k all",
	} {
		if !sys.has(want) {
			t.Errorf("missing %q\n%s", want, sys.dump())
		}
	}
	// Identity original: marker written, machine-id untouched.
	var marker map[string]string
	mb, err := os.ReadFile(filepath.Join(staging, "var", "lib", "breeze", "recovery-marker.json"))
	if err != nil || json.Unmarshal(mb, &marker) != nil || marker["recoveryId"] != "rec-1" || marker["nonce"] != "n-1" || marker["snapshotId"] != "snap-1" {
		t.Errorf("marker = %s err=%v", mb, err)
	}
	if b, _ := os.ReadFile(filepath.Join(staging, "etc", "machine-id")); !strings.HasPrefix(string(b), "0123456789abcdef") {
		t.Errorf("machine-id changed on original identity: %q", b)
	}
	// Validate: sync, boot/efi unmounts before its parents, loop detached, no warnings.
	if !sys.has("sync") || len(sys.unmounts) < 3 || sys.unmounts[0] != filepath.Join(staging, "boot", "efi") || !sys.has("losetup -d /dev/loop7") {
		t.Errorf("teardown = unmounts %v\n%s", sys.unmounts, sys.dump())
	}
	if res.FilesRestored < 11 || len(res.Warnings) != 0 {
		t.Errorf("files=%d warnings=%v", res.FilesRestored, res.Warnings)
	}
	if strings.Join(phaseNames(phases), ",") != "preflight,provision,restore,boot,identity,encryption,validate" {
		t.Errorf("progress phases = %v", phases)
	}
}

// #5493: found live on the bare-metal boot proof. The whole-machine backup
// preset excludes /proc, /sys, /dev, /run, /tmp, /var/tmp, /mnt, /media, so
// a snapshot taken before the backup-side fix (collectBackupFilesFromPaths
// force-recording an excluded directory's own manifest entry) never
// contains them at all — restore alone leaves the staging root without
// them. boot()'s pseudoMounts/BindMount calls normally paper over this on a
// real system (a bind mount creates its target), but a SkipBoot run (or any
// run where boot() is skipped/fails before reaching them) must not depend on
// that: restoreTree's ensureMountpoints call is the belt-and-braces fix.
//
// This proves it in isolation: SkipBoot means boot() never executes (and
// fakeSystem's own BindMount, which happens to os.MkdirAll its target, never
// fires either), and the seeded snapshot's content map (seedSnapshot) has no
// proc/sys/dev/run/tmp entries — so these directories can only exist
// afterward because ensureMountpoints created them.
func TestRun_EnsureMountpointsSurvivesSkipBoot(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	staging := filepath.Join(dir, "mnt")
	res, err := Run(context.Background(), Options{
		SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetImage, Path: filepath.Join(dir, "t.img"), ImageSizeBytes: 100 * GiB},
		Identity: IdentityOriginal, StateDir: dir, StagingRoot: staging, System: sys, SkipBoot: true,
	})
	if err != nil {
		t.Fatalf("err=%v\n%s", err, sys.dump())
	}
	if res.Status != "completed" {
		t.Fatalf("res = %+v\n%s", res, sys.dump())
	}
	if sys.has("mount --bind") {
		t.Fatalf("SkipBoot run must never bind-mount (that would mask the defect this test checks): %s", sys.dump())
	}
	for _, name := range []string{"proc", "sys", "dev", "run"} {
		fi, statErr := os.Stat(filepath.Join(staging, name))
		if statErr != nil || !fi.IsDir() {
			t.Errorf("%s missing after a SkipBoot run: %v", name, statErr)
		}
	}
	fi, statErr := os.Stat(filepath.Join(staging, "tmp"))
	if statErr != nil || !fi.IsDir() {
		t.Fatalf("tmp missing after a SkipBoot run: %v", statErr)
	}
	if fi.Mode()&os.ModeSticky == 0 || fi.Mode().Perm() != 0o777 {
		t.Errorf("tmp mode = %v, want sticky 1777", fi.Mode())
	}
}

func TestRun_ResumeSkipsProvisionAndReusesPlan(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.fail["chroot"] = os.ErrPermission // first run dies in boot
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseBoot {
		t.Fatalf("first run = %+v err=%v", res, err)
	}
	sys2 := newFakeSystem(dir, 100*GiB)
	opts.System = sys2
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" || !res2.Resumed {
		t.Fatalf("second run = %+v err=%v\n%s", res2, err, sys2.dump())
	}
	if sys2.has("sgdisk") || sys2.has("mkfs") {
		t.Fatalf("resume re-provisioned the disk\n%s", sys2.dump())
	}
	if res2.Phases[1].Status != PhaseSkipped || res2.Phases[2].Status != PhaseSkipped {
		t.Errorf("phases = %+v", res2.Phases)
	}
	// State file is removed after success.
	if m, _ := filepath.Glob(filepath.Join(dir, "rebuild-snap-1-*.json")); len(m) != 0 {
		t.Errorf("state file left behind: %v", m)
	}
}

// TestRun_ResumeImageTargetReattachesLoop proves the review fix: an image
// target's loop device does NOT survive across Run() calls (teardown always
// detaches it on exit, even on failure), so a resumed run must re-attach a
// FRESH loop device rather than trusting a persisted device path — which
// could by then be stale, freed, or reused by something else entirely.
func TestRun_ResumeImageTargetReattachesLoop(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.fail["chroot"] = os.ErrPermission // first run dies in boot
	p := seedSnapshot(t, "snap-1", testLayout())
	img := filepath.Join(dir, "t.img")
	opts := Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetImage, Path: img, ImageSizeBytes: 100 * GiB}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys}
	res, err := Run(context.Background(), opts)
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseBoot {
		t.Fatalf("first run = %+v err=%v", res, err)
	}

	sys2 := newFakeSystem(dir, 100*GiB)
	opts.System = sys2
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" || !res2.Resumed {
		t.Fatalf("second run = %+v err=%v\n%s", res2, err, sys2.dump())
	}
	if sys2.has("sgdisk") || sys2.has("mkfs") {
		t.Fatalf("resume re-provisioned the disk\n%s", sys2.dump())
	}
	losetupIdx := sys2.indexOf("losetup --find --show --partscan " + img)
	if losetupIdx < 0 {
		t.Fatalf("resume did not re-attach the image via losetup\n%s", sys2.dump())
	}
	mountIdx := -1
	for i, c := range sys2.cmds {
		if strings.HasPrefix(c, "mount ") || strings.HasPrefix(c, "mount -") {
			mountIdx = i
			break
		}
	}
	if mountIdx < 0 {
		t.Fatalf("resume never mounted anything\n%s", sys2.dump())
	}
	if mountIdx < losetupIdx {
		t.Fatalf("mount happened before the loop device was re-attached\n%s", sys2.dump())
	}
}

// TestRun_ResumeDiskTargetNeverCallsLosetup is TestRun_ResumeImageTargetReattachesLoop's
// disk-target sibling: a disk target never goes through losetup at all, on
// a fresh run or a resumed one.
func TestRun_ResumeDiskTargetNeverCallsLosetup(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.fail["chroot"] = os.ErrPermission
	p := seedSnapshot(t, "snap-1", testLayout())
	opts := Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys}
	if _, err := Run(context.Background(), opts); err == nil {
		t.Fatal("expected the first run to fail in boot")
	}

	sys2 := newFakeSystem(dir, 100*GiB)
	opts.System = sys2
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" {
		t.Fatalf("second run = %+v err=%v\n%s", res2, err, sys2.dump())
	}
	if sys2.has("losetup") {
		t.Errorf("a disk target must never call losetup\n%s", sys2.dump())
	}
}

func TestRun_StrictRestoreFailsOnMissingObject(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	delete(p.files, "snapshots/snap-1/files/path_0/usr/bin/tool")
	res, err := Run(context.Background(), Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys})
	if err == nil || res.Status != "failed" || res.PhaseReached != PhaseRestore || !strings.Contains(res.Error, "/usr/bin/tool") {
		t.Fatalf("res = %+v err=%v", res, err)
	}
}

// TestRun_ResumeReusesRestoreProgress proves the restore phase resumes from
// the persistent work root instead of re-downloading every file: run 1 hits a
// missing object (strict restore fails after every other file landed), run 2
// with AllowPartialRestore must report the landed files as skipped.
func TestRun_ResumeReusesRestoreProgress(t *testing.T) {
	skipUnlessLinuxSystemState(t)
	resetBmrCalls()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	delete(p.files, "snapshots/snap-1/files/path_0/usr/bin/tool")
	opts := Options{SnapshotID: "snap-1", Provider: p, Target: Target{Kind: TargetDisk, Path: "/dev/sdb"}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys}
	if res, err := Run(context.Background(), opts); err == nil || res == nil || res.PhaseReached != PhaseRestore {
		t.Fatalf("first run = %+v err=%v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "work", "restore-work", "staging", "snap-1")); err != nil {
		t.Fatalf("restore work root must survive a failed run: %v", err)
	}
	var skipped, restored int
	opts.System = newFakeSystem(dir, 100*GiB)
	opts.AllowPartialRestore = true
	opts.Progress = func(ph Phase, msg string, _, _ int64) {
		if ph != PhaseRestore {
			return
		}
		if strings.Contains(msg, "skipped (resumed)") {
			skipped++
		} else if strings.HasPrefix(msg, "restored:") {
			restored++
		}
	}
	res2, err := Run(context.Background(), opts)
	if err != nil || res2.Status != "completed" || !res2.Resumed {
		t.Fatalf("second run = %+v err=%v", res2, err)
	}
	if skipped == 0 || restored != 0 {
		t.Fatalf("resume must skip already-restored files: skipped=%d restored=%d", skipped, restored)
	}
	if _, err := os.Stat(filepath.Join(dir, "work")); !os.IsNotExist(err) {
		t.Fatalf("work root must be removed after a completed run (err=%v)", err)
	}
}
