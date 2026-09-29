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
	"time"
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

// BackupIdentity implements JournalIdentity.
func (p *LocalProvider) BackupIdentity() string {
	return "local|" + p.BasePath
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

// UploadWithDigest implements DigestUploader. It writes the object exactly as
// UploadContext does (gzip for a ".gz" key) but through a temporary file in
// the destination directory that is renamed over the key only once the copy
// completed, so a failed or cancelled upload leaves any existing object
// untouched. The digest is over the source bytes read — the content Download
// returns for the key.
func (p *LocalProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (UploadDigest, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if p.BasePath == "" {
		return UploadDigest{}, errors.New("local provider base path is required")
	}
	if localPath == "" {
		return UploadDigest{}, errors.New("local source path is required")
	}
	if remotePath == "" {
		return UploadDigest{}, errors.New("remote path is required")
	}
	destPath, err := containedPath(p.BasePath, remotePath)
	if err != nil {
		return UploadDigest{}, err
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to create backup directory: %w", err)
	}

	srcFile, err := os.Open(localPath)
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer func() { _ = srcFile.Close() }()
	srcInfo, err := srcFile.Stat()
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to stat source file: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(destPath), "."+filepath.Base(destPath)+localUploadTempMarker+"*")
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to create destination file: %w", err)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	sum := newCountingHash()
	reader := io.TeeReader(&contextReader{ctx: ctx, reader: uploadProgressSource(ctx, srcFile)}, sum)
	if strings.HasSuffix(remotePath, ".gz") {
		gzipWriter := gzip.NewWriter(tmp)
		gzipWriter.Name = filepath.Base(localPath)
		gzipWriter.ModTime = srcInfo.ModTime()
		if _, err := io.Copy(gzipWriter, reader); err != nil {
			return UploadDigest{}, fmt.Errorf("failed to compress file: %w", err)
		}
		if err := gzipWriter.Close(); err != nil {
			return UploadDigest{}, fmt.Errorf("failed to compress file: %w", err)
		}
	} else if _, err := io.Copy(tmp, reader); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to copy file: %w", err)
	}
	// No fsync, like the in-place writers: the rename keeps a failed upload
	// from replacing an existing object, and a restore checks every byte
	// against the recorded digest anyway.
	if err := tmp.Close(); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to close destination file: %w", err)
	}
	// Same permissions os.Create gives the in-place writers.
	_ = os.Chmod(tmpPath, 0o644)
	if !strings.HasSuffix(remotePath, ".gz") {
		if err := os.Chtimes(tmpPath, srcInfo.ModTime(), srcInfo.ModTime()); err != nil {
			return UploadDigest{}, fmt.Errorf("failed to copy file: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return UploadDigest{}, err
	}
	if err := renameWithRetry(tmpPath, destPath); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to store backup file: %w", err)
	}
	committed = true
	return sum.digest(), nil
}

// localRename is os.Rename; a test seam.
var localRename = os.Rename

func setLocalRenameForTest(fn func(string, string) error) (restore func()) {
	old := localRename
	localRename = fn
	return func() { localRename = old }
}

// renameWithRetry renames from over to, retrying a few times over about a
// second: on Windows, replacing a file fails while another process (a
// virus scanner, the search indexer) briefly holds it open.
func renameWithRetry(from, to string) error {
	delay := 25 * time.Millisecond
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = localRename(from, to); err == nil {
			return nil
		}
		if attempt < 4 {
			time.Sleep(delay)
			delay *= 2
		}
	}
	return err
}

// localUploadTempMarker is part of the name of the temporary file
// UploadWithDigest writes beside an object before renaming it into place.
const localUploadTempMarker = ".upload-"

// SweepStaleUploads implements StaleUploadSweeper: it removes temporary upload
// files (".<name>.upload-*", written by UploadWithDigest) under prefix that
// are older than olderThan — left behind when the helper stopped mid-upload.
// Nothing else is touched.
func (p *LocalProvider) SweepStaleUploads(prefix string, olderThan time.Duration) (int, error) {
	if p.BasePath == "" {
		return 0, errors.New("local provider base path is required")
	}
	root, err := containedPath(p.BasePath, prefix)
	if err != nil {
		return 0, err
	}
	if _, err := os.Stat(root); errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	cutoff := time.Now().Add(-olderThan)
	removed := 0
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		name := entry.Name()
		if !strings.HasPrefix(name, ".") || !strings.Contains(name, localUploadTempMarker) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			return nil
		}
		if err := os.Remove(path); err == nil {
			removed++
		}
		return nil
	})
	return removed, walkErr
}

// Download retrieves a file from the local backup store.
func (p *LocalProvider) Download(remotePath, localPath string) error {
	return p.DownloadContext(context.Background(), remotePath, localPath)
}

// DownloadContext retrieves a file from the local backup store. Cancelling
// ctx stops the copy/decompression between reads, which bounds a SLOW local
// store (e.g. a crawling network share). It cannot interrupt a single read
// syscall that never returns — os.File I/O is not cancellable — so a hard-hung
// share still blocks the caller.
func (p *LocalProvider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
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
	// Positively confirm the SOURCE object is absent before attempting
	// anything else. copyFileContext/decompressFile also touch the
	// destination side (os.Create, os.Chtimes) after this point, and their
	// own fmt.Errorf wrapping would let a DESTINATION-side ENOENT (a
	// concurrently-removed destination directory, however unlikely) also
	// satisfy errors.Is(_, fs.ErrNotExist) — which must never be classified
	// the same as "the requested remote object doesn't exist" (the
	// fail-open bug ErrObjectNotFound exists to prevent; see
	// fetchPublishedManifest's three-state contract).
	if _, statErr := os.Stat(srcPath); statErr != nil {
		if errors.Is(statErr, fs.ErrNotExist) {
			return fmt.Errorf("%w: %s", ErrObjectNotFound, statErr)
		}
		return fmt.Errorf("failed to stat local backup object: %w", statErr)
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	if strings.HasSuffix(remotePath, ".gz") {
		return decompressFileContext(ctx, srcPath, localPath)
	}
	return copyFileContext(ctx, srcPath, localPath)
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

	_, err = io.Copy(DownloadProgressWriter(ctx, destFile), &contextReader{ctx: ctx, reader: uploadProgressSource(ctx, srcFile)})
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

	_, err = io.Copy(gzipWriter, &contextReader{ctx: ctx, reader: uploadProgressSource(ctx, srcFile)})
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

func decompressFileContext(ctx context.Context, srcPath, destPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}

	gzipReader, err := gzip.NewReader(&contextReader{ctx: ctx, reader: srcFile})
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

	_, err = io.Copy(DownloadProgressWriter(ctx, destFile), io.LimitReader(gzipReader, maxDecompressSize))
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
