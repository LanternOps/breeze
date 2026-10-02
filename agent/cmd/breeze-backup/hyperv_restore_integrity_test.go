package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// appAttestedBlock is the integrity block the server sends for an attested
// database or VM snapshot: its manifest is the only control object.
func appAttestedBlock(snapshotID string, manifest backup.PublishedObject) map[string]any {
	return map[string]any{
		"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": snapshotID,
		"objects": []map[string]any{{
			"role": "manifest", "key": manifest.Key, "sha256": manifest.SHA256, "size": manifest.Size,
		}},
	}
}

func appOverrideBlock(snapshotID string) map[string]any {
	return map[string]any{
		"v": 1, "mode": "unattested_override", "snapshotId": snapshotID,
		"authorizationId": "8d6f1c9e-4f7a-4c1b-9a53-2f6c0f1d2a11",
	}
}

// replaceStoredObject rewrites the bytes a LocalProvider holds for key.
func replaceStoredObject(t *testing.T, storeDir, key string, data []byte) {
	t.Helper()
	p := filepath.Join(storeDir, filepath.FromSlash(key))
	_ = os.Chmod(p, 0o644)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatalf("rewrite stored object %s: %v", key, err)
	}
}

// findStagingFiles lists every stage-and-publish leftover under dir.
func findStagingFiles(t *testing.T, dir string) []string {
	t.Helper()
	var found []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), integrity.StagingPrefix) {
			found = append(found, p)
		}
		return nil
	})
	return found
}

const appHypervDiskRel = "Accounting VM/Virtual Hard Disks/disk.vhdx"
const appHypervConfigRel = "Accounting VM/Virtual Machines/cfg.vmcx"

var appHypervDisk = []byte("vhdx-original-bytes")
var appHypervConfig = []byte("vmcx-config")

// seedAppHypervSnapshot stores a two-file Hyper-V export with per-file
// checksums (unless withoutChecksum) and returns its published manifest.
func seedAppHypervSnapshot(t *testing.T, provider providers.BackupProvider, snapshotID string, withoutChecksum bool) (hypervSnapshotManifest, backup.PublishedObject) {
	t.Helper()
	manifest := hypervSnapshotManifest{ID: snapshotID, VMName: "Accounting VM", Timestamp: time.Now().UTC(), ExportRoot: "Accounting VM"}
	for _, f := range []struct {
		rel  string
		data []byte
	}{{appHypervDiskRel, appHypervDisk}, {appHypervConfigRel, appHypervConfig}} {
		src := filepath.Join(t.TempDir(), "obj")
		if err := os.WriteFile(src, f.data, 0o644); err != nil {
			t.Fatal(err)
		}
		key := path.Join("snapshots", snapshotID, "files", f.rel)
		if err := provider.Upload(src, key); err != nil {
			t.Fatalf("upload %s: %v", key, err)
		}
		entry := hypervSnapshotManifestFile{SourcePath: f.rel, BackupPath: key, Size: int64(len(f.data))}
		if !withoutChecksum {
			entry.Checksum = integrity.DigestBytes(f.data)
		}
		manifest.Files = append(manifest.Files, entry)
		manifest.Size += entry.Size
	}
	obj, err := uploadHypervSnapshotManifest(provider, "", manifest)
	if err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
	return manifest, obj
}

