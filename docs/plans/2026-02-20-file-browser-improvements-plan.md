# File Browser Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add copy, move, delete (with recycle bin), and trash management to the file browser, with full audit logging and batch operations.

**Architecture:** Agent-side operations with a `.breeze-trash/` recycle bin on each device. API routes delegate to agent commands via the existing command queue. Frontend adds multi-select, context menu, folder picker dialog, trash view, and activity panel.

**Tech Stack:** Go (agent), TypeScript/Hono (API), React/Tailwind (frontend), Zod (validation), Drizzle (ORM), Vitest (API tests)

---

## Task 1: Agent — Add `file_copy` Command Constants and Types

**Files:**
- Modify: `agent/internal/remote/tools/types.go:99-106` (add constant)

**Step 1: Add the new command constants**

In `agent/internal/remote/tools/types.go`, add after `CmdFileRename` (line 105):

```go
CmdFileCopy         = "file_copy"
CmdFileTrashList    = "file_trash_list"
CmdFileTrashRestore = "file_trash_restore"
CmdFileTrashPurge   = "file_trash_purge"
```

**Step 2: Add trash metadata type**

In `agent/internal/remote/tools/types.go`, add after the `FileListResponse` struct (line 336):

```go
// TrashMetadata stores info about a trashed item for restore/audit purposes.
type TrashMetadata struct {
	OriginalPath string `json:"originalPath"`
	TrashID      string `json:"trashId"`
	DeletedAt    string `json:"deletedAt"`
	DeletedBy    string `json:"deletedBy,omitempty"`
	IsDirectory  bool   `json:"isDirectory"`
	SizeBytes    int64  `json:"sizeBytes"`
}

// TrashListResponse is the response for listing trash contents.
type TrashListResponse struct {
	Items []TrashMetadata `json:"items"`
	Path  string          `json:"path"`
}
```

**Step 3: Verify agent compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go build ./...`
Expected: SUCCESS (no errors)

**Step 4: Commit**

```bash
git add agent/internal/remote/tools/types.go
git commit -m "feat(agent): add file_copy and trash command constants and types"
```

---

## Task 2: Agent — Implement `CopyFile` Function

**Files:**
- Modify: `agent/internal/remote/tools/fileops.go` (add CopyFile function)
- Create: `agent/internal/remote/tools/fileops_test.go` (tests)

**Step 1: Write the failing test**

Create `agent/internal/remote/tools/fileops_test.go`:

```go
package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFile_SingleFile(t *testing.T) {
	tmpDir := t.TempDir()
	srcFile := filepath.Join(tmpDir, "source.txt")
	destFile := filepath.Join(tmpDir, "dest.txt")

	if err := os.WriteFile(srcFile, []byte("hello world"), 0644); err != nil {
		t.Fatalf("failed to create source file: %v", err)
	}

	result := CopyFile(map[string]any{
		"sourcePath": srcFile,
		"destPath":   destFile,
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	content, err := os.ReadFile(destFile)
	if err != nil {
		t.Fatalf("failed to read dest file: %v", err)
	}
	if string(content) != "hello world" {
		t.Errorf("expected 'hello world', got %q", string(content))
	}
}

func TestCopyFile_Directory(t *testing.T) {
	tmpDir := t.TempDir()
	srcDir := filepath.Join(tmpDir, "srcdir")
	destDir := filepath.Join(tmpDir, "destdir")
	os.MkdirAll(filepath.Join(srcDir, "sub"), 0755)
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("aaa"), 0644)
	os.WriteFile(filepath.Join(srcDir, "sub", "b.txt"), []byte("bbb"), 0644)

	result := CopyFile(map[string]any{
		"sourcePath": srcDir,
		"destPath":   destDir,
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
	}

	content, _ := os.ReadFile(filepath.Join(destDir, "a.txt"))
	if string(content) != "aaa" {
		t.Errorf("expected 'aaa', got %q", string(content))
	}
	content, _ = os.ReadFile(filepath.Join(destDir, "sub", "b.txt"))
	if string(content) != "bbb" {
		t.Errorf("expected 'bbb', got %q", string(content))
	}
}

func TestCopyFile_MissingSource(t *testing.T) {
	tmpDir := t.TempDir()
	result := CopyFile(map[string]any{
		"sourcePath": filepath.Join(tmpDir, "nonexistent"),
		"destPath":   filepath.Join(tmpDir, "dest"),
	})

	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

func TestCopyFile_DeniedSystemPath(t *testing.T) {
	result := CopyFile(map[string]any{
		"sourcePath": "/",
		"destPath":   "/tmp/bad",
	})

	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

func TestCopyFile_MissingParams(t *testing.T) {
	result := CopyFile(map[string]any{})
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}

	result = CopyFile(map[string]any{"sourcePath": "/tmp/a"})
	if result.Status != "failed" {
		t.Errorf("expected failed for missing destPath, got %s", result.Status)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go test ./internal/remote/tools/ -run TestCopyFile -v`
Expected: FAIL with "undefined: CopyFile"

**Step 3: Implement CopyFile**

Add to `agent/internal/remote/tools/fileops.go` after `RenameFile`:

```go
// CopyFile copies a file or directory to a new location on the same device.
func CopyFile(payload map[string]any) CommandResult {
	start := time.Now()

	sourcePath := GetPayloadString(payload, "sourcePath", "")
	if sourcePath == "" {
		return NewErrorResult(fmt.Errorf("sourcePath is required"), time.Since(start).Milliseconds())
	}

	destPath := GetPayloadString(payload, "destPath", "")
	if destPath == "" {
		return NewErrorResult(fmt.Errorf("destPath is required"), time.Since(start).Milliseconds())
	}

	cleanSource := filepath.Clean(sourcePath)
	cleanDest := filepath.Clean(destPath)

	if isDeniedSystemPath(cleanSource) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanSource), time.Since(start).Milliseconds())
	}
	if isDeniedSystemPath(cleanDest) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanDest), time.Since(start).Milliseconds())
	}

	info, err := os.Stat(cleanSource)
	if err != nil {
		return NewErrorResult(fmt.Errorf("source path error: %w", err), time.Since(start).Milliseconds())
	}

	if info.IsDir() {
		err = copyDir(cleanSource, cleanDest)
	} else {
		err = copyFile(cleanSource, cleanDest, info.Mode())
	}

	if err != nil {
		return NewErrorResult(fmt.Errorf("copy failed: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"sourcePath": cleanSource,
		"destPath":   cleanDest,
		"copied":     true,
	}, time.Since(start).Milliseconds())
}

