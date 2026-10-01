package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/storagesession"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/mtls"
)

// brokeredReadCommands are the restore-shaped commands whose storage reads
// may be brokered through a storage session instead of reusable storage
// credentials. When one of them carries a storageSession, the session is the
// ONLY storage source: no agent.yaml manager, no vault, no providerConfig.
var brokeredReadCommands = map[string]bool{
	"backup_restore":         true,
	"backup_verify":          true,
	"backup_test_restore":    true,
	"mssql_restore":          true,
	"mssql_verify":           true,
	"hyperv_restore":         true,
	"vm_restore_from_backup": true,
	"vm_instant_boot":        true,
}

// brokeredWriteCommands are the backups whose storage writes may be brokered
// through a write-scoped storage session. When one of them carries a
// storageSession, the session is the ONLY storage destination: no agent.yaml
// manager, no vault, no providerConfig.
var brokeredWriteCommands = map[string]bool{
	"backup_run":    true,
	"mssql_backup":  true,
	"hyperv_backup": true,
}

// printProtocolInfo writes the protocol versions this helper implements as a
// single JSON object (breeze-backup --protocol-info). The main agent reads it
// from the installed binary and reports it in its heartbeat.
func printProtocolInfo(w io.Writer) error {
	return json.NewEncoder(w).Encode(backupipc.ProtocolInfo{
		BackupReadProtocolVersion:      storagesession.ProtocolVersion,
		BackupIntegrityProtocolVersion: backup.IntegrityProtocolVersion,
		BackupWriteProtocolVersion:     storagesession.WriteProtocolVersion,
	})
}

// loadStorageSessionCredentials returns the agent identity used to
// authenticate storage-session calls. Loaded per command (not cached at
// startup) so a rotated agent credential or a promoted control-plane URL is
// picked up. A seam for tests.
var loadStorageSessionCredentials = func() (storagesession.Credentials, error) {
	cfg, err := config.Load("")
	if err != nil {
		return storagesession.Credentials{}, fmt.Errorf("storage session: load agent configuration: %w", err)
	}
	origins := []string{cfg.ServerURL}
	if cfg.BackupServerURL != "" {
		origins = append(origins, cfg.BackupServerURL)
	}
	if persisted, perr := config.PersistedServerURL(""); perr == nil && persisted != "" {
		origins = append(origins, persisted)
	}
	clientTLS, tlsErr := mtls.BuildTLSConfig(cfg.MtlsCertPEM, cfg.MtlsKeyPEM)
	if tlsErr != nil {
		slog.Warn("storage session: agent client certificate unusable; continuing without it", "error", tlsErr.Error())
		clientTLS = nil
	}
	return storagesession.Credentials{
		AgentID:             cfg.AgentID,
		AgentToken:          cfg.AuthToken,
		ControlPlaneOrigins: origins,
		ClientTLS:           clientTLS,
	}, nil
}

// storageSessionOptions tunes the provider; tests inject TLS-trusting
// clients here.
var storageSessionOptions storagesession.Options

// storageSessionProvider builds the brokered read provider when payload
// carries a storageSession. It returns (nil, nil) when there is no session.
// Every error must fail the command: the caller never falls back.
func storageSessionProvider(ctx context.Context, payload json.RawMessage) (*storagesession.Provider, error) {
	descriptor, err := storagesession.ParsePayload(payload, time.Now())
	if err != nil || descriptor == nil {
		return nil, err
	}
	creds, err := loadStorageSessionCredentials()
	if err != nil {
		return nil, err
	}
	return storagesession.New(ctx, descriptor, creds, storageSessionOptions)
}

