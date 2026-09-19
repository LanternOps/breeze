package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

var (
	runMSSQLBackup  = mssql.RunBackup
	runMSSQLRestore = mssql.RunRestore
	runMSSQLVerify  = mssql.VerifyBackup

	// resolveMSSQLRestoreTargetDir resolves the directory RESTORE/RESTORE
	// VERIFYONLY artifacts must be downloaded into: the same SQL-Server-
	// writable directory RunBackup writes into (D23b). See
	// mssql.ResolveRestoreTargetDir's doc comment.
	resolveMSSQLRestoreTargetDir = mssql.ResolveRestoreTargetDir
)

// --- MSSQL ---

func execMSSQLDiscover() backupipc.BackupCommandResult {
	instances, err := mssql.DiscoverInstances()
	return marshalResult(instances, err)
}

func execMSSQLBackup(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		Database   string `json:"database"`
		BackupType string `json:"backupType"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL backup payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}
	provider := mgr.GetProvider()
	if provider == nil {
		return fail("backup not configured")
	}
	if err := applyCommandStorageEncryption(provider, payload); err != nil {
		return fail(err.Error())
	}

	stagingDir, err := os.MkdirTemp(mgr.GetStagingDir(), "breeze-mssql-*")
	if err != nil {
		return fail("failed to create staging dir: " + err.Error())
	}
	defer func() {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		}
	}()

	result, err := runMSSQLBackup(p.Instance, p.Database, p.BackupType, stagingDir)
	if err != nil {
		return fail(err.Error())
	}

	backupFileInfo, statErr := os.Stat(result.BackupFile)
	if statErr != nil {
		return fail("failed to stat MSSQL backup file: " + statErr.Error())
	}
	totalSize := backupFileInfo.Size()
	snapshotID := newMssqlSnapshotID(p.Instance, p.Database)
	remotePath := path.Join("snapshots", snapshotID, "files", filepath.Base(result.BackupFile))

	if err := provider.Upload(result.BackupFile, remotePath); err != nil {
		removeMssqlBackupFile(result.BackupFile)
		cleanupMssqlSnapshot(provider, snapshotID)
		return fail("failed to upload MSSQL backup: " + err.Error())
	}
	removeMssqlBackupFile(result.BackupFile)

	modTime := backupFileInfo.ModTime().UTC()
	snapshot := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{
				SourcePath: filepath.Base(result.BackupFile),
				BackupPath: remotePath,
				Size:       totalSize,
				ModTime:    modTime,
			},
		},
		Size: totalSize,
	}

	if err := uploadMssqlSnapshotManifest(provider, snapshot); err != nil {
		cleanupMssqlSnapshot(provider, snapshotID)
		return fail("failed to upload MSSQL manifest: " + err.Error())
	}

	return marshalResult(map[string]any{
		"snapshotId":    snapshotID,
		"filesBackedUp": 1,
		"bytesBackedUp": totalSize,
		"backupType":    "database",
		"metadata": map[string]any{
			"backupKind":        "mssql_database",
			"instance":          result.InstanceName,
			"instanceName":      result.InstanceName,
			"database":          result.DatabaseName,
			"databaseName":      result.DatabaseName,
			"backupSubtype":     result.BackupType,
			"mssqlBackupType":   result.BackupType,
			"backupFileName":    filepath.Base(result.BackupFile),
			"backupFile":        remotePath,
			"storagePrefix":     path.Join("snapshots", snapshotID),
			"firstLsn":          result.FirstLSN,
			"lastLsn":           result.LastLSN,
			"databaseBackupLsn": result.DatabaseLSN,
			"compressed":        result.Compressed,
			"durationMs":        result.DurationMs,
			"sizeBytes":         totalSize,
		},
		"snapshot": map[string]any{
			"id":        snapshot.ID,
			"timestamp": snapshot.Timestamp.Format(time.RFC3339),
			"size":      snapshot.Size,
			"files": []map[string]any{
				{
					"sourcePath": snapshot.Files[0].SourcePath,
					"backupPath": snapshot.Files[0].BackupPath,
					"size":       snapshot.Files[0].Size,
					"modTime":    snapshot.Files[0].ModTime.Format(time.RFC3339),
				},
			},
		},
	}, nil)
}

func execMSSQLRestore(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		SnapshotID string `json:"snapshotId"`
		BackupFile string `json:"backupFile"`
		TargetDB   string `json:"targetDatabase"`
		NoRecovery bool   `json:"noRecovery"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL restore payload: " + err.Error())
	}
	var provider providers.BackupProvider
	if mgr != nil {
		provider = mgr.GetProvider()
	}
	artifactPath, cleanup, err := resolveMSSQLBackupArtifact(p.Instance, provider, p.SnapshotID, p.BackupFile)
	if err != nil {
		return fail(err.Error())
	}
	if cleanup != nil {
		defer cleanup()
	}
	result, err := runMSSQLRestore(p.Instance, artifactPath, p.TargetDB, p.NoRecovery)
	return marshalResult(result, err)
}

