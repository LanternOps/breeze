package tools

import (
	"encoding/base64"
	"fmt"
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

	return NewSuccessResult(map[string]any{
		"path":     cleanPath,
		"size":     len(content),
		"content":  string(content),
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

// DeleteFile deletes a file or directory
func DeleteFile(payload map[string]any) CommandResult {
	start := time.Now()

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
	}

	recursive := GetPayloadBool(payload, "recursive", false)

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

	// Delete based on type
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
		"path":    cleanPath,
		"deleted": true,
	}, time.Since(start).Milliseconds())
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
