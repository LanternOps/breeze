package fakeserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// postJSON POSTs body (marshaled to JSON) to url and returns the raw
// *http.Response — callers close the body and decode it themselves (some
// tests need the status code before caring about the body shape).
func postJSON(t *testing.T, url string, body map[string]any) *http.Response {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

// decodeJSON decodes resp.Body into a map, failing the test on any decode
// error (a malformed body is itself a test failure, not something callers
// should have to guard against individually).
func decodeJSON(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
	return body
}

// writeManifest seeds a minimal manifest.json for snapshotID under dir, with
// one file entry per (sourcePath, backupPath) pair in files.
func writeManifest(t *testing.T, dir, snapshotID string, files [][2]string) {
	t.Helper()
	snapDir := filepath.Join(dir, "snapshots", snapshotID)
	if err := os.MkdirAll(snapDir, 0o755); err != nil {
		t.Fatalf("mkdir manifest dir: %v", err)
	}
	type fileEntry struct {
		SourcePath string `json:"sourcePath"`
		BackupPath string `json:"backupPath"`
	}
	entries := make([]fileEntry, 0, len(files))
	for _, f := range files {
		entries = append(entries, fileEntry{SourcePath: f[0], BackupPath: f[1]})
	}
	manifest := map[string]any{"id": snapshotID, "files": entries}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(snapDir, "manifest.json"), data, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func TestContainedPath(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{"plain key", "snapshots/e2e-1/layout.json", false},
		{"nested key", "snapshots/e2e-1/system-state/manifest.json", false},
		{"parent escape", "../etc/passwd", true},
		{"deep escape", "snapshots/../../etc/passwd", true},
		{"dot-dot that stays inside root is still rejected", "snapshots/e2e-1/../e2e-1/layout.json", true},
		{"absolute key", "/etc/passwd", true},
		{"empty key", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := containedPath(root, tc.key)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("containedPath(%q) = %q, want error", tc.key, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("containedPath(%q): %v", tc.key, err)
			}
			want := filepath.Join(root, filepath.FromSlash(tc.key))
			if got != want {
				t.Fatalf("containedPath(%q) = %q, want %q", tc.key, got, want)
			}
		})
	}
}

func TestFakeServer_BootstrapEchoesGrantedCapabilities(t *testing.T) {
	store := t.TempDir()
	writeManifest(t, store, "gen-3", [][2]string{
		{"/etc/hostname", "snapshots/gen-3/files/aaa.gz"},
		{"/etc/fstab", "snapshots/gen-1/files/bbb.gz"},
		{"/etc/hosts", "snapshots/gen-2/files/ccc.gz"},
	})
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: store,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity:        "new", MinHelperVersion: "0.0.0",
		Capabilities:          []string{"snapshot-file-membership-v1"},
		ReferencedSnapshotIDs: []string{"gen-1", "gen-2"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
		"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
	})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	// handleExchange nests the full bootstrapPayload under
	// body["bootstrap"]["bootstrap"] (double envelope, per the handler's
	// own comment) — not a single "bootstrap" hop.
	outer, ok := body["bootstrap"].(map[string]any)
	if !ok {
		t.Fatalf("body[bootstrap] = %#v, want map", body["bootstrap"])
	}
	inner, ok := outer["bootstrap"].(map[string]any)
	if !ok {
		t.Fatalf("body[bootstrap][bootstrap] = %#v, want map", outer["bootstrap"])
	}
	download, ok := inner["download"].(map[string]any)
	if !ok {
		t.Fatalf("download = %#v, want map", inner["download"])
	}
	caps, ok := download["capabilities"].([]any)
	if !ok {
		t.Fatalf("download[capabilities] = %#v, want []any", download["capabilities"])
	}
	found := false
	for _, c := range caps {
		if c == "snapshot-file-membership-v1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("capabilities = %v, want to contain snapshot-file-membership-v1", caps)
	}
	snapshot, ok := inner["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot = %#v, want map", inner["snapshot"])
	}
	fileIndex, ok := snapshot["fileIndex"].(map[string]any)
	if !ok {
		t.Fatalf("fileIndex = %#v, want map", snapshot["fileIndex"])
	}
	if fileIndex["status"] != "complete" {
		t.Fatalf("fileIndex[status] = %v, want complete", fileIndex["status"])
	}
	origins, ok := fileIndex["originSnapshotIds"].([]any)
	if !ok {
		t.Fatalf("originSnapshotIds = %#v, want []any", fileIndex["originSnapshotIds"])
	}
	wantOrigins := map[string]bool{"gen-1": true, "gen-2": true}
	if len(origins) != len(wantOrigins) {
		t.Fatalf("originSnapshotIds = %v, want elements matching %v", origins, wantOrigins)
	}
	for _, o := range origins {
		if !wantOrigins[fmt.Sprint(o)] {
			t.Fatalf("originSnapshotIds = %v, unexpected element %v", origins, o)
		}
	}
}

