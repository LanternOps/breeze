package tools

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func decodeSuccessPayload(t *testing.T, result CommandResult, target any) {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %q: %s", result.Status, result.Error)
	}
	if err := json.Unmarshal([]byte(result.Stdout), target); err != nil {
		t.Fatalf("unmarshal success payload: %v", err)
	}
}

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

func TestDeleteFile_MovesToTrash(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	testFile := filepath.Join(tmpDir, "delete-me.txt")
	os.WriteFile(testFile, []byte("goodbye"), 0644)

	result := DeleteFile(map[string]any{"path": testFile})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	// File should be gone from original location
	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Error("file should have been removed from original location")
	}

	// Trash should have contents
	trashEntries, _ := os.ReadDir(filepath.Join(tmpDir, ".breeze-trash"))
	if len(trashEntries) == 0 {
		t.Error("trash directory should contain the deleted item")
	}
}

func TestListFilesCapsEntriesAndMarksTruncated(t *testing.T) {
	tmpDir := t.TempDir()
	for i := 0; i < 4; i++ {
		path := filepath.Join(tmpDir, strings.Repeat("a", i+1)+".txt")
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	result := ListFiles(map[string]any{
		"path":  tmpDir,
		"limit": 2,
	})

	var payload FileListResponse
	decodeSuccessPayload(t, result, &payload)

	if len(payload.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(payload.Entries))
	}
	if payload.Limit != 2 {
		t.Fatalf("expected limit 2, got %d", payload.Limit)
	}
	if !payload.Truncated {
		t.Fatal("expected listing to be marked truncated")
	}
}

func TestListFilesClampsLimit(t *testing.T) {
	tmpDir := t.TempDir()
	for i := 0; i < 3; i++ {
		path := filepath.Join(tmpDir, strings.Repeat("b", i+1)+".txt")
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	result := ListFiles(map[string]any{
		"path":  tmpDir,
		"limit": maxFileListLimit + 100,
	})

	var payload FileListResponse
	decodeSuccessPayload(t, result, &payload)

	if payload.Limit != maxFileListLimit {
		t.Fatalf("expected clamped limit %d, got %d", maxFileListLimit, payload.Limit)
	}
	if len(payload.Entries) != 3 {
		t.Fatalf("expected all 3 entries, got %d", len(payload.Entries))
	}
	if payload.Truncated {
		t.Fatal("expected small listing not to be truncated")
	}
}

func TestWriteFileRejectsOversizedTextPayload(t *testing.T) {
	tmpDir := t.TempDir()
	target := filepath.Join(tmpDir, "too-large.txt")

	result := WriteFile(map[string]any{
		"path":    target,
		"content": strings.Repeat("x", maxFileWriteSize+1),
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "file write payload too large") {
		t.Fatalf("unexpected error: %s", result.Error)
	}
}

func TestWriteFileRejectsOversizedBase64Payload(t *testing.T) {
	tmpDir := t.TempDir()
	target := filepath.Join(tmpDir, "too-large.bin")
	data := make([]byte, maxFileWriteSize+1)

	result := WriteFile(map[string]any{
		"path":     target,
		"encoding": "base64",
		"content":  base64.StdEncoding.EncodeToString(data),
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "file write payload too large") {
		t.Fatalf("unexpected error: %s", result.Error)
	}
}

func TestDeleteFile_PermanentSkipsTrash(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	testFile := filepath.Join(tmpDir, "perm-delete.txt")
	os.WriteFile(testFile, []byte("gone forever"), 0644)

	result := DeleteFile(map[string]any{"path": testFile, "permanent": true})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Error("file should have been permanently deleted")
	}

	trashDir := filepath.Join(tmpDir, ".breeze-trash")
	os.MkdirAll(trashDir, 0700)
	trashEntries, _ := os.ReadDir(trashDir)
	if len(trashEntries) != 0 {
		t.Error("trash should be empty for permanent delete")
	}
}

func TestTrashList(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	testFile := filepath.Join(tmpDir, "list-me.txt")
	os.WriteFile(testFile, []byte("listed"), 0644)
	DeleteFile(map[string]any{"path": testFile})

	result := TrashList(map[string]any{})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}
	// Verify stdout contains the original path
	if !strings.Contains(result.Stdout, testFile) {
		t.Errorf("trash list should contain original path %s, got: %s", testFile, result.Stdout)
	}
}

func TestTrashListTruncatesAndSkipsOversizedMetadata(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	trashDir := filepath.Join(tmpDir, ".breeze-trash")
	if err := os.MkdirAll(trashDir, 0o700); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < maxTrashListItems+5; i++ {
		itemDir := filepath.Join(trashDir, fmt.Sprintf("item-%03d", i))
		if err := os.MkdirAll(itemDir, 0o700); err != nil {
			t.Fatal(err)
		}
		meta := TrashMetadata{
			OriginalPath: filepath.Join(tmpDir, "f.txt"),
			TrashID:      filepath.Base(itemDir),
			DeletedAt:    time.Now().UTC().Format(time.RFC3339),
			IsDirectory:  false,
		}
		metaBytes, err := json.Marshal(meta)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), metaBytes, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	oversizedDir := filepath.Join(trashDir, "oversized")
	if err := os.MkdirAll(oversizedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oversizedDir, "metadata.json"), []byte(strings.Repeat("x", maxTrashMetadataSize+1)), 0o600); err != nil {
		t.Fatal(err)
	}

	result := TrashList(map[string]any{})
	var payload TrashListResponse
	decodeSuccessPayload(t, result, &payload)

	if !payload.Truncated {
		t.Fatal("expected trash list to be marked truncated")
	}
	if len(payload.Items) > maxTrashListItems {
		t.Fatalf("expected at most %d items, got %d", maxTrashListItems, len(payload.Items))
	}
}

func TestTrashRestore(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	testFile := filepath.Join(tmpDir, "restore-me.txt")
	os.WriteFile(testFile, []byte("restore this"), 0644)
	DeleteFile(map[string]any{"path": testFile})

	// Get the trash ID from the list
	listResult := TrashList(map[string]any{})
	if listResult.Status != "completed" {
		t.Fatalf("TrashList failed: %s", listResult.Error)
	}

	var listResp TrashListResponse
	if err := json.Unmarshal([]byte(listResult.Stdout), &listResp); err != nil {
		t.Fatalf("failed to parse trash list: %v", err)
	}
	if len(listResp.Items) == 0 {
		t.Fatal("expected at least one trash item")
	}

	trashID := listResp.Items[0].TrashID
	restoreResult := TrashRestore(map[string]any{"trashId": trashID})
	if restoreResult.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", restoreResult.Status, restoreResult.Error)
	}

	content, err := os.ReadFile(testFile)
	if err != nil {
		t.Fatalf("file should be restored: %v", err)
	}
	if string(content) != "restore this" {
		t.Errorf("expected 'restore this', got %q", string(content))
	}
}

func TestTrashPurge(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	testFile := filepath.Join(tmpDir, "purge-me.txt")
	os.WriteFile(testFile, []byte("purge this"), 0644)
	DeleteFile(map[string]any{"path": testFile})

	result := TrashPurge(map[string]any{})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	trashDir := filepath.Join(tmpDir, ".breeze-trash")
	entries, _ := os.ReadDir(trashDir)
	if len(entries) != 0 {
		t.Errorf("expected empty trash, got %d entries", len(entries))
	}
}
