package providers

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewLocalProvider(t *testing.T) {
	p := NewLocalProvider("/tmp/backups")
	if p == nil {
		t.Fatal("NewLocalProvider returned nil")
	}
	if p.BasePath != "/tmp/backups" {
		t.Errorf("BasePath = %q, want %q", p.BasePath, "/tmp/backups")
	}
}

func TestNewLocalProvider_CleansPath(t *testing.T) {
	p := NewLocalProvider("/tmp/backups/../backups/")
	if p.BasePath != "/tmp/backups" {
		t.Errorf("BasePath = %q, want %q", p.BasePath, "/tmp/backups")
	}
}

func TestLocalProvider_UploadAndDownload_PlainFile(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create a source file
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.txt")
	content := []byte("hello local provider")
	if err := os.WriteFile(srcPath, content, 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	// Upload (non-gz path => plain copy)
	if err := p.Upload(srcPath, "backups/data.txt"); err != nil {
		t.Fatalf("Upload failed: %v", err)
	}

	// Verify file exists in the backup store
	destPath := filepath.Join(baseDir, "backups", "data.txt")
	stored, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("file not found in backup store: %v", err)
	}
	if !bytes.Equal(content, stored) {
		t.Fatalf("stored content mismatch: got %q", string(stored))
	}

	// Download
	downloadDir := t.TempDir()
	downloadPath := filepath.Join(downloadDir, "downloaded.txt")
	if err := p.Download("backups/data.txt", downloadPath); err != nil {
		t.Fatalf("Download failed: %v", err)
	}

	downloaded, err := os.ReadFile(downloadPath)
	if err != nil {
		t.Fatalf("failed to read downloaded: %v", err)
	}
	if !bytes.Equal(content, downloaded) {
		t.Fatalf("downloaded content mismatch: got %q", string(downloaded))
	}
}

func TestLocalProvider_UploadAndDownload_GzipFile(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create a source file
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.txt")
	content := []byte("gzip compressed backup data")
	if err := os.WriteFile(srcPath, content, 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	// Upload with .gz extension => compressed
	if err := p.Upload(srcPath, "backups/data.txt.gz"); err != nil {
		t.Fatalf("Upload failed: %v", err)
	}

	// Verify the stored file is actually gzip-compressed
	destPath := filepath.Join(baseDir, "backups", "data.txt.gz")
	stored, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("gz file not found: %v", err)
	}
	// First two bytes of gzip are 0x1f 0x8b
	if len(stored) < 2 || stored[0] != 0x1f || stored[1] != 0x8b {
		t.Error("stored file does not appear to be gzip format")
	}

	// Download should decompress
	downloadDir := t.TempDir()
	downloadPath := filepath.Join(downloadDir, "restored.txt")
	if err := p.Download("backups/data.txt.gz", downloadPath); err != nil {
		t.Fatalf("Download failed: %v", err)
	}

	downloaded, err := os.ReadFile(downloadPath)
	if err != nil {
		t.Fatalf("failed to read downloaded: %v", err)
	}
	if !bytes.Equal(content, downloaded) {
		t.Fatalf("downloaded content mismatch after decompression: got %q", string(downloaded))
	}
}

