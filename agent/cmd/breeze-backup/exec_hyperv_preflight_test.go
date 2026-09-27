package main

import (
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// Issue #5460: a Hyper-V export needs the VM's full size on the staging
// volume. Before this fix nothing checked, so a too-small system drive failed
// only after a multi-GB Export-VM (or, on restore, after the whole download).
// These tests drive execHypervBackup / execHypervRestore through their
// package-level seams — the real hyperv package is a stub off Windows.

const gib = int64(1) << 30

type hypervSeamRecorder struct {
	exportCalls int
	importCalls int
}

// stubHypervSeams replaces every Hyper-V/disk seam for one test. export, when
// non-nil, runs in place of hyperv.ExportVM; free maps a directory to the free
// bytes of "its volume".
func stubHypervSeams(
	t *testing.T,
	estimate func(string) (int64, error),
	free func(string) (int64, error),
	importDir func() (string, error),
	export func(vmName, exportPath, consistencyType string) (*hyperv.BackupResult, error),
) *hypervSeamRecorder {
	t.Helper()
	rec := &hypervSeamRecorder{}
	prevEstimate, prevFree, prevImportDir := estimateHypervExportBytes, volumeFreeBytes, hypervImportTargetDir
	prevExport, prevImport := exportHypervVM, importHypervVM
	t.Cleanup(func() {
		estimateHypervExportBytes, volumeFreeBytes, hypervImportTargetDir = prevEstimate, prevFree, prevImportDir
		exportHypervVM, importHypervVM = prevExport, prevImport
	})
	estimateHypervExportBytes = estimate
	volumeFreeBytes = free
	hypervImportTargetDir = importDir
	exportHypervVM = func(vmName, exportPath, consistencyType string) (*hyperv.BackupResult, error) {
		rec.exportCalls++
		if export != nil {
			return export(vmName, exportPath, consistencyType)
		}
		return nil, errors.New("export seam not configured")
	}
	importHypervVM = func(exportPath, vmName string, generateNewID bool) (*hyperv.RestoreResult, error) {
		rec.importCalls++
		return &hyperv.RestoreResult{VMName: vmName, Status: "completed"}, nil
	}
	return rec
}

func constFree(n int64) func(string) (int64, error) {
	return func(string) (int64, error) { return n, nil }
}

// fakeExport writes a small VM export tree under exportPath/<vm>, the way
// Export-VM lays it out, and optionally fails after writing (a partial export).
func fakeExport(failAfterWrite bool) func(vmName, exportPath, consistencyType string) (*hyperv.BackupResult, error) {
	return func(vmName, exportPath, consistencyType string) (*hyperv.BackupResult, error) {
		vmDir := filepath.Join(exportPath, vmName, "Virtual Hard Disks")
		if err := os.MkdirAll(vmDir, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(vmDir, "disk.vhdx"), []byte("vhdx-bytes"), 0o644); err != nil {
			return nil, err
		}
		if failAfterWrite {
			return nil, errors.New("Export-VM : There is not enough space on the disk")
		}
		return &hyperv.BackupResult{VMName: vmName, ConsistencyType: consistencyType, ExportPath: filepath.Join(exportPath, vmName)}, nil
	}
}

func newStagedManager(t *testing.T) (*backup.BackupManager, string, string) {
	t.Helper()
	storeDir := t.TempDir()
	stagingBase := t.TempDir()
	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   providers.NewLocalProvider(storeDir),
		StagingDir: stagingBase,
	})
	return mgr, storeDir, stagingBase
}

func hypervBackupPayload(t *testing.T) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"vmName": "Accounting VM", "consistencyType": "application"})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return payload
}

func assertNoHypervStagingLeft(t *testing.T, stagingBase string) {
	t.Helper()
	entries, err := os.ReadDir(stagingBase)
	if err != nil {
		t.Fatalf("read staging base: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "breeze-hyperv-") {
			t.Fatalf("Hyper-V staging dir %q was left behind in %s", e.Name(), stagingBase)
		}
	}
}

