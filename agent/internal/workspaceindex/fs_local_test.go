package workspaceindex

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLocalFSReadDirAndStat(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "docs"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(base, "report.txt"), []byte("report"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	fys := NewLocalFS(base)
	entries, err := fys.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if got, want := localDirEntryNames(entries), []string{"docs", "report.txt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ReadDir names = %#v, want %#v", got, want)
	}

	tests := []struct {
		name    string
		path    string
		wantDir bool
		wantLen int64
	}{
		{name: "directory", path: "docs", wantDir: true},
		{name: "file", path: "report.txt", wantLen: int64(len("report"))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, statErr := fys.Stat(tt.path)
			if statErr != nil {
				t.Fatalf("Stat: %v", statErr)
			}
			if info.IsDir() != tt.wantDir || (!tt.wantDir && info.Size() != tt.wantLen) {
				t.Fatalf("Stat(%q) = dir %v size %d, want dir %v size %d", tt.path, info.IsDir(), info.Size(), tt.wantDir, tt.wantLen)
			}
		})
	}
}

func TestLocalFSSurfacesSymlinkMode(t *testing.T) {
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "target.txt"), []byte("target"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Symlink("target.txt", filepath.Join(base, "link.txt")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}

	fys := NewLocalFS(base)
	entries, err := fys.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var link fs.DirEntry
	for _, entry := range entries {
		if entry.Name() == "link.txt" {
			link = entry
			break
		}
	}
	if link == nil || link.Type()&fs.ModeSymlink == 0 {
		t.Fatalf("link entry mode = %v, want symlink", link)
	}

	info, err := fys.Stat("link.txt")
	if err != nil {
		t.Fatalf("Stat symlink: %v", err)
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		t.Fatalf("Stat mode = %v, want symlink", info.Mode())
	}
}

func TestLocalFSRejectsPathEscapes(t *testing.T) {
	fys := NewLocalFS(t.TempDir())
	tests := []struct {
		name string
		call func() error
	}{
		{name: "ReadDir parent", call: func() error { _, err := fys.ReadDir(".."); return err }},
		{name: "Stat nested parent", call: func() error { _, err := fys.Stat(filepath.Join("dir", "..", "..", "outside")); return err }},
		{name: "Stat absolute", call: func() error { _, err := fys.Stat(filepath.Join(string(filepath.Separator), "outside")); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.call(); err == nil {
				t.Fatal("path escape accepted, want error")
			}
		})
	}
}

func TestWalkLocalFSIntegrationSkipsSymlink(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "alpha"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(base, "alpha", "report.txt"), []byte("report"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.WriteFile(filepath.Join(base, "zeta.txt"), []byte("zeta"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Symlink("alpha", filepath.Join(base, "linked-alpha")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}

	var got []string
	_, err := Walk(context.Background(), NewLocalFS(base), ".", WalkOptions{}, func(entry Entry) error {
		got = append(got, entry.RelPath)
		return nil
	})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if want := []string{"alpha", "alpha/report.txt", "zeta.txt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
}

func localDirEntryNames(entries []fs.DirEntry) []string {
	names := make([]string, len(entries))
	for i, entry := range entries {
		names[i] = entry.Name()
	}
	return names
}