func TestLocalProvider_Upload_EmptyBasePath(t *testing.T) {
	p := &LocalProvider{BasePath: ""}
	err := p.Upload("/tmp/src", "dest")
	if err == nil {
		t.Fatal("expected error for empty base path")
	}
	if !strings.Contains(err.Error(), "base path is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLocalProvider_Upload_EmptyLocalPath(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Upload("", "dest")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
	if !strings.Contains(err.Error(), "local source path is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLocalProvider_Upload_EmptyRemotePath(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Upload("/tmp/src", "")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
	if !strings.Contains(err.Error(), "remote path is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLocalProvider_Upload_SourceNotFound(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Upload("/nonexistent/file.txt", "backup.txt")
	if err == nil {
		t.Fatal("expected error for nonexistent source")
	}
}

func TestLocalProvider_Upload_PathTraversal(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.txt")
	os.WriteFile(srcPath, []byte("evil"), 0644)

	err := p.Upload(srcPath, "../../etc/passwd")
	if err == nil {
		t.Fatal("expected error for path traversal")
	}
	if !strings.Contains(err.Error(), "path traversal") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLocalProvider_Download_EmptyBasePath(t *testing.T) {
	p := &LocalProvider{BasePath: ""}
	err := p.Download("src", "/tmp/dest")
	if err == nil {
		t.Fatal("expected error for empty base path")
	}
}

func TestLocalProvider_Download_EmptyRemotePath(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Download("", "/tmp/dest")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestLocalProvider_Download_EmptyLocalPath(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Download("src", "")
	if err == nil {
		t.Fatal("expected error for empty local path")
	}
}

func TestLocalProvider_Download_PathTraversal(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Download("../../etc/shadow", "/tmp/stolen")
	if err == nil {
		t.Fatal("expected error for path traversal in download")
	}
	if !strings.Contains(err.Error(), "path traversal") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLocalProvider_Download_FileNotFound(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Download("nonexistent.txt", filepath.Join(t.TempDir(), "out.txt"))
	if err == nil {
		t.Fatal("expected error for nonexistent remote file")
	}
}

func TestLocalProvider_List_Empty(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	items, err := p.List("snapshots")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected 0 items, got %d", len(items))
	}
}

func TestLocalProvider_List_WithFiles(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create some files in the backup store
	dir := filepath.Join(baseDir, "snapshots", "snap1", "files")
	os.MkdirAll(dir, 0755)
	os.WriteFile(filepath.Join(dir, "a.gz"), []byte("a"), 0644)
	os.WriteFile(filepath.Join(dir, "b.gz"), []byte("b"), 0644)
	os.WriteFile(filepath.Join(baseDir, "snapshots", "snap1", "manifest.json"), []byte("{}"), 0644)

	items, err := p.List("snapshots")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d: %v", len(items), items)
	}

	// All paths should use forward slashes
	for _, item := range items {
		if strings.Contains(item, "\\") {
			t.Errorf("item path contains backslash: %q", item)
		}
	}
}

func TestLocalProvider_List_EmptyBasePath(t *testing.T) {
	p := &LocalProvider{BasePath: ""}
	_, err := p.List("prefix")
	if err == nil {
		t.Fatal("expected error for empty base path")
	}
}

func TestLocalProvider_List_PathTraversal(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	_, err := p.List("../../etc")
	if err == nil {
		t.Fatal("expected error for path traversal in list")
	}
}

func TestLocalProvider_Delete(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create a file
	dir := filepath.Join(baseDir, "snapshots", "snap1")
	os.MkdirAll(dir, 0755)
	filePath := filepath.Join(dir, "data.gz")
	os.WriteFile(filePath, []byte("to delete"), 0644)

	err := p.Delete("snapshots/snap1/data.gz")
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	// Verify file is gone
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Error("file should be deleted")
	}
}

func TestLocalProvider_Delete_NonexistentFile(t *testing.T) {
	p := NewLocalProvider(t.TempDir())

	// Should not error when file doesn't exist
	err := p.Delete("nonexistent/file.gz")
	if err != nil {
		t.Fatalf("Delete should not error for nonexistent file: %v", err)
	}
}

func TestLocalProvider_Delete_EmptyBasePath(t *testing.T) {
	p := &LocalProvider{BasePath: ""}
	err := p.Delete("file")
	if err == nil {
		t.Fatal("expected error for empty base path")
	}
}

func TestLocalProvider_Delete_EmptyRemotePath(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Delete("")
	if err == nil {
		t.Fatal("expected error for empty remote path")
	}
}

func TestLocalProvider_Delete_PathTraversal(t *testing.T) {
	p := NewLocalProvider(t.TempDir())
	err := p.Delete("../../etc/important")
	if err == nil {
		t.Fatal("expected error for path traversal in delete")
	}
}

func TestLocalProvider_Delete_CleansEmptyDirs(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create a nested file
	dir := filepath.Join(baseDir, "snapshots", "snap1", "files")
	os.MkdirAll(dir, 0755)
	os.WriteFile(filepath.Join(dir, "data.gz"), []byte("data"), 0644)

	err := p.Delete("snapshots/snap1/files/data.gz")
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	// Empty parent directories should be cleaned up
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("empty 'files' directory should be cleaned up")
	}
}

func TestLocalProvider_ImplementsInterface(t *testing.T) {
	var _ BackupProvider = (*LocalProvider)(nil)
}

func TestContainedPath_Valid(t *testing.T) {
	tests := []struct {
		base     string
		untrusted string
	}{
		{"/base", "sub/file.txt"},
		{"/base", "a/b/c.gz"},
		{"/base", "file.txt"},
	}

	for _, tt := range tests {
		result, err := containedPath(tt.base, tt.untrusted)
		if err != nil {
			t.Errorf("containedPath(%q, %q) error: %v", tt.base, tt.untrusted, err)
		}
		if !strings.HasPrefix(result, tt.base) {
			t.Errorf("containedPath(%q, %q) = %q, not under base", tt.base, tt.untrusted, result)
		}
	}
}

func TestContainedPath_Traversal(t *testing.T) {
	tests := []struct {
		base     string
		untrusted string
	}{
		{"/base", "../etc/passwd"},
		{"/base", "../../root/.ssh/id_rsa"},
		{"/base", "sub/../../etc/shadow"},
	}

	for _, tt := range tests {
		_, err := containedPath(tt.base, tt.untrusted)
		if err == nil {
			t.Errorf("containedPath(%q, %q) should fail for path traversal", tt.base, tt.untrusted)
		}
	}
}

func TestLocalProvider_Upload_LargeFile(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "large.bin")

	// 1 MB of data
	data := bytes.Repeat([]byte("backup"), 170000)
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("failed to write large file: %v", err)
	}

	if err := p.Upload(srcPath, "large.bin.gz"); err != nil {
		t.Fatalf("Upload failed: %v", err)
	}

	// Download and verify round-trip
	downloadPath := filepath.Join(t.TempDir(), "restored.bin")
	if err := p.Download("large.bin.gz", downloadPath); err != nil {
		t.Fatalf("Download failed: %v", err)
	}

	restored, err := os.ReadFile(downloadPath)
	if err != nil {
		t.Fatalf("failed to read restored: %v", err)
	}
	if !bytes.Equal(data, restored) {
		t.Fatal("large file content mismatch after round-trip")
	}
}

