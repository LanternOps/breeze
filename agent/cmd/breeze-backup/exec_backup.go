package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
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

var backupRestoreWorkRoot = func() string {
	return filepath.Join(config.GetDataDir(), "backup")
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
	// AccessKeyID/SecretAccessKey: the AWS-idiomatic spelling the API's own
	// S3 config validator and connectivity probe have long accepted
	// (apps/api/src/routes/backup/schemas.ts,
	// services/backupSnapshotStorage.ts) alongside AccessKey/SecretKey. The
	// API now canonicalizes to AccessKey/SecretKey at the config write and
	// dispatch boundaries (#6511), but the agent tolerates both spellings
	// too — see credentials() below — as a cheap second line of defense so
	// a config that somehow bypasses that normalization doesn't silently
	// run every upload with empty credentials.
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	Path            string `json:"path"` // local provider destination
}

// credentials resolves the S3 access key / secret key, preferring the
// canonical accessKey/secretKey spelling and falling back to the
// AWS-idiomatic accessKeyId/secretAccessKey spelling when the canonical
// field is empty. See the AccessKeyID/SecretAccessKey field comments (#6511).
func (c *backupRunProviderConfig) credentials() (accessKey, secretKey string) {
	accessKey = c.AccessKey
	if accessKey == "" {
		accessKey = c.AccessKeyID
	}
	secretKey = c.SecretKey
	if secretKey == "" {
		secretKey = c.SecretAccessKey
	}
	return accessKey, secretKey
}

// defaultVSS decides whether VSS shadow-copy defaults on for a backup_run,
// given the target OS, whether this is a system_image run, and whether that
// run also carries file paths to walk. VSS is a Windows-only feature; it
// stays off for a system_image run with NO paths, which manages its own
// consistency via system-state collection alone. A wholeMachine system_image
// run (#5493) DOES carry paths — it walks the OS root in the same run that
// collects system state — so it needs VSS on Windows the same as a plain
// file-mode run; systemImage alone must not suppress it once paths are
// present. Extracted as a pure function of goos so the OS decision is
// table-testable on EVERY platform — the internal/backup package (and this
// command's VSS-by-default flip) is excluded from the Windows CI job, so a
// runtime.GOOS-only assertion would be vacuous on the Linux runners that
// actually run these tests.
func defaultVSS(goos string, systemImage bool, hasPaths bool) bool {
	return goos == "windows" && (!systemImage || hasPaths)
}

// managerFromBackupRunPayload builds a BackupManager from the backup_run command
// payload's provider + providerConfig + paths. Returns (nil,nil) when the payload
// carries no provider config so the caller falls back to the agent.yaml manager.
// helperAgentID is the enrolled agent id loaded from agent.yaml at startup
// (main.go). It is stamped into every manifest's BackupIdentity so incremental
// dedupe only ever references this device's own previous snapshot (D6).
var helperAgentID string

// helperStagingDir is agent.yaml's backup_staging_dir, resolved at startup by
// resolveBackupStagingDir (main.go). Empty means the OS temp dir. Carried into
// the payload-built managers so the operator's staging override applies to
// policy-managed devices too (#5460) — not only to the agent.yaml manager.
var helperStagingDir string

// resolveBackupStagingDir validates agent.yaml's backup_staging_dir: it
// creates the directory and returns it, or returns "" (the OS temp dir) when
// it is unset or cannot be created.
func resolveBackupStagingDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Error("configured backup staging dir cannot be created, falling back to OS temp dir", "dir", dir, "error", err.Error())
		return ""
	}
	return dir
}

