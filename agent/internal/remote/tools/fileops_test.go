package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestCopyFile_SameSourceAndDest(t *testing.T) {
	tmpDir := t.TempDir()

	srcPath := filepath.Join(tmpDir, "same.txt")
	if err := os.WriteFile(srcPath, []byte("don't truncate me"), 0644); err != nil {
		t.Fatal(err)
	}

	result := CopyFile(map[string]any{
		"sourcePath": srcPath,
		"destPath":   srcPath,
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed for same source and dest, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "same path") {
		t.Errorf("error should mention same path, got: %s", result.Error)
	}

	// Verify original file is untouched
	content, err := os.ReadFile(srcPath)
	if err != nil {
		t.Fatalf("file should still exist: %v", err)
	}
	if string(content) != "don't truncate me" {
		t.Errorf("file content was corrupted: got %q", string(content))
	}
}

func TestCopyFile_DirectoryIntoItself(t *testing.T) {
	tmpDir := t.TempDir()
	srcDir := filepath.Join(tmpDir, "src")
	os.MkdirAll(srcDir, 0755)
	os.WriteFile(filepath.Join(srcDir, "file.txt"), []byte("hello"), 0644)

	destDir := filepath.Join(srcDir, "nested-copy")

	result := CopyFile(map[string]any{
		"sourcePath": srcDir,
		"destPath":   destDir,
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed for copy into self, got %q", result.Status)
	}
	if !strings.Contains(result.Error, "into itself") {
		t.Errorf("error should mention copying into itself, got: %s", result.Error)
	}
}

func TestTrashRestore_PathTraversalInTrashId(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	// Attempt path traversal via trashId
	result := TrashRestore(map[string]any{
		"trashId": "../../etc/passwd",
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed for path traversal trashId, got %q", result.Status)
	}
	// The sanitized ID should be "passwd" (filepath.Base), not the traversal path
	if strings.Contains(result.Error, "etc") {
		t.Errorf("error should not reference traversal path components, got: %s", result.Error)
	}
}

func TestTrashPurge_SpecificItems(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	// Delete two files to create two trash entries
	file1 := filepath.Join(tmpDir, "purge-specific-1.txt")
	file2 := filepath.Join(tmpDir, "purge-specific-2.txt")
	os.WriteFile(file1, []byte("one"), 0644)
	os.WriteFile(file2, []byte("two"), 0644)

	DeleteFile(map[string]any{"path": file1})
	DeleteFile(map[string]any{"path": file2})

	// Get trash IDs
	listResult := TrashList(map[string]any{})
	if listResult.Status != "completed" {
		t.Fatalf("TrashList failed: %s", listResult.Error)
	}
	var listResp TrashListResponse
	if err := json.Unmarshal([]byte(listResult.Stdout), &listResp); err != nil {
		t.Fatalf("failed to parse trash list: %v", err)
	}
	if len(listResp.Items) < 2 {
		t.Fatalf("expected at least 2 trash items, got %d", len(listResp.Items))
	}

	// Purge only the first item
	purgeResult := TrashPurge(map[string]any{
		"trashIds": []any{listResp.Items[0].TrashID},
	})
	if purgeResult.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", purgeResult.Status, purgeResult.Error)
	}

	// Verify only one item remains
	listResult2 := TrashList(map[string]any{})
	var listResp2 TrashListResponse
	json.Unmarshal([]byte(listResult2.Stdout), &listResp2)
	if len(listResp2.Items) != 1 {
		t.Errorf("expected 1 item after selective purge, got %d", len(listResp2.Items))
	}
}

func TestDeleteFile_DirectoryToTrash(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	// Create a directory with files
	dirPath := filepath.Join(tmpDir, "test-dir")
	os.MkdirAll(filepath.Join(dirPath, "sub"), 0755)
	os.WriteFile(filepath.Join(dirPath, "file1.txt"), []byte("hello"), 0644)
	os.WriteFile(filepath.Join(dirPath, "sub", "file2.txt"), []byte("world"), 0644)

	result := DeleteFile(map[string]any{"path": dirPath, "recursive": true})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	// Directory should be gone
	if _, err := os.Stat(dirPath); !os.IsNotExist(err) {
		t.Error("directory should have been removed from original location")
	}

	// Verify trash has the item with correct metadata
	listResult := TrashList(map[string]any{})
	var listResp TrashListResponse
	json.Unmarshal([]byte(listResult.Stdout), &listResp)
	if len(listResp.Items) == 0 {
		t.Fatal("expected trash item for deleted directory")
	}
	if !listResp.Items[0].IsDirectory {
		t.Error("trash metadata should indicate isDirectory=true")
	}
	if listResp.Items[0].OriginalPath != dirPath {
		t.Errorf("original path mismatch: got %q, want %q", listResp.Items[0].OriginalPath, dirPath)
	}
}
