package providers

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const maxDecompressSize = 2 * 1024 * 1024 * 1024 // 2GB decompression limit

// containedPath ensures that the resolved path stays within basePath.
// Returns the safe absolute path or an error if path traversal is detected.
func containedPath(basePath, untrustedPath string) (string, error) {
	absBase, err := filepath.Abs(basePath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve base path: %w", err)
	}
	joined := filepath.Join(absBase, filepath.FromSlash(untrustedPath))
	absJoined, err := filepath.Abs(joined)
	if err != nil {
		return "", fmt.Errorf("failed to resolve path: %w", err)
	}
	if !strings.HasPrefix(absJoined, absBase+string(filepath.Separator)) && absJoined != absBase {
		return "", fmt.Errorf("path traversal detected: %q resolves outside base %q", untrustedPath, absBase)
	}
	return absJoined, nil
}

// LocalProvider stores backups on a local or mounted filesystem.
type LocalProvider struct {
	BasePath string
}

// NewLocalProvider creates a LocalProvider rooted at basePath.
func NewLocalProvider(basePath string) *LocalProvider {
	return &LocalProvider{
		BasePath: filepath.Clean(basePath),
	}
}

// Upload copies a file into the local backup store.
func (p *LocalProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}

// UploadContext copies a file into the local backup store with cancellation support.
func (p *LocalProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if p.BasePath == "" {
		return errors.New("local provider base path is required")
	}
	if localPath == "" {
		return errors.New("local source path is required")
	}
	if remotePath == "" {
		return errors.New("remote path is required")
	}

	destPath, err := containedPath(p.BasePath, remotePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}

	if strings.HasSuffix(remotePath, ".gz") {
		return compressFileContext(ctx, localPath, destPath)
	}
	return copyFileContext(ctx, localPath, destPath)
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

	srcPath, err := containedPath(p.BasePath, remotePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	if strings.HasSuffix(remotePath, ".gz") {
		return decompressFile(srcPath, localPath)
	}
	return copyFileContext(context.Background(), srcPath, localPath)
}

// List enumerates files under the given prefix.
func (p *LocalProvider) List(prefix string) ([]string, error) {
	if p.BasePath == "" {
		return nil, errors.New("local provider base path is required")
	}

	root := p.BasePath
	if prefix != "" {
		var containErr error
		root, containErr = containedPath(p.BasePath, prefix)
		if containErr != nil {
			return nil, containErr
		}
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

	target, err := containedPath(p.BasePath, remotePath)
	if err != nil {
		return err
	}
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

func copyFileContext(ctx context.Context, srcPath, destPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
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

	_, err = io.Copy(destFile, &contextReader{ctx: ctx, reader: srcFile})
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
		_ = os.Remove(destPath)
		return fmt.Errorf("failed to copy file: %w", err)
	}
	return nil
}

func compressFileContext(ctx context.Context, srcPath, destPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
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

	_, err = io.Copy(gzipWriter, &contextReader{ctx: ctx, reader: srcFile})
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
		_ = os.Remove(destPath)
		return fmt.Errorf("failed to compress file: %w", err)
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if r.ctx != nil {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
	}
	return r.reader.Read(p)
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

	_, err = io.Copy(destFile, io.LimitReader(gzipReader, maxDecompressSize))
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