// executeBrokeredRead runs an in-scope command whose payload carries a
// storageSession. handled is false when the payload has no session, in which
// case the caller keeps its legacy routing.
func executeBrokeredRead(req backupipc.BackupCommandRequest, mgr *backup.BackupManager, conn *ipc.Conn, commandCanceller *activeCommandCanceller) (result backupipc.BackupCommandResult, handled bool) {
	descriptor, err := storagesession.ParsePayload(req.Payload, time.Now())
	if err != nil {
		return fail(err.Error()), true
	}
	if descriptor == nil {
		return backupipc.BackupCommandResult{}, false
	}
	if err := descriptor.ValidateFor(storagesession.CommandClassRead); err != nil {
		return fail(err.Error()), true
	}
	ctx, cleanup := commandCanceller.track(req.CommandID)
	defer cleanup()

	// The core commands resolve their provider themselves (and see the same
	// session); they get no manager and no vault so nothing else can serve
	// them.
	switch req.CommandType {
	case "backup_restore":
		return execBackupRestoreWithProgress(ctx, req.CommandID, req.Payload, nil, nil, conn), true
	case "backup_verify":
		return execBackupVerifyContext(ctx, req.CommandID, req.Payload, nil, nil, conn), true
	case "backup_test_restore":
		return execBackupTestRestoreContext(ctx, req.CommandID, req.Payload, nil, nil, conn), true
	}

	provider, err := storageSessionProvider(ctx, req.Payload)
	if err != nil {
		return fail(err.Error()), true
	}
	defer provider.Close()
	var stagingDir string
	if mgr != nil {
		stagingDir = mgr.GetStagingDir()
	}
	brokered := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		AgentID:    helperAgentID,
		StagingDir: stagingDir,
	})

	switch req.CommandType {
	case "mssql_restore":
		return execMSSQLRestore(req.Payload, brokered), true
	case "mssql_verify":
		return execMSSQLVerify(req.Payload, brokered), true
	case "hyperv_restore":
		return execHypervRestore(req.Payload, brokered), true
	case "vm_restore_from_backup":
		return execVMRestoreFromBackup(ctx, req.Payload, brokered), true
	case "vm_instant_boot":
		return execInstantBoot(ctx, req.Payload, brokered), true
	}
	return fail(fmt.Sprintf("storage session: command %s is not a brokered read", req.CommandType)), true
}

// executeBrokeredWrite runs a backup whose payload carries a storageSession.
// handled is false when the payload has no session, in which case the caller
// keeps its legacy routing. With a session every problem fails the command:
// the session must be write-scoped, and nothing else (agent.yaml storage, a
// vault, a payload providerConfig) is ever read or written instead — the
// vault auto-sync after a backup does not run.
func executeBrokeredWrite(req backupipc.BackupCommandRequest, conn *ipc.Conn, commandCanceller *activeCommandCanceller) (result backupipc.BackupCommandResult, handled bool) {
	descriptor, err := storagesession.ParsePayload(req.Payload, time.Now())
	if err != nil {
		return fail(err.Error()), true
	}
	if descriptor == nil {
		return backupipc.BackupCommandResult{}, false
	}
	if err := descriptor.ValidateFor(storagesession.CommandClassWrite); err != nil {
		return fail(err.Error()), true
	}
	var ids struct {
		ConfigID string `json:"configId"`
	}
	_ = json.Unmarshal(req.Payload, &ids)

	ctx, cleanup := commandCanceller.track(req.CommandID)
	defer cleanup()
	creds, err := loadStorageSessionCredentials()
	if err != nil {
		return fail(err.Error()), true
	}
	opts := storageSessionOptions
	opts.IdentityHint = ids.ConfigID
	provider, err := storagesession.NewWriteProvider(ctx, descriptor, creds, opts)
	if err != nil {
		return fail(err.Error()), true
	}
	defer provider.Close()

	switch req.CommandType {
	case "backup_run":
		if err := applyCommandStorageEncryption(provider, req.Payload); err != nil {
			return fail(err.Error()), true
		}
		runMgr, err := brokeredBackupRunManager(req.Payload, provider)
		if err != nil {
			return fail(err.Error()), true
		}
		// No vault sync: it reads the snapshot back through the agent.yaml
		// storage, which a brokered backup never uses.
		return runBackupRunCommand(ctx, req, runMgr, nil, conn), true
	case "mssql_backup", "hyperv_backup":
		// An earlier writer of this snapshot (a redelivered job) is waited
		// out once, before the export; the uploads themselves do not wait.
		if err := provider.AwaitWriteAccess(ctx); err != nil {
			return fail(fmt.Sprintf("storage session: the snapshot cannot be written yet: %v", err)), true
		}
		brokered := backup.NewBackupManager(backup.BackupConfig{
			Provider:   provider,
			AgentID:    helperAgentID,
			StagingDir: helperStagingDir,
		})
		if req.CommandType == "mssql_backup" {
			return execMSSQLBackup(req.Payload, brokered), true
		}
		return execHypervBackup(req.Payload, brokered), true
	}
	return fail(fmt.Sprintf("storage session: command %s is not a brokered write", req.CommandType)), true
}