func TestExecHypervBackup_FailsFastWhenStagingVolumeTooSmall(t *testing.T) {
	mgr, _, stagingBase := newStagedManager(t)
	rec := stubHypervSeams(t,
		func(string) (int64, error) { return 12 * gib, nil },
		constFree(5*gib),
		nil,
		fakeExport(false),
	)

	result := execHypervBackup(hypervBackupPayload(t), mgr)

	if result.Success {
		t.Fatal("expected the backup to fail its free-space preflight")
	}
	if rec.exportCalls != 0 {
		t.Fatalf("Export-VM ran %d time(s); the preflight must stop it before any data is written", rec.exportCalls)
	}
	for _, want := range []string{"not enough free space", "Accounting VM", stagingBase, "backup_staging_dir"} {
		if !strings.Contains(result.Stderr, want) {
			t.Fatalf("error %q does not mention %q", result.Stderr, want)
		}
	}
	assertNoHypervStagingLeft(t, stagingBase)
}

func TestExecHypervBackup_HeadroomIsRequiredOnTopOfTheEstimate(t *testing.T) {
	mgr, _, _ := newStagedManager(t)
	// Exactly the estimate free, but no headroom: must still refuse.
	rec := stubHypervSeams(t,
		func(string) (int64, error) { return 12 * gib, nil },
		constFree(12*gib),
		nil,
		fakeExport(false),
	)
	if result := execHypervBackup(hypervBackupPayload(t), mgr); result.Success {
		t.Fatal("expected refusal when free space equals the estimate with no headroom")
	}
	if rec.exportCalls != 0 {
		t.Fatal("Export-VM must not run without headroom")
	}
}

func TestExecHypervBackup_SucceedsAndRemovesStagingWhenSpaceSuffices(t *testing.T) {
	mgr, storeDir, stagingBase := newStagedManager(t)
	rec := stubHypervSeams(t,
		func(string) (int64, error) { return 1 * gib, nil },
		constFree(100*gib),
		nil,
		fakeExport(false),
	)

	result := execHypervBackup(hypervBackupPayload(t), mgr)

	if !result.Success {
		t.Fatalf("expected success, got: %s", result.Stderr)
	}
	if rec.exportCalls != 1 {
		t.Fatalf("Export-VM ran %d times, want 1", rec.exportCalls)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	snapshotID, _ := out["snapshotId"].(string)
	if snapshotID == "" {
		t.Fatalf("no snapshotId in result: %s", result.Stdout)
	}
	if _, err := os.Stat(filepath.Join(storeDir, filepath.FromSlash(path.Join("snapshots", snapshotID, "manifest.json")))); err != nil {
		t.Fatalf("manifest was not uploaded: %v", err)
	}
	assertNoHypervStagingLeft(t, stagingBase)
}

func TestExecHypervBackup_RemovesPartialExportOnFailure(t *testing.T) {
	mgr, _, stagingBase := newStagedManager(t)
	stubHypervSeams(t,
		func(string) (int64, error) { return 1 * gib, nil },
		constFree(100*gib),
		nil,
		fakeExport(true),
	)

	if result := execHypervBackup(hypervBackupPayload(t), mgr); result.Success {
		t.Fatal("expected the export failure to fail the backup")
	}
	assertNoHypervStagingLeft(t, stagingBase)
}

// The preflight is advisory about its own inputs: when the size estimate or
// the free-space query itself fails, the backup must run exactly as it did
// before this change (and say the check was skipped), never fail a backup
// that would have succeeded.
func TestExecHypervBackup_PreflightInputFailureFailsOpenWithWarning(t *testing.T) {
	cases := map[string]struct {
		estimate func(string) (int64, error)
		free     func(string) (int64, error)
	}{
		"estimate fails": {
			estimate: func(string) (int64, error) { return 0, errors.New("Get-VHD not recognized") },
			free:     constFree(1 * gib),
		},
		"free-space query fails": {
			estimate: func(string) (int64, error) { return 50 * gib, nil },
			free:     func(string) (int64, error) { return 0, errors.New("access denied") },
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			mgr, _, _ := newStagedManager(t)
			rec := stubHypervSeams(t, tc.estimate, tc.free, nil, fakeExport(false))

			result := execHypervBackup(hypervBackupPayload(t), mgr)

			if !result.Success {
				t.Fatalf("expected the backup to proceed, got: %s", result.Stderr)
			}
			if rec.exportCalls != 1 {
				t.Fatalf("Export-VM ran %d times, want 1", rec.exportCalls)
			}
			if !strings.Contains(result.Stdout, "free-space preflight skipped") {
				t.Fatalf("expected a skipped-preflight warning in the result, got: %s", result.Stdout)
			}
		})
	}
}