func TestFakeServer_RefusesExchangeWithoutCapabilityWhenReferencesExist(t *testing.T) {
	store := t.TempDir()
	writeManifest(t, store, "gen-3", [][2]string{{"/etc/fstab", "snapshots/gen-1/files/bbb.gz"}})
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: store,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity:        "new", MinHelperVersion: "0.0.0",
		ReferencedSnapshotIDs: []string{"gen-1"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{"code": "ABCDEFGHJ"})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["error"] != "client_capability_required" {
		t.Fatalf("error = %v, want client_capability_required", body["error"])
	}
}

func TestFakeServer_DownloadDeniesUnreferencedObject(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "snapshots", "gen-1", "files"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "snapshots", "gen-1", "files", "not-referenced.gz"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	writeManifest(t, dir, "gen-3", [][2]string{{"/etc/hosts", "snapshots/gen-2/files/ccc.gz"}})
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: dir,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Identity:        "new", MinHelperVersion: "0.0.0",
		Capabilities: []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{"gen-2"},
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Obtain a valid token via a real exchange first — handleDownload
	// authenticates via a `token` query parameter checked against
	// s.tokens, not an Authorization header.
	exResp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
		"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
	})
	defer func() { _ = exResp.Body.Close() }()
	if exResp.StatusCode != http.StatusOK {
		t.Fatalf("exchange status = %d, want 200", exResp.StatusCode)
	}
	exBody := decodeJSON(t, exResp)
	validToken, ok := exBody["token"].(string)
	if !ok || validToken == "" {
		t.Fatalf("expected the exchange response to carry a top-level token, got %#v", exBody["token"])
	}

	key := "snapshots/gen-1/files/not-referenced.gz"
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/backup/bmr/recover/download?path="+url.QueryEscape(key)+"&token="+url.QueryEscape(validToken), nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (an object outside the seeded reference set must be refused even with membership granted)", resp.StatusCode)
	}
}

func TestProbeToken_IsPreRegisteredForDownloads(t *testing.T) {
	store := t.TempDir()
	if err := os.MkdirAll(filepath.Join(store, "snapshots", "e2e-1", "files"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "snapshots", "e2e-1", "files", "unref.gz"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "snapshots", "e2e-1", "files", "ref.gz"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(store, "snapshots", "e2e-3"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "snapshots", "e2e-3", "manifest.json"), []byte(`{"id":"e2e-3","files":[{"sourcePath":"/a","backupPath":"snapshots/e2e-1/files/ref.gz"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := New(Config{
		Code: "ABC", SnapshotID: "e2e-3", StoreDir: store, ProgressLogPath: filepath.Join(store, "p.json"),
		Capabilities: []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{"e2e-1"},
		ProbeToken: "probe-1",
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=snapshots/e2e-1/files/unref.gz")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("unreferenced object via probe token: status %d, want 409", res.StatusCode)
	}
	res, err = http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=snapshots/e2e-1/files/ref.gz")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("referenced external object via probe token: status %d, want 200", res.StatusCode)
	}
	res, err = http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=nope&path=snapshots/e2e-1/files/unref.gz")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown token: status %d, want 401", res.StatusCode)
	}
}
