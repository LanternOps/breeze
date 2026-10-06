package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/storagesession"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

const wiringAgentID = "agent-wiring-1"

// brokeredEnv is a fake control plane + fake object storage, both TLS, wired
// into the helper's storage-session seams.
type brokeredEnv struct {
	t       *testing.T
	api     *httptest.Server
	storage *httptest.Server

	mu             sync.Mutex
	objects        map[string][]byte
	resolvedKeys   []string
	storageHeaders []http.Header
}

func newBrokeredEnv(t *testing.T) *brokeredEnv {
	t.Helper()
	e := &brokeredEnv{t: t, objects: map[string][]byte{}}
	e.storage = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		e.storageHeaders = append(e.storageHeaders, r.Header.Clone())
		data, ok := e.objects[r.URL.Query().Get("k")]
		e.mu.Unlock()
		if !ok {
			http.Error(w, "NoSuchKey", http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(e.storage.Close)
	base := "/api/v1/agents/" + wiringAgentID + "/storage-sessions/" + testStorageSessionID
	e.api = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer brz_wiring" || r.Header.Get(storagesession.SessionHeader) != testStorageSessionToken() {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.EscapedPath() {
		case base + "/renew":
			_ = json.NewEncoder(w).Encode(map[string]string{"expiresAt": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)})
		case base + "/objects:resolve":
			var body struct {
				Keys []string `json:"keys"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			type obj struct {
				Key       string            `json:"key"`
				Method    string            `json:"method"`
				URL       string            `json:"url"`
				Headers   map[string]string `json:"headers"`
				ExpiresAt string            `json:"expiresAt"`
			}
			resp := struct {
				Objects []obj    `json:"objects"`
				Denied  []string `json:"denied"`
			}{Objects: []obj{}, Denied: []string{}}
			e.mu.Lock()
			e.resolvedKeys = append(e.resolvedKeys, body.Keys...)
			e.mu.Unlock()
			for _, k := range body.Keys {
				resp.Objects = append(resp.Objects, obj{
					Key: k, Method: "GET", URL: e.storage.URL + "/o?k=" + url.QueryEscape(k),
					Headers: map[string]string{}, ExpiresAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339),
				})
			}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	t.Cleanup(e.api.Close)

	origCreds, origOpts := loadStorageSessionCredentials, storageSessionOptions
	loadStorageSessionCredentials = func() (storagesession.Credentials, error) {
		return storagesession.Credentials{
			AgentID: wiringAgentID, AgentToken: "brz_wiring", ControlPlaneOrigins: []string{e.api.URL},
		}, nil
	}
	storageSessionOptions = storagesession.Options{ControlClient: e.api.Client(), StorageClient: e.storage.Client()}
	t.Cleanup(func() { loadStorageSessionCredentials, storageSessionOptions = origCreds, origOpts })
	return e
}

func (e *brokeredEnv) put(key string, data []byte) {
	e.mu.Lock()
	e.objects[key] = data
	e.mu.Unlock()
}

func (e *brokeredEnv) putJSON(key string, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		e.t.Fatal(err)
	}
	e.put(key, raw)
}

func (e *brokeredEnv) session() map[string]any {
	return validStorageSession(func(d map[string]any) { d["baseUrl"] = e.api.URL })
}

func (e *brokeredEnv) resolved() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.resolvedKeys...)
}

// assertStorageNeverSawCredentials: object storage must never receive the
// session token, the agent credential or a cookie.
func (e *brokeredEnv) assertStorageNeverSawCredentials() {
	e.t.Helper()
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.storageHeaders) == 0 {
		e.t.Fatal("object storage was never contacted")
	}
	for _, h := range e.storageHeaders {
		if h.Get(storagesession.SessionHeader) != "" || h.Get("Authorization") != "" || h.Get("Cookie") != "" {
			e.t.Fatalf("storage request carried credentials: %v", h)
		}
	}
}

// seedBrokeredSnapshot places a file snapshot in the fake storage.
func (e *brokeredEnv) seedBrokeredSnapshot(snapshotID string, files map[string][]byte) {
	prefix := path.Join("snapshots", snapshotID)
	manifest := backup.Snapshot{ID: snapshotID, Timestamp: time.Now().UTC()}
	for name, data := range files {
		key := path.Join(prefix, "files", name)
		e.put(key, data)
		manifest.Files = append(manifest.Files, backup.SnapshotFile{
			SourcePath: "/data/" + name, BackupPath: key, Size: int64(len(data)),
		})
		manifest.Size += int64(len(data))
	}
	e.putJSON(path.Join(prefix, "manifest.json"), manifest)
}

// decoyManager is an agent.yaml manager holding DIFFERENT bytes for the same
// snapshot, so a result sourced from it is detectable.
func decoyManager(t *testing.T, snapshotID string, files map[string][]byte) *backup.BackupManager {
	t.Helper()
	decoy := map[string][]byte{}
	for name := range files {
		decoy[name] = []byte("decoy-from-agent-config")
	}
	return backup.NewBackupManager(backup.BackupConfig{Provider: seedLocalSnapshot(t, t.TempDir(), snapshotID, decoy)})
}

func TestStorageSessionWiring_CoreCommands(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	snapshotID := "snap-brokered-core"
	files := map[string][]byte{"a.txt": []byte("brokered-alpha"), "b.txt": []byte("brokered-beta")}

	type runner func(e *brokeredEnv, mgr *backup.BackupManager, payload json.RawMessage) backupipc.BackupCommandResult
	viaExecute := func(cmd string) runner {
		return func(_ *brokeredEnv, mgr *backup.BackupManager, payload json.RawMessage) backupipc.BackupCommandResult {
			return executeCommand(backupipc.BackupCommandRequest{CommandID: "c-" + cmd, CommandType: cmd, Payload: payload},
				mgr, &vaultManagerRef{}, nil, newActiveCommandCanceller())
		}
	}
	cases := []struct {
		name  string
		run   runner
		check func(t *testing.T, result backupipc.BackupCommandResult, target string)
	}{
		{"restore direct", func(_ *brokeredEnv, mgr *backup.BackupManager, payload json.RawMessage) backupipc.BackupCommandResult {
			return execBackupRestoreWithProgress(context.Background(), "c1", payload, mgr, &vaultManagerRef{}, nil)
		}, checkRestored(files)},
		{"restore via dispatcher", viaExecute("backup_restore"), checkRestored(files)},
		{"verify direct", func(_ *brokeredEnv, mgr *backup.BackupManager, payload json.RawMessage) backupipc.BackupCommandResult {
			return execBackupVerifyContext(context.Background(), "c2", payload, mgr, &vaultManagerRef{}, nil)
		}, checkStatus("passed")},
		{"verify via dispatcher", viaExecute("backup_verify"), checkStatus("passed")},
		{"test restore direct", func(_ *brokeredEnv, mgr *backup.BackupManager, payload json.RawMessage) backupipc.BackupCommandResult {
			return execBackupTestRestoreContext(context.Background(), "c3", payload, mgr, &vaultManagerRef{}, nil)
		}, checkStatus("passed")},
		{"test restore via dispatcher", viaExecute("backup_test_restore"), checkStatus("passed")},
	}
	for _, tc := range cases {
		for _, withMgr := range []bool{true, false} {
			name := tc.name + "/nil-manager"
			if withMgr {
				name = tc.name + "/agent-config-manager"
			}
			t.Run(name, func(t *testing.T) {
				e := newBrokeredEnv(t)
				e.seedBrokeredSnapshot(snapshotID, files)
				var mgr *backup.BackupManager
				if withMgr {
					mgr = decoyManager(t, snapshotID, files)
				}
				target := t.TempDir()
				payload := sessionPayloadJSON(t, map[string]any{
					"snapshotId": snapshotID, "targetPath": target, "storageSession": e.session(),
				})
				result := tc.run(e, mgr, payload)
				if !result.Success {
					t.Fatalf("command failed: %q", result.Stderr)
				}
				tc.check(t, result, target)
				e.assertStorageNeverSawCredentials()
				if len(e.resolved()) == 0 {
					t.Fatal("no object was resolved through the session")
				}
			})
		}
	}
}

func checkRestored(files map[string][]byte) func(t *testing.T, _ backupipc.BackupCommandResult, target string) {
	return func(t *testing.T, _ backupipc.BackupCommandResult, target string) {
		t.Helper()
		for name, want := range files {
			got, err := os.ReadFile(filepath.Join(target, "data", name))
			if err != nil {
				t.Fatalf("restored %s: %v", name, err)
			}
			if string(got) != string(want) {
				t.Fatalf("restored %s = %q, want the brokered bytes %q", name, got, want)
			}
		}
	}
}

func checkStatus(want string) func(t *testing.T, result backupipc.BackupCommandResult, _ string) {
	return func(t *testing.T, result backupipc.BackupCommandResult, _ string) {
		t.Helper()
		var body struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &body); err != nil {
			t.Fatalf("result body %q: %v", result.Stdout, err)
		}
		if body.Status != want {
			t.Fatalf("status = %q, want %q (body %s)", body.Status, want, result.Stdout)
		}
	}
}

// TestStorageSessionWiring_PlanBatchesRestore: a restore resolves the
// manifest, then the planned files in batches rather than one call per file.
// The restore downloads concurrently (#5623), so the first few downloads may
// each open a batch before one covers the rest; the invariants are that no
// key is resolved twice and the call count stays far below one per file.
func TestStorageSessionWiring_PlanBatchesRestore(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })
	e := newBrokeredEnv(t)
	const n = 40
	files := map[string][]byte{}
	for i := 0; i < n; i++ {
		files[fmt.Sprintf("f%02d", i)] = []byte(fmt.Sprintf("v%d", i))
	}
	e.seedBrokeredSnapshot("snap-plan", files)
	var calls int
	orig := e.api.Config.Handler
	e.api.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/objects:resolve") {
			e.mu.Lock()
			calls++
			e.mu.Unlock()
		}
		orig.ServeHTTP(w, r)
	})
	result := execBackupRestoreWithProgress(context.Background(), "plan", sessionPayloadJSON(t, map[string]any{
		"snapshotId": "snap-plan", "targetPath": t.TempDir(), "storageSession": e.session(),
	}), nil, nil, nil)
	if !result.Success {
		t.Fatalf("restore failed: %q", result.Stderr)
	}
	seen := map[string]int{}
	for _, k := range e.resolved() {
		seen[k]++
	}
	for k, c := range seen {
		if c != 1 {
			t.Errorf("key %s resolved %d times, want once", k, c)
		}
	}
	if len(seen) != n+1 {
		t.Errorf("resolved %d distinct keys, want the manifest plus %d files", len(seen), n)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// Manifest + at most one batch per download that starts before any
	// batch covers it (bounded by the restore's download concurrency, 8).
	if calls-1 > n/4 {
		t.Fatalf("resolve calls = %d for %d files; want batching, not one call per file", calls, n)
	}
}

func stubMSSQLRunners(t *testing.T) (staged *[]string, stagedBytes *[]string) {
	t.Helper()
	origResolve := resolveMSSQLRestoreTargetDir
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return t.TempDir(), nil }
	origRestore, origVerify := runMSSQLRestore, runMSSQLVerify
	var paths, contents []string
	record := func(p string) {
		paths = append(paths, p)
		b, _ := os.ReadFile(p)
		contents = append(contents, string(b))
	}
	runMSSQLRestore = func(_, backupFile, _ string, _ bool) (*mssql.RestoreResult, error) {
		record(backupFile)
		return &mssql.RestoreResult{Status: "completed"}, nil
	}
	runMSSQLVerify = func(_, backupFile string) (*mssql.VerifyResult, error) {
		record(backupFile)
		return &mssql.VerifyResult{Valid: true}, nil
	}
	t.Cleanup(func() {
		resolveMSSQLRestoreTargetDir = origResolve
		runMSSQLRestore, runMSSQLVerify = origRestore, origVerify
	})
	return &paths, &contents
}

func TestStorageSessionWiring_MSSQL(t *testing.T) {
	localBak := filepath.Join(t.TempDir(), "local.bak")
	if err := os.WriteFile(localBak, []byte("local-bak"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name        string
		manifest    func(id string) backup.Snapshot
		payload     func(id string) map[string]any
		wantErr     string
		wantBytes   string
		wantPath    string
		wantResolve bool
	}{
		{
			name: "canonical snapshot",
			manifest: func(id string) backup.Snapshot {
				return backup.Snapshot{ID: id, Files: []backup.SnapshotFile{{SourcePath: "Db.bak", BackupPath: "snapshots/" + id + "/files/Db.bak", Size: 9}}}
			},
			payload:     func(id string) map[string]any { return map[string]any{"snapshotId": id} },
			wantBytes:   "brokered!",
			wantResolve: true,
		},
		{
			name:     "remote backupFile without snapshot refused",
			manifest: nil,
			payload: func(id string) map[string]any {
				return map[string]any{"backupFile": "snapshots/" + id + "/files/Db.bak"}
			},
			wantErr: "requires snapshotId",
		},
		{
			name:     "arbitrary remote key refused",
			manifest: nil,
			payload: func(string) map[string]any {
				return map[string]any{"backupFile": "other-tenant/prefix/Db.bak"}
			},
			wantErr: "requires snapshotId",
		},
		{
			name:     "explicit local file kept",
			manifest: nil,
			payload: func(string) map[string]any {
				return map[string]any{"backupFile": localBak}
			},
			wantPath: localBak,
		},
		{
			name: "manifest pointing outside its snapshot refused",
			manifest: func(id string) backup.Snapshot {
				return backup.Snapshot{ID: id, Files: []backup.SnapshotFile{{SourcePath: "Db.bak", BackupPath: "snapshots/other-snapshot/files/Db.bak", Size: 9}}}
			},
			payload: func(id string) map[string]any { return map[string]any{"snapshotId": id} },
			wantErr: "outside its own snapshot",
		},
		{
			name: "manifest with nested file name refused",
			manifest: func(id string) backup.Snapshot {
				return backup.Snapshot{ID: id, Files: []backup.SnapshotFile{{SourcePath: "Db.bak", BackupPath: "snapshots/" + id + "/files/../../x/Db.bak", Size: 9}}}
			},
			payload: func(id string) map[string]any { return map[string]any{"snapshotId": id} },
			wantErr: "outside its own snapshot",
		},
		{
			name:     "snapshot id with separators refused",
			manifest: nil,
			payload:  func(string) map[string]any { return map[string]any{"snapshotId": "../x"} },
			wantErr:  "single path component",
		},
	}
	for _, cmd := range []string{"mssql_restore", "mssql_verify"} {
		for _, tc := range cases {
			t.Run(cmd+"/"+tc.name, func(t *testing.T) {
				staged, stagedBytes := stubMSSQLRunners(t)
				e := newBrokeredEnv(t)
				id := "mssql-inst-db-1-abcd"
				if tc.manifest != nil {
					m := tc.manifest(id)
					e.putJSON("snapshots/"+id+"/manifest.json", m)
					e.put(m.Files[0].BackupPath, []byte("brokered!"))
				}
				p := tc.payload(id)
				p["instance"] = "MSSQLSERVER"
				p["targetDatabase"] = "Db_Restored"
				p["storageSession"] = e.session()
				// A decoy agent.yaml manager that holds a different artifact.
				mgr := decoyManager(t, id, map[string][]byte{"Db.bak": nil})
				result := executeCommand(backupipc.BackupCommandRequest{CommandID: "m", CommandType: cmd, Payload: sessionPayloadJSON(t, p)},
					mgr, nil, nil, newActiveCommandCanceller())
				if tc.wantErr != "" {
					if result.Success || !strings.Contains(result.Stderr, tc.wantErr) {
						t.Fatalf("result = %+v, want failure containing %q", result, tc.wantErr)
					}
					if len(*staged) != 0 {
						t.Fatal("MSSQL runner invoked for a refused artifact")
					}
					return
				}
				if !result.Success {
					t.Fatalf("command failed: %q", result.Stderr)
				}
				if len(*staged) != 1 {
					t.Fatalf("runner calls = %d", len(*staged))
				}
				if tc.wantPath != "" && (*staged)[0] != tc.wantPath {
					t.Fatalf("staged %q, want %q", (*staged)[0], tc.wantPath)
				}
				if tc.wantBytes != "" && (*stagedBytes)[0] != tc.wantBytes {
					t.Fatalf("staged bytes %q, want brokered %q", (*stagedBytes)[0], tc.wantBytes)
				}
				if tc.wantResolve != (len(e.resolved()) > 0) {
					t.Fatalf("resolved keys = %v, want resolve=%v", e.resolved(), tc.wantResolve)
				}
			})
		}
	}
}

func TestStorageSessionWiring_HypervRestore(t *testing.T) {
	e := newBrokeredEnv(t)
	id := "hyperv-vm1-1-abcd"
	manifest := hypervSnapshotManifest{
		ID: id, VMName: "vm1", ExportRoot: "vm1",
		Files: []hypervSnapshotManifestFile{
			{SourcePath: "vm1/Virtual Hard Disks/disk.vhdx", BackupPath: "snapshots/" + id + "/files/vm1/Virtual Hard Disks/disk.vhdx", Size: 4},
			{SourcePath: "vm1/Virtual Machines/cfg.vmcx", BackupPath: "snapshots/" + id + "/files/vm1/Virtual Machines/cfg.vmcx", Size: 3},
		},
	}
	e.putJSON("snapshots/"+id+"/manifest.json", manifest)
	e.put(manifest.Files[0].BackupPath, []byte("disk"))
	e.put(manifest.Files[1].BackupPath, []byte("cfg"))

	orig := importHypervVM
	var importedDisk string
	importHypervVM = func(importRoot, vmName string) (*hyperv.RestoreResult, error) {
		b, err := os.ReadFile(filepath.Join(importRoot, "Virtual Hard Disks", "disk.vhdx"))
		if err != nil {
			return nil, err
		}
		importedDisk = string(b)
		return &hyperv.RestoreResult{}, nil
	}
	t.Cleanup(func() { importHypervVM = orig })

	for _, withMgr := range []bool{false, true} {
		importedDisk = ""
		var mgr *backup.BackupManager
		if withMgr {
			mgr = backup.NewBackupManager(backup.BackupConfig{Provider: providers.NewLocalProvider(t.TempDir())})
		}
		result := executeCommand(backupipc.BackupCommandRequest{CommandID: "h", CommandType: "hyperv_restore", Payload: sessionPayloadJSON(t, map[string]any{
			"snapshotId": id, "vmName": "vm1-restored", "storageSession": e.session(),
		})}, mgr, nil, nil, newActiveCommandCanceller())
		if !result.Success {
			t.Fatalf("hyperv_restore (mgr=%v) failed: %q", withMgr, result.Stderr)
		}
		if importedDisk != "disk" {
			t.Fatalf("imported disk = %q, want brokered bytes", importedDisk)
		}
	}
	e.assertStorageNeverSawCredentials()
}

func TestStorageSessionWiring_VMCommandsUseSessionProvider(t *testing.T) {
	e := newBrokeredEnv(t)
	e.put("snapshots/vm-snap/manifest.json", []byte(`{"id":"vm-snap","files":[]}`))

	fetchThrough := func(p providers.BackupProvider) string {
		if _, ok := p.(*storagesession.Provider); !ok {
			t.Fatalf("provider = %T, want the storage session provider", p)
		}
		dst := filepath.Join(t.TempDir(), "m.json")
		if err := p.Download("snapshots/vm-snap/manifest.json", dst); err != nil {
			t.Fatalf("download through provider: %v", err)
		}
		b, _ := os.ReadFile(dst)
		return string(b)
	}
	origRestore, origBoot := hypervRestoreAsVM, hypervInstantBoot
	var seen []string
	hypervRestoreAsVM = func(_ context.Context, _ hyperv.VMRestoreFromBackupConfig, p providers.BackupProvider, _ func(string, int64, int64)) (*hyperv.VMRestoreFromBackupResult, error) {
		seen = append(seen, fetchThrough(p))
		return &hyperv.VMRestoreFromBackupResult{Status: "completed"}, nil
	}
	hypervInstantBoot = func(_ context.Context, _ hyperv.InstantBootConfig, p providers.BackupProvider, _ func(string, int64, int64)) (*hyperv.InstantBootResult, error) {
		seen = append(seen, fetchThrough(p))
		return &hyperv.InstantBootResult{Status: "completed"}, nil
	}
	t.Cleanup(func() { hypervRestoreAsVM, hypervInstantBoot = origRestore, origBoot })

	for _, cmd := range []string{"vm_restore_from_backup", "vm_instant_boot"} {
		for _, withMgr := range []bool{false, true} {
			var mgr *backup.BackupManager
			if withMgr {
				mgr = decoyManager(t, "vm-snap", map[string][]byte{"x": nil})
			}
			seen = nil
			result := executeCommand(backupipc.BackupCommandRequest{CommandID: "v", CommandType: cmd, Payload: sessionPayloadJSON(t, map[string]any{
				"snapshotId": "vm-snap", "vmName": "vm-new", "storageSession": e.session(),
			})}, mgr, nil, nil, newActiveCommandCanceller())
			if !result.Success {
				t.Fatalf("%s (mgr=%v) failed: %q", cmd, withMgr, result.Stderr)
			}
			if len(seen) != 1 || !strings.Contains(seen[0], `"vm-snap"`) {
				t.Fatalf("%s: provider served %q", cmd, seen)
			}
		}
	}
}

// TestStorageSessionWiring_LegacyPayloadUnchanged: without a session the
// legacy providerConfig path still works.
func TestStorageSessionWiring_LegacyPayloadUnchanged(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })
	storeDir := t.TempDir()
	seedLocalSnapshot(t, storeDir, "snap-legacy", map[string][]byte{"a.txt": []byte("legacy")})
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "l", CommandType: "backup_verify", Payload: sessionPayloadJSON(t, map[string]any{
		"snapshotId": "snap-legacy", "provider": "local", "providerConfig": map[string]any{"path": storeDir}, "storageSession": nil,
	})}, nil, nil, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("legacy verify failed: %q", result.Stderr)
	}
}