// uploadHypervTestSnapshot publishes a minimal Hyper-V snapshot (manifest +
// one export file) so execHypervRestore can get past the manifest download.
func uploadHypervTestSnapshot(t *testing.T, provider providers.BackupProvider, snapshotID string, size int64) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "disk.vhdx")
	if err := os.WriteFile(src, []byte("vhdx-bytes"), 0o644); err != nil {
		t.Fatalf("write export file: %v", err)
	}
	backupPath := path.Join("snapshots", snapshotID, "files", "Accounting VM/Virtual Hard Disks/disk.vhdx")
	if err := provider.Upload(src, backupPath); err != nil {
		t.Fatalf("upload export file: %v", err)
	}
	manifest := hypervSnapshotManifest{
		ID:         snapshotID,
		VMName:     "Accounting VM",
		Timestamp:  time.Now().UTC(),
		ExportRoot: "Accounting VM",
		Files: []hypervSnapshotManifestFile{{
			SourcePath: "Accounting VM/Virtual Hard Disks/disk.vhdx",
			BackupPath: backupPath,
			Size:       size,
		}},
		Size: size,
	}
	if err := uploadHypervSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
}

func hypervRestorePayload(t *testing.T, snapshotID string) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"snapshotId": snapshotID, "vmName": "Recovered VM"})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return payload
}

// Restore downloads the export into staging AND Import-VM -Copy writes a
// second full copy into the host's virtual hard disk path. When both land on
// one volume (the campaign's C: drive) it needs twice the snapshot size.
func TestExecHypervRestore_FailsFastWhenStagingAndImportShareATooSmallVolume(t *testing.T) {
	mgr, _, stagingBase := newStagedManager(t)
	uploadHypervTestSnapshot(t, mgr.GetProvider(), "hv-restore-small", 12*gib)
	importDir := t.TempDir()
	rec := stubHypervSeams(t,
		nil,
		constFree(20*gib), // enough for one copy, not for two
		func() (string, error) { return importDir, nil },
		nil,
	)
	// Both directories on C: — the campaign host's layout.
	prevKey := hypervVolumeKey
	hypervVolumeKey = func(string) string { return "C:" }
	t.Cleanup(func() { hypervVolumeKey = prevKey })

	result := execHypervRestore(hypervRestorePayload(t, "hv-restore-small"), mgr)

	if result.Success {
		t.Fatal("expected the restore to fail its free-space preflight")
	}
	if rec.importCalls != 0 {
		t.Fatal("Import-VM must not run when the preflight fails")
	}
	for _, want := range []string{"not enough free space", "download", "Import-VM copy"} {
		if !strings.Contains(result.Stderr, want) {
			t.Fatalf("error %q does not mention %q", result.Stderr, want)
		}
	}
	assertNoHypervStagingLeft(t, stagingBase)
}

func TestExecHypervRestore_ProceedsWhenImportTargetIsOnAnotherVolume(t *testing.T) {
	mgr, _, stagingBase := newStagedManager(t)
	uploadHypervTestSnapshot(t, mgr.GetProvider(), "hv-restore-split", 12*gib)
	importDir := t.TempDir()
	rec := stubHypervSeams(t,
		nil,
		constFree(20*gib), // each volume holds one copy
		func() (string, error) { return importDir, nil },
		nil,
	)

	result := execHypervRestore(hypervRestorePayload(t, "hv-restore-split"), mgr)

	if !result.Success {
		t.Fatalf("expected success, got: %s", result.Stderr)
	}
	if rec.importCalls != 1 {
		t.Fatalf("Import-VM ran %d times, want 1", rec.importCalls)
	}
	assertNoHypervStagingLeft(t, stagingBase)
}

// agent.yaml's backup_staging_dir is the existing staging override. The
// payload-built manager every policy-managed device uses for hyperv_backup /
// hyperv_restore must honour it — before this fix it was silently dropped, so
// exports always staged in the OS temp dir (C:\Windows\SystemTemp).
func TestManagerFromProviderPayload_CarriesConfiguredStagingDir(t *testing.T) {
	prev := helperStagingDir
	helperStagingDir = filepath.Join(t.TempDir(), "staging")
	t.Cleanup(func() { helperStagingDir = prev })

	mgr, err := managerFromProviderPayload(json.RawMessage(`{"provider":"local","providerConfig":{"path":"/var/backups"}}`))
	if err != nil || mgr == nil {
		t.Fatalf("mgr=%v err=%v", mgr, err)
	}
	if got := mgr.GetStagingDir(); got != helperStagingDir {
		t.Fatalf("StagingDir = %q, want %q", got, helperStagingDir)
	}
}

