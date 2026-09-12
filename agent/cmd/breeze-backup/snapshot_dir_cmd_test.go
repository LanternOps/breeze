package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
)

func TestSnapshotDir_WalksAndWritesManifest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("snapshot-dir models a Linux root (SourcePath \"/...\"); not meaningful on Windows")
	}

	root := t.TempDir()
	store := t.TempDir()

	mustWrite := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("etc/hostname", "e2e-restored-src\n")
	mustWrite("etc/fstab", "# fstab\n")
	if err := os.Symlink("hostname", filepath.Join(root, "etc/hostname.link")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "proc"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite("proc/should-be-excluded", "x")

	result, err := snapshotDir(root, store, "e2e-1", []string{"proc"})
	if err != nil {
		t.Fatalf("snapshotDir() error = %v", err)
	}

	// 2 regular files + 1 symlink + 1 dir (etc) = 4 entries; proc dir and
	// its content must be entirely excluded.
	if result.Files != 4 {
		t.Errorf("Files = %d, want 4", result.Files)
	}

	data, err := os.ReadFile(result.ManifestPath)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var snap backup.Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if snap.ID != "e2e-1" {
		t.Errorf("snapshot ID = %q, want e2e-1", snap.ID)
	}

	byPath := make(map[string]backup.SnapshotFile, len(snap.Files))
	for _, f := range snap.Files {
		byPath[f.SourcePath] = f
	}

	hostname, ok := byPath["/etc/hostname"]
	if !ok {
		t.Fatal("manifest missing /etc/hostname")
	}
	if hostname.Kind != "" {
		t.Errorf("/etc/hostname Kind = %q, want \"\" (regular file)", hostname.Kind)
	}
	if hostname.BackupPath == "" {
		t.Error("/etc/hostname has no BackupPath")
	}
	if hostname.Checksum == "" {
		t.Error("/etc/hostname has no Checksum")
	}
	if hostname.Size != int64(len("e2e-restored-src\n")) {
		t.Errorf("/etc/hostname Size = %d, want %d", hostname.Size, len("e2e-restored-src\n"))
	}

	link, ok := byPath["/etc/hostname.link"]
	if !ok {
		t.Fatal("manifest missing /etc/hostname.link")
	}
	if link.Kind != backup.KindSymlink || link.LinkTarget != "hostname" {
		t.Errorf("/etc/hostname.link = %+v, want Kind=symlink LinkTarget=hostname", link)
	}

	etcDir, ok := byPath["/etc"]
	if !ok {
		t.Fatal("manifest missing /etc directory entry")
	}
	if etcDir.Kind != backup.KindDir {
		t.Errorf("/etc Kind = %q, want dir", etcDir.Kind)
	}

	if _, ok := byPath["/proc"]; ok {
		t.Error("manifest includes excluded /proc directory")
	}
	if _, ok := byPath["/proc/should-be-excluded"]; ok {
		t.Error("manifest includes a file under excluded /proc")
	}

	// The content object must actually be on disk at BackupPath, readable,
	// and byte-identical to the source (uncompressed — see the package doc
	// comment on why this deliberately does not gzip).
	stored, err := os.ReadFile(filepath.Join(store, filepath.FromSlash(hostname.BackupPath)))
	if err != nil {
		t.Fatalf("read stored content object: %v", err)
	}
	if string(stored) != "e2e-restored-src\n" {
		t.Errorf("stored content = %q, want %q", stored, "e2e-restored-src\n")
	}
}
