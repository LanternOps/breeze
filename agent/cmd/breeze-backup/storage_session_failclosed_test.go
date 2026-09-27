package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// These tests pin the fail-closed half of the brokered storage-read
// contract: when a restore-shaped command carries a storageSession, the
// helper must use it and nothing else. Every case below arranges a helper
// whose agent.yaml manager (and, where relevant, the payload's legacy
// providerConfig) CAN serve the snapshot, so a helper that silently falls
// back to those sources succeeds — and the test fails.

const testStorageSessionID = "7d3f5a2e-9c41-4b8e-a6d2-1f0e9b8c7a65"

func testStorageSessionToken() string { return strings.Repeat("Q", 43) }

// validStorageSession returns a structurally valid v1 descriptor; mutate
// adjusts it per case.
func validStorageSession(mutate func(map[string]any)) map[string]any {
	now := time.Now().UTC()
	d := map[string]any{
		"version":      1,
		"sessionId":    testStorageSessionID,
		"token":        testStorageSessionToken(),
		"baseUrl":      "https://control-plane.example",
		"expiresAt":    now.Add(10 * time.Minute).Format(time.RFC3339),
		"deadline":     now.Add(1 * time.Hour).Format(time.RFC3339),
		"capabilities": []string{"resolve_batch", "renew"},
		"maxBatch":     100,
	}
	if mutate != nil {
		mutate(d)
	}
	return d
}

// expiredStorageSession is a session whose absolute deadline has passed: it
// must fail the command before any network access and before any fallback.
func expiredStorageSession() map[string]any {
	return validStorageSession(func(d map[string]any) {
		past := time.Now().UTC().Add(-2 * time.Hour)
		d["expiresAt"] = past.Add(-time.Minute).Format(time.RFC3339)
		d["deadline"] = past.Format(time.RFC3339)
	})
}

// seedLocalSnapshot writes a restorable snapshot (manifest + one file per
// entry) into a LocalProvider rooted at dir and returns the provider.
func seedLocalSnapshot(t *testing.T, dir, snapshotID string, files map[string][]byte) *providers.LocalProvider {
	t.Helper()
	provider := providers.NewLocalProvider(dir)
	prefix := path.Join("snapshots", snapshotID)
	manifest := backup.Snapshot{ID: snapshotID, Timestamp: time.Now().UTC()}
	src := t.TempDir()
	for name, data := range files {
		local := filepath.Join(src, name)
		if err := os.WriteFile(local, data, 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		key := path.Join(prefix, "files", name)
		if err := provider.Upload(local, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
		manifest.Files = append(manifest.Files, backup.SnapshotFile{
			SourcePath: "/data/" + name, BackupPath: key, Size: int64(len(data)),
		})
		manifest.Size += int64(len(data))
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestLocal := filepath.Join(src, "manifest.json")
	if err := os.WriteFile(manifestLocal, raw, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := provider.Upload(manifestLocal, path.Join(prefix, "manifest.json")); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
	return provider
}

func sessionPayloadJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func assertStorageSessionFailure(t *testing.T, result backupipc.BackupCommandResult) {
	t.Helper()
	if result.Success {
		t.Fatalf("command succeeded (stdout %q); a storageSession payload must never be served from another storage source", result.Stdout)
	}
	if !strings.Contains(strings.ToLower(result.Stderr), "storage session") {
		t.Fatalf("stderr = %q, want a storage session error", result.Stderr)
	}
}

// TestStorageSession_InvalidDescriptorFailsClosed: every malformed, mixed or
// unsupported descriptor fails the command with a storage session error,
// even though both the agent.yaml manager and the payload's providerConfig
// could serve the snapshot.
func TestStorageSession_InvalidDescriptorFailsClosed(t *testing.T) {
	snapshotID := "snap-session-failclosed"
	storeDir := t.TempDir()
	local := seedLocalSnapshot(t, storeDir, snapshotID, map[string][]byte{"a.txt": []byte("alpha")})
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: local})

	cases := []struct {
		name    string
		payload map[string]any
	}{
		{"both storageSession and providerConfig", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(nil),
			"provider": "local", "providerConfig": map[string]any{"path": storeDir},
		}},
		{"unsupported version", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["version"] = 2 }),
		}},
		{"version missing", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { delete(d, "version") }),
		}},
		{"session id not a uuid", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["sessionId"] = "../../other" }),
		}},
		{"token missing", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["token"] = "" }),
		}},
		{"token too short", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["token"] = "abc" }),
		}},
		{"token outside base64url alphabet", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["token"] = strings.Repeat("a", 42) + "/" }),
		}},
		{"plain http base url", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["baseUrl"] = "http://control-plane.example" }),
		}},
		{"base url with credentials", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["baseUrl"] = "https://user:pw@control-plane.example" }),
		}},
		{"base url with query", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["baseUrl"] = "https://control-plane.example/?x=1" }),
		}},
		{"expiresAt unparseable", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["expiresAt"] = "tomorrow" }),
		}},
		{"expiresAt after deadline", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) {
				d["expiresAt"] = time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
			}),
		}},
		{"deadline passed", map[string]any{
			"snapshotId": snapshotID, "storageSession": expiredStorageSession(),
		}},
		{"resolve capability missing", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["capabilities"] = []string{"renew"} }),
		}},
		{"maxBatch zero", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(func(d map[string]any) { d["maxBatch"] = 0 }),
		}},
		{"non-s3 provider alongside session", map[string]any{
			"snapshotId": snapshotID, "storageSession": validStorageSession(nil), "provider": "local",
		}},
		{"session is not an object", map[string]any{
			"snapshotId": snapshotID, "storageSession": "opaque",
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := sessionPayloadJSON(t, tc.payload)
			result := execBackupVerifyContext(context.Background(), "verify-"+tc.name, payload, mgr, nil, nil)
			assertStorageSessionFailure(t, result)
		})
	}
}

