package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// #5412 CLI wiring tests: every way breeze-backup rebuild builds
// rebuild.Options must carry ExpectSystemState, so a system_image snapshot
// without system state is refused at preflight instead of rebuilt
// "completed" files-only. Both modes below use an image target so preflight
// never touches rebuild.System (noopTestSystem panics if it does) and the
// refusal lands before anything is written.

// uefiLayoutJSON is a restorable (UEFI/GPT) single-disk layout, the
// counterpart of biosLayoutJSON: preflight gets past layout.Assess and on
// to the manifest + system-state verification this file is about.
func uefiLayoutJSON(t *testing.T) []byte {
	t.Helper()
	m := &layout.Manifest{
		SchemaVersion: layout.SchemaVersion,
		Platform:      "linux",
		BootMode:      layout.BootModeUEFI,
		Disks: []layout.Disk{{
			Name: "/dev/sda", TableType: "gpt", SizeBytes: 8 << 30, SectorSize: 512, IsSystem: true,
			Partitions: []layout.Partition{
				{Number: 1, Name: "/dev/sda1", TypeGUID: layout.GUIDEFISystem, PartUUID: "11111111-2222-3333-4444-555555555555", StartBytes: 1 << 20, SizeBytes: 512 << 20, Filesystem: "vfat", FSUUID: "ABCD-1234", MountPoint: "/boot/efi", Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
				{Number: 2, Name: "/dev/sda2", TypeGUID: layout.GUIDLinuxFilesystem, PartUUID: "22222222-2222-3333-4444-555555555555", StartBytes: 513 << 20, SizeBytes: (8 << 30) - (514 << 20), UsedBytes: 1 << 30, Filesystem: "ext4", FSUUID: "9f7a2c41-6b3e-4d5f-8a9b-0c1d2e3f4a5b", MountPoint: "/", Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
			},
		}},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func emptyManifestJSON(t *testing.T, id string) []byte {
	t.Helper()
	b, err := json.Marshal(backup.Snapshot{ID: id, Timestamp: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// newSystemImageTokenServer is newTokenModeTestServer's sibling for a
// snapshot the bootstrap describes as backupType "system_image" with a
// NULL systemStateManifest (the exact #5412 shape), serving layout.json and
// manifest.json but NO system-state/manifest.json.
func newSystemImageTokenServer(t *testing.T) (server *httptest.Server, statuses func() []string) {
	t.Helper()
	var mu sync.Mutex
	var posted []string
	files := map[string][]byte{
		"snapshots/snap-1/layout.json":   uefiLayoutJSON(t),
		"snapshots/snap-1/manifest.json": emptyManifestJSON(t, "snap-1"),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{"bootstrap": {
				"version": 1, "minHelperVersion": "0.1.0", "tokenId": "tok-1",
				"device": {"id": "dev-1", "hostname": "rig-01", "osType": "linux"},
				"snapshot": {"id": "snap-1", "snapshotId": "snap-1", "size": 1, "fileCount": 1, "backupType": "system_image", "systemStateManifest": null},
				"restoreType": "bare_metal", "targetConfig": {}, "providerType": "local",
				"download": {
					"type": "breeze_proxy", "method": "GET", "url": %q,
					"pathQueryParam": "path", "tokenHeaderName": "authorization",
					"tokenHeaderFormat": "Bearer <recovery-token>", "requiresAuthentication": true,
					"pathPrefix": "snapshots/snap-1", "expiresAt": ""
				},
				"recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-1"}
			}}`, "http://"+r.Host+"/download")
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := files[r.URL.Query().Get("path")]; ok {
			_, _ = w.Write(b)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/api/v1/backup/bmr/recover/progress", func(w http.ResponseWriter, r *http.Request) {
		var reqBody struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
		mu.Lock()
		posted = append(posted, reqBody.Status)
		mu.Unlock()
		_, _ = fmt.Fprintf(w, `{"id":"rec-1","status":%q}`, reqBody.Status)
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	statuses = func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), posted...)
	}
	return server, statuses
}

func TestRebuildCommand_TokenModeRefusesSystemImageWithoutSystemState(t *testing.T) {
	server, statuses := newSystemImageTokenServer(t)
	prevSystem := rebuildSystemForTest
	rebuildSystemForTest = noopTestSystem{}
	t.Cleanup(func() { rebuildSystemForTest = prevSystem })

	dir := t.TempDir()
	out := filepath.Join(dir, "result.json")
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test", "--server", server.URL,
		"--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "16G",
		"--state-dir", dir, "--result-json", out,
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "system state expected but system-state/manifest.json is missing") {
		t.Fatalf("err = %v, want the #5412 preflight refusal", err)
	}
	if got := statuses(); len(got) != 1 || got[0] != "refused" {
		t.Fatalf("posted statuses = %v, want [refused]", got)
	}
	b, rerr := os.ReadFile(out)
	if rerr != nil {
		t.Fatalf("result file missing: %v", rerr)
	}
	var res rebuild.Result
	if json.Unmarshal(b, &res) != nil || res.Status != "refused" || res.StateManifestFound || res.StateApplied {
		t.Fatalf("result = %s", b)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "t.img")); statErr == nil {
		t.Fatal("refusal must not create the image target")
	}
}

// seedLocalStore writes a snapshot with layout.json + manifest.json (a
// whole-machine capture) and no system state into a LocalProvider root.
func seedLocalStore(t *testing.T, store string) {
	t.Helper()
	dir := filepath.Join(store, "snapshots", "snap-1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "layout.json"), uefiLayoutJSON(t), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), emptyManifestJSON(t, "snap-1"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRebuildCommand_ConfigFileExpectSystemStateFlag(t *testing.T) {
	tests := []struct {
		name       string
		flag       []string
		wantStatus string
		wantText   string // in res.Refusal (refused) or res.Warnings (completed)
	}{
		{"auto: layout.json present means system_image, refused", nil, "refused", "system state expected but system-state/manifest.json is missing"},
		{"explicit true, refused", []string{"--expect-system-state", "true"}, "refused", "system state expected but system-state/manifest.json is missing"},
		{"explicit false, files-only with warning", []string{"--expect-system-state", "false"}, "completed", "snapshot has no system state"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prevSystem := rebuildSystemForTest
			rebuildSystemForTest = noopTestSystem{}
			t.Cleanup(func() { rebuildSystemForTest = prevSystem })

			dir := t.TempDir()
			store := filepath.Join(dir, "store")
			seedLocalStore(t, store)
			provFile := filepath.Join(dir, "prov.json")
			if err := os.WriteFile(provFile, []byte(`{"provider":"local","providerConfig":{"path":`+strconvQuote(store)+`}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			out := filepath.Join(dir, "result.json")
			cmd := newRebuildCommand()
			args := []string{"--snapshot", "snap-1", "--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "16G", "--provider-config", provFile, "--identity", "new", "--dry-run", "--result-json", out, "--state-dir", dir}
			cmd.SetArgs(append(args, tt.flag...))
			err := cmd.Execute()
			b, rerr := os.ReadFile(out)
			if rerr != nil {
				t.Fatalf("result file missing: %v (err=%v)", rerr, err)
			}
			var res rebuild.Result
			if json.Unmarshal(b, &res) != nil || res.Status != tt.wantStatus {
				t.Fatalf("result = %s err=%v", b, err)
			}
			if tt.wantStatus == "refused" {
				if err == nil || !strings.Contains(res.Refusal, tt.wantText) {
					t.Fatalf("result = %s err=%v", b, err)
				}
				return
			}
			if err != nil || !strings.Contains(strings.Join(res.Warnings, "\n"), tt.wantText) {
				t.Fatalf("result = %s err=%v", b, err)
			}
		})
	}
}

func TestRebuildCommand_ExpectSystemStateFlagRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	provFile := filepath.Join(dir, "prov.json")
	if err := os.WriteFile(provFile, []byte(`{"provider":"local","providerConfig":{"path":`+strconvQuote(dir)+`}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{"--snapshot", "snap-1", "--target", "image:" + filepath.Join(dir, "t.img"), "--provider-config", provFile, "--expect-system-state", "maybe"})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "--expect-system-state") {
		t.Fatalf("err = %v, want a flag validation error", err)
	}
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
