package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
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
func (noopTestSystem) LookPath(string) (string, error) {
	panic("noopTestSystem: LookPath should not be called for a preflight refusal")
}
func (noopTestSystem) FreeSpace(string) (int64, error) {
	panic("noopTestSystem: FreeSpace should not be called for a preflight refusal")
}

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
	return newTokenModeTestServerWithRecovery(t, layoutJSON, "new", "")
}

// newTokenModeTestServerWithRecovery is newTokenModeTestServer with the
// bootstrap's recovery binding under test control: identity "original"
// plus a nonce (the marker case), "new" (no nonce needed), or "" for a
// token that is not bound to any bare-metal recovery at all (the
// "recovery" key is then omitted from the bootstrap).
func newTokenModeTestServerWithRecovery(t *testing.T, layoutJSON []byte, identity, nonce string) (server *httptest.Server, statuses func() []string) {
	t.Helper()
	var mu sync.Mutex
	var posted []string
	recovery := ""
	if identity != "" {
		recovery = fmt.Sprintf(`, "recovery": {"id": "rec-1", "identity": %q, "deviceId": "dev-1", "snapshotId": "snap-1"`, identity)
		if nonce != "" {
			recovery += fmt.Sprintf(`, "nonce": %q`, nonce)
		}
		recovery += "}"
	}

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
				}%s
			}
		}`, "http://"+r.Host+"/download", recovery)
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("path") {
		case "snapshots/snap-1/layout.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(layoutJSON)
			return
		case "snapshots/snap-1/manifest.json":
			// A self-contained (no cross-snapshot references) manifest, so
			// buildTokenModeOptions' WidenScopeFromManifest call (Task 10)
			// finds zero external entries and never needs a capability or
			// fileIndex — tests using this server care about identity/
			// layout behaviour, not scope widening.
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"snap-1","files":[]}`))
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

