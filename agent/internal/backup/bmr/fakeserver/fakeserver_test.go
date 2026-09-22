package fakeserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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

// seedRealManifestShape copies the shared real-manifest fixture
// (agent/internal/backup/bmr/testdata/real-manifest-shape.json — a REAL
// agent manifest shape from the KIT lab, PR #6491) into a store as the
// token snapshot's manifest and writes a body for every content entry at
// its key, so the fake server serves exactly what a real Linux snapshot
// looks like: dir/symlink entries with backupPath "", systemd unit names
// with a literal backslash, dpkg names with a colon. Returns the manifest id
// and base id.
func seedRealManifestShape(t *testing.T, store string) (id, baseID string, contentKeys []string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "testdata", "real-manifest-shape.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var m struct {
		ID             string `json:"id"`
		BaseSnapshotID string `json:"baseSnapshotId"`
		Files          []struct {
			BackupPath string `json:"backupPath"`
		} `json:"files"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal shared fixture: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(store, "snapshots", m.ID), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, "snapshots", m.ID, "manifest.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range m.Files {
		if f.BackupPath == "" {
			continue
		}
		full := filepath.Join(store, filepath.FromSlash(f.BackupPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("body-of-"+f.BackupPath), 0o644); err != nil {
			t.Fatal(err)
		}
		contentKeys = append(contentKeys, f.BackupPath)
	}
	return m.ID, m.BaseSnapshotID, contentKeys
}

// TestFakeServer_RealManifestShape_ServesEveryContentKey is the e2e-side
// D-W09-1/D-W09-2 regression: a real manifest must produce a complete
// fileIndex with the exact external count (4 base-snapshot entries; the 4
// content-less entries are NOT counted and NOT admissible), and every
// content key — backslash and colon names included — must download 200
// through the membership check.
func TestFakeServer_RealManifestShape_ServesEveryContentKey(t *testing.T) {
	store := t.TempDir()
	id, baseID, keys := seedRealManifestShape(t, store)
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: id, StoreDir: store,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Capabilities:    []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{baseID},
		ProbeToken: "probe-1",
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
		"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
	})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("exchange status = %d, want 200 (a real manifest must not be refused)", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	outer := body["bootstrap"].(map[string]any)
	inner := outer["bootstrap"].(map[string]any)
	snapshot := inner["snapshot"].(map[string]any)
	fi, ok := snapshot["fileIndex"].(map[string]any)
	if !ok {
		t.Fatalf("bootstrap.snapshot.fileIndex missing: %#v", snapshot)
	}
	if fi["status"] != "complete" || fi["externalCount"] != float64(4) {
		t.Fatalf("fileIndex = %#v, want status complete with externalCount 4", fi)
	}

	var sawBackslash, sawColon bool
	for _, key := range keys {
		res, err := http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=" + url.QueryEscape(key))
		if err != nil {
			t.Fatalf("GET %q: %v", key, err)
		}
		got, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("download %q: status %d, want 200", key, res.StatusCode)
		}
		if string(got) != "body-of-"+key {
			t.Fatalf("download %q: body %q, want the object seeded at that exact key", key, got)
		}
		sawBackslash = sawBackslash || strings.Contains(key, `\x2d`)
		sawColon = sawColon || strings.Contains(key, ":")
	}
	if !sawBackslash || !sawColon {
		t.Fatalf("fixture lost a trait: backslash=%v colon=%v", sawBackslash, sawColon)
	}
	// A content-less entry has no object: the empty key must never be
	// admissible (it is not in the membership set) — 409, not 200/500.
	res, err := http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("empty key: status %d, want 409", res.StatusCode)
	}
}

// TestFakeServer_RefusesManifestWithEmptyContentBackupPath mirrors the real
// server's hydration gate (backupSnapshotFileIndex.ts: a CONTENT entry —
// kind "" — with backupPath "" is manifest_invalid; an unparseable key is
// manifest_key_invalid; both flip file_index_status to failed and
// negotiateRecoveryCapabilities refuses 409 snapshot_index_failed). The
// fake fails closed the same way so the QEMU e2e catches a manifest the
// real server would refuse, instead of silently serving it.
func TestFakeServer_RefusesManifestWithEmptyContentBackupPath(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files string
	}{
		{"content entry with empty backupPath", `{"sourcePath":"/a","backupPath":""}`},
		{"content entry with unparseable key", `{"sourcePath":"/a","backupPath":"snapshots/gen-1/../x"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := t.TempDir()
			if err := os.MkdirAll(filepath.Join(store, "snapshots", "gen-3"), 0o755); err != nil {
				t.Fatal(err)
			}
			manifest := `{"id":"gen-3","files":[` + tc.files + `,{"sourcePath":"/d","backupPath":"","kind":"dir"},{"sourcePath":"/b","backupPath":"snapshots/gen-1/files/b.gz"}]}`
			if err := os.WriteFile(filepath.Join(store, "snapshots", "gen-3", "manifest.json"), []byte(manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			srv := New(Config{
				Code: "ABCDEFGHJ", SnapshotID: "gen-3", StoreDir: store,
				ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
				Capabilities:    []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{"gen-1"},
			})
			ts := httptest.NewServer(srv.Handler())
			defer ts.Close()
			resp := postJSON(t, ts.URL+"/api/v1/backup/bmr/recover/exchange", map[string]any{
				"code": "ABCDEFGHJ", "capabilities": []string{"snapshot-file-membership-v1"},
			})
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusConflict {
				t.Fatalf("status = %d, want 409 snapshot_index_failed", resp.StatusCode)
			}
			if got := decodeJSON(t, resp)["error"]; got != "snapshot_index_failed" {
				t.Fatalf("error = %v, want snapshot_index_failed", got)
			}
		})
	}
}