func execMSSQLVerify(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		SnapshotID string `json:"snapshotId"`
		BackupFile string `json:"backupFile"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL verify payload: " + err.Error())
	}
	var provider providers.BackupProvider
	if mgr != nil {
		provider = mgr.GetProvider()
	}
	artifactPath, cleanup, err := resolveMSSQLBackupArtifact(p.Instance, provider, p.SnapshotID, p.BackupFile)
	if err != nil {
		return fail(err.Error())
	}
	if cleanup != nil {
		defer cleanup()
	}
	result, err := runMSSQLVerify(p.Instance, artifactPath)
	return marshalResult(result, err)
}

// --- Hyper-V ---

func execHypervDiscover() backupipc.BackupCommandResult {
	vms, err := hyperv.DiscoverVMs()
	return marshalResult(vms, err)
}

func execHypervBackup(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		VMName          string `json:"vmName"`
		ConsistencyType string `json:"consistencyType"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V backup payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}
	provider := mgr.GetProvider()
	if provider == nil {
		return fail("backup not configured")
	}
	if err := applyCommandStorageEncryption(provider, payload); err != nil {
		return fail(err.Error())
	}

	stagingDir, err := os.MkdirTemp(mgr.GetStagingDir(), "breeze-hyperv-*")
	if err != nil {
		return fail("failed to create staging dir: " + err.Error())
	}
	defer func() {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		}
	}()

	result, err := hyperv.ExportVM(p.VMName, stagingDir, p.ConsistencyType)
	if err != nil {
		return fail(err.Error())
	}

	snapshotID := newHypervSnapshotID(p.VMName)
	prefix := path.Join("snapshots", snapshotID)

	var fileCount int
	var totalSize int64
	manifestFiles := make([]hypervSnapshotManifestFile, 0)
	err = filepath.WalkDir(stagingDir, func(localPath string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return walkErr
		}
		relPath, relErr := filepath.Rel(stagingDir, localPath)
		if relErr != nil {
			return fmt.Errorf("cannot compute relative path for %s: %w", localPath, relErr)
		}
		normalizedRelPath := filepath.ToSlash(relPath)
		remotePath := path.Join(prefix, "files", normalizedRelPath)
		info, infoErr := d.Info()
		var fileSize int64
		var modTime time.Time
		if infoErr != nil {
			slog.Warn("failed to stat file during backup upload, size will be approximate",
				"path", localPath, "error", infoErr.Error())
		} else {
			fileSize = info.Size()
			modTime = info.ModTime().UTC()
			totalSize += fileSize
		}
		fileCount++
		manifestFiles = append(manifestFiles, hypervSnapshotManifestFile{
			SourcePath: normalizedRelPath,
			BackupPath: remotePath,
			Size:       fileSize,
			ModTime:    modTime,
		})
		return provider.Upload(localPath, remotePath)
	})
	if err != nil {
		return fail("failed to upload Hyper-V export: " + err.Error())
	}

	manifest := hypervSnapshotManifest{
		ID:              snapshotID,
		VMName:          p.VMName,
		Timestamp:       time.Now().UTC(),
		ConsistencyType: p.ConsistencyType,
		ExportRoot:      filepath.ToSlash(filepath.Base(result.ExportPath)),
		Files:           manifestFiles,
		Size:            totalSize,
	}
	if err := uploadHypervSnapshotManifest(provider, manifest); err != nil {
		cleanupHypervSnapshot(provider, snapshotID)
		return fail("failed to upload Hyper-V manifest: " + err.Error())
	}

	return marshalResult(map[string]any{
		"snapshotId":    snapshotID,
		"filesBackedUp": fileCount,
		"bytesBackedUp": totalSize,
		"warning":       strings.Join(result.Warnings, "\n"),
		"backupType":    "application",
		"metadata": map[string]any{
			"backupKind":       "hyperv_export",
			"vmName":           result.VMName,
			"consistencyType":  result.ConsistencyType,
			"durationMs":       result.DurationMs,
			"warnings":         result.Warnings,
			"storagePrefix":    path.Join("snapshots", snapshotID),
			"exportArtifactId": snapshotID,
			"exportRoot":       manifest.ExportRoot,
		},
		"snapshot": map[string]any{
			"id":        snapshotID,
			"timestamp": manifest.Timestamp.Format(time.RFC3339),
			"size":      totalSize,
			"files":     manifestFiles,
		},
	}, nil)
}