// copyFile copies a single file preserving permissions.
func copyFile(src, dst string, mode os.FileMode) error {
	parentDir := filepath.Dir(dst)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("failed to create parent dir: %w", err)
	}

	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}
	return nil
}

// copyDir recursively copies a directory tree.
func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}

	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		destPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(destPath, info.Mode())
		}
		return copyFile(path, destPath, info.Mode())
	})
}
```

Also add `"io"` to the imports at the top of `fileops.go`.

**Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go test ./internal/remote/tools/ -run TestCopyFile -v`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add agent/internal/remote/tools/fileops.go agent/internal/remote/tools/fileops_test.go
git commit -m "feat(agent): implement CopyFile with recursive directory support"
```

---

## Task 3: Agent — Implement Trash-Based Delete

**Files:**
- Modify: `agent/internal/remote/tools/fileops.go` (rewrite DeleteFile, add trash functions)
- Modify: `agent/internal/remote/tools/fileops_test.go` (add trash tests)

**Step 1: Write the failing tests**

Add to `agent/internal/remote/tools/fileops_test.go`:

```go
func TestDeleteFile_MovesToTrash(t *testing.T) {
	tmpDir := t.TempDir()
	// Override trash dir for testing
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

	// File should be gone
	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Error("file should have been permanently deleted")
	}

	// Trash should be empty
	trashEntries, _ := os.ReadDir(filepath.Join(tmpDir, ".breeze-trash"))
	if len(trashEntries) != 0 {
		t.Error("trash should be empty for permanent delete")
	}
}