func TestExecHypervRestore_Integrity(t *testing.T) {
	const id = "hyperv-accounting-1-abcd"
	sameSizeOther := []byte(strings.Repeat("x", len(appHypervDisk)))
	cases := []struct {
		name            string
		block           func(obj backup.PublishedObject) any
		withoutChecksum bool
		storedDisk      []byte // replaces the stored VHDX bytes when set
		wantSuccess     bool
		wantErr         string
		wantImportDisk  []byte
		wantUnattested  bool
	}{
		{
			name:        "attested export is checked and imported",
			block:       func(o backup.PublishedObject) any { return appAttestedBlock(id, o) },
			wantSuccess: true, wantImportDisk: appHypervDisk,
		},
		{
			name:       "same-size different VHDX bytes fail before import",
			block:      func(o backup.PublishedObject) any { return appAttestedBlock(id, o) },
			storedDisk: sameSizeOther,
			wantErr:    "differs from its attestation",
		},
		{
			name:            "attested entry without a checksum fails",
			block:           func(o backup.PublishedObject) any { return appAttestedBlock(id, o) },
			withoutChecksum: true,
			wantErr:         "no checksum",
		},
		{
			name: "manifest bytes differ from attestation",
			block: func(o backup.PublishedObject) any {
				o.SHA256 = strings.Repeat("0", 64)
				return appAttestedBlock(id, o)
			},
			wantErr: "failed to download Hyper-V snapshot manifest",
		},
		{
			name:            "unattested override keeps the size check and warns",
			block:           func(backup.PublishedObject) any { return appOverrideBlock(id) },
			withoutChecksum: true,
			wantSuccess:     true, wantImportDisk: appHypervDisk, wantUnattested: true,
		},
		{
			name:            "unattested override refuses a size mismatch",
			block:           func(backup.PublishedObject) any { return appOverrideBlock(id) },
			withoutChecksum: true,
			storedDisk:      []byte("short"),
			wantErr:         "size differs",
		},
		{
			name:    "invalid integrity block fails the command",
			block:   func(backup.PublishedObject) any { return map[string]any{"v": 2, "mode": "attested", "snapshotId": id} },
			wantErr: "invalid integrity expectation",
		},
		{
			name: "expectation for another snapshot fails the command",
			block: func(o backup.PublishedObject) any {
				return appOverrideBlock("hyperv-other-1-abcd")
			},
			wantErr: "invalid integrity expectation",
		},
		{
			name:        "without an expectation the export is imported as before",
			block:       func(backup.PublishedObject) any { return nil },
			storedDisk:  sameSizeOther,
			wantSuccess: true, wantImportDisk: sameSizeOther,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mgr, storeDir, stagingBase := newStagedManager(t)
			_, obj := seedAppHypervSnapshot(t, mgr.GetProvider(), id, tc.withoutChecksum)
			if tc.storedDisk != nil {
				replaceStoredObject(t, storeDir, path.Join("snapshots", id, "files", appHypervDiskRel), tc.storedDisk)
			}
			rec := stubHypervSeams(t, nil, constFree(100*gib), func() (string, error) { return t.TempDir(), nil }, nil)
			var imported []byte
			var stagingAtImport []string
			importHypervVM = func(importRoot, vmName string) (*hyperv.RestoreResult, error) {
				rec.importCalls++
				imported, _ = os.ReadFile(filepath.Join(importRoot, "Virtual Hard Disks", "disk.vhdx"))
				stagingAtImport = findStagingFiles(t, filepath.Dir(importRoot))
				return &hyperv.RestoreResult{VMName: vmName, Status: "completed"}, nil
			}

			payload := map[string]any{"snapshotId": id, "vmName": "Recovered VM"}
			if b := tc.block(obj); b != nil {
				payload["integrity"] = b
			}
			result := execHypervRestore(sessionPayloadJSON(t, payload), mgr)

			assertNoHypervStagingLeft(t, stagingBase)
			if !tc.wantSuccess {
				if result.Success {
					t.Fatalf("expected failure, got %s", result.Stdout)
				}
				if !strings.Contains(result.Stderr, tc.wantErr) {
					t.Fatalf("stderr = %q, want it to contain %q", result.Stderr, tc.wantErr)
				}
				if rec.importCalls != 0 {
					t.Fatal("Import-VM ran for a restore whose files failed their checks")
				}
				return
			}
			if !result.Success {
				t.Fatalf("restore failed: %s", result.Stderr)
			}
			if rec.importCalls != 1 || string(imported) != string(tc.wantImportDisk) {
				t.Fatalf("imported disk = %q (%d imports), want %q", imported, rec.importCalls, tc.wantImportDisk)
			}
			if len(stagingAtImport) != 0 {
				t.Fatalf("staging files present at import: %v", stagingAtImport)
			}
			var body hyperv.RestoreResult
			if err := json.Unmarshal([]byte(result.Stdout), &body); err != nil {
				t.Fatal(err)
			}
			n := 0
			for _, w := range body.Warnings {
				if w == integrity.UnattestedRestoreWarning {
					n++
				}
			}
			if want := map[bool]int{true: 1, false: 0}[tc.wantUnattested]; n != want {
				t.Fatalf("unattested warning appears %d times, want %d (warnings %q)", n, want, body.Warnings)
			}
		})
	}
}

// stagingRecorder records where each object is downloaded to.
type stagingRecorder struct {
	providers.BackupProvider
	dests map[string]string
}

func (r *stagingRecorder) Download(key, local string) error {
	r.dests[key] = local
	return r.BackupProvider.Download(key, local)
}

func TestRestoreHypervSnapshotFiles_StageHashPublish(t *testing.T) {
	const id = "hyperv-accounting-2-abcd"
	storeDir := t.TempDir()
	base := providers.NewLocalProvider(storeDir)
	manifest, obj := seedAppHypervSnapshot(t, base, id, false)
	e, err := integrity.Parse(sessionPayloadJSON(t, appAttestedBlock(id, obj)))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("objects are staged beside their final path and published after the check", func(t *testing.T) {
		restoreDir := t.TempDir()
		rec := &stagingRecorder{BackupProvider: base, dests: map[string]string{}}
		warnings, err := restoreHypervSnapshotFiles(rec, &manifest, restoreDir, e)
		if err != nil {
			t.Fatalf("restore: %v", err)
		}
		if len(warnings) != 0 {
			t.Fatalf("warnings = %q", warnings)
		}
		for _, f := range manifest.Files {
			final := filepath.Join(restoreDir, filepath.FromSlash(f.SourcePath))
			dest := rec.dests[f.BackupPath]
			if filepath.Dir(dest) != filepath.Dir(final) || !strings.HasPrefix(filepath.Base(dest), integrity.StagingPrefix) {
				t.Fatalf("%s downloaded to %q, want a staging file beside %q", f.BackupPath, dest, final)
			}
			if _, err := os.Stat(final); err != nil {
				t.Fatalf("%s not published: %v", final, err)
			}
		}
		if left := findStagingFiles(t, restoreDir); len(left) != 0 {
			t.Fatalf("staging files left: %v", left)
		}
	})

	t.Run("a same-size different VHDX never reaches its final path", func(t *testing.T) {
		replaceStoredObject(t, storeDir, manifest.Files[0].BackupPath, []byte(strings.Repeat("y", len(appHypervDisk))))
		restoreDir := t.TempDir()
		_, err := restoreHypervSnapshotFiles(base, &manifest, restoreDir, e)
		if err == nil || !strings.Contains(err.Error(), "differs from its attestation") {
			t.Fatalf("err = %v, want an attestation mismatch", err)
		}
		if _, statErr := os.Stat(filepath.Join(restoreDir, filepath.FromSlash(appHypervDiskRel))); !os.IsNotExist(statErr) {
			t.Fatalf("the VHDX is in its final location: %v", statErr)
		}
		if left := findStagingFiles(t, restoreDir); len(left) != 0 {
			t.Fatalf("staging files left: %v", left)
		}
	})
}
