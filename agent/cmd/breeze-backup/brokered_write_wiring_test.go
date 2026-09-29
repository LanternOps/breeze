package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/storagesession"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

const wiringIssuedSnapshotID = "snapshot-20261128T101500Z-abcdefabcdefabcdefabcdef"

// writeEnv is a fake write-session control plane plus object storage, both
// TLS, wired into the helper's storage-session seams. It accepts keys under
// the issued snapshot only.
type writeEnv struct {
	t       *testing.T
	api     *httptest.Server
	storage *httptest.Server

	mu             sync.Mutex
	objects        map[string][]byte
	uploads        map[string]map[int][]byte
	nextUpload     int
	ops            []string
	storageHeaders []http.Header
}

func newWriteEnv(t *testing.T) *writeEnv {
	t.Helper()
	e := &writeEnv{t: t, objects: map[string][]byte{}, uploads: map[string]map[int][]byte{}}
	e.storage = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		e.storageHeaders = append(e.storageHeaders, r.Header.Clone())
		e.mu.Unlock()
		q := r.URL.Query()
		key := q.Get("k")
		switch r.Method {
		case http.MethodGet:
			e.mu.Lock()
			data, ok := e.objects[key]
			e.mu.Unlock()
			if !ok {
				http.Error(w, "NoSuchKey", http.StatusNotFound)
				return
			}
			_, _ = w.Write(data)
		case http.MethodPut:
			data, _ := io.ReadAll(r.Body)
			e.mu.Lock()
			defer e.mu.Unlock()
			if u := q.Get("u"); u != "" {
				n, _ := strconv.Atoi(q.Get("n"))
				e.uploads[u][n] = data
				w.Header().Set("ETag", fmt.Sprintf(`"p%d"`, n))
				return
			}
			e.objects[key] = data
			w.Header().Set("ETag", `"x"`)
		}
	}))
	t.Cleanup(e.storage.Close)
	base := "/api/v1/agents/" + wiringAgentID + "/storage-sessions/" + testStorageSessionID + "/"
	e.api = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer brz_wiring" || r.Header.Get(storagesession.SessionHeader) != testStorageSessionToken() {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		op := strings.TrimPrefix(r.URL.EscapedPath(), base)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		e.mu.Lock()
		defer e.mu.Unlock()
		e.ops = append(e.ops, op)
		own := func(k string) bool { return strings.HasPrefix(k, "snapshots/"+wiringIssuedSnapshotID+"/") }
		reply := func(status int, v any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(v)
		}
		switch op {
		case "renew":
			reply(200, map[string]string{"expiresAt": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)})
		case "objects:resolve":
			objects, denied := []map[string]any{}, []map[string]any{}
			for _, raw := range body["requests"].([]any) {
				req := raw.(map[string]any)
				key, method := req["key"].(string), req["method"].(string)
				if !own(key) {
					denied = append(denied, map[string]any{"key": key, "method": method, "code": "outside_reservation"})
					continue
				}
				o := map[string]any{"key": key, "method": method, "headers": map[string]string{},
					"expiresAt": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)}
				u := e.storage.URL + "/o?k=" + url.QueryEscape(key)
				if method != "GET" {
					o["headers"] = map[string]string{"content-length": strconv.FormatInt(int64(req["size"].(float64)), 10)}
				}
				if method == "UPLOAD_PART" {
					u += "&u=" + url.QueryEscape(req["uploadId"].(string)) + "&n=" + strconv.Itoa(int(req["partNumber"].(float64)))
					o["uploadId"], o["partNumber"] = req["uploadId"], int(req["partNumber"].(float64))
				}
				o["url"] = u
				objects = append(objects, o)
			}
			reply(200, map[string]any{"objects": objects, "denied": denied})
		case "multipart:create":
			if !own(body["key"].(string)) {
				reply(403, map[string]string{"code": "outside_reservation"})
				return
			}
			e.nextUpload++
			id := fmt.Sprintf("u%d", e.nextUpload)
			e.uploads[id] = map[int][]byte{}
			reply(200, map[string]string{"uploadId": id})
		case "multipart:complete":
			parts := e.uploads[body["uploadId"].(string)]
			var assembled []byte
			for i := 1; i <= len(parts); i++ {
				assembled = append(assembled, parts[i]...)
			}
			e.objects[body["key"].(string)] = assembled
			reply(200, map[string]any{})
		case "multipart:abort":
			reply(200, map[string]any{})
		case "objects:list":
			prefix := body["prefix"].(string)
			keys := []string{}
			for k := range e.objects {
				if strings.HasPrefix(k, prefix) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			reply(200, map[string]any{"keys": keys, "nextToken": nil})
		case "objects:delete":
			deleted := []string{}
			for _, raw := range body["keys"].([]any) {
				delete(e.objects, raw.(string))
				deleted = append(deleted, raw.(string))
			}
			reply(200, map[string]any{"deleted": deleted, "denied": []any{}, "failed": []any{}})
		case "snapshot:resume":
			reply(409, map[string]string{"code": "not_resumable"})
		default:
			reply(404, map[string]string{"error": "not found"})
		}
	}))
	t.Cleanup(e.api.Close)

	origCreds, origOpts := loadStorageSessionCredentials, storageSessionOptions
	loadStorageSessionCredentials = func() (storagesession.Credentials, error) {
		return storagesession.Credentials{AgentID: wiringAgentID, AgentToken: "brz_wiring", ControlPlaneOrigins: []string{e.api.URL}}, nil
	}
	storageSessionOptions = storagesession.Options{ControlClient: e.api.Client(), StorageClient: e.storage.Client()}
	t.Cleanup(func() { loadStorageSessionCredentials, storageSessionOptions = origCreds, origOpts })
	// The checkpoint journal of a payload-built backup_run lives under the
	// home directory.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return e
}

