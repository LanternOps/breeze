package tools

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// maxFileReadSize is the maximum file size for reading (1MB)
	maxFileReadSize = 1024 * 1024
)

// deniedSystemPaths are critical system paths that mutating file operations should never target directly.
var deniedSystemPaths = []string{"/", "/boot", "/proc", "/sys", "/dev", "/bin", "/sbin", "/usr"}

// getTrashDirFunc returns the trash directory path. Variable allows test injection.
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

// isDeniedSystemPath checks whether the given cleaned path matches a denied system path.
func isDeniedSystemPath(cleanPath string) bool {
	for _, d := range deniedSystemPaths {
		if cleanPath == d {
			return true
		}
	}
	return false
}

// ListFiles lists the contents of a directory
func ListFiles(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		// Default to home directory
		home, err := os.UserHomeDir()
		if err != nil {
			return NewErrorResult(fmt.Errorf("failed to get home directory: %w", err), time.Since(start).Milliseconds())
		}
		path = home
	}

	// Normalize path separators
	cleanPath := filepath.Clean(path)

	entries, err := os.ReadDir(cleanPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read directory: %w", err), time.Since(start).Milliseconds())
	}

	fileEntries := make([]FileEntry, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue // Skip files we can't stat
		}

		entryType := "file"
		if entry.IsDir() {
			entryType = "directory"
		}

		fileEntries = append(fileEntries, FileEntry{
			Name:        entry.Name(),
			Path:        filepath.Join(cleanPath, entry.Name()),
			Type:        entryType,
			Size:        info.Size(),
			Modified:    info.ModTime().Format(time.RFC3339),
			Permissions: info.Mode().String(),
		})
	}

	return NewSuccessResult(FileListResponse{
		Path:    cleanPath,
		Entries: fileEntries,
	}, time.Since(start).Milliseconds())
}

// ReadFile reads the contents of a file
func ReadFile(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}
	encoding := strings.ToLower(GetPayloadString(payload, "encoding", "text"))
	if encoding != "text" && encoding != "base64" {
		return NewErrorResult(fmt.Errorf("unsupported encoding: %s", encoding), time.Since(start).Milliseconds())
	}

	// Normalize path separators
	cleanPath := filepath.Clean(path)

	// Check file info first
	info, err := os.Stat(cleanPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to stat file: %w", err), time.Since(start).Milliseconds())
	}

	if info.IsDir() {
		return NewErrorResult(fmt.Errorf("path is a directory, not a file"), time.Since(start).Milliseconds())
	}

	// Check file size
	if info.Size() > maxFileReadSize {
		return NewErrorResult(fmt.Errorf("file too large: %d bytes (max %d bytes)", info.Size(), maxFileReadSize), time.Since(start).Milliseconds())
	}

	// Read file contents
	content, err := os.ReadFile(cleanPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read file: %w", err), time.Since(start).Milliseconds())
	}

	contentValue := string(content)
	if encoding == "base64" {
		contentValue = base64.StdEncoding.EncodeToString(content)
	}

	return NewSuccessResult(map[string]any{
		"path":     cleanPath,
		"size":     len(content),
		"encoding": encoding,
		"content":  contentValue,
		"modified": info.ModTime().Format(time.RFC3339),
	}, time.Since(start).Milliseconds())
}

// WriteFile writes content to a file
func WriteFile(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}

	content := GetPayloadString(payload, "content", "")
	encoding := GetPayloadString(payload, "encoding", "text")

	// Normalize path separators
	cleanPath := filepath.Clean(path)

	// Check against denied system paths
	if isDeniedSystemPath(cleanPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanPath), time.Since(start).Milliseconds())
	}

	// Ensure parent directory exists
	parentDir := filepath.Dir(cleanPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create parent directory: %w", err), time.Since(start).Milliseconds())
	}

	// Decode content based on encoding
	var data []byte
	if encoding == "base64" {
		var err error
		data, err = base64.StdEncoding.DecodeString(content)
		if err != nil {
			return NewErrorResult(fmt.Errorf("failed to decode base64 content: %w", err), time.Since(start).Milliseconds())
		}
	} else {
		data = []byte(content)
	}

	// Write file
	if err := os.WriteFile(cleanPath, data, 0644); err != nil {
		return NewErrorResult(fmt.Errorf("failed to write file: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"path":    cleanPath,
		"size":    len(data),
		"written": true,
	}, time.Since(start).Milliseconds())
}