func TestResolveBackupStagingDir(t *testing.T) {
	if got := resolveBackupStagingDir(""); got != "" {
		t.Fatalf("unset staging dir resolved to %q, want empty (OS temp)", got)
	}
	want := filepath.Join(t.TempDir(), "a", "b")
	if got := resolveBackupStagingDir(want); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("configured staging dir was not created: %v", err)
	}
	// A path that cannot be a directory falls back to the OS temp dir.
	file := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := resolveBackupStagingDir(filepath.Join(file, "child")); got != "" {
		t.Fatalf("uncreatable staging dir resolved to %q, want empty fallback", got)
	}
}

// A helper killed mid-export (crash, update, service stop) never runs its
// deferred cleanup, stranding a VM-sized directory. The startup sweep removes
// stale Breeze Hyper-V staging dirs and nothing else — and never one whose
// liveness marker is still being refreshed: a directory's own mtime freezes
// once Export-VM has created its subfolders, so a multi-hour export in an
// overlapping helper looks "old" by dir mtime alone.
func TestSweepOrphanedHypervStaging(t *testing.T) {
	base := t.TempDir()
	now := time.Now()
	mk := func(name string, dirMod time.Time, marker *time.Time) string {
		p := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Join(p, "Accounting VM"), 0o755); err != nil {
			t.Fatal(err)
		}
		if marker != nil {
			m := filepath.Join(p, hypervStagingAliveMarker)
			if err := os.WriteFile(m, nil, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(m, *marker, *marker); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Chtimes(p, dirMod, dirMod); err != nil {
			t.Fatal(err)
		}
		return p
	}
	twoHours := now.Add(-2 * time.Hour)
	twoDays := now.Add(-48 * time.Hour)
	fresh := now

	staleMarker := mk("breeze-hyperv-111", twoHours, &twoHours)
	staleRestore := mk("breeze-hyperv-restore-222", twoHours, &twoHours)
	liveLongExport := mk("breeze-hyperv-333", twoDays, &fresh) // old dir, heartbeat fresh
	legacyRecent := mk("breeze-hyperv-444", twoHours, nil)     // no marker (older helper), < 24h
	legacyStale := mk("breeze-hyperv-555", twoDays, nil)       // no marker, > 24h
	unrelated := mk("breeze-mssql-666", twoDays, nil)

	removed := sweepOrphanedHypervStaging([]string{base, base}, time.Hour, 24*time.Hour)

	if removed != 3 {
		t.Fatalf("removed %d dirs, want 3", removed)
	}
	for _, gone := range []string{staleMarker, staleRestore, legacyStale} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Fatalf("stale staging dir %s was not removed", gone)
		}
	}
	for _, kept := range []string{liveLongExport, legacyRecent, unrelated} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("%s must be kept: %v", kept, err)
		}
	}
}