func (e *writeEnv) session() map[string]any {
	return validStorageSession(func(d map[string]any) {
		d["baseUrl"] = e.api.URL
		d["scope"] = "snapshot_write"
		d["snapshotId"] = wiringIssuedSnapshotID
		d["capabilities"] = []string{"resolve_batch", "renew", "put", "multipart", "list", "delete", "resume"}
		d["partSizeBytes"] = 64 << 20
		d["conditionalWrites"] = true
	})
}

func (e *writeEnv) storedKeys() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var keys []string
	for k := range e.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (e *writeEnv) assertOnlyIssuedKeys() {
	e.t.Helper()
	keys := e.storedKeys()
	if len(keys) == 0 {
		e.t.Fatal("nothing was written through the storage session")
	}
	for _, k := range keys {
		if !strings.HasPrefix(k, "snapshots/"+wiringIssuedSnapshotID+"/") {
			e.t.Fatalf("stored %s outside the issued snapshot", k)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, h := range e.storageHeaders {
		if h.Get("Authorization") != "" || h.Get(storagesession.SessionHeader) != "" || h.Get("Cookie") != "" {
			e.t.Fatalf("object storage received a credential header: %v", h)
		}
	}
}

// decoyStore is an agent.yaml-style manager whose destination must never be
// written by a brokered backup.
func decoyStore(t *testing.T) (*backup.BackupManager, string) {
	t.Helper()
	dir := t.TempDir()
	return backup.NewBackupManager(backup.BackupConfig{Provider: providers.NewLocalProvider(dir), StagingDir: t.TempDir()}), dir
}

func assertDirEmpty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("%s was written to (%d entries)", dir, len(entries))
	}
}

func brokeredBackupRunPayload(t *testing.T, e *writeEnv, mutate func(map[string]any)) json.RawMessage {
	t.Helper()
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("alpha"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := map[string]any{
		"jobId":                 "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35",
		"configId":              "c0ffee00-0000-4000-8000-000000000001",
		"provider":              "s3",
		"paths":                 []string{src},
		"baseSnapshotId":        "",
		"publishLeaseExpiresAt": time.Now().Add(4 * time.Hour).UTC().Format(time.RFC3339),
		"storageSession":        e.session(),
	}
	if mutate != nil {
		mutate(p)
	}
	return sessionPayloadJSON(t, p)
}

func TestBrokeredWrite_BackupRunWritesOnlyThroughTheSession(t *testing.T) {
	e := newWriteEnv(t)
	mgr, decoyDir := decoyStore(t)
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "b1", CommandType: "backup_run",
		Payload: brokeredBackupRunPayload(t, e, nil)}, mgr, nil, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("brokered backup_run failed: %q", result.Stderr)
	}
	var decoded struct {
		Snapshot struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if decoded.Snapshot.ID != wiringIssuedSnapshotID {
		t.Fatalf("snapshot id = %q, want the issued id", decoded.Snapshot.ID)
	}
	e.assertOnlyIssuedKeys()
	assertDirEmpty(t, decoyDir)
}