func managerFromBackupRunPayload(payload json.RawMessage) (*backup.BackupManager, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var p struct {
		Provider       string                   `json:"provider"`
		ProviderConfig *backupRunProviderConfig `json:"providerConfig"`
		Paths          []string                 `json:"paths"`
		// Excludes is only consumed here for the wholeMachine system_image
		// branch below. Plain file-mode runs ignore this field on the
		// manager config — their excludes flow through main.go's separate
		// parseBackupRunExcludes + RunBackupContext(ctx, excludes) call,
		// which takes precedence whenever the payload's top-level "excludes"
		// key is present (see RunBackupContext's excludes==nil fallback).
		Excludes    []string `json:"excludes"`
		SystemImage bool     `json:"systemImage"`
		// BaseSnapshotID/PublishLeaseExpiresAt implement the D18 §3.1
		// server-owned-base protocol. BaseSnapshotID's presence in the JSON
		// (vs. entirely absent) is the protocol switch: a *string stays nil
		// when the field is omitted (older server, legacy bucket-listing
		// mode) and becomes non-nil (possibly pointing at "") when present.
		BaseSnapshotID        *string `json:"baseSnapshotId"`
		PublishLeaseExpiresAt string  `json:"publishLeaseExpiresAt"`
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
	var publishLeaseExpiresAt time.Time
	if p.PublishLeaseExpiresAt != "" {
		parsed, parseErr := time.Parse(time.RFC3339, p.PublishLeaseExpiresAt)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid backup_run payload: publishLeaseExpiresAt %q: %w", p.PublishLeaseExpiresAt, parseErr)
		}
		publishLeaseExpiresAt = parsed
	}
	// D18 §3.1 (P1 fix): publishLeaseExpiresAt is sent for EVERY
	// server-owned-mode run — base or an explicit full run — never only
	// when a base was actually chosen. A present baseSnapshotId (server-
	// owned mode is ON, even if it points at "") with a missing, empty, or
	// unparseable-to-zero lease means the dispatching server is violating
	// its own protocol. Reject the WHOLE payload here rather than silently
	// running server-owned mode ungated: main.go's caller turns this error
	// into `fail(err.Error())`, so the backup_run command fails outright
	// and uploads nothing.
	if p.BaseSnapshotID != nil && publishLeaseExpiresAt.IsZero() {
		return nil, fmt.Errorf("invalid backup_run payload: baseSnapshotId is present (server-owned mode) but publishLeaseExpiresAt is missing, empty, or zero")
	}
	// Symmetric defense-in-depth (review finding): the leaseGate installs
	// on BaseSnapshotID != nil alone (backup.go), never on the lease value,
	// so a payload that sent a non-zero lease WITHOUT baseSnapshotId would
	// otherwise silently fall back to fully-unfenced legacy mode instead of
	// getting the publish fence its own lease implies it wants. This can
	// only happen if a dispatching server has a bug (the protocol ties the
	// two together — baseSnapshotId's presence, even as "", IS the
	// server-owned-mode switch per D18 §3.1), but reject it loudly here
	// rather than silently downgrading to legacy/ungated.
	if p.BaseSnapshotID == nil && !publishLeaseExpiresAt.IsZero() {
		return nil, fmt.Errorf("invalid backup_run payload: publishLeaseExpiresAt is present but baseSnapshotId is absent (server-owned mode requires both fields together)")
	}
	// vssEnabled defaults to on for server-dispatched Windows file backups so
	// locked files (open documents, DB files) aren't silently skipped — VSS
	// failure is already non-fatal (backup.go's RunBackupWithExcludes proceeds
	// without it), so this can't newly break Linux/macOS or Windows hosts
	// without VSS. system_image mode manages its own consistency via system
	// state collection, so it stays off there unless the payload overrides it.
	// The server can force it either way via the optional `vss` field (not
	// currently sent by apps/api/src/jobs/backupWorker.ts).
	vssEnabled := defaultVSS(runtime.GOOS, p.SystemImage, len(p.Paths) > 0)
	if p.Vss != nil {
		vssEnabled = *p.Vss
	}
	var provider providers.BackupProvider
	switch p.Provider {
	case "s3":
		accessKey, secretKey := p.ProviderConfig.credentials()
		// #6511: fail loudly here rather than let an S3Provider with empty
		// credentials fall through to the AWS SDK's default credential
		// chain, which is exactly the "upload stalled" symptom (opaque
		// IMDS/DNS timeout, mislabelled by attemptFileUpload) this issue was
		// filed for. This is now a rarer trigger — BOTH spellings missing —
		// since credentials() already covers the common "config saved under
		// the wrong spelling" case, but it's a cheap, direct guard against
		// the same failure mode recurring for any other reason.
		if accessKey == "" || secretKey == "" {
			return nil, fmt.Errorf("s3 backup provider config is missing accessKey/secretKey (and accessKeyId/secretAccessKey)")
		}
		provider = providers.NewS3ProviderWithEndpoint(
			p.ProviderConfig.Bucket, p.ProviderConfig.Region, p.ProviderConfig.Endpoint,
			accessKey, secretKey, "")
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
		cfg := backup.BackupConfig{
			Provider:              provider,
			SystemStateEnabled:    true,
			VSSEnabled:            vssEnabled,
			AgentID:               helperAgentID,
			AgentVersion:          version,
			BaseSnapshotID:        p.BaseSnapshotID,
			PublishLeaseExpiresAt: publishLeaseExpiresAt,
		}
		// #5493: a wholeMachine system_image selection fans out with Paths
		// set (backupWorker.ts resolveBackupTargets), so this run ALSO walks
		// the OS root — one snapshot carrying files + layout.json + system
		// state, instead of the files-less system_image-only snapshot a
		// plain systemImage:true payload (no paths) still produces below.
		if len(p.Paths) > 0 {
			cfg.Paths = p.Paths
			cfg.Excludes = p.Excludes
			// W06: a whole-machine snapshot must carry every file's and
			// directory's NTFS security descriptor, or a bare-metal rebuild
			// lands the OS with inherited ACLs only. No-op off Windows.
			// Plain file-mode backups (below) leave it off.
			cfg.CaptureSecurityDescriptors = true
		}
		return backup.NewBackupManager(cfg), nil
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
		Provider:              provider,
		Paths:                 p.Paths,
		Retention:             0,
		VSSEnabled:            vssEnabled,
		AgentID:               helperAgentID,
		AgentVersion:          version,
		BaseSnapshotID:        p.BaseSnapshotID,
		PublishLeaseExpiresAt: publishLeaseExpiresAt,
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
		accessKey, secretKey := p.ProviderConfig.credentials()
		// #6511: same fail-loud guard as managerFromBackupRunPayload — see
		// its comment for why this must not fall through to the AWS SDK's
		// default credential chain.
		if accessKey == "" || secretKey == "" {
			return nil, fmt.Errorf("s3 backup provider config is missing accessKey/secretKey (and accessKeyId/secretAccessKey)")
		}
		return providers.NewS3ProviderWithEndpoint(
			p.ProviderConfig.Bucket, p.ProviderConfig.Region, p.ProviderConfig.Endpoint,
			accessKey, secretKey, ""), nil
	case "local":
		return providers.NewLocalProvider(p.ProviderConfig.Path), nil
	default:
		return nil, fmt.Errorf("unsupported backup provider %q", p.Provider)
	}
}

