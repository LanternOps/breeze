package providers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func TestLocalProvider_ImplementsInterface(t *testing.T) {
	var _ BackupProvider = (*LocalProvider)(nil)
}

func TestContainedPath_Valid(t *testing.T) {
	tests := []struct {
		base      string
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
		base      string
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