func TestBrokeredWrite_FailsClosed(t *testing.T) {
	cases := []struct {
		name    string
		command string
		payload func(t *testing.T, e *writeEnv, localDir string) json.RawMessage
	}{
		{"session and providerConfig together", "backup_run", func(t *testing.T, e *writeEnv, localDir string) json.RawMessage {
			return brokeredBackupRunPayload(t, e, func(p map[string]any) {
				p["provider"] = "local"
				p["providerConfig"] = map[string]any{"path": localDir}
			})
		}},
		{"read session on a backup", "backup_run", func(t *testing.T, e *writeEnv, _ string) json.RawMessage {
			return brokeredBackupRunPayload(t, e, func(p map[string]any) {
				p["storageSession"] = validStorageSession(func(d map[string]any) { d["baseUrl"] = e.api.URL })
			})
		}},
		{"write session without a server-selected base", "backup_run", func(t *testing.T, e *writeEnv, _ string) json.RawMessage {
			return brokeredBackupRunPayload(t, e, func(p map[string]any) {
				delete(p, "baseSnapshotId")
				delete(p, "publishLeaseExpiresAt")
			})
		}},
		{"read session on a database backup", "mssql_backup", func(t *testing.T, e *writeEnv, _ string) json.RawMessage {
			return sessionPayloadJSON(t, map[string]any{"jobId": "j", "instance": "MSSQLSERVER", "database": "Db", "backupType": "full",
				"provider": "s3", "storageSession": validStorageSession(func(d map[string]any) { d["baseUrl"] = e.api.URL })})
		}},
		{"write session on a restore", "backup_verify", func(t *testing.T, e *writeEnv, _ string) json.RawMessage {
			return sessionPayloadJSON(t, map[string]any{"snapshotId": wiringIssuedSnapshotID, "provider": "s3", "storageSession": e.session()})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newWriteEnv(t)
			mgr, decoyDir := decoyStore(t)
			localDir := t.TempDir()
			result := executeCommand(backupipc.BackupCommandRequest{CommandID: "f", CommandType: tc.command,
				Payload: tc.payload(t, e, localDir)}, mgr, nil, nil, newActiveCommandCanceller())
			assertStorageSessionFailure(t, result)
			assertDirEmpty(t, decoyDir)
			assertDirEmpty(t, localDir)
			if keys := e.storedKeys(); len(keys) != 0 {
				t.Fatalf("stored %v", keys)
			}
		})
	}
}

func TestBrokeredWrite_MSSQLBackupUsesTheIssuedID(t *testing.T) {
	e := newWriteEnv(t)
	mgr, decoyDir := decoyStore(t)
	orig := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = orig })
	runMSSQLBackup = func(_, _, _, outputPath string) (*mssql.BackupResult, error) {
		f := filepath.Join(outputPath, "Db_full.bak")
		if err := os.WriteFile(f, []byte("bak-bytes"), 0o644); err != nil {
			t.Fatal(err)
		}
		return &mssql.BackupResult{InstanceName: "MSSQLSERVER", DatabaseName: "Db", BackupType: "full", BackupFile: f}, nil
	}
	payload := sessionPayloadJSON(t, map[string]any{"jobId": "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35", "instance": "MSSQLSERVER",
		"database": "Db", "backupType": "full", "provider": "s3", "storageSession": e.session()})
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "m", CommandType: "mssql_backup", Payload: payload},
		mgr, nil, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("brokered mssql_backup failed: %q", result.Stderr)
	}
	var decoded struct {
		SnapshotID string `json:"snapshotId"`
	}
	_ = json.Unmarshal([]byte(result.Stdout), &decoded)
	if decoded.SnapshotID != wiringIssuedSnapshotID {
		t.Fatalf("snapshot id = %q, want the issued id", decoded.SnapshotID)
	}
	e.assertOnlyIssuedKeys()
	assertDirEmpty(t, decoyDir)
}

func TestBrokeredWrite_HypervBackupUsesTheIssuedID(t *testing.T) {
	e := newWriteEnv(t)
	stubHypervSeams(t, func(string) (int64, error) { return 1 << 20, nil }, constFree(1<<40), nil, fakeExport(false))
	mgr, decoyDir := decoyStore(t)
	payload := sessionPayloadJSON(t, map[string]any{"jobId": "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35", "vmName": "vm1",
		"consistencyType": "application", "provider": "s3", "storageSession": e.session()})
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "h", CommandType: "hyperv_backup", Payload: payload},
		mgr, nil, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("brokered hyperv_backup failed: %q", result.Stderr)
	}
	var decoded struct {
		SnapshotID string `json:"snapshotId"`
	}
	_ = json.Unmarshal([]byte(result.Stdout), &decoded)
	if decoded.SnapshotID != wiringIssuedSnapshotID {
		t.Fatalf("snapshot id = %q, want the issued id", decoded.SnapshotID)
	}
	e.assertOnlyIssuedKeys()
	assertDirEmpty(t, decoyDir)
}

