package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFile_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()

	// Create a source file with known content
	srcPath := filepath.Join(tmpDir, "source.txt")
	content := []byte("hello copy test")
	if err := os.WriteFile(srcPath, content, 0644); err != nil {
		t.Fatal(err)
	}

	dstPath := filepath.Join(tmpDir, "destination.txt")

	result := CopyFile(map[string]any{
		"sourcePath": srcPath,
		"destPath":   dstPath,
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %q; error: %s", result.Status, result.Error)
	}

	// Verify destination file exists and content matches
	got, err := os.ReadFile(dstPath)
	if err != nil {
		t.Fatalf("failed to read destination: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content mismatch: got %q, want %q", string(got), string(content))
	}

	// Verify source file still exists (it's a copy, not a move)
	if _, err := os.Stat(srcPath); err != nil {
		t.Fatalf("source file should still exist: %v", err)
	}
}

func TestCopyFile_Directory(t *testing.T) {
	tmpDir := t.TempDir()

	// Build a source directory tree:
	// src/
	//   file1.txt
	//   sub/
	//     file2.txt
	srcDir := filepath.Join(tmpDir, "src")
	subDir := filepath.Join(srcDir, "sub")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "file1.txt"), []byte("file1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "file2.txt"), []byte("file2"), 0755); err != nil {
		t.Fatal(err)
	}

	dstDir := filepath.Join(tmpDir, "dst")

	result := CopyFile(map[string]any{
		"sourcePath": srcDir,
		"destPath":   dstDir,
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %q; error: %s", result.Status, result.Error)
	}

	// Verify all files were copied
	got1, err := os.ReadFile(filepath.Join(dstDir, "file1.txt"))
	if err != nil {
		t.Fatalf("failed to read copied file1.txt: %v", err)
	}
	if string(got1) != "file1" {
		t.Fatalf("file1.txt content mismatch: got %q", string(got1))
	}

	got2, err := os.ReadFile(filepath.Join(dstDir, "sub", "file2.txt"))
	if err != nil {
		t.Fatalf("failed to read copied sub/file2.txt: %v", err)
	}
	if string(got2) != "file2" {
		t.Fatalf("file2.txt content mismatch: got %q", string(got2))
	}

	// Verify the subdirectory was created
	info, err := os.Stat(filepath.Join(dstDir, "sub"))
	if err != nil {
		t.Fatalf("sub directory should exist: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("sub should be a directory")
	}
}

func TestCopyFile_MissingSource(t *testing.T) {
	tmpDir := t.TempDir()

	result := CopyFile(map[string]any{
		"sourcePath": filepath.Join(tmpDir, "nonexistent.txt"),
		"destPath":   filepath.Join(tmpDir, "dst.txt"),
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}
}

func TestCopyFile_DeniedSystemPath(t *testing.T) {
	tmpDir := t.TempDir()

	// Copying FROM a denied system path should fail
	result := CopyFile(map[string]any{
		"sourcePath": "/",
		"destPath":   filepath.Join(tmpDir, "dst"),
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed status for denied source, got %q", result.Status)
	}

	// Copying TO a denied system path should also fail
	srcPath := filepath.Join(tmpDir, "src.txt")
	os.WriteFile(srcPath, []byte("test"), 0644)

	result2 := CopyFile(map[string]any{
		"sourcePath": srcPath,
		"destPath":   "/",
	})

	if result2.Status != "failed" {
		t.Fatalf("expected failed status for denied dest, got %q", result2.Status)
	}
}

func TestCopyFile_MissingParams(t *testing.T) {
	// Empty payload
	result := CopyFile(map[string]any{})

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result.Status)
	}

	// Only sourcePath
	result2 := CopyFile(map[string]any{
		"sourcePath": "/tmp/something",
	})

	if result2.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result2.Status)
	}

	// Only destPath
	result3 := CopyFile(map[string]any{
		"destPath": "/tmp/something",
	})

	if result3.Status != "failed" {
		t.Fatalf("expected failed status, got %q", result3.Status)
	}
}