// newTokenModeTestServerWithReferencedFiles stands up an authenticate
// endpoint whose snapshot ("snap-2") manifest references content under an
// OLDER snapshot's prefix ("snapshots/snap-1/..."), plus a download proxy
// serving that manifest, and a progress endpoint recording posted statuses
// — modeled on newTokenModeTestServer/newTokenModeTestServerWithRecovery
// above. grantedCapabilities is echoed as the bootstrap's
// download.capabilities (and, when it contains the membership capability,
// as a matching snapshot.fileIndex whose manifestSha256 is computed from
// the manifest bytes actually served) — nil/empty models a server that
// granted nothing (or an old server that never negotiates at all).
func newTokenModeTestServerWithReferencedFiles(t *testing.T, grantedCapabilities []string) (server *httptest.Server, statuses func() []string) {
	t.Helper()
	manifestJSON := []byte(`{"id":"snap-2","files":[` +
		`{"sourcePath":"/a","backupPath":"snapshots/snap-1/files/a.gz","size":1},` +
		`{"sourcePath":"/b","backupPath":"snapshots/snap-2/files/b.gz","size":1}` +
		`]}`)
	sum := sha256.Sum256(manifestJSON)
	sha := hex.EncodeToString(sum[:])

	fileIndexJSON := ""
	if bmr.HasCapability(grantedCapabilities, bmr.CapabilitySnapshotFileMembershipV1) {
		fileIndexJSON = fmt.Sprintf(`, "fileIndex": {"status": "complete", "manifestSha256": %q, "externalCount": 1, "originSnapshotIds": ["snap-1"]}`, sha)
	}
	capsJSON, err := json.Marshal(grantedCapabilities)
	if err != nil {
		t.Fatalf("marshal capabilities: %v", err)
	}

	var mu sync.Mutex
	var posted []string

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"bootstrap": {
				"version": 1, "minHelperVersion": "0.1.0", "tokenId": "tok-1",
				"device": {"id": "dev-1", "hostname": "rig-01", "osType": "linux"},
				"snapshot": {"id": "snap-2", "snapshotId": "snap-2", "size": 2, "fileCount": 2%s},
				"restoreType": "bare_metal", "targetConfig": {}, "providerType": "local",
				"recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-2"},
				"download": {
					"type": "breeze_proxy", "method": "GET", "url": %q,
					"pathQueryParam": "path", "tokenHeaderName": "authorization",
					"tokenHeaderFormat": "Bearer <recovery-token>", "requiresAuthentication": true,
					"pathPrefix": "snapshots/snap-2", "expiresAt": "", "capabilities": %s
				}
			}
		}`, fileIndexJSON, "http://"+r.Host+"/download", string(capsJSON))
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("path") == "snapshots/snap-2/manifest.json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestJSON)
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

// TestBuildTokenModeOptions_RefusesWithoutCapabilityWhenManifestHasExternalRefs
// proves buildTokenModeOptions itself refuses — before returning any
// rebuild.Options a caller could pass to rebuild.Run — when the manifest
// references an older snapshot's objects and the server granted no
// cross-snapshot capability. It also proves the refusal is reported to the
// server as progress status "refused".
func TestBuildTokenModeOptions_RefusesWithoutCapabilityWhenManifestHasExternalRefs(t *testing.T) {
	server, statuses := newTokenModeTestServerWithReferencedFiles(t, nil)

	_, _, err := buildTokenModeOptions(context.Background(), server.URL, "tok", rebuild.Target{Kind: rebuild.TargetImage, Path: filepath.Join(t.TempDir(), "out.img")}, "")
	if err == nil {
		t.Fatal("expected an error")
	}
	if got := statuses(); len(got) != 1 || got[0] != "refused" {
		t.Fatalf("expected exactly one posted status [\"refused\"], got %v", got)
	}
}

// TestBuildTokenModeOptions_ProceedsWithCapabilityAndMatchingSha proves the
// converse: when the server grants the membership capability and its
// fileIndex's manifestSha256 matches the manifest buildTokenModeOptions
// fetched, no refusal is posted and options are returned for the caller to
// proceed with rebuild.Run.
func TestBuildTokenModeOptions_ProceedsWithCapabilityAndMatchingSha(t *testing.T) {
	server, statuses := newTokenModeTestServerWithReferencedFiles(t, []string{bmr.CapabilitySnapshotFileMembershipV1})

	opts, report, err := buildTokenModeOptions(context.Background(), server.URL, "tok", rebuild.Target{Kind: rebuild.TargetImage, Path: filepath.Join(t.TempDir(), "out.img")}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.Provider == nil {
		t.Fatal("expected a provider")
	}
	if report == nil {
		t.Fatal("expected a report func")
	}
	if got := statuses(); len(got) != 0 {
		t.Fatalf("no refusal should have been posted yet, got %v", got)
	}
}

// TestRebuildCommand_TokenModeOwnPrefixManifestPassesPreflight is the
// regression test for review finding #1: the rebuild engine's preflight
// ObjectAdmission sweep (preflight.go, calling provider.Admits per content
// entry) must never refuse a manifest whose entries are ALL under the
// token's own snapshot prefix — the ordinary, self-contained case, which
// never negotiates the cross-snapshot membership capability at all. Before
// the fix, *recoveryDownloadProvider.Admits consulted only the external
// admissible set and returned false unconditionally without membership, so
// preflight refused every own-prefix file and every token-mode rebuild of
// a self-contained snapshot failed before provisioning. This drives the
// REAL authenticate -> provider -> rebuild.Run(DryRun) path end to end
// against an httptest server, matching production wiring exactly.
func TestRebuildCommand_TokenModeOwnPrefixManifestPassesPreflight(t *testing.T) {
	manifestJSON := []byte(`{"id":"snap-1","files":[` +
		`{"sourcePath":"/a","backupPath":"snapshots/snap-1/files/a.gz","size":1},` +
		`{"sourcePath":"/b","backupPath":"snapshots/snap-1/files/b.gz","size":1}` +
		`]}`)
	uefiLayout := &layout.Manifest{
		SchemaVersion: layout.SchemaVersion,
		Platform:      "linux",
		BootMode:      layout.BootModeUEFI,
		Disks: []layout.Disk{{
			Name: "/dev/sda", TableType: "gpt", SizeBytes: 64 << 30, IsSystem: true,
			Partitions: []layout.Partition{
				{Number: 1, Name: "/dev/sda1", TypeGUID: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", Filesystem: "vfat", MountPoint: "/boot/efi", SizeBytes: 512 << 20, Role: layout.RoleEFI, Encryption: layout.EncryptionNone},
				{Number: 2, Name: "/dev/sda2", TypeGUID: "0fc63daf-8483-4772-8e79-3d69d8477de4", Filesystem: "ext4", MountPoint: "/", SizeBytes: 40 << 30, Role: layout.RoleRoot, Encryption: layout.EncryptionNone},
			},
		}},
	}
	layoutJSON, err := json.Marshal(uefiLayout)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var posted []string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		body := fmt.Sprintf(`{
			"bootstrap": {
				"version": 1, "minHelperVersion": "0.1.0", "tokenId": "tok-1",
				"device": {"id": "dev-1", "hostname": "rig-01", "osType": "linux"},
				"snapshot": {"id": "snap-1", "snapshotId": "snap-1", "size": 2, "fileCount": 2},
				"restoreType": "bare_metal", "targetConfig": {}, "providerType": "local",
				"recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-1"},
				"download": {
					"type": "breeze_proxy", "method": "GET", "url": %q,
					"pathQueryParam": "path", "tokenHeaderName": "authorization",
					"tokenHeaderFormat": "Bearer <recovery-token>", "requiresAuthentication": true,
					"pathPrefix": "snapshots/snap-1", "expiresAt": ""
				}
			}
		}`, "http://"+r.Host+"/download")
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("path") {
		case "snapshots/snap-1/manifest.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestJSON)
			return
		case "snapshots/snap-1/layout.json":
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
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	target := rebuild.Target{Kind: rebuild.TargetImage, Path: filepath.Join(t.TempDir(), "out.img")}
	opts, _, err := buildTokenModeOptions(context.Background(), server.URL, "tok", target, "")
	if err != nil {
		t.Fatalf("buildTokenModeOptions: unexpected error: %v", err)
	}
	opts.System = noopTestSystem{}
	opts.DryRun = true
	opts.Target.ImageSizeBytes = 2 << 30
	opts.StateDir = t.TempDir()

	res, err := rebuild.Run(context.Background(), opts)
	if err != nil {
		var refusal *rebuild.RefusalError
		if errors.As(err, &refusal) {
			t.Fatalf("preflight refused an all-own-prefix manifest: %s", refusal.Reason)
		}
		t.Fatalf("rebuild.Run: unexpected error: %v", err)
	}
	if res == nil || res.PhaseReached != rebuild.PhasePreflight {
		t.Fatalf("expected DryRun to stop after preflight, got %+v", res)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 0 {
		t.Fatalf("expected no progress posted for a dry-run preflight pass, got %v", posted)
	}
}