// DeleteFile deletes a file or directory. By default it moves the item to the
// .breeze-trash directory for later restore. Pass "permanent": true to bypass
// the trash and delete immediately.
func DeleteFile(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}

	recursive := GetPayloadBool(payload, "recursive", false)
	permanent := GetPayloadBool(payload, "permanent", false)

	// Normalize path separators
	cleanPath := filepath.Clean(path)

	// Check against denied system paths
	if isDeniedSystemPath(cleanPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanPath), time.Since(start).Milliseconds())
	}

	// Block recursive deletes on any top-level directory (e.g. /home, /var, /opt)
	if recursive {
		parts := strings.Split(strings.TrimPrefix(cleanPath, "/"), "/")
		if len(parts) <= 1 {
			return NewErrorResult(fmt.Errorf("recursive delete denied on top-level path: %s", cleanPath), time.Since(start).Milliseconds())
		}
	}

	// Check if path exists
	info, err := os.Stat(cleanPath)
	if err != nil {
		if os.IsNotExist(err) {
			return NewErrorResult(fmt.Errorf("path does not exist: %s", cleanPath), time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to stat path: %w", err), time.Since(start).Milliseconds())
	}

	// Permanent delete — bypass trash
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
		return NewErrorResult(fmt.Errorf("failed to get trash directory: %w", err), time.Since(start).Milliseconds())
	}
	if err := os.MkdirAll(trashDir, 0700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create trash directory: %w", err), time.Since(start).Milliseconds())
	}

	// Create trash item directory: <trashDir>/<unixMillis>-<basename>/
	now := time.Now()
	trashID := fmt.Sprintf("%d-%s", now.UnixMilli(), filepath.Base(cleanPath))
	trashItemDir := filepath.Join(trashDir, trashID)
	if err := os.MkdirAll(trashItemDir, 0700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create trash item directory: %w", err), time.Since(start).Milliseconds())
	}

	// Write metadata.json
	meta := TrashMetadata{
		OriginalPath: cleanPath,
		TrashID:      trashID,
		DeletedAt:    now.Format(time.RFC3339),
		IsDirectory:  info.IsDir(),
		SizeBytes:    info.Size(),
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to marshal trash metadata: %w", err), time.Since(start).Milliseconds())
	}
	metaPath := filepath.Join(trashItemDir, "metadata.json")
	if err := os.WriteFile(metaPath, metaBytes, 0600); err != nil {
		return NewErrorResult(fmt.Errorf("failed to write trash metadata: %w", err), time.Since(start).Milliseconds())
	}

	// Move content into trash item dir
	contentPath := filepath.Join(trashItemDir, "content")
	if err := os.Rename(cleanPath, contentPath); err != nil {
		// Rename may fail across devices; fall back to copy + remove
		if info.IsDir() {
			if cpErr := copyDir(cleanPath, contentPath); cpErr != nil {
				// Clean up the trash item dir on failure
				os.RemoveAll(trashItemDir)
				return NewErrorResult(fmt.Errorf("failed to move directory to trash: %w", cpErr), time.Since(start).Milliseconds())
			}
			if err := os.RemoveAll(cleanPath); err != nil {
				return NewErrorResult(fmt.Errorf("copied to trash but failed to remove original: %w", err), time.Since(start).Milliseconds())
			}
		} else {
			if cpErr := copyFile(cleanPath, contentPath, info.Mode()); cpErr != nil {
				os.RemoveAll(trashItemDir)
				return NewErrorResult(fmt.Errorf("failed to move file to trash: %w", cpErr), time.Since(start).Milliseconds())
			}
			if err := os.Remove(cleanPath); err != nil {
				return NewErrorResult(fmt.Errorf("copied to trash but failed to remove original: %w", err), time.Since(start).Milliseconds())
			}
		}
	}

	// Lazily purge items older than trashMaxAgeDays
	go lazyPurgeOldTrash()

	return NewSuccessResult(map[string]any{
		"path":    cleanPath,
		"deleted": true,
		"trashId": trashID,
	}, time.Since(start).Milliseconds())
}

// TrashList lists all items currently in the trash directory.
func TrashList(payload map[string]any) CommandResult {
	start := time.Now()

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to get trash directory: %w", err), time.Since(start).Milliseconds())
	}

	// Ensure trash dir exists (may not yet)
	if err := os.MkdirAll(trashDir, 0700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create trash directory: %w", err), time.Since(start).Milliseconds())
	}

	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read trash directory: %w", err), time.Since(start).Milliseconds())
	}

	items := make([]TrashMetadata, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		metaBytes, err := os.ReadFile(metaPath)
		if err != nil {
			continue // skip entries without valid metadata
		}
		var meta TrashMetadata
		if err := json.Unmarshal(metaBytes, &meta); err != nil {
			continue
		}
		items = append(items, meta)
	}

	return NewSuccessResult(TrashListResponse{
		Items: items,
		Path:  trashDir,
	}, time.Since(start).Milliseconds())
}