// managerFromProviderPayload builds an ephemeral BackupManager carrying only a
// provider (no paths/retention/VSS) from a provider-backed command payload's
// provider + providerConfig, reusing restoreProviderFromPayload's parsing.
//
// D20b item B: mssql_backup/hyperv_backup/hyperv_restore only ever call
// mgr.GetProvider() and mgr.GetStagingDir() (see execMSSQLBackup,
// execHypervRestore, etc.) — never mgr.RunBackupContext — so unlike
// managerFromBackupRunPayload (which requires paths, or systemImage,
// because backup_run actually drives a full backup through the manager)
// this builder needs nothing but a provider — plus agent.yaml's
// backup_staging_dir (helperStagingDir), so a Hyper-V export stages where the
// operator pointed it (#5460). GetStagingDir() on an unset
// StagingDir returns "", and every remaining GetStagingDir()
// caller already passes that straight to os.MkdirTemp, which treats "" as
// "use the OS default temp dir" — so an unset StagingDir here is safe, not
// a bug.
//
// mssql_restore/mssql_verify are the one exception as of D23b:
// resolveMSSQLBackupArtifact no longer touches GetStagingDir() at all — it
// downloads into mssql.ResolveRestoreTargetDir's directory instead, the
// same SQL-Server-writable location RunBackup writes into (D23), since
// RESTORE/RESTORE VERIFYONLY are read by the SQL Server service account,
// not the Breeze helper. This builder is still fine for them: they only
// need mgr.GetProvider().
//
// Returns (nil, nil) when the payload carries no provider config, so the
// caller can produce its own command-specific "not configured" message
// instead of a generic one.
func managerFromProviderPayload(payload json.RawMessage) (*backup.BackupManager, error) {
	provider, err := restoreProviderFromPayload(payload)
	if err != nil {
		return nil, err
	}
	if provider == nil {
		return nil, nil
	}
	return backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		AgentID:    helperAgentID,
		StagingDir: helperStagingDir,
	}), nil
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
		WorkRoot:      backupRestoreWorkRoot(),
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

// verifyRunBudget bounds each backup_verify / backup_test_restore run so it
// reports its partial counts before the agent's forward wait expires (see
// backupipc.VerifyRunBudget, #6598). A var so tests can shorten it.
var verifyRunBudget = backupipc.VerifyRunBudget

// verifyOptions builds the run options for a verify or test restore:
// the run budget, and progress over conn (nil conn = log-only progress).
func verifyOptions(conn *ipc.Conn, commandID, phase string) backup.VerifyOptions {
	var send func(backupipc.BackupProgress)
	if conn != nil {
		send = func(p backupipc.BackupProgress) { sendBackupRunProgress(conn, commandID, p) }
	}
	return backup.VerifyOptions{
		TimeBudget: verifyRunBudget,
		Progress:   newVerifyProgressReporter(send, commandID, phase, verifyProgressInterval, time.Now),
	}
}

func execBackupVerify(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	return execBackupVerifyContext(context.Background(), "", payload, mgr, vaultState, nil)
}

// execBackupVerifyContext runs a backup_verify. When the run budget elapses
// the result is still a successful command whose body carries the partial
// counts and a `partial`/`failed` status — the API reads the verification
// body only from a completed command. conn may be nil.
func execBackupVerifyContext(ctx context.Context, commandID string, payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn) backupipc.BackupCommandResult {
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
	result, err := backup.VerifyIntegrityWithOptions(ctx, restoreProvider, p.SnapshotID,
		verifyOptions(conn, commandID, "verifying"))
	return marshalResult(result, err)
}

func execBackupTestRestore(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	return execBackupTestRestoreContext(context.Background(), "", payload, mgr, vaultState, nil)
}

// execBackupTestRestoreContext runs a backup_test_restore; see
// execBackupVerifyContext for the budget and progress behaviour.
func execBackupTestRestoreContext(ctx context.Context, commandID string, payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn) backupipc.BackupCommandResult {
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
	result, err := backup.TestRestoreWithOptions(ctx, restoreProvider, p.SnapshotID, backupRestoreWorkRoot(),
		verifyOptions(conn, commandID, "test_restore"))
	return marshalResult(result, err)
}

func execBackupCleanup(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		RestorePath string `json:"restorePath"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid cleanup payload: " + err.Error())
	}
	if err := backup.CleanupRestoreDir(p.RestorePath, backupRestoreWorkRoot()); err != nil {
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
