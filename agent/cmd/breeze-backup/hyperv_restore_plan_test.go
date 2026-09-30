package main

import (
	"errors"
	"os"
	"testing"
)

// planRecordingProvider records the download plan and every download.
type planRecordingProvider struct {
	plans     [][]string
	downloads []string
}

func (p *planRecordingProvider) Upload(string, string) error { return errors.New("not supported") }
func (p *planRecordingProvider) List(string) ([]string, error) {
	return nil, errors.New("not supported")
}
func (p *planRecordingProvider) Delete(string) error            { return errors.New("not supported") }
func (p *planRecordingProvider) PrepareDownloads(keys []string) { p.plans = append(p.plans, keys) }
func (p *planRecordingProvider) Download(remotePath, localPath string) error {
	p.downloads = append(p.downloads, remotePath)
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	return os.WriteFile(localPath, []byte(remotePath), 0o600)
}

func TestHypervRestorePlanOmitsEntriesWithoutBackupPath(t *testing.T) {
	provider := &planRecordingProvider{}
	manifest := &hypervSnapshotManifest{
		ID: "snap-1",
		Files: []hypervSnapshotManifestFile{
			{SourcePath: "vm/a.vhdx", BackupPath: "snapshots/snap-1/files/a"},
			{SourcePath: "vm/b.xml", BackupPath: ""},
			{SourcePath: "vm/c.vmcx", BackupPath: "snapshots/snap-1/files/c"},
		},
	}
	_, err := restoreHypervSnapshotFiles(provider, manifest, t.TempDir(), nil)
	if len(provider.plans) != 1 {
		t.Fatalf("plans = %d, want 1", len(provider.plans))
	}
	for _, k := range provider.plans[0] {
		if k == "" {
			t.Fatalf("download plan carried an empty key: %q", provider.plans[0])
		}
	}
	if want := []string{"snapshots/snap-1/files/a", "snapshots/snap-1/files/c"}; len(provider.plans[0]) != len(want) ||
		provider.plans[0][0] != want[0] || provider.plans[0][1] != want[1] {
		t.Fatalf("plan = %q, want %q", provider.plans[0], want)
	}
	// Per-item behaviour is unchanged: the entry without a backup path fails
	// at its own download, after the entries before it.
	if err == nil {
		t.Fatal("entry without a backup path must fail the restore")
	}
	if len(provider.downloads) != 2 || provider.downloads[0] != "snapshots/snap-1/files/a" || provider.downloads[1] != "" {
		t.Fatalf("downloads = %q", provider.downloads)
	}
}