// TestFakeServer_TransportFaultOnceDropsFirstMatchingDownload is the e2e
// stand-in for D-W09-3's KIT failure (one presigned GET died at the
// transport mid-restore): with FaultTransportOnceKey set, the FIRST
// download whose key contains it gets a 200 with Content-Length, a partial
// body, and then the connection is dropped — a transport-class error with
// no status for the client to branch on. The second request for the same
// key is served normally, so a client that retries transport failures
// completes and one that does not loses the file.
func TestFakeServer_TransportFaultOnceDropsFirstMatchingDownload(t *testing.T) {
	store := t.TempDir()
	id, baseID, keys := seedRealManifestShape(t, store)
	var target string
	for _, k := range keys {
		if strings.Contains(k, `\x2dcryptsetup`) {
			target = k
		}
	}
	if target == "" {
		t.Fatal("fixture has no cryptsetup key")
	}
	srv := New(Config{
		Code: "ABCDEFGHJ", SnapshotID: id, StoreDir: store,
		ProgressLogPath: filepath.Join(t.TempDir(), "progress.json"),
		Capabilities:    []string{"snapshot-file-membership-v1"}, ReferencedSnapshotIDs: []string{baseID},
		ProbeToken:            "probe-1",
		FaultTransportOnceKey: `\x2dcryptsetup`,
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func() (int, string, error) {
		res, err := http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=" + url.QueryEscape(target))
		if err != nil {
			return 0, "", err
		}
		defer func() { _ = res.Body.Close() }()
		got, readErr := io.ReadAll(res.Body)
		return res.StatusCode, string(got), readErr
	}

	// An unrelated key is never faulted, even before the fault has fired.
	if status, _, err := (func() (int, string, error) {
		res, err := http.Get(ts.URL + "/api/v1/backup/bmr/recover/download?token=probe-1&path=" + url.QueryEscape(keys[0]))
		if err != nil {
			return 0, "", err
		}
		defer func() { _ = res.Body.Close() }()
		_, readErr := io.ReadAll(res.Body)
		return res.StatusCode, "", readErr
	})(); err != nil || status != http.StatusOK {
		t.Fatalf("unrelated key: status %d err %v, want a clean 200", status, err)
	}

	status, body, err := get()
	if err == nil && body == "body-of-"+target {
		t.Fatalf("first request for the faulted key completed cleanly (status %d) — the fault did not fire", status)
	}
	status, body, err = get()
	if err != nil || status != http.StatusOK || body != "body-of-"+target {
		t.Fatalf("second request: status %d body %q err %v, want the full object (fault is one-shot)", status, body, err)
	}
	if !srv.TransportFaultFired() {
		t.Fatal("TransportFaultFired() = false after the fault fired")
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