func TestHypervStagingHeartbeatRefreshesMarker(t *testing.T) {
	dir := t.TempDir()
	stop := startHypervStagingHeartbeat(dir, 10*time.Millisecond)
	marker := filepath.Join(dir, hypervStagingAliveMarker)
	first, err := os.Stat(marker)
	if err != nil {
		t.Fatalf("marker not written on start: %v", err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(marker, old, old); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		info, err := os.Stat(marker)
		if err == nil && info.ModTime().After(old.Add(time.Minute)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("heartbeat never refreshed the marker (first write %v)", first.ModTime())
		}
		time.Sleep(5 * time.Millisecond)
	}
	stop()
	stop() // idempotent
}

// The live export's staging dir carries the marker for the whole run.
func TestExecHypervBackup_StagingDirCarriesAliveMarkerDuringExport(t *testing.T) {
	mgr, _, _ := newStagedManager(t)
	var sawMarker bool
	stubHypervSeams(t,
		func(string) (int64, error) { return 1 * gib, nil },
		constFree(100*gib),
		nil,
		func(vmName, exportPath, consistencyType string) (*hyperv.BackupResult, error) {
			_, err := os.Stat(filepath.Join(exportPath, hypervStagingAliveMarker))
			sawMarker = err == nil
			return fakeExport(false)(vmName, exportPath, consistencyType)
		},
	)
	if result := execHypervBackup(hypervBackupPayload(t), mgr); !result.Success {
		t.Fatalf("backup failed: %s", result.Stderr)
	}
	if !sawMarker {
		t.Fatal("staging dir had no liveness marker while Export-VM ran")
	}
}

// The marker must not be uploaded as part of the VM export.
func TestExecHypervBackup_AliveMarkerIsNotUploaded(t *testing.T) {
	mgr, _, _ := newStagedManager(t)
	stubHypervSeams(t,
		func(string) (int64, error) { return 1 * gib, nil },
		constFree(100*gib),
		nil,
		fakeExport(false),
	)
	result := execHypervBackup(hypervBackupPayload(t), mgr)
	if !result.Success {
		t.Fatalf("backup failed: %s", result.Stderr)
	}
	if strings.Contains(result.Stdout, hypervStagingAliveMarker) {
		t.Fatalf("liveness marker leaked into the snapshot: %s", result.Stdout)
	}
	var out struct {
		FilesBackedUp int `json:"filesBackedUp"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.FilesBackedUp != 1 {
		t.Fatalf("filesBackedUp = %d, want 1 (the VHDX only)", out.FilesBackedUp)
	}
}

// When the host's import destination cannot be read the restore still runs
// (staging is checked alone) and says the import check was skipped.
func TestExecHypervRestore_ImportTargetLookupFailureFailsOpenWithWarning(t *testing.T) {
	mgr, _, _ := newStagedManager(t)
	uploadHypervTestSnapshot(t, mgr.GetProvider(), "hv-restore-noimportdir", 12*gib)
	rec := stubHypervSeams(t,
		nil,
		constFree(20*gib),
		func() (string, error) { return "", errors.New("Get-VMHost failed") },
		nil,
	)

	result := execHypervRestore(hypervRestorePayload(t, "hv-restore-noimportdir"), mgr)

	if !result.Success {
		t.Fatalf("expected the restore to proceed, got: %s", result.Stderr)
	}
	if rec.importCalls != 1 {
		t.Fatalf("Import-VM ran %d times, want 1", rec.importCalls)
	}
	if !strings.Contains(result.Stdout, "import destination") {
		t.Fatalf("expected a skipped-import-check warning in the result, got: %s", result.Stdout)
	}
}

// Manifests without a top-level size fall back to the sum of file sizes.
func TestExecHypervRestore_ManifestWithoutSizeUsesFileSizes(t *testing.T) {
	mgr, _, _ := newStagedManager(t)
	uploadHypervTestSnapshot(t, mgr.GetProvider(), "hv-restore-nosize", 12*gib)
	// Rewrite the manifest with Size 0 but the file still recording 12 GiB.
	m, err := downloadHypervSnapshotManifest("hv-restore-nosize", mgr.GetProvider())
	if err != nil {
		t.Fatal(err)
	}
	m.Size = 0
	if err := uploadHypervSnapshotManifest(mgr.GetProvider(), *m); err != nil {
		t.Fatal(err)
	}
	rec := stubHypervSeams(t,
		nil,
		constFree(5*gib),
		func() (string, error) { return t.TempDir(), nil },
		nil,
	)

	if result := execHypervRestore(hypervRestorePayload(t, "hv-restore-nosize"), mgr); result.Success {
		t.Fatal("expected the restore to fail its free-space preflight from the file sizes")
	}
	if rec.importCalls != 0 {
		t.Fatal("Import-VM must not run when the preflight fails")
	}
}

func TestVolumeKeyAndProbeDir(t *testing.T) {
	// filepath.VolumeName only recognises drive letters on Windows; off
	// Windows each directory is its own volume.
	dir := t.TempDir()
	if got := volumeKey(dir); got != filepath.Clean(dir) {
		t.Fatalf("volumeKey(%q) = %q", dir, got)
	}
	if got := volumeProbeDir(dir); got != dir {
		t.Fatalf("volumeProbeDir(%q) = %q", dir, got)
	}
}
