package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// --- core backup ---

type commandStorageEncryption struct {
	Required     bool   `json:"required"`
	Mode         string `json:"mode"`
	KeyReference string `json:"keyReference"`
}

type sseConfigurableProvider interface {
	SetServerSideEncryption(algorithm, kmsKeyID string)
}

func applyCommandStorageEncryption(provider providers.BackupProvider, payload json.RawMessage) error {
	if len(payload) == 0 {
		return nil
	}

	var p struct {
		StorageEncryption *commandStorageEncryption `json:"storageEncryption"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fmt.Errorf("invalid backup encryption payload: %w", err)
	}
	if p.StorageEncryption == nil || !p.StorageEncryption.Required {
		return nil
	}
	if provider == nil {
		return fmt.Errorf("backup storage encryption is required but backup storage is not configured")
	}

	sseProvider, ok := provider.(sseConfigurableProvider)
	if !ok {
		return fmt.Errorf("backup storage encryption is required but the configured provider cannot enforce it")
	}

	switch p.StorageEncryption.Mode {
	case "s3-sse-s3":
		sseProvider.SetServerSideEncryption("AES256", "")
	case "s3-sse-kms":
		if p.StorageEncryption.KeyReference == "" {
			return fmt.Errorf("backup storage encryption requires a KMS key reference")
		}
		sseProvider.SetServerSideEncryption("aws:kms", p.StorageEncryption.KeyReference)
	default:
		return fmt.Errorf("unsupported backup storage encryption mode %q", p.StorageEncryption.Mode)
	}

	return nil
}

// backupRunProviderConfig mirrors the providerConfig the API sends in a backup
// command payload (apps/api/src/jobs/backupWorker.ts). Creds arrive plaintext.
type backupRunProviderConfig struct {
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	Endpoint  string `json:"endpoint"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
	Path      string `json:"path"` // local provider destination
}

// defaultVSS decides whether VSS shadow-copy defaults on for a backup_run,
// given the target OS and whether this is a system_image run. VSS is a
// Windows-only feature; it stays off for system_image mode, which manages its
// own consistency via system-state collection. Extracted as a pure function of
// goos so the OS decision is table-testable on EVERY platform — the
// internal/backup package (and this command's VSS-by-default flip) is excluded
// from the Windows CI job, so a runtime.GOOS-only assertion would be vacuous on
// the Linux runners that actually run these tests.
func defaultVSS(goos string, systemImage bool) bool {
	return goos == "windows" && !systemImage
}

// managerFromBackupRunPayload builds a BackupManager from the backup_run command
// payload's provider + providerConfig + paths. Returns (nil,nil) when the payload
// carries no provider config so the caller falls back to the agent.yaml manager.
func managerFromBackupRunPayload(payload json.RawMessage) (*backup.BackupManager, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var p struct {
		Provider       string                   `json:"provider"`
		ProviderConfig *backupRunProviderConfig `json:"providerConfig"`
		Paths          []string                 `json:"paths"`
		SystemImage    bool                     `json:"systemImage"`
		// Vss lets the server force VSS on/off for this run. Not currently sent
		// by apps/api/src/jobs/backupWorker.ts (a future policy toggle can); when
		// absent the agent defaults it itself below.
		Vss *bool `json:"vss,omitempty"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("invalid backup_run payload: %w", err)
	}
	if p.ProviderConfig == nil || p.Provider == "" {
		return nil, nil
	}
	// vssEnabled defaults to on for server-dispatched Windows file backups so
	// locked files (open documents, DB files) aren't silently skipped — VSS
	// failure is already non-fatal (backup.go's RunBackupWithExcludes proceeds
	// without it), so this can't newly break Linux/macOS or Windows hosts
	// without VSS. system_image mode manages its own consistency via system
	// state collection, so it stays off there unless the payload overrides it.
	// The server can force it either way via the optional `vss` field (not
	// currently sent by apps/api/src/jobs/backupWorker.ts).
	vssEnabled := defaultVSS(runtime.GOOS, p.SystemImage)
	if p.Vss != nil {
		vssEnabled = *p.Vss
	}
	var provider providers.BackupProvider
	switch p.Provider {
	case "s3":
		provider = providers.NewS3ProviderWithEndpoint(
			p.ProviderConfig.Bucket, p.ProviderConfig.Region, p.ProviderConfig.Endpoint,
			p.ProviderConfig.AccessKey, p.ProviderConfig.SecretKey, "")
	case "local":
		provider = providers.NewLocalProvider(p.ProviderConfig.Path)
	default:
		return nil, fmt.Errorf("unsupported backup provider %q", p.Provider)
	}
	// system_image mode carries no file paths: the backup content is the
	// collected system-state staging dir. The server fans a `system_image`
	// selection out as a backup_run with `systemImage:true` and no `paths`
	// (backupWorker.ts resolveBackupTargets), so enable system-state collection
	// and skip the file-paths requirement below.
	if p.SystemImage {
		// BackupConfig.Retention is left at its zero value (0) — same
		// server-owns-retention invariant as the file-mode path below (which
		// sets it explicitly): the agent must never prune remote storage itself
		// and race the server's GFS/legal-hold/immutability authority.
		return backup.NewBackupManager(backup.BackupConfig{
			Provider:           provider,
			SystemStateEnabled: true,
			VSSEnabled:         vssEnabled,
		}), nil
	}
	if len(p.Paths) == 0 {
		return nil, fmt.Errorf("backup_run payload has no paths")
	}
	// Retention is owned entirely by the server: GFS tiering, legal-hold and
	// object-immutability live in apps/api/src/jobs/backupRetention.ts, and the
	// backup_run payload carries no retention field. The agent MUST NOT prune —
	// BackupManager.Backup would otherwise call DeleteSnapshotContext and delete
	// objects directly from S3/B2/local storage, racing the server's authority.
	// Retention: 0 makes DeleteSnapshotContext a no-op (it returns early on
	// retention <= 0), leaving the server as the sole retention authority.
	return backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		Paths:      p.Paths,
		Retention:  0,
		VSSEnabled: vssEnabled,
	}), nil
}

// parseBackupRunExcludes extracts file-exclusion glob patterns from a
// backup_run command payload (#2418). Returns nil when the payload omits the
// field so locally-configured excludes still apply; a server that sends an
// explicit empty list disables exclusions for the run. Unknown payload fields
// are ignored (encoding/json), so older servers and newer agents interoperate.
func parseBackupRunExcludes(payload json.RawMessage) ([]string, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var p struct {
		Excludes []string `json:"excludes"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("invalid backup payload: %w", err)
	}
	return p.Excludes, nil
}

// restoreProviderFromPayload builds a BackupProvider directly from a restore/
// verify/test-restore command payload's provider + providerConfig, mirroring
// managerFromBackupRunPayload's parsing. Returns (nil, nil) when the payload
// carries no provider config so callers fall back to resolveRestoreProvider.
func restoreProviderFromPayload(payload json.RawMessage) (providers.BackupProvider, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var p struct {
		Provider       string                   `json:"provider"`
		ProviderConfig *backupRunProviderConfig `json:"providerConfig"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("invalid backup restore payload: %w", err)
	}
	if p.ProviderConfig == nil || p.Provider == "" {
		return nil, nil
	}
	switch p.Provider {
	case "s3":
		return providers.NewS3ProviderWithEndpoint(
			p.ProviderConfig.Bucket, p.ProviderConfig.Region, p.ProviderConfig.Endpoint,
			p.ProviderConfig.AccessKey, p.ProviderConfig.SecretKey, ""), nil
	case "local":
		return providers.NewLocalProvider(p.ProviderConfig.Path), nil
	default:
		return nil, fmt.Errorf("unsupported backup provider %q", p.Provider)
	}
}

// restoreProviderForCommand resolves the provider to use for restore/verify/
// test-restore commands. The payload's provider+providerConfig (sent by the
// API, mirroring backup_run) takes precedence over the agent.yaml-configured
// manager, since mgr is empty on most real agents. Vault fallback is
// preserved: when a vault provider is configured it still wraps the resolved
// primary via NewFallbackProvider, whether the primary came from the payload
// or from mgr.
func restoreProviderForCommand(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) (providers.BackupProvider, error) {
	payloadProvider, err := restoreProviderFromPayload(payload)
	if err != nil {
		return nil, err
	}
	if payloadProvider == nil {
		return resolveRestoreProvider(mgr, vaultState), nil
	}
	if vaultState != nil {
		if vaultMgr := vaultState.Get(); vaultMgr != nil {
			if vaultProvider := vaultMgr.GetProvider(); vaultProvider != nil {
				return providers.NewFallbackProvider(vaultProvider, payloadProvider), nil
			}
		}
	}
	return payloadProvider, nil
}

func resolveRestoreProvider(mgr *backup.BackupManager, vaultState *vaultManagerRef) providers.BackupProvider {
	if mgr == nil {
		return nil
	}
	primary := mgr.GetProvider()
	if primary == nil {
		return nil
	}
	if vaultState == nil {
		return primary
	}
	vaultMgr := vaultState.Get()
	if vaultMgr == nil {
		return primary
	}
	vaultProvider := vaultMgr.GetProvider()
	if vaultProvider == nil {
		return primary
	}
	return providers.NewFallbackProvider(vaultProvider, primary)
}

func execBackupRestore(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	return execBackupRestoreWithProgress(context.Background(), "", payload, mgr, vaultState, nil)
}

func execBackupRestoreWithProgress(ctx context.Context, commandID string, payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn) backupipc.BackupCommandResult {
	restoreProvider, err := restoreProviderForCommand(payload, mgr, vaultState)
	if err != nil {
		return fail(err.Error())
	}
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}

	var p struct {
		CommandID     string   `json:"commandId"`
		SnapshotID    string   `json:"snapshotId"`
		TargetPath    string   `json:"targetPath"`
		SelectedPaths []string `json:"selectedPaths"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid restore payload: " + err.Error())
	}

	cfg := backup.RestoreConfig{
		SnapshotID:    p.SnapshotID,
		TargetPath:    p.TargetPath,
		SelectedPaths: p.SelectedPaths,
	}

	var progressFn backup.ProgressFunc
	if conn != nil {
		cmdID := commandID
		if cmdID == "" {
			cmdID = p.CommandID
		}
		progressFn = func(phase string, current, total int64, message string) {
			progress := backupipc.BackupProgress{
				CommandID: cmdID,
				Phase:     phase,
				Current:   current,
				Total:     total,
				Message:   message,
			}
			if err := conn.SendTyped("", backupipc.TypeBackupProgress, progress); err != nil {
				slog.Warn("failed to send restore progress", "error", err.Error())
			}
		}
	}

	result, err := backup.RestoreFromSnapshotContext(ctx, restoreProvider, cfg, progressFn)
	return marshalRestoreResult(result, err)
}

func execBackupVerify(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	restoreProvider, err := restoreProviderForCommand(payload, mgr, vaultState)
	if err != nil {
		return fail(err.Error())
	}
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid verify payload: " + err.Error())
	}
	result, err := backup.VerifyIntegrity(restoreProvider, p.SnapshotID)
	return marshalResult(result, err)
}