// backupSnapshotID is the snapshot id a backup writing through provider
// uses: the one the control plane issued to a brokered writer, otherwise a
// freshly minted one.
func backupSnapshotID(provider providers.BackupProvider, mint func() string) string {
	if issuer, ok := provider.(providers.SnapshotIDIssuer); ok {
		return issuer.SnapshotID()
	}
	return mint()
}

func isBrokeredProvider(provider providers.BackupProvider) bool {
	_, ok := provider.(*storagesession.Provider)
	return ok
}

// resolveBrokeredMSSQLArtifact is resolveMSSQLBackupArtifact for a storage
// session. The artifact must come from a canonical snapshot: the snapshot's
// manifest names exactly one backup file stored under that snapshot's own
// files/ prefix. A remote backupFile path is never accepted; an explicit,
// existing local file is still honoured (not with an integrity
// expectation: then the file always comes from the snapshot and is checked
// against its manifest entry before its path is returned).
func resolveBrokeredMSSQLArtifact(instance string, provider providers.BackupProvider, snapshotID, backupFile string, expect *integrity.Expectation) (string, func(), []string, error) {
	if snapshotID == "" {
		trimmed := strings.TrimSpace(backupFile)
		if trimmed != "" && filepath.IsAbs(trimmed) && !expect.Present() {
			if info, err := os.Stat(trimmed); err == nil && info.Mode().IsRegular() {
				return trimmed, nil, nil, nil
			}
		}
		return "", nil, nil, fmt.Errorf("storage session: MSSQL restore through a storage session requires snapshotId; a remote backupFile path is not accepted")
	}
	if snapshotID == "." || snapshotID == ".." || strings.ContainsAny(snapshotID, `/\`) {
		return "", nil, nil, fmt.Errorf("storage session: snapshotId must be a single path component")
	}
	manifest, warnings, err := downloadMssqlSnapshotManifest(provider, snapshotID, expect)
	if err != nil {
		return "", nil, nil, err
	}
	if len(manifest.Files) != 1 {
		return "", nil, nil, fmt.Errorf("storage session: MSSQL snapshot %s must list exactly one backup file, found %d", snapshotID, len(manifest.Files))
	}
	key := manifest.Files[0].BackupPath
	prefix := path.Join("snapshots", snapshotID, "files") + "/"
	name, ok := strings.CutPrefix(key, prefix)
	if !ok || name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || filepath.Base(name) != name {
		return "", nil, nil, fmt.Errorf("storage session: MSSQL snapshot %s names a backup file outside its own snapshot", snapshotID)
	}
	artifact, cleanup, fileWarnings, err := downloadMSSQLArtifact(instance, provider, key, name, mssqlStored(manifest.Files[0]), expect)
	if err != nil {
		return "", nil, nil, err
	}
	return artifact, cleanup, append(warnings, fileWarnings...), nil
}