// TrashRestore restores a trashed item back to its original location.
func TrashRestore(payload map[string]any) CommandResult {
	start := time.Now()

	trashID := GetPayloadString(payload, "trashId", "")
	if trashID == "" {
		return NewErrorResult(fmt.Errorf("trashId is required"), time.Since(start).Milliseconds())
	}

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to get trash directory: %w", err), time.Since(start).Milliseconds())
	}

	trashItemDir := filepath.Join(trashDir, trashID)
	metaPath := filepath.Join(trashItemDir, "metadata.json")

	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("trash item not found: %s", trashID), time.Since(start).Milliseconds())
	}

	var meta TrashMetadata
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return NewErrorResult(fmt.Errorf("failed to parse trash metadata: %w", err), time.Since(start).Milliseconds())
	}

	contentPath := filepath.Join(trashItemDir, "content")

	// Ensure the parent directory of the original path exists
	parentDir := filepath.Dir(meta.OriginalPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create parent directory: %w", err), time.Since(start).Milliseconds())
	}

	// Move content back to original location
	if err := os.Rename(contentPath, meta.OriginalPath); err != nil {
		// Rename may fail across devices; fall back to copy + remove
		info, statErr := os.Stat(contentPath)
		if statErr != nil {
			return NewErrorResult(fmt.Errorf("failed to stat trash content: %w", statErr), time.Since(start).Milliseconds())
		}
		if info.IsDir() {
			if cpErr := copyDir(contentPath, meta.OriginalPath); cpErr != nil {
				return NewErrorResult(fmt.Errorf("failed to restore directory: %w", cpErr), time.Since(start).Milliseconds())
			}
		} else {
			if cpErr := copyFile(contentPath, meta.OriginalPath, info.Mode()); cpErr != nil {
				return NewErrorResult(fmt.Errorf("failed to restore file: %w", cpErr), time.Since(start).Milliseconds())
			}
		}
		// Remove the trash item after successful copy
		os.RemoveAll(trashItemDir)
	} else {
		// Rename succeeded; remove the metadata and trash item directory
		os.RemoveAll(trashItemDir)
	}

	return NewSuccessResult(map[string]any{
		"trashId":      trashID,
		"restoredPath": meta.OriginalPath,
		"restored":     true,
	}, time.Since(start).Milliseconds())
}

// TrashPurge permanently deletes items from the trash. If trashIds are
// provided, only those items are purged. Otherwise everything is purged.
func TrashPurge(payload map[string]any) CommandResult {
	start := time.Now()

	trashDir, err := getTrashDirFunc()
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to get trash directory: %w", err), time.Since(start).Milliseconds())
	}

	if err := os.MkdirAll(trashDir, 0700); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create trash directory: %w", err), time.Since(start).Milliseconds())
	}

	trashIds := GetPayloadStringSlice(payload, "trashIds")

	if len(trashIds) > 0 {
		// Purge specific items
		purged := 0
		for _, id := range trashIds {
			itemDir := filepath.Join(trashDir, id)
			if err := os.RemoveAll(itemDir); err == nil {
				purged++
			}
		}
		return NewSuccessResult(map[string]any{
			"purged": purged,
		}, time.Since(start).Milliseconds())
	}

	// Purge everything
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read trash directory: %w", err), time.Since(start).Milliseconds())
	}

	purged := 0
	for _, entry := range entries {
		itemDir := filepath.Join(trashDir, entry.Name())
		if err := os.RemoveAll(itemDir); err == nil {
			purged++
		}
	}

	return NewSuccessResult(map[string]any{
		"purged": purged,
	}, time.Since(start).Milliseconds())
}

// lazyPurgeOldTrash removes trash items older than trashMaxAgeDays.
func lazyPurgeOldTrash() {
	trashDir, err := getTrashDirFunc()
	if err != nil {
		return
	}

	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return
	}

	cutoff := time.Now().AddDate(0, 0, -trashMaxAgeDays)

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		metaBytes, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var meta TrashMetadata
		if err := json.Unmarshal(metaBytes, &meta); err != nil {
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

// MakeDirectory creates a directory
func MakeDirectory(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}

	// Normalize path separators
	cleanPath := filepath.Clean(path)

	// Check against denied system paths
	if isDeniedSystemPath(cleanPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanPath), time.Since(start).Milliseconds())
	}

	// Create directory and any necessary parents
	if err := os.MkdirAll(cleanPath, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create directory: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"path":    cleanPath,
		"created": true,
	}, time.Since(start).Milliseconds())
}

