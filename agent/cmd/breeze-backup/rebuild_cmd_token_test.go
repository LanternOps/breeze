package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// noopTestSystem satisfies rebuild.System without ever being called: the
// BIOS-layout refusal test below is refused in preflight's very first
// check (layout.Assess), strictly before the engine touches System at all.
// It exists only so rebuild.Run never tries to construct the REAL Linux
// system (which fails outright on a non-Linux dev machine, and would need
// root even on Linux).
type noopTestSystem struct{}

func (noopTestSystem) Run(context.Context, string, ...string) ([]byte, error) {
	panic("noopTestSystem: Run should not be called for a preflight refusal")
}
func (noopTestSystem) Chroot(string) func(context.Context, string, ...string) ([]byte, error) {
	panic("noopTestSystem: Chroot should not be called for a preflight refusal")
}
func (noopTestSystem) BlockDeviceSize(string) (int64, error) {
	panic("noopTestSystem: BlockDeviceSize should not be called for a preflight refusal")
}
func (noopTestSystem) AttachImage(string, int64) (string, func() error, error) {
	panic("noopTestSystem: AttachImage should not be called for a preflight refusal")
}
func (noopTestSystem) PartitionDevice(string, int) string {
	panic("noopTestSystem: PartitionDevice should not be called for a preflight refusal")
}
func (noopTestSystem) Rescan(context.Context, string) error {
	panic("noopTestSystem: Rescan should not be called for a preflight refusal")
}
func (noopTestSystem) Exists(string) bool {
	panic("noopTestSystem: Exists should not be called for a preflight refusal")
}
func (noopTestSystem) MountedSources() ([]string, error) {
	panic("noopTestSystem: MountedSources should not be called for a preflight refusal")
}
func (noopTestSystem) RootSources() ([]string, error) {
	panic("noopTestSystem: RootSources should not be called for a preflight refusal")
}
func (noopTestSystem) Mount(context.Context, string, string, string, ...string) error {
	panic("noopTestSystem: Mount should not be called for a preflight refusal")
}
func (noopTestSystem) BindMount(context.Context, string, string) error {
	panic("noopTestSystem: BindMount should not be called for a preflight refusal")
}
func (noopTestSystem) Unmount(context.Context, string) error {
	panic("noopTestSystem: Unmount should not be called for a preflight refusal")
}
func (noopTestSystem) Sync(context.Context) error {
	panic("noopTestSystem: Sync should not be called for a preflight refusal")
}
func (noopTestSystem) Arch() string { return "amd64" }

var _ rebuild.System = noopTestSystem{}

func biosLayoutJSON(t *testing.T) []byte {
	t.Helper()
	m := &layout.Manifest{
		SchemaVersion: layout.SchemaVersion,
		Platform:      "linux",
		BootMode:      layout.BootModeBIOS,
		Disks: []layout.Disk{{
			Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true,
			Partitions: []layout.Partition{
				{Number: 1, Name: "/dev/sda1", TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "vfat", MountPoint: "/boot/efi", SizeBytes: 512 << 20, Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
				{Number: 2, Name: "/dev/sda2", TypeGUID: "0fc63daf-8483-4772-8e79-3d69d8477de4", Filesystem: "ext4", MountPoint: "/", SizeBytes: 40 << 30, Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
			},
		}},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// newTokenModeTestServer stands up the three endpoints breeze-backup
// rebuild --token drives: authenticate (returns a bootstrap bound to a
// bare-metal recovery with identity "new", so no nonce is needed), the
// download proxy (serves layoutJSON at snapshots/snap-1/layout.json and
// 404s everything else), and progress (records every posted status in
// order). The authenticate handler embeds the server's own URL in its
// download descriptor, so the mux is built first and installed on a
// *http.ServeMux the httptest.Server wraps — server.URL is only read
// inside the handler closures, never before the server has started.
func newTokenModeTestServer(t *testing.T, layoutJSON []byte) (server *httptest.Server, statuses func() []string) {
	t.Helper()
	var mu sync.Mutex
	var posted []string

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"version": 1, "minHelperVersion": "0.1.0", "tokenId": "tok-1",
			"deviceId": "dev-1", "snapshotId": "snap-1", "restoreType": "bare_metal",
			"targetConfig": {}, "authenticatedAt": "2026-09-10T00:00:00Z",
			"device": {"id": "dev-1", "hostname": "rig-01", "osType": "linux"},
			"snapshot": {"id": "snap-1", "snapshotId": "snap-1", "size": 1, "fileCount": 1},
			"bootstrap": {
				"version": 1, "minHelperVersion": "0.1.0", "tokenId": "tok-1",
				"device": {"id": "dev-1", "hostname": "rig-01", "osType": "linux"},
				"snapshot": {"id": "snap-1", "snapshotId": "snap-1", "size": 1, "fileCount": 1},
				"restoreType": "bare_metal", "targetConfig": {}, "providerType": "local",
				"download": {
					"type": "breeze_proxy", "method": "GET", "url": %q,
					"pathQueryParam": "path", "tokenHeaderName": "authorization",
					"tokenHeaderFormat": "Bearer <recovery-token>", "requiresAuthentication": true,
					"pathPrefix": "snapshots/snap-1", "expiresAt": ""
				},
				"recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-1"}
			}
		}`, "http://"+r.Host+"/download")
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("path") == "snapshots/snap-1/layout.json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(layoutJSON)
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
		w.Header().Set("Content-Type", "application/json")
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

// TestRebuildCommand_TokenModeRefusesOnBIOSLayout drives the full --token
// wiring (authenticate -> provider -> preflight) against a snapshot whose
// recorded layout is BIOS/MBR — refused by layout.Assess before the engine
// ever touches a disk, so this needs no fake System behaviour beyond
// existing (see noopTestSystem) and no real target sizing. It proves: the
// token/server flags authenticate and build a working provider, the
// identity defaults from the bootstrap's recovery binding, and a refusal
// is reported to the server as status "refused" with the BIOS reason.
func TestRebuildCommand_TokenModeRefusesOnBIOSLayout(t *testing.T) {
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))

	prevSystem := rebuildSystemForTest
	rebuildSystemForTest = noopTestSystem{}
	t.Cleanup(func() { rebuildSystemForTest = prevSystem })

	dir := t.TempDir()
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test", "--server", server.URL,
		"--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "1G",
		"--state-dir", dir,
	})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected an error for a BIOS-layout refusal")
	}
	if !strings.Contains(err.Error(), layout.ReasonBIOSBoot) {
		t.Fatalf("expected the error to name %q, got: %v", layout.ReasonBIOSBoot, err)
	}

	got := statuses()
	if len(got) != 1 || got[0] != "refused" {
		t.Fatalf("expected exactly one posted status [\"refused\"], got %v", got)
	}
}