func execHypervRestore(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID    string `json:"snapshotId"`
		VMName        string `json:"vmName"`
		GenerateNewID bool   `json:"generateNewId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V restore payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}

	provider := mgr.GetProvider()
	manifest, err := downloadHypervSnapshotManifest(p.SnapshotID, provider)
	if err != nil {
		return fail("failed to download Hyper-V snapshot manifest: " + err.Error())
	}

	restoreDir, err := os.MkdirTemp(mgr.GetStagingDir(), "breeze-hyperv-restore-*")
	if err != nil {
		return fail("failed to create Hyper-V restore staging dir: " + err.Error())
	}
	defer func() {
		if err := os.RemoveAll(restoreDir); err != nil {
			slog.Warn("failed to clean up Hyper-V restore staging dir", "dir", restoreDir, "error", err.Error())
		}
	}()

	if err := restoreHypervSnapshotFiles(provider, manifest, restoreDir); err != nil {
		return fail("failed to restore Hyper-V snapshot files: " + err.Error())
	}

	importRoot, err := hypervImportRoot(manifest, restoreDir)
	if err != nil {
		return fail("failed to locate Hyper-V import root: " + err.Error())
	}

	result, err := hyperv.ImportVM(importRoot, p.VMName, p.GenerateNewID)
	return marshalResult(result, err)
}

func execHypervCheckpoint(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		VMName       string `json:"vmName"`
		Action       string `json:"action"`
		CheckpointID string `json:"checkpointName"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V checkpoint payload: " + err.Error())
	}
	result, err := hyperv.ManageCheckpoint(p.VMName, p.Action, p.CheckpointID)
	return marshalResult(result, err)
}