func execBackupTestRestore(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	restoreProvider, err := restoreProviderForCommand(payload, mgr, vaultState)
	if err != nil {
		return fail(err.Error())
	}
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid test restore payload: " + err.Error())
	}
	result, err := backup.TestRestore(restoreProvider, p.SnapshotID, nil)
	return marshalResult(result, err)
}

func execBackupCleanup(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		RestorePath string `json:"restorePath"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid cleanup payload: " + err.Error())
	}
	if err := backup.CleanupRestoreDir(p.RestorePath); err != nil {
		return fail(err.Error())
	}
	return ok(`{"cleaned":true}`)
}

func marshalRestoreResult(result *backup.RestoreResult, err error) backupipc.BackupCommandResult {
	if err != nil {
		return marshalResult(result, err)
	}
	if result == nil || result.Status == "completed" {
		return marshalResult(result, nil)
	}

	data, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return fail(fmt.Sprintf("failed to marshal restore result: %v", marshalErr))
	}

	msg := "restore failed"
	if result.Status == "partial" {
		msg = "restore completed partially"
	}
	return backupipc.BackupCommandResult{
		Success: false,
		Stdout:  string(data),
		Stderr:  msg,
	}
}

// --- VSS ---

func execVSS(cmdType string) backupipc.BackupCommandResult {
	provider := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writers, err := provider.ListWriters(ctx)
	if err != nil {
		return fail(err.Error())
	}

	if cmdType == "vss_status" {
		healthy := true
		for _, w := range writers {
			if w.State != "stable" {
				healthy = false
				break
			}
		}
		return marshalResult(map[string]any{"writers": writers, "healthy": healthy, "count": len(writers)}, nil)
	}
	return marshalResult(writers, nil)
}

// --- system state & BMR ---

func execSystemStateCollect() backupipc.BackupCommandResult {
	manifest, stagingDir, err := systemstate.CollectSystemState()
	if err != nil {
		return fail(err.Error())
	}
	return marshalResult(map[string]any{"manifest": manifest, "stagingDir": stagingDir, "artifacts": len(manifest.Artifacts)}, nil)
}

func execHardwareProfile() backupipc.BackupCommandResult {
	profile, err := systemstate.CollectHardwareOnly()
	return marshalResult(profile, err)
}

func execBMRRecover(ctx context.Context, payload json.RawMessage, _ *backup.BackupManager) backupipc.BackupCommandResult {
	var cfg bmr.RecoveryConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return fail("invalid BMR config: " + err.Error())
	}
	if cfg.RecoveryToken == "" || cfg.ServerURL == "" {
		return fail("bmr recovery requires recoveryToken and serverUrl")
	}
	result, err := runBMRRecovery(ctx, cfg)
	return marshalResult(result, err)
}