// TestStorageSession_ExpiredSessionNeverFallsBack drives every in-scope
// command with a session whose deadline has passed. Each must fail on the
// session, never reach the agent.yaml manager or the MSSQL runner.
func TestStorageSession_ExpiredSessionNeverFallsBack(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	origResolve := resolveMSSQLRestoreTargetDir
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return t.TempDir(), nil }
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })

	var mssqlCalls int
	origRestore, origVerify := runMSSQLRestore, runMSSQLVerify
	runMSSQLRestore = func(_, _, _ string, _ bool) (*mssql.RestoreResult, error) {
		mssqlCalls++
		return &mssql.RestoreResult{Status: "completed"}, nil
	}
	runMSSQLVerify = func(_, _ string) (*mssql.VerifyResult, error) {
		mssqlCalls++
		return &mssql.VerifyResult{Valid: true}, nil
	}
	t.Cleanup(func() { runMSSQLRestore, runMSSQLVerify = origRestore, origVerify })

	snapshotID := "snap-session-nofallback"
	storeDir := t.TempDir()
	local := seedLocalSnapshot(t, storeDir, snapshotID, map[string][]byte{"db.bak": []byte("bak-bytes")})

	commands := []string{
		"backup_restore", "backup_verify", "backup_test_restore",
		"mssql_restore", "mssql_verify", "hyperv_restore",
		"vm_restore_from_backup", "vm_instant_boot",
	}
	for _, cmd := range commands {
		for _, withMgr := range []bool{true, false} {
			name := cmd + "/nil-manager"
			if withMgr {
				name = cmd + "/agent-config-manager"
			}
			t.Run(name, func(t *testing.T) {
				mssqlCalls = 0
				var mgr *backup.BackupManager
				if withMgr {
					mgr = backup.NewBackupManager(backup.BackupConfig{Provider: local})
				}
				target := t.TempDir()
				payload := sessionPayloadJSON(t, map[string]any{
					"snapshotId":     snapshotID,
					"targetPath":     target,
					"instance":       "MSSQLSERVER",
					"targetDatabase": "Restored",
					"vmName":         "vm-restore-test",
					"storageSession": expiredStorageSession(),
				})
				result := executeCommand(backupipc.BackupCommandRequest{
					CommandID: "cmd-" + cmd, CommandType: cmd, Payload: payload,
				}, mgr, nil, nil, newActiveCommandCanceller())
				assertStorageSessionFailure(t, result)
				if mssqlCalls != 0 {
					t.Fatalf("MSSQL runner was invoked %d times; the command must fail before any restore", mssqlCalls)
				}
				if entries, _ := os.ReadDir(target); len(entries) != 0 {
					t.Fatalf("restore target received %d entries from a fallback source", len(entries))
				}
			})
		}
	}
}

// TestStorageSession_CoreCommandsDirectPathNeverFallBack covers the direct
// (non-queued) dispatch the helper uses for restore/verify/test-restore:
// handleBackupCommand calls these exec functions without executeCommand.
func TestStorageSession_CoreCommandsDirectPathNeverFallBack(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	snapshotID := "snap-session-direct"
	storeDir := t.TempDir()
	local := seedLocalSnapshot(t, storeDir, snapshotID, map[string][]byte{"a.txt": []byte("alpha")})
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: local})
	target := t.TempDir()
	payload := sessionPayloadJSON(t, map[string]any{
		"snapshotId": snapshotID, "targetPath": target, "storageSession": expiredStorageSession(),
	})

	for name, run := range map[string]func() backupipc.BackupCommandResult{
		"restore": func() backupipc.BackupCommandResult {
			return execBackupRestoreWithProgress(context.Background(), "c1", payload, mgr, nil, nil)
		},
		"verify": func() backupipc.BackupCommandResult {
			return execBackupVerifyContext(context.Background(), "c2", payload, mgr, nil, nil)
		},
		"test_restore": func() backupipc.BackupCommandResult {
			return execBackupTestRestoreContext(context.Background(), "c3", payload, mgr, nil, nil)
		},
	} {
		t.Run(name, func(t *testing.T) {
			assertStorageSessionFailure(t, run())
			if entries, _ := os.ReadDir(target); len(entries) != 0 {
				t.Fatalf("restore target received %d entries from a fallback source", len(entries))
			}
		})
	}
}

// TestProtocolInfoFlagReportsBackupReadProtocol: the main agent learns the
// installed helper's brokered-read protocol by running it with
// --protocol-info; the output is one JSON object.
func TestProtocolInfoFlagReportsBackupReadProtocol(t *testing.T) {
	var out bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&out)
	rootCmd.SetArgs([]string{"--protocol-info"})
	t.Cleanup(func() {
		rootCmd.SetArgs(nil)
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
	})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("--protocol-info failed: %v (output %q)", err, out.String())
	}
	var info struct {
		BackupReadProtocolVersion *int `json:"backupReadProtocolVersion"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &info); err != nil {
		t.Fatalf("--protocol-info output %q is not JSON: %v", out.String(), err)
	}
	if info.BackupReadProtocolVersion == nil || *info.BackupReadProtocolVersion != 1 {
		t.Fatalf("backupReadProtocolVersion = %v, want 1", info.BackupReadProtocolVersion)
	}
}