func TestTrashList(t *testing.T) {
	tmpDir := t.TempDir()
	origGetTrashDir := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(tmpDir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = origGetTrashDir }()

	// Delete a file to trash first
	testFile := filepath.Join(tmpDir, "list-me.txt")
	os.WriteFile(testFile, []byte("listed"), 0644)
	DeleteFile(map[string]any{"path": testFile})

	result := TrashList(map[string]any{})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s: %s", result.Status, result.Error)
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

	// Get the trash ID
	listResult := TrashList(map[string]any{})
	if listResult.Status != "completed" {
		t.Fatalf("TrashList failed: %s", listResult.Error)
	}

	// Parse the trash list to find the ID
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

	// File should be back
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

	// Trash should be empty
	trashDir := filepath.Join(tmpDir, ".breeze-trash")
	entries, _ := os.ReadDir(trashDir)
	if len(entries) != 0 {
		t.Errorf("expected empty trash, got %d entries", len(entries))
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go test ./internal/remote/tools/ -run "TestDeleteFile_MovesToTrash|TestDeleteFile_PermanentSkipsTrash|TestTrashList|TestTrashRestore|TestTrashPurge" -v`
Expected: FAIL (functions/variables not defined)

**Step 3: Implement trash-based delete and trash management**

Rewrite `DeleteFile` and add `TrashList`, `TrashRestore`, `TrashPurge` in `fileops.go`. Also add the `getTrashDirFunc` variable for test injection and `encoding/json` to imports:

```go
// getTrashDirFunc returns the trash directory path. Variable for test injection.
var getTrashDirFunc = getTrashDir

func getTrashDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	trashDir := filepath.Join(home, ".breeze-trash")
	if err := os.MkdirAll(trashDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create trash directory: %w", err)
	}
	return trashDir, nil
}

const trashMaxAgeDays = 30
```

Replace `DeleteFile` with:

```go
// DeleteFile moves a file or directory to the agent-side recycle bin.
// If "permanent" is true, deletes immediately without trashing.
func DeleteFile(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}

	recursive := GetPayloadBool(payload, "recursive", false)
	permanent := GetPayloadBool(payload, "permanent", false)

	cleanPath := filepath.Clean(path)

	if isDeniedSystemPath(cleanPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanPath), time.Since(start).Milliseconds())
	}

	if recursive {
		parts := strings.Split(strings.TrimPrefix(cleanPath, "/"), "/")
		if len(parts) <= 1 {
			return NewErrorResult(fmt.Errorf("recursive delete denied on top-level path: %s", cleanPath), time.Since(start).Milliseconds())
		}
	}

	info, err := os.Stat(cleanPath)
	if err != nil {
		if os.IsNotExist(err) {
			return NewErrorResult(fmt.Errorf("path does not exist: %s", cleanPath), time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to stat path: %w", err), time.Since(start).Milliseconds())
	}

	if permanent {
		if info.IsDir() && recursive {
			if err := os.RemoveAll(cleanPath); err != nil {
				return NewErrorResult(fmt.Errorf("failed to remove directory: %w", err), time.Since(start).Milliseconds())
			}
		} else {
			if err := os.Remove(cleanPath); err != nil {
				return NewErrorResult(fmt.Errorf("failed to remove file: %w", err), time.Since(start).Milliseconds())
			}
		}
		return NewSuccessResult(map[string]any{
			"path":      cleanPath,
			"deleted":   true,
			"permanent": true,
		}, time.Since(start).Milliseconds())
	}

	// Move to trash
	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	trashID := fmt.Sprintf("%d-%s", time.Now().UnixMilli(), filepath.Base(cleanPath))
	trashItemDir := filepath.Join(trashDir, trashID)
	if err := os.MkdirAll(trashItemDir, 0700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create trash item dir: %w", err), time.Since(start).Milliseconds())
	}

	// Write metadata
	var sizeBytes int64
	if info.IsDir() {
		filepath.Walk(cleanPath, func(_ string, fi os.FileInfo, _ error) error {
			if fi != nil && !fi.IsDir() {
				sizeBytes += fi.Size()
			}
			return nil
		})
	} else {
		sizeBytes = info.Size()
	}

	meta := TrashMetadata{
		OriginalPath: cleanPath,
		TrashID:      trashID,
		DeletedAt:    time.Now().Format(time.RFC3339),
		DeletedBy:    GetPayloadString(payload, "deletedBy", ""),
		IsDirectory:  info.IsDir(),
		SizeBytes:    sizeBytes,
	}
	metaBytes, _ := json.Marshal(meta)
	metaPath := filepath.Join(trashItemDir, "metadata.json")
	if err := os.WriteFile(metaPath, metaBytes, 0600); err != nil {
		return NewErrorResult(fmt.Errorf("failed to write trash metadata: %w", err), time.Since(start).Milliseconds())
	}

	// Move the actual content
	contentDest := filepath.Join(trashItemDir, "content")
	if err := os.Rename(cleanPath, contentDest); err != nil {
		// Cross-device fallback: copy then remove
		if info.IsDir() {
			if cpErr := copyDir(cleanPath, contentDest); cpErr != nil {
				os.RemoveAll(trashItemDir)
				return NewErrorResult(fmt.Errorf("failed to move to trash: %w", cpErr), time.Since(start).Milliseconds())
			}
			os.RemoveAll(cleanPath)
		} else {
			if cpErr := copyFile(cleanPath, contentDest, info.Mode()); cpErr != nil {
				os.RemoveAll(trashItemDir)
				return NewErrorResult(fmt.Errorf("failed to move to trash: %w", cpErr), time.Since(start).Milliseconds())
			}
			os.Remove(cleanPath)
		}
	}

	// Lazy purge: remove items older than 30 days
	lazyPurgeOldTrash(trashDir)

	return NewSuccessResult(map[string]any{
		"path":    cleanPath,
		"deleted": true,
		"trashId": trashID,
	}, time.Since(start).Milliseconds())
}

func lazyPurgeOldTrash(trashDir string) {
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -trashMaxAgeDays)
	for _, entry := range entries {
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var meta TrashMetadata
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		deletedAt, err := time.Parse(time.RFC3339, meta.DeletedAt)
		if err != nil {
			continue
		}
		if deletedAt.Before(cutoff) {
			os.RemoveAll(filepath.Join(trashDir, entry.Name()))
		}
	}
}
```

Add `TrashList`:

```go
// TrashList lists all items in the agent-side recycle bin.
func TrashList(payload map[string]any) CommandResult {
	start := time.Now()

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	entries, err := os.ReadDir(trashDir)
	if err != nil {
		if os.IsNotExist(err) {
			return NewSuccessResult(TrashListResponse{Items: []TrashMetadata{}, Path: trashDir}, time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to read trash: %w", err), time.Since(start).Milliseconds())
	}

	items := make([]TrashMetadata, 0, len(entries))
	for _, entry := range entries {
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var meta TrashMetadata
		if json.Unmarshal(data, &meta) == nil {
			items = append(items, meta)
		}
	}

	return NewSuccessResult(TrashListResponse{Items: items, Path: trashDir}, time.Since(start).Milliseconds())
}
```

Add `TrashRestore`:

```go
// TrashRestore restores a trashed item back to its original path.
func TrashRestore(payload map[string]any) CommandResult {
	start := time.Now()

	trashID := GetPayloadString(payload, "trashId", "")
	if trashID == "" {
		return NewErrorResult(fmt.Errorf("trashId is required"), time.Since(start).Milliseconds())
	}

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	trashItemDir := filepath.Join(trashDir, trashID)
	metaPath := filepath.Join(trashItemDir, "metadata.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("trash item not found: %s", trashID), time.Since(start).Milliseconds())
	}

	var meta TrashMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return NewErrorResult(fmt.Errorf("corrupt trash metadata: %w", err), time.Since(start).Milliseconds())
	}

	contentPath := filepath.Join(trashItemDir, "content")

	// Ensure parent directory exists
	parentDir := filepath.Dir(meta.OriginalPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create restore directory: %w", err), time.Since(start).Milliseconds())
	}

	// Move back to original location
	if err := os.Rename(contentPath, meta.OriginalPath); err != nil {
		// Cross-device fallback
		info, statErr := os.Stat(contentPath)
		if statErr != nil {
			return NewErrorResult(fmt.Errorf("failed to stat trash content: %w", statErr), time.Since(start).Milliseconds())
		}
		if info.IsDir() {
			if cpErr := copyDir(contentPath, meta.OriginalPath); cpErr != nil {
				return NewErrorResult(fmt.Errorf("failed to restore: %w", cpErr), time.Since(start).Milliseconds())
			}
		} else {
			if cpErr := copyFile(contentPath, meta.OriginalPath, info.Mode()); cpErr != nil {
				return NewErrorResult(fmt.Errorf("failed to restore: %w", cpErr), time.Since(start).Milliseconds())
			}
		}
	}

	// Clean up trash entry
	os.RemoveAll(trashItemDir)

	return NewSuccessResult(map[string]any{
		"trashId":      trashID,
		"restoredPath": meta.OriginalPath,
		"restored":     true,
	}, time.Since(start).Milliseconds())
}
```

Add `TrashPurge`:

```go
// TrashPurge permanently deletes items from the recycle bin.
// If trashIds is provided, only those items are purged. Otherwise all items are purged.
func TrashPurge(payload map[string]any) CommandResult {
	start := time.Now()

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	trashIDs := GetPayloadStringSlice(payload, "trashIds")

	if len(trashIDs) > 0 {
		purged := 0
		for _, id := range trashIDs {
			itemDir := filepath.Join(trashDir, filepath.Base(id)) // Base() prevents traversal
			if err := os.RemoveAll(itemDir); err == nil {
				purged++
			}
		}
		return NewSuccessResult(map[string]any{
			"purged": purged,
			"total":  len(trashIDs),
		}, time.Since(start).Milliseconds())
	}

	// Purge all
	entries, _ := os.ReadDir(trashDir)
	purged := 0
	for _, entry := range entries {
		if os.RemoveAll(filepath.Join(trashDir, entry.Name())) == nil {
			purged++
		}
	}

	return NewSuccessResult(map[string]any{
		"purged": purged,
		"total":  purged,
	}, time.Since(start).Milliseconds())
}
```

Add `"encoding/json"` to the imports in `fileops.go` if not already present.

**Step 4: Run all tests**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go test ./internal/remote/tools/ -v`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add agent/internal/remote/tools/fileops.go agent/internal/remote/tools/fileops_test.go
git commit -m "feat(agent): implement trash-based delete with restore and purge"
```

---

## Task 4: Agent — Register New Command Handlers

**Files:**
- Modify: `agent/internal/heartbeat/handlers.go:64-71` (register new handlers)

**Step 1: Add handler functions**

After `handleFileRename` (around line 245), add:

```go
func handleFileCopy(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.CopyFile(cmd.Payload)
}

func handleFileTrashList(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashList(cmd.Payload)
}

func handleFileTrashRestore(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashRestore(cmd.Payload)
}

func handleFileTrashPurge(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashPurge(cmd.Payload)
}
```

**Step 2: Register in handlerRegistry**

In the `handlerRegistry` map (after `CmdFileRename` line 70), add:

```go
tools.CmdFileCopy:         handleFileCopy,
tools.CmdFileTrashList:    handleFileTrashList,
tools.CmdFileTrashRestore: handleFileTrashRestore,
tools.CmdFileTrashPurge:   handleFileTrashPurge,
```

**Step 3: Verify agent compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements/agent && go build ./...`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add agent/internal/heartbeat/handlers.go
git commit -m "feat(agent): register file_copy and trash command handlers"
```

---

## Task 5: API — Add New Command Types and Audit Registration

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts:42-49` (add command types)
- Modify: `apps/api/src/services/commandQueue.ts:117-144` (add to AUDITED_COMMANDS)

**Step 1: Add command types**

In `apps/api/src/services/commandQueue.ts`, after `FILESYSTEM_ANALYSIS` (line 49), add:

```typescript
FILE_COPY: 'file_copy',
FILE_TRASH_LIST: 'file_trash_list',
FILE_TRASH_RESTORE: 'file_trash_restore',
FILE_TRASH_PURGE: 'file_trash_purge',
```

**Step 2: Add to AUDITED_COMMANDS**

In the `AUDITED_COMMANDS` set (after `CommandTypes.FILE_RENAME`, line 132), add:

```typescript
CommandTypes.FILE_COPY,
CommandTypes.FILE_TRASH_RESTORE,
CommandTypes.FILE_TRASH_PURGE,
```

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm --filter api exec tsc --noEmit`
Expected: SUCCESS (or existing unrelated errors only)

**Step 4: Commit**

```bash
git add apps/api/src/services/commandQueue.ts
git commit -m "feat(api): add file_copy and trash command types with audit registration"
```

---

## Task 6: API — Add Zod Schemas for File Operations

**Files:**
- Modify: `apps/api/src/routes/systemTools/schemas.ts` (add new schemas)

**Step 1: Add schemas**

Add at the end of `apps/api/src/routes/systemTools/schemas.ts`:

```typescript
// File operation schemas

const filePathString = z.string().min(1).max(2048).refine(
  (val) => !val.includes('\0') && !val.split('/').includes('..') && !val.split('\\').includes('..'),
  { message: 'Invalid path: null bytes and path traversal (..) are not allowed' }
);

export const fileCopyBodySchema = z.object({
  items: z.array(z.object({
    sourcePath: filePathString,
    destPath: filePathString,
  })).min(1).max(100),
});

export const fileMoveBodySchema = z.object({
  items: z.array(z.object({
    sourcePath: filePathString,
    destPath: filePathString,
  })).min(1).max(100),
});

export const fileDeleteBodySchema = z.object({
  paths: z.array(filePathString).min(1).max(100),
  permanent: z.boolean().optional().default(false),
});

export const fileTrashRestoreBodySchema = z.object({
  trashIds: z.array(z.string().min(1).max(512)).min(1).max(100),
});

export const fileTrashPurgeBodySchema = z.object({
  trashIds: z.array(z.string().min(1).max(512)).optional(),
});
```

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm --filter api exec tsc --noEmit`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add apps/api/src/routes/systemTools/schemas.ts
git commit -m "feat(api): add Zod schemas for file copy, move, delete, and trash operations"
```

---

## Task 7: API — Add Copy, Move, Delete Routes

**Files:**
- Modify: `apps/api/src/routes/systemTools/fileBrowser.ts` (add new route handlers)

**Step 1: Add imports**

At the top of `fileBrowser.ts`, update the schemas import to include the new schemas:

```typescript
import { deviceIdParamSchema, fileListQuerySchema, fileDownloadQuerySchema, fileCopyBodySchema, fileMoveBodySchema, fileDeleteBodySchema, fileTrashRestoreBodySchema, fileTrashPurgeBodySchema } from './schemas';
```

**Step 2: Add POST /files/copy route**

After the upload route (after line 173), add:

```typescript
// POST /devices/:deviceId/files/copy - Copy files
fileBrowserRoutes.post(
  '/devices/:deviceId/files/copy',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileCopyBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { items } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const item of items) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_COPY, {
        sourcePath: item.sourcePath,
        destPath: item.destPath,
      }, { userId: auth.user?.id, timeoutMs: 60000 });

      const success = result.status !== 'failed';
      results.push({
        sourcePath: item.sourcePath,
        destPath: item.destPath,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_copy',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { sourcePath: item.sourcePath, destPath: item.destPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);
```

**Step 3: Add POST /files/move route**

```typescript
// POST /devices/:deviceId/files/move - Move/rename files
fileBrowserRoutes.post(
  '/devices/:deviceId/files/move',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileMoveBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { items } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const item of items) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_RENAME, {
        oldPath: item.sourcePath,
        newPath: item.destPath,
      }, { userId: auth.user?.id, timeoutMs: 60000 });

      const success = result.status !== 'failed';
      results.push({
        sourcePath: item.sourcePath,
        destPath: item.destPath,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_move',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { sourcePath: item.sourcePath, destPath: item.destPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);
```

**Step 4: Add POST /files/delete route**

```typescript
// POST /devices/:deviceId/files/delete - Delete files (move to trash)
fileBrowserRoutes.post(
  '/devices/:deviceId/files/delete',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileDeleteBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { paths, permanent } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const path of paths) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_DELETE, {
        path,
        permanent,
        recursive: true,
        deletedBy: auth.user?.email || auth.user?.id,
      }, { userId: auth.user?.id, timeoutMs: 30000 });

      const success = result.status !== 'failed';
      results.push({
        path,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_delete',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { path, permanent },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);
```

**Step 5: Add GET /files/trash route**

```typescript
// GET /devices/:deviceId/files/trash - List trash contents
fileBrowserRoutes.get(
  '/devices/:deviceId/files/trash',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_LIST, {}, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to list trash' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.items || [] });
    } catch {
      return c.json({ error: 'Failed to parse trash list response' }, 502);
    }
  }
);
```

**Step 6: Add POST /files/trash/restore route**

```typescript
// POST /devices/:deviceId/files/trash/restore - Restore from trash
fileBrowserRoutes.post(
  '/devices/:deviceId/files/trash/restore',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileTrashRestoreBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { trashIds } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const trashId of trashIds) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_RESTORE, {
        trashId,
      }, { userId: auth.user?.id, timeoutMs: 30000 });

      const success = result.status !== 'failed';
      let restoredPath: string | undefined;
      if (success) {
        try {
          const data = JSON.parse(result.stdout || '{}');
          restoredPath = data.restoredPath;
        } catch { /* ignore parse error */ }
      }

      results.push({
        trashId,
        status: success ? 'success' : 'failure',
        restoredPath,
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_restore',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { trashId, restoredPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);
```

**Step 7: Add POST /files/trash/purge route**

```typescript
// POST /devices/:deviceId/files/trash/purge - Permanently delete from trash
fileBrowserRoutes.post(
  '/devices/:deviceId/files/trash/purge',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileTrashPurgeBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_PURGE, {
      trashIds: body.trashIds || [],
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    const success = result.status !== 'failed';

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'file_trash_purge',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { trashIds: body.trashIds, purgeAll: !body.trashIds },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: success ? 'success' : 'failure',
      errorMessage: success ? undefined : result.error,
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to purge trash' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ success: true, purged: data.purged || 0 });
    } catch {
      return c.json({ success: true });
    }
  }
);
```

**Step 8: Verify TypeScript compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm --filter api exec tsc --noEmit`
Expected: SUCCESS

**Step 9: Commit**

```bash
git add apps/api/src/routes/systemTools/fileBrowser.ts
git commit -m "feat(api): add copy, move, delete, and trash management routes with audit logging"
```

---

## Task 8: API — Add Tests for New Routes

**Files:**
- Modify: `apps/api/src/routes/systemTools.test.ts` (add tests for new routes)

**Step 1: Update mock CommandTypes**

In the `vi.mock('../services/commandQueue')` block, add the new command types:

```typescript
FILE_COPY: 'file_copy',
FILE_DELETE: 'file_delete',
FILE_RENAME: 'file_rename',
FILE_TRASH_LIST: 'file_trash_list',
FILE_TRASH_RESTORE: 'file_trash_restore',
FILE_TRASH_PURGE: 'file_trash_purge',
```

**Step 2: Add test cases**

Add describe blocks for each new route following the existing patterns in the test file. Test:
- 404 when device not found
- Successful copy with mock command result
- Successful delete with mock command result
- Successful trash list
- Successful restore
- Validation errors (empty paths, missing fields)

**Step 3: Run tests**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm --filter api test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add apps/api/src/routes/systemTools.test.ts
git commit -m "test(api): add tests for file copy, move, delete, and trash routes"
```

---

## Task 9: Frontend — Add File Operation API Functions

**Files:**
- Create: `apps/web/src/components/remote/fileOperations.ts`

**Step 1: Create the API utility module**

```typescript
import { fetchWithAuth } from '@/stores/auth';

export type FileOpResult = {
  path?: string;
  sourcePath?: string;
  destPath?: string;
  trashId?: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
};

export type TrashItem = {
  originalPath: string;
  trashId: string;
  deletedAt: string;
  deletedBy?: string;
  isDirectory: boolean;
  sizeBytes: number;
};

export async function copyFiles(
  deviceId: string,
  items: { sourcePath: string; destPath: string }[]
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/copy`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Copy failed' }));
    throw new Error(json.error || 'Copy failed');
  }
  return response.json();
}

export async function moveFiles(
  deviceId: string,
  items: { sourcePath: string; destPath: string }[]
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Move failed' }));
    throw new Error(json.error || 'Move failed');
  }
  return response.json();
}

export async function deleteFiles(
  deviceId: string,
  paths: string[],
  permanent = false
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/delete`, {
    method: 'POST',
    body: JSON.stringify({ paths, permanent }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error(json.error || 'Delete failed');
  }
  return response.json();
}

export async function listTrash(deviceId: string): Promise<TrashItem[]> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash`);
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Failed to list trash' }));
    throw new Error(json.error || 'Failed to list trash');
  }
  const json = await response.json();
  return json.data || [];
}

export async function restoreFromTrash(
  deviceId: string,
  trashIds: string[]
): Promise<{ results: FileOpResult[] }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash/restore`, {
    method: 'POST',
    body: JSON.stringify({ trashIds }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Restore failed' }));
    throw new Error(json.error || 'Restore failed');
  }
  return response.json();
}

export async function purgeTrash(
  deviceId: string,
  trashIds?: string[]
): Promise<{ success: boolean; purged?: number }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/trash/purge`, {
    method: 'POST',
    body: JSON.stringify({ trashIds }),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Purge failed' }));
    throw new Error(json.error || 'Purge failed');
  }
  return response.json();
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/remote/fileOperations.ts
git commit -m "feat(web): add file operation API utility functions"
```

---

## Task 10: Frontend — Add Folder Picker Dialog Component

**Files:**
- Create: `apps/web/src/components/remote/FolderPickerDialog.tsx`

**Step 1: Create the folder picker component**

Build a modal dialog that reuses the same directory listing API as `FileManager`. It shows:
- A title ("Copy to..." or "Move to...")
- Breadcrumb navigation (reuse `buildBreadcrumbs` from `filePathUtils.ts`)
- Directory listing (only directories, not files)
- Back/up buttons
- "Select this folder" confirmation button
- Cancel button

Props:
```typescript
type FolderPickerDialogProps = {
  open: boolean;
  title: string;
  deviceId: string;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
};
```

The component fetches directory listings using `fetchWithAuth` and filters to show only directories. Double-click navigates into a directory. The "Select" button calls `onSelect(currentPath)`.

**Step 2: Commit**

```bash
git add apps/web/src/components/remote/FolderPickerDialog.tsx
git commit -m "feat(web): add FolderPickerDialog for copy/move destination selection"
```

---

## Task 11: Frontend — Add Delete Confirmation Dialog Component

**Files:**
- Create: `apps/web/src/components/remote/DeleteConfirmDialog.tsx`

**Step 1: Create the delete confirmation component**

A modal dialog that shows:
- List of items to be deleted (name + size)
- Total count and size
- Warning text about trash/permanent
- "Move to Trash" button (primary)
- "Delete Permanently" button (destructive, secondary)
- Cancel button

Props:
```typescript
type DeleteConfirmDialogProps = {
  open: boolean;
  items: { name: string; path: string; size?: number; type: string }[];
  onConfirm: (permanent: boolean) => void;
  onClose: () => void;
};
```

**Step 2: Commit**

```bash
git add apps/web/src/components/remote/DeleteConfirmDialog.tsx
git commit -m "feat(web): add DeleteConfirmDialog with trash/permanent options"
```

---

## Task 12: Frontend — Add Trash View Component

**Files:**
- Create: `apps/web/src/components/remote/TrashView.tsx`

**Step 1: Create the trash view component**

A component that replaces the file list when trash mode is active. Shows:
- List of trashed items (original path, deletion date, who deleted, size)
- Checkbox multi-select
- Action buttons: Restore Selected, Permanently Delete Selected, Purge All
- Empty state message when no trash items

Props:
```typescript
type TrashViewProps = {
  deviceId: string;
  onRestore: () => void; // callback to refresh file list after restore
};
```

Uses `listTrash()`, `restoreFromTrash()`, and `purgeTrash()` from `fileOperations.ts`.

**Step 2: Commit**

```bash
git add apps/web/src/components/remote/TrashView.tsx
git commit -m "feat(web): add TrashView component for recycle bin management"
```

---

## Task 13: Frontend — Add Activity Panel Component

**Files:**
- Create: `apps/web/src/components/remote/FileActivityPanel.tsx`

**Step 1: Create the activity panel component**

A collapsible sidebar that shows recent file operations for this device. Fetches from the existing audit log API (filter by `resourceId=deviceId` and file-related actions). Shows:
- Timestamp
- User (email)
- Action (copy, move, delete, restore, upload)
- Path details
- Result badge (success/failure)
- "Load more" button

Props:
```typescript
type FileActivityPanelProps = {
  deviceId: string;
  open: boolean;
  onToggle: () => void;
};
```

Note: Check if there is an existing audit log API endpoint to query. If not, this component can show recent operations tracked in local state during the current session, with a note that full audit history is in the org audit log.

**Step 2: Commit**

```bash
git add apps/web/src/components/remote/FileActivityPanel.tsx
git commit -m "feat(web): add FileActivityPanel for recent file operation history"
```

---

## Task 14: Frontend — Integrate All Components into FileManager

**Files:**
- Modify: `apps/web/src/components/remote/FileManager.tsx`

This is the largest frontend task. It integrates everything into the existing FileManager:

**Step 1: Add imports**

Add imports for new components and utilities:
```typescript
import { copyFiles, moveFiles, deleteFiles } from './fileOperations';
import FolderPickerDialog from './FolderPickerDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import TrashView from './TrashView';
import FileActivityPanel from './FileActivityPanel';
import { Trash2, Copy, Move, MoreVertical, History, RotateCcw } from 'lucide-react';
```

**Step 2: Add state variables**

Add to the component state (after existing useState calls):
```typescript
const [showFolderPicker, setShowFolderPicker] = useState(false);
const [folderPickerMode, setFolderPickerMode] = useState<'copy' | 'move'>('copy');
const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
const [showTrash, setShowTrash] = useState(false);
const [showActivity, setShowActivity] = useState(false);
const [operationLoading, setOperationLoading] = useState(false);
const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
```

**Step 3: Add operation handlers**

Add handlers for copy, move, delete:
- `handleCopyTo(destPath)` — Calls `copyFiles()` for selected items, shows toast, refreshes
- `handleMoveTo(destPath)` — Calls `moveFiles()` for selected items, shows toast, refreshes
- `handleDelete(permanent)` — Calls `deleteFiles()` for selected items, shows toast, refreshes
- `handleContextMenu(e, entry)` — Shows context menu at click position
- `handleRename(entry)` — Inline rename (sets entry into edit mode, on blur calls moveFiles)

**Step 4: Update the toolbar**

Add buttons to existing toolbar:
- Trash toggle button with item count badge
- Activity panel toggle button
- These go alongside existing Upload/Refresh buttons

**Step 5: Add floating action bar**

When `selectedItems.size > 0`, render a fixed-bottom bar with:
- Selection count: "N items selected"
- Copy to... button
- Move to... button
- Delete button
- Download button (existing)

**Step 6: Add context menu**

On right-click of a file row, show a dropdown with: Copy to, Move to, Rename, Delete, Download.

**Step 7: Add checkbox column**

Add a checkbox to each file row for multi-select. "Select all" checkbox in header.

**Step 8: Conditional rendering**

If `showTrash` is true, render `<TrashView>` instead of the file list.

**Step 9: Mount dialogs and panels**

At the end of the component JSX, add:
```tsx
<FolderPickerDialog
  open={showFolderPicker}
  title={folderPickerMode === 'copy' ? 'Copy to...' : 'Move to...'}
  deviceId={deviceId}
  initialPath={currentPath}
  onSelect={folderPickerMode === 'copy' ? handleCopyTo : handleMoveTo}
  onClose={() => setShowFolderPicker(false)}
/>
<DeleteConfirmDialog
  open={showDeleteConfirm}
  items={entries.filter(e => selectedItems.has(e.path))}
  onConfirm={handleDelete}
  onClose={() => setShowDeleteConfirm(false)}
/>
<FileActivityPanel
  deviceId={deviceId}
  open={showActivity}
  onToggle={() => setShowActivity(prev => !prev)}
/>
```

**Step 10: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm --filter web build`
Expected: SUCCESS (or at least no new errors)

**Step 11: Commit**

```bash
git add apps/web/src/components/remote/FileManager.tsx
git commit -m "feat(web): integrate multi-select, context menu, copy/move/delete, trash, and activity panel"
```

---

## Task 15: Manual Testing and Polish

**Step 1: Start dev servers**

Run: `cd /Users/toddhebebrand/breeze/.worktrees/file-browser-improvements && pnpm dev`

**Step 2: Test each operation manually**

Test with a real device or mock:
1. Navigate to file browser for a device
2. Select multiple files with checkboxes
3. Test "Copy to..." — opens folder picker, select destination, verify files copied
4. Test "Move to..." — opens folder picker, select destination, verify files moved
5. Test "Delete" — confirmation dialog, verify moved to trash
6. Test Trash view — toggle trash, see deleted items, restore one, purge one
7. Test context menu — right-click a file, use each action
8. Test activity panel — see recent operations logged

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix(web): polish file browser operations from manual testing"
```

---

## Summary of Files Modified/Created

| Layer | File | Action |
|-------|------|--------|
| Agent | `agent/internal/remote/tools/types.go` | Modify (add constants + types) |
| Agent | `agent/internal/remote/tools/fileops.go` | Modify (add CopyFile, rewrite DeleteFile, add trash funcs) |
| Agent | `agent/internal/remote/tools/fileops_test.go` | Create (all agent tests) |
| Agent | `agent/internal/heartbeat/handlers.go` | Modify (register new handlers) |
| API | `apps/api/src/services/commandQueue.ts` | Modify (add command types + audit) |
| API | `apps/api/src/routes/systemTools/schemas.ts` | Modify (add Zod schemas) |
| API | `apps/api/src/routes/systemTools/fileBrowser.ts` | Modify (add 6 new routes) |
| API | `apps/api/src/routes/systemTools.test.ts` | Modify (add route tests) |
| Web | `apps/web/src/components/remote/fileOperations.ts` | Create (API utilities) |
| Web | `apps/web/src/components/remote/FolderPickerDialog.tsx` | Create |
| Web | `apps/web/src/components/remote/DeleteConfirmDialog.tsx` | Create |
| Web | `apps/web/src/components/remote/TrashView.tsx` | Create |
| Web | `apps/web/src/components/remote/FileActivityPanel.tsx` | Create |
| Web | `apps/web/src/components/remote/FileManager.tsx` | Modify (integrate all) |