func TestLocalProvider_Upload_PreservesModTime_PlainCopy(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "timed.txt")
	if err := os.WriteFile(srcPath, []byte("check modtime"), 0644); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	srcInfo, _ := os.Stat(srcPath)

	if err := p.Upload(srcPath, "timed.txt"); err != nil {
		t.Fatalf("Upload failed: %v", err)
	}

	destPath := filepath.Join(baseDir, "timed.txt")
	destInfo, err := os.Stat(destPath)
	if err != nil {
		t.Fatalf("dest not found: %v", err)
	}

	if !srcInfo.ModTime().Equal(destInfo.ModTime()) {
		t.Errorf("modtime not preserved: src=%v dest=%v", srcInfo.ModTime(), destInfo.ModTime())
	}
}

func TestLocalProvider_GzipRoundTrip_PreservesName(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "original_name.txt")
	if err := os.WriteFile(srcPath, []byte("name preservation"), 0644); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	if err := p.Upload(srcPath, "backup/original_name.txt.gz"); err != nil {
		t.Fatalf("Upload failed: %v", err)
	}

	// Verify the gzip header contains the original filename
	gzPath := filepath.Join(baseDir, "backup", "original_name.txt.gz")
	f, err := os.Open(gzPath)
	if err != nil {
		t.Fatalf("failed to open gz: %v", err)
	}
	defer f.Close()

	reader, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("failed to create gzip reader: %v", err)
	}
	defer reader.Close()

	if reader.Name != "original_name.txt" {
		t.Errorf("gzip Name = %q, want %q", reader.Name, "original_name.txt")
	}
}

func TestLocalProvider_List_WithPrefix(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	// Create files under different prefixes
	os.MkdirAll(filepath.Join(baseDir, "snapshots", "snap1"), 0755)
	os.MkdirAll(filepath.Join(baseDir, "snapshots", "snap2"), 0755)
	os.MkdirAll(filepath.Join(baseDir, "other"), 0755)

	os.WriteFile(filepath.Join(baseDir, "snapshots", "snap1", "a.gz"), []byte("a"), 0644)
	os.WriteFile(filepath.Join(baseDir, "snapshots", "snap2", "b.gz"), []byte("b"), 0644)
	os.WriteFile(filepath.Join(baseDir, "other", "c.txt"), []byte("c"), 0644)

	// List under "snapshots/snap1" prefix
	items, err := p.List("snapshots/snap1")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item under snap1, got %d: %v", len(items), items)
	}

	// List under "snapshots" prefix
	allSnaps, err := p.List("snapshots")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(allSnaps) != 2 {
		t.Fatalf("expected 2 items under snapshots, got %d: %v", len(allSnaps), allSnaps)
	}
}

func TestLocalProvider_List_EmptyPrefix(t *testing.T) {
	baseDir := t.TempDir()
	p := NewLocalProvider(baseDir)

	os.WriteFile(filepath.Join(baseDir, "root_file.txt"), []byte("root"), 0644)
	os.MkdirAll(filepath.Join(baseDir, "sub"), 0755)
	os.WriteFile(filepath.Join(baseDir, "sub", "nested.txt"), []byte("nested"), 0644)

	items, err := p.List("")
	if err != nil {
		t.Fatalf("List with empty prefix failed: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %v", len(items), items)
	}
}