func execHypervVMState(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		VMName      string `json:"vmName"`
		TargetState string `json:"targetState"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V VM state payload: " + err.Error())
	}
	result, err := hyperv.ChangeVMState(p.VMName, p.TargetState)
	return marshalResult(result, err)
}

type hypervSnapshotManifest struct {
	ID              string                       `json:"id"`
	VMName          string                       `json:"vmName"`
	Timestamp       time.Time                    `json:"timestamp"`
	ConsistencyType string                       `json:"consistencyType,omitempty"`
	ExportRoot      string                       `json:"exportRoot"`
	Files           []hypervSnapshotManifestFile `json:"files"`
	Size            int64                        `json:"size"`
}

type hypervSnapshotManifestFile struct {
	SourcePath string    `json:"sourcePath"`
	BackupPath string    `json:"backupPath"`
	Size       int64     `json:"size"`
	ModTime    time.Time `json:"modTime,omitempty"`
}

func uploadHypervSnapshotManifest(provider providers.BackupProvider, manifest hypervSnapshotManifest) error {
	tempFile, err := os.CreateTemp("", "hyperv-manifest-*.json")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	encoder := json.NewEncoder(tempFile)
	if err := encoder.Encode(manifest); err != nil {
		_ = tempFile.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := tempFile.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	defer os.Remove(tempPath)

	manifestKey := path.Join("snapshots", manifest.ID, "manifest.json")
	return provider.Upload(tempPath, manifestKey)
}

func downloadHypervSnapshotManifest(snapshotID string, provider providers.BackupProvider) (*hypervSnapshotManifest, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("snapshotId is required")
	}
	tempFile, err := os.CreateTemp("", "hyperv-manifest-*.json")
	if err != nil {
		return nil, err
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, err
	}

	var manifest hypervSnapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	if manifest.ID == "" {
		manifest.ID = snapshotID
	}
	return &manifest, nil
}

func restoreHypervSnapshotFiles(provider providers.BackupProvider, manifest *hypervSnapshotManifest, restoreDir string) error {
	if manifest == nil {
		return fmt.Errorf("manifest is required")
	}
	restoreRoot := filepath.Clean(restoreDir)
	for _, file := range manifest.Files {
		relativePath := filepath.Clean(filepath.FromSlash(file.SourcePath))
		targetPath := filepath.Join(restoreRoot, relativePath)
		cleanTarget := filepath.Clean(targetPath)
		if cleanTarget != restoreRoot && !strings.HasPrefix(cleanTarget, restoreRoot+string(filepath.Separator)) {
			return fmt.Errorf("invalid export path %q", file.SourcePath)
		}
		if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
			return err
		}
		if err := provider.Download(file.BackupPath, cleanTarget); err != nil {
			return err
		}
	}
	return nil
}

func hypervImportRoot(manifest *hypervSnapshotManifest, restoreDir string) (string, error) {
	if manifest == nil {
		return "", fmt.Errorf("manifest is required")
	}
	exportRoot := strings.Trim(strings.TrimSpace(manifest.ExportRoot), "/")
	if exportRoot == "" && len(manifest.Files) > 0 {
		first := filepath.ToSlash(manifest.Files[0].SourcePath)
		if first != "" {
			parts := strings.SplitN(first, "/", 2)
			exportRoot = parts[0]
		}
	}
	if exportRoot == "" {
		return "", fmt.Errorf("manifest export root is missing")
	}
	importRoot := filepath.Join(restoreDir, filepath.FromSlash(exportRoot))
	if _, err := os.Stat(importRoot); err != nil {
		return "", err
	}
	return importRoot, nil
}

func cleanupHypervSnapshot(provider providers.BackupProvider, snapshotID string) {
	items, err := provider.List(path.Join("snapshots", snapshotID))
	if err != nil {
		slog.Warn("failed to list Hyper-V snapshot for cleanup", "snapshotId", snapshotID, "error", err.Error())
		return
	}
	for _, item := range items {
		if err := provider.Delete(item); err != nil {
			slog.Warn("failed to delete Hyper-V snapshot item", "item", item, "error", err.Error())
		}
	}
}

func uploadMssqlSnapshotManifest(provider providers.BackupProvider, snapshot backup.Snapshot) error {
	tempFile, err := os.CreateTemp("", "mssql-manifest-*.json")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	encoder := json.NewEncoder(tempFile)
	if err := encoder.Encode(snapshot); err != nil {
		_ = tempFile.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := tempFile.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	defer os.Remove(tempPath)

	manifestKey := path.Join("snapshots", snapshot.ID, "manifest.json")
	return provider.Upload(tempPath, manifestKey)
}

func downloadMssqlSnapshotManifest(provider providers.BackupProvider, snapshotID string) (*backup.Snapshot, error) {
	if provider == nil {
		return nil, fmt.Errorf("backup provider is required")
	}
	if snapshotID == "" {
		return nil, fmt.Errorf("snapshotId is required")
	}

	tempFile, err := os.CreateTemp("", "mssql-manifest-*.json")
	if err != nil {
		return nil, err
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	defer os.Remove(tempPath)

	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	if err := provider.Download(manifestKey, tempPath); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, err
	}

	var snapshot backup.Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, err
	}
	if snapshot.ID == "" {
		snapshot.ID = snapshotID
	}
	return &snapshot, nil
}

// removeMssqlBackupFile deletes the local .bak/.trn file once execMSSQLBackup
// is done with it, on both the success and upload-failure paths.
//
// D23: RunBackup no longer writes into the staging directory this function
// created (mssql.RunBackup now resolves its own directory that the SQL
// Server service account, not the Breeze helper, can write to), so the
// deferred os.RemoveAll(stagingDir) in execMSSQLBackup no longer reaches
// the real backup file — it would otherwise accumulate forever in SQL
// Server's default backup directory or the ProgramData fallback.
func removeMssqlBackupFile(localPath string) {
	if err := os.Remove(localPath); err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("failed to remove local MSSQL backup file", "file", localPath, "error", err.Error())
		}
		return
	}
	slog.Debug("removed local MSSQL backup file", "file", localPath)
}

func cleanupMssqlSnapshot(provider providers.BackupProvider, snapshotID string) {
	if provider == nil || snapshotID == "" {
		return
	}
	items, err := provider.List(path.Join("snapshots", snapshotID))
	if err != nil {
		slog.Warn("failed to list MSSQL snapshot for cleanup", "snapshotId", snapshotID, "error", err.Error())
		return
	}
	for _, item := range items {
		if err := provider.Delete(item); err != nil {
			slog.Warn("failed to delete MSSQL snapshot item", "item", item, "error", err.Error())
		}
	}
}

func newMssqlSnapshotID(instance, database string) string {
	slug := strings.ToLower(strings.TrimSpace(instance + "-" + database))
	slug = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, slug)
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "db"
	}

	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return fmt.Sprintf("mssql-%s-%d", slug, time.Now().UnixNano())
	}
	return fmt.Sprintf("mssql-%s-%d-%x", slug, time.Now().Unix(), random)
}

// resolveMSSQLBackupArtifact locates the local file RESTORE / RESTORE
// VERIFYONLY should read: either an already-local path the caller supplied
// directly, or a remote artifact downloaded via downloadMSSQLArtifact —
// see that function's doc comment for why the download destination isn't a
// process-local staging directory (D23b).
func resolveMSSQLBackupArtifact(instance string, provider providers.BackupProvider, snapshotID, backupFile string) (string, func(), error) {
	if snapshotID != "" {
		return stageMSSQLSnapshotArtifact(instance, provider, snapshotID)
	}

	trimmed := strings.TrimSpace(backupFile)
	if trimmed == "" {
		return "", nil, fmt.Errorf("backup file path is required")
	}
	if filepath.IsAbs(trimmed) {
		if _, err := os.Stat(trimmed); err == nil {
			return trimmed, nil, nil
		}
	}

	if provider == nil {
		return "", nil, fmt.Errorf("backup provider is required")
	}

	cleaned := path.Clean(filepath.ToSlash(trimmed))
	if snapshotIDFromPath := mssqlSnapshotIDFromArtifactPath(cleaned); snapshotIDFromPath != "" {
		return stageMSSQLSnapshotArtifact(instance, provider, snapshotIDFromPath)
	}

	return downloadMSSQLArtifact(instance, provider, cleaned, filepath.Base(cleaned))
}

func stageMSSQLSnapshotArtifact(instance string, provider providers.BackupProvider, snapshotID string) (string, func(), error) {
	if provider == nil {
		return "", nil, fmt.Errorf("backup provider is required")
	}
	manifest, err := downloadMssqlSnapshotManifest(provider, snapshotID)
	if err != nil {
		return "", nil, err
	}
	if len(manifest.Files) == 0 {
		return "", nil, fmt.Errorf("snapshot %s has no backup files", snapshotID)
	}

	file := manifest.Files[0]
	return downloadMSSQLArtifact(instance, provider, file.BackupPath, filepath.Base(file.BackupPath))
}

// downloadMSSQLArtifact downloads a remote backup artifact into the same
// SQL-Server-writable directory RunBackup writes into (D23b): RESTORE
// DATABASE/LOG and RESTORE VERIFYONLY are executed by the SQL Server
// service account, not the Breeze helper, exactly like BACKUP DATABASE/LOG
// (D23) — so a process-local staging directory (which resolves under
// C:\Windows\SystemTemp when the helper runs as SYSTEM) is the wrong place
// to put the file; the SQL Server service account can't open it there.
//
// The returned cleanup removes only the downloaded file, not a whole
// directory: the resolved directory is either SQL Server's own default
// backup directory or a shared Breeze staging directory, either of which
// other concurrent jobs may also be using.
func downloadMSSQLArtifact(instance string, provider providers.BackupProvider, remotePath, filename string) (string, func(), error) {
	targetDir, err := resolveMSSQLRestoreTargetDir(instance)
	if err != nil {
		return "", nil, fmt.Errorf("resolve restore target directory: %w", err)
	}
	localPath := filepath.Join(targetDir, filename)
	if err := provider.Download(remotePath, localPath); err != nil {
		removeMssqlBackupFile(localPath)
		return "", nil, err
	}

	return localPath, func() {
		removeMssqlBackupFile(localPath)
	}, nil
}

func mssqlSnapshotIDFromArtifactPath(artifactPath string) string {
	cleaned := path.Clean(strings.TrimSpace(artifactPath))
	if !strings.HasPrefix(cleaned, "snapshots/") {
		return ""
	}
	parts := strings.Split(cleaned, "/")
	if len(parts) < 2 || parts[1] == "" {
		return ""
	}
	return parts[1]
}

func newHypervSnapshotID(vmName string) string {
	slug := strings.ToLower(strings.TrimSpace(vmName))
	slug = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, slug)
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "vm"
	}

	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return fmt.Sprintf("hyperv-%s-%d", slug, time.Now().UnixNano())
	}
	return fmt.Sprintf("hyperv-%s-%d-%x", slug, time.Now().Unix(), random)
}

// --- VM restore from backup + instant boot ---

func execVMRestoreFromBackup(parentCtx context.Context, payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
		VMName     string `json:"vmName"`
		MemoryMB   int64  `json:"memoryMb"`
		CPUCount   int    `json:"cpuCount"`
		DiskSizeGB int64  `json:"diskSizeGb"`
		SwitchName string `json:"switchName"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid VM restore payload: " + err.Error())
	}

	cfg := hyperv.VMRestoreFromBackupConfig{
		SnapshotID: p.SnapshotID,
		VMName:     p.VMName,
		MemoryMB:   p.MemoryMB,
		CPUCount:   p.CPUCount,
		DiskSizeGB: p.DiskSizeGB,
		SwitchName: p.SwitchName,
	}

	ctx, cancel := context.WithTimeout(parentCtx, 2*time.Hour)
	defer cancel()

	result, err := hyperv.RestoreAsVM(ctx, cfg, mgr.GetProvider(), nil)
	return marshalResult(result, err)
}

