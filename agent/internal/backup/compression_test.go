package backup

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompressFile_RoundTrip(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "input.txt")
	gzPath := filepath.Join(tmpDir, "output.gz")
	outPath := filepath.Join(tmpDir, "restored.txt")

	content := []byte("hello breeze backup compression test")
	if err := os.WriteFile(srcPath, content, 0644); err != nil {
		t.Fatalf("failed to write source file: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed: %v", err)
	}

	// Verify compressed file exists and is valid gzip
	gzData, err := os.ReadFile(gzPath)
	if err != nil {
		t.Fatalf("failed to read compressed file: %v", err)
	}
	if len(gzData) == 0 {
		t.Fatal("compressed file is empty")
	}

	if err := DecompressFile(gzPath, outPath); err != nil {
		t.Fatalf("DecompressFile failed: %v", err)
	}

	restored, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read restored file: %v", err)
	}
	if !bytes.Equal(content, restored) {
		t.Fatalf("content mismatch: got %q, want %q", string(restored), string(content))
	}
}

func TestCompressFile_PreservesGzipMetadata(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "data.txt")
	gzPath := filepath.Join(tmpDir, "data.gz")

	if err := os.WriteFile(srcPath, []byte("metadata test"), 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed: %v", err)
	}

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

	if reader.Name != "data.txt" {
		t.Errorf("gzip Name = %q, want %q", reader.Name, "data.txt")
	}
	if reader.ModTime.IsZero() {
		t.Error("gzip ModTime should not be zero")
	}
}

func TestCompressFile_SourceNotFound(t *testing.T) {
	tmpDir := t.TempDir()
	err := CompressFile(filepath.Join(tmpDir, "nonexistent.txt"), filepath.Join(tmpDir, "out.gz"))
	if err == nil {
		t.Fatal("expected error for nonexistent source file")
	}
	if !strings.Contains(err.Error(), "failed to open source file") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestCompressFile_InvalidDestDir(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "input.txt")
	if err := os.WriteFile(srcPath, []byte("data"), 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	// Use a path where MkdirAll should fail (file in place of directory)
	blockerPath := filepath.Join(tmpDir, "blocker")
	if err := os.WriteFile(blockerPath, []byte("not a dir"), 0644); err != nil {
		t.Fatalf("failed to create blocker: %v", err)
	}
	destPath := filepath.Join(blockerPath, "subdir", "out.gz")

	err := CompressFile(srcPath, destPath)
	if err == nil {
		t.Fatal("expected error when destination directory cannot be created")
	}
}

func TestCompressFile_EmptyFile(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "empty.txt")
	gzPath := filepath.Join(tmpDir, "empty.gz")
	outPath := filepath.Join(tmpDir, "restored.txt")

	if err := os.WriteFile(srcPath, []byte{}, 0644); err != nil {
		t.Fatalf("failed to write empty file: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed on empty file: %v", err)
	}

	if err := DecompressFile(gzPath, outPath); err != nil {
		t.Fatalf("DecompressFile failed on empty file: %v", err)
	}

	restored, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read restored: %v", err)
	}
	if len(restored) != 0 {
		t.Fatalf("expected empty restored file, got %d bytes", len(restored))
	}
}

func TestCompressFile_LargeFile(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "large.bin")
	gzPath := filepath.Join(tmpDir, "large.bin.gz")
	outPath := filepath.Join(tmpDir, "large_restored.bin")

	// 1 MB of repeating data (compresses well)
	data := bytes.Repeat([]byte("breeze-rmm-backup-data\n"), 45000)
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("failed to write large file: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed on large file: %v", err)
	}

	// Compressed should be smaller than original
	srcInfo, _ := os.Stat(srcPath)
	gzInfo, _ := os.Stat(gzPath)
	if gzInfo.Size() >= srcInfo.Size() {
		t.Errorf("compressed size %d >= original size %d", gzInfo.Size(), srcInfo.Size())
	}

	if err := DecompressFile(gzPath, outPath); err != nil {
		t.Fatalf("DecompressFile failed on large file: %v", err)
	}

	restored, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read restored: %v", err)
	}
	if !bytes.Equal(data, restored) {
		t.Fatal("large file content mismatch after round-trip")
	}
}

func TestCompressFile_CreatesDestDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "input.txt")
	gzPath := filepath.Join(tmpDir, "deep", "nested", "dir", "output.gz")

	if err := os.WriteFile(srcPath, []byte("nested dir test"), 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile should create nested directories: %v", err)
	}

	if _, err := os.Stat(gzPath); err != nil {
		t.Fatalf("compressed file not created: %v", err)
	}
}

func TestDecompressFile_SourceNotFound(t *testing.T) {
	tmpDir := t.TempDir()
	err := DecompressFile(filepath.Join(tmpDir, "nonexistent.gz"), filepath.Join(tmpDir, "out.txt"))
	if err == nil {
		t.Fatal("expected error for nonexistent source")
	}
	if !strings.Contains(err.Error(), "failed to open source file") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDecompressFile_InvalidGzip(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "invalid.gz")
	if err := os.WriteFile(srcPath, []byte("this is not gzip"), 0644); err != nil {
		t.Fatalf("failed to write invalid gz: %v", err)
	}

	err := DecompressFile(srcPath, filepath.Join(tmpDir, "out.txt"))
	if err == nil {
		t.Fatal("expected error for invalid gzip file")
	}
	if !strings.Contains(err.Error(), "failed to create gzip reader") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDecompressFile_CreatesDestDirectory(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "input.txt")
	gzPath := filepath.Join(tmpDir, "input.gz")
	outPath := filepath.Join(tmpDir, "deep", "nested", "restored.txt")

	if err := os.WriteFile(srcPath, []byte("nested decompress"), 0644); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}
	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed: %v", err)
	}

	if err := DecompressFile(gzPath, outPath); err != nil {
		t.Fatalf("DecompressFile should create nested directories: %v", err)
	}

	restored, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read restored: %v", err)
	}
	if string(restored) != "nested decompress" {
		t.Fatalf("content mismatch: %q", string(restored))
	}
}

func TestDecompressFile_BinaryContent(t *testing.T) {
	tmpDir := t.TempDir()
	srcPath := filepath.Join(tmpDir, "binary.bin")
	gzPath := filepath.Join(tmpDir, "binary.bin.gz")
	outPath := filepath.Join(tmpDir, "binary_restored.bin")

	// Binary content with null bytes and all byte values
	data := make([]byte, 256)
	for i := range data {
		data[i] = byte(i)
	}
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("failed to write binary file: %v", err)
	}

	if err := CompressFile(srcPath, gzPath); err != nil {
		t.Fatalf("CompressFile failed: %v", err)
	}

	if err := DecompressFile(gzPath, outPath); err != nil {
		t.Fatalf("DecompressFile failed: %v", err)
	}

	restored, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read restored: %v", err)
	}
	if !bytes.Equal(data, restored) {
		t.Fatal("binary content mismatch after round-trip")
	}
}