// RenameFile renames or moves a file
func RenameFile(payload map[string]any) CommandResult {
	start := time.Now()

	oldPath := GetPayloadString(payload, "oldPath", "")
	if oldPath == "" {
		return NewErrorResult(fmt.Errorf("oldPath is required"), time.Since(start).Milliseconds())
	}

	newPath := GetPayloadString(payload, "newPath", "")
	if newPath == "" {
		return NewErrorResult(fmt.Errorf("newPath is required"), time.Since(start).Milliseconds())
	}

	// Normalize path separators
	cleanOldPath := filepath.Clean(oldPath)
	cleanNewPath := filepath.Clean(newPath)

	// Check against denied system paths
	if isDeniedSystemPath(cleanOldPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanOldPath), time.Since(start).Milliseconds())
	}
	if isDeniedSystemPath(cleanNewPath) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanNewPath), time.Since(start).Milliseconds())
	}

	// Check if source exists
	if _, err := os.Stat(cleanOldPath); err != nil {
		if os.IsNotExist(err) {
			return NewErrorResult(fmt.Errorf("source path does not exist: %s", cleanOldPath), time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to stat source: %w", err), time.Since(start).Milliseconds())
	}

	// Ensure destination parent directory exists
	parentDir := filepath.Dir(cleanNewPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create destination directory: %w", err), time.Since(start).Milliseconds())
	}

	// Rename/move file
	if err := os.Rename(cleanOldPath, cleanNewPath); err != nil {
		return NewErrorResult(fmt.Errorf("failed to rename file: %w", err), time.Since(start).Milliseconds())
	}

	return NewSuccessResult(map[string]any{
		"oldPath": cleanOldPath,
		"newPath": cleanNewPath,
		"renamed": true,
	}, time.Since(start).Milliseconds())
}

// CopyFile copies a file or directory recursively
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

	// Normalize path separators
	cleanSrc := filepath.Clean(sourcePath)
	cleanDst := filepath.Clean(destPath)

	// Check against denied system paths
	if isDeniedSystemPath(cleanSrc) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanSrc), time.Since(start).Milliseconds())
	}
	if isDeniedSystemPath(cleanDst) {
		return NewErrorResult(fmt.Errorf("operation denied on system path: %s", cleanDst), time.Since(start).Milliseconds())
	}

	// Check if source exists
	info, err := os.Stat(cleanSrc)
	if err != nil {
		if os.IsNotExist(err) {
			return NewErrorResult(fmt.Errorf("source path does not exist: %s", cleanSrc), time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to stat source: %w", err), time.Since(start).Milliseconds())
	}

	if info.IsDir() {
		if err := copyDir(cleanSrc, cleanDst); err != nil {
			return NewErrorResult(fmt.Errorf("failed to copy directory: %w", err), time.Since(start).Milliseconds())
		}
	} else {
		// Ensure destination parent directory exists
		parentDir := filepath.Dir(cleanDst)
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			return NewErrorResult(fmt.Errorf("failed to create destination directory: %w", err), time.Since(start).Milliseconds())
		}
		if err := copyFile(cleanSrc, cleanDst, info.Mode()); err != nil {
			return NewErrorResult(fmt.Errorf("failed to copy file: %w", err), time.Since(start).Milliseconds())
		}
	}

	return NewSuccessResult(map[string]any{
		"sourcePath": cleanSrc,
		"destPath":   cleanDst,
		"copied":     true,
	}, time.Since(start).Milliseconds())
}

// copyFile copies a single file from src to dst, preserving the given file mode.
func copyFile(src, dst string, mode os.FileMode) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer srcFile.Close()

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return fmt.Errorf("copy data: %w", err)
	}

	return nil
}

// copyDir recursively copies a directory tree from src to dst.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Compute the relative path from the source root
		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return fmt.Errorf("compute relative path: %w", err)
		}

		targetPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(targetPath, info.Mode())
		}

		// Ensure the parent directory exists
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return fmt.Errorf("create parent dir: %w", err)
		}

		return copyFile(path, targetPath, info.Mode())
	})
}