// recordingPrimary is an agent.yaml-style storage provider that records any
// use; a brokered backup must never reach it, directly or through a vault.
type recordingPrimary struct {
	mu    sync.Mutex
	calls []string
}

func (r *recordingPrimary) note(c string) error {
	r.mu.Lock()
	r.calls = append(r.calls, c)
	r.mu.Unlock()
	return fmt.Errorf("recording primary: %s", c)
}
func (r *recordingPrimary) Upload(l, k string) error        { return r.note("upload " + k) }
func (r *recordingPrimary) Download(k, l string) error      { return r.note("download " + k) }
func (r *recordingPrimary) List(p string) ([]string, error) { return nil, r.note("list " + p) }
func (r *recordingPrimary) Delete(k string) error           { return r.note("delete " + k) }
func (r *recordingPrimary) used() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

func TestBrokeredWrite_BackupRunNeverSyncsTheVault(t *testing.T) {
	e := newWriteEnv(t)
	primary := &recordingPrimary{}
	vaultDir := t.TempDir()
	vault, err := backup.NewVaultManager(backup.VaultConfig{VaultPath: vaultDir}, primary)
	if err != nil {
		t.Fatal(err)
	}
	vaultState := &vaultManagerRef{}
	vaultState.Set(vault)
	mgr, decoyDir := decoyStore(t)
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "v", CommandType: "backup_run",
		Payload: brokeredBackupRunPayload(t, e, nil)}, mgr, vaultState, nil, newActiveCommandCanceller())
	if !result.Success {
		t.Fatalf("brokered backup_run failed: %q", result.Stderr)
	}
	// Vault sync runs asynchronously after a successful run; give it time.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) && len(primary.used()) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if used := primary.used(); len(used) != 0 {
		t.Fatalf("a brokered backup reached agent.yaml storage through the vault: %v", used)
	}
	assertDirEmpty(t, vaultDir)
	assertDirEmpty(t, decoyDir)
}

func TestBrokeredWrite_DatabaseAndVMBackupsRequireThePlannedEncryption(t *testing.T) {
	sse := map[string]any{"required": true, "mode": "s3-sse-s3"}
	cases := []struct {
		command string
		payload map[string]any
		setup   func(t *testing.T)
	}{
		{"mssql_backup", map[string]any{"instance": "MSSQLSERVER", "database": "Db", "backupType": "full"}, func(t *testing.T) {
			orig := runMSSQLBackup
			t.Cleanup(func() { runMSSQLBackup = orig })
			runMSSQLBackup = func(_, _, _, outputPath string) (*mssql.BackupResult, error) {
				f := filepath.Join(outputPath, "Db_full.bak")
				if err := os.WriteFile(f, []byte("bak-bytes"), 0o644); err != nil {
					t.Fatal(err)
				}
				return &mssql.BackupResult{InstanceName: "MSSQLSERVER", DatabaseName: "Db", BackupType: "full", BackupFile: f}, nil
			}
		}},
		{"hyperv_backup", map[string]any{"vmName": "vm1", "consistencyType": "application"}, func(t *testing.T) {
			stubHypervSeams(t, func(string) (int64, error) { return 1 << 20, nil }, constFree(1<<40), nil, fakeExport(false))
		}},
	}
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			e := newWriteEnv(t)
			tc.setup(t)
			mgr, decoyDir := decoyStore(t)
			payload := map[string]any{"jobId": "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35", "provider": "s3",
				"storageEncryption": sse, "storageSession": e.session()}
			for k, v := range tc.payload {
				payload[k] = v
			}
			result := executeCommand(backupipc.BackupCommandRequest{CommandID: "s", CommandType: tc.command,
				Payload: sessionPayloadJSON(t, payload)}, mgr, nil, nil, newActiveCommandCanceller())
			if result.Success {
				t.Fatalf("%s succeeded without the planned encryption", tc.command)
			}
			if !strings.Contains(result.Stderr, "encryption") {
				t.Fatalf("stderr = %q, want an encryption refusal", result.Stderr)
			}
			if keys := e.storedKeys(); len(keys) != 0 {
				t.Fatalf("stored %v without the planned encryption", keys)
			}
			assertDirEmpty(t, decoyDir)
		})
	}
}