func execInstantBoot(parentCtx context.Context, payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
		VMName     string `json:"vmName"`
		MemoryMB   int64  `json:"memoryMb"`
		CPUCount   int    `json:"cpuCount"`
		DiskSizeGB int64  `json:"diskSizeGb"`
		WorkDir    string `json:"workDir"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid instant boot payload: " + err.Error())
	}

	cfg := hyperv.InstantBootConfig{
		SnapshotID: p.SnapshotID,
		VMName:     p.VMName,
		MemoryMB:   p.MemoryMB,
		CPUCount:   p.CPUCount,
		DiskSizeGB: p.DiskSizeGB,
		WorkDir:    p.WorkDir,
	}

	ctx, cancel := context.WithTimeout(parentCtx, 30*time.Minute)
	defer cancel()

	result, err := hyperv.InstantBoot(ctx, cfg, mgr.GetProvider(), nil)
	return marshalResult(result, err)
}

func execVMRestoreEstimate(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid VM estimate payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}

	// Download just the manifest (lightweight) instead of all snapshot files.
	provider := mgr.GetProvider()
	manifestPath := fmt.Sprintf("snapshots/%s/manifest.json", p.SnapshotID)
	tmpFile, err := os.CreateTemp("", "manifest-*.json")
	if err != nil {
		return fail("failed to create temp file: " + err.Error())
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Close()

	if err := provider.Download(manifestPath, tmpFile.Name()); err != nil {
		return fail("failed to download manifest: " + err.Error())
	}

	data, err := os.ReadFile(tmpFile.Name())
	if err != nil {
		return fail("failed to read manifest: " + err.Error())
	}

	var snapshot backup.Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return fail("failed to parse manifest: " + err.Error())
	}

	totalBytes := snapshot.Size
	diskGB := (totalBytes / (1024 * 1024 * 1024)) * 2 // 2x snapshot size for headroom
	if diskGB < 50 {
		diskGB = 50
	}

	estimate := bmr.VMEstimate{
		RecommendedMemoryMB: 4096,
		RecommendedCPU:      2,
		RequiredDiskGB:      diskGB,
		Platform:            runtime.GOOS,
	}

	return marshalResult(estimate, nil)
}
