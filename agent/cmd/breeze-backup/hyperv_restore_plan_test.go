package main

import (
	"errors"
	"os"
	"strings"
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

// Export paths are names Windows must store literally: a reserved device name
// is refused before anything is downloaded. A short-name form is an ordinary
// recorded spelling and is accepted.
func TestRestoreHypervSnapshotFilesRefusesInvalidWindowsNames(t *testing.T) {
	for _, tt := range []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "device name file", path: "vm/Virtual Hard Disks/CON.vhdx", wantErr: true},
		{name: "device name directory", path: "vm/aux/cfg.vmcx", wantErr: true},
		{name: "port device name", path: "vm/COM3", wantErr: true},
		{name: "superscript port device name", path: "vm/LPT².vmcx", wantErr: true},
		{name: "console output device", path: "vm/CONOUT$", wantErr: true},
		{name: "short name directory", path: "VIRTUA~1/disk.vhdx"},
		{name: "short name file", path: "vm/DISK~1.VHD"},
		{name: "trailing dot", path: "vm/disk.vhdx.", wantErr: true},
		{name: "stream separator", path: "vm/disk.vhdx:alt", wantErr: true},
		{name: "ordinary export file", path: "vm/Virtual Hard Disks/console-disk.vhdx"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			provider := &planRecordingProvider{}
			manifest := &hypervSnapshotManifest{
				ID: "snap-1",
				Files: []hypervSnapshotManifestFile{
					{SourcePath: "vm/Virtual Machines/cfg.vmcx", BackupPath: "snapshots/snap-1/files/a"},
					{SourcePath: tt.path, BackupPath: "snapshots/snap-1/files/b"},
				},
			}
			_, err := restoreHypervSnapshotFiles(provider, manifest, t.TempDir(), nil)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("restore: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "invalid_windows_name") {
				t.Fatalf("err = %v, want invalid_windows_name", err)
			}
			if len(provider.downloads) != 0 || len(provider.plans) != 0 {
				t.Fatalf("an export with a refused name was fetched: plans %q downloads %q", provider.plans, provider.downloads)
			}
		})
	}
}
