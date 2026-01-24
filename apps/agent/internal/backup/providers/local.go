package providers

import (
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"go.uber.org/zap"
)

// LocalProvider stores backups on a local or mounted filesystem.
type LocalProvider struct {
	BasePath string
	logger   *zap.Logger
}

// NewLocalProvider creates a LocalProvider rooted at basePath.
func NewLocalProvider(basePath string, logger *zap.Logger) *LocalProvider {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &LocalProvider{
		BasePath: filepath.Clean(basePath),
		logger:   logger.Named("backup.local"),
	}
}

// Upload copies a file into the local backup store.
func (p *LocalProvider) Upload(localPath, remotePath string) error {
	if p.BasePath == "" {
		return errors.New("local provider base path is required")
	}
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	destPath := filepath.Join(p.BasePath, filepath.FromSlash(remotePath))
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}

	if strings.HasSuffix(remotePath, ".gz") {
		return compressFile(localPath, destPath)
	}
	return copyFile(localPath, destPath)
}

// Download retrieves a file from the local backup store.
func (p *LocalProvider) Download(remotePath, localPath string) error {
	if p.BasePath == "" {
		return errors.New("local provider base path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	if localPath == "" {
		return errors.New("local destination path is required")
	}

	srcPath := filepath.Join(p.BasePath, filepath.FromSlash(remotePath))
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	if strings.HasSuffix(remotePath, ".gz") {
		return decompressFile(srcPath, localPath)
	}
	return copyFile(srcPath, localPath)
}

// List enumerates files under the given prefix.
func (p *LocalProvider) List(prefix string) ([]string, error) {
	if p.BasePath == "" {
		return nil, errors.New("local provider base path is required")
	}

	root := p.BasePath
	if prefix != "" {
		root = filepath.Join(p.BasePath, filepath.FromSlash(prefix))
	}

	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("failed to stat prefix %s: %w", root, err)
	}

	var results []string
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relPath, err := filepath.Rel(p.BasePath, path)
		if err != nil {
			return err
		}
		results = append(results, filepath.ToSlash(relPath))
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("failed to list backup files: %w", walkErr)
	}
	return results, nil
}

// Delete removes a file from the local backup store.
func (p *LocalProvider) Delete(remotePath string) error {
	if p.BasePath == "" {
		return errors.New("local provider base path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	target := filepath.Join(p.BasePath, filepath.FromSlash(remotePath))
	if err := os.Remove(target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("failed to delete backup file: %w", err)
	}

	p.cleanupEmptyDirs(filepath.Dir(target))
	return nil
}

func (p *LocalProvider) cleanupEmptyDirs(startPath string) {
	base := filepath.Clean(p.BasePath)
	path := filepath.Clean(startPath)

	for path != base && path != "." && path != string(filepath.Separator) {
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) > 0 {
			return
		}
		if err := os.Remove(path); err != nil {
			return
		}
		path = filepath.Dir(path)
	}
}

func copyFile(srcPath, destPath string) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	info, statErr := srcFile.Stat()
	if statErr != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to stat source file: %w", statErr)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	destFile, err := os.Create(destPath)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination file: %w", err)
	}

	_, err = io.Copy(destFile, srcFile)
	closeErr := destFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chtimes(destPath, info.ModTime(), info.ModTime())
	}

	if err != nil {
		return fmt.Errorf("failed to copy file: %w", err)
	}
	return nil
}

func compressFile(srcPath, destPath string) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	srcInfo, statErr := srcFile.Stat()
	if statErr != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to stat source file: %w", statErr)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	destFile, err := os.Create(destPath)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination file: %w", err)
	}

	gzipWriter := gzip.NewWriter(destFile)
	gzipWriter.Name = filepath.Base(srcPath)
	gzipWriter.ModTime = srcInfo.ModTime()

	_, err = io.Copy(gzipWriter, srcFile)
	closeErr := gzipWriter.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = destFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}

	if err != nil {
		return fmt.Errorf("failed to compress file: %w", err)
	}
	return nil
}

func decompressFile(srcPath, destPath string) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}

	gzipReader, err := gzip.NewReader(srcFile)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		_ = gzipReader.Close()
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	destFile, err := os.Create(destPath)
	if err != nil {
		_ = gzipReader.Close()
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination file: %w", err)
	}

	_, err = io.Copy(destFile, gzipReader)
	closeErr := destFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = gzipReader.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}

	if err != nil {
		return fmt.Errorf("failed to decompress file: %w", err)
	}
	return nil
}
