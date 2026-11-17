package providers

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
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
	if strings.TrimSpace(basePath) == "" {
		return &LocalProvider{}
	}
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
	_, err := p.UploadWithDigest(ctx, localPath, remotePath)
	return err
}

// openStoreRoot is os.OpenRoot; a test seam.
var openStoreRoot = os.OpenRoot

// openStore returns the store directory as an *os.Root that every operation
// resolves keys through. The directory's ownership and access are verified on
// a descriptor reached by a walk that does not follow a link at the store path
// itself; the returned root is then accepted only when it is that same
// directory (same file identity), so the root that operations use is always
// the one that was verified.
func (p *LocalProvider) openStore(create bool) (*os.Root, error) {
	if strings.TrimSpace(p.BasePath) == "" {
		return nil, errors.New("local provider base path is required")
	}
	base, err := filepath.Abs(p.BasePath)
	if err != nil {
		return nil, err
	}
	// Network shares are refused before the path is created, opened or
	// checked, so the operator sees why rather than an access-check failure.
	if err := refuseNetworkShare(p.BasePath, base); err != nil {
		return nil, err
	}
	if filepath.Dir(base) == base {
		return nil, errors.New("local backup store requires a dedicated directory")
	}
	if _, err := os.Lstat(base); errors.Is(err, fs.ErrNotExist) {
		if !create {
			return nil, err
		}
		if err := securefs.EnsurePrivateDir(base); err != nil {
			return nil, fmt.Errorf("create backup store: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	verified, err := securefs.PrivateDirInfo(base)
	if err != nil {
		return nil, fmt.Errorf("local backup store is not private: stop using this destination, verify it is a dedicated backup directory, migrate to a new private directory or restrict existing directory access to the service account, and review all existing object permissions before retrying: %w", err)
	}
	root, err := openStoreRoot(base)
	if err != nil {
		return nil, err
	}
	captured, err := root.Stat(".")
	if err != nil || !os.SameFile(verified, captured) {
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("backup store directory changed while opening")
	}
	// The opened root itself must not be on a network volume, however its
	// path was spelled; a check that cannot decide refuses the store.
	remote, err := storeRootIsRemote(root)
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("local backup store %q: determine whether it is on a network share: %w", p.BasePath, err)
	}
	if remote {
		_ = root.Close()
		return nil, fmt.Errorf("local backup store %q is on a network share: %w", p.BasePath, ErrNetworkShareStore)
	}
	return root, nil
}

// Prepare creates or verifies the dedicated, owner-only store directory.
func (p *LocalProvider) Prepare() error {
	tree, err := p.openStore(true)
	if err != nil {
		return err
	}
	return tree.Close()
}

func (p *LocalProvider) prepareObjectParents(root *os.Root, key string) error {
	var parents []string
	for dir := filepath.Dir(key); dir != "."; dir = filepath.Dir(dir) {
		parents = append(parents, dir)
	}
	for i := len(parents) - 1; i >= 0; i-- {
		if err := securefs.EnsurePrivateDirInRoot(root, parents[i]); err != nil {
			return fmt.Errorf("backup object directory: %w", err)
		}
	}
	return nil
}

func (p *LocalProvider) objectRelative(root *os.Root, key string) (string, error) {
	target, err := containedPath(p.BasePath, key)
	if err != nil {
		return "", err
	}
	base, err := filepath.Abs(p.BasePath)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(base, target)
	if err != nil {
		return "", err
	}
	if relative == "." {
		return relative, nil
	}
	relative, err = securefs.CleanRelative(relative)
	if err != nil {
		return "", err
	}
	current := ""
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := root.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("backup object path contains a link")
		}
		if err := checkStoreEntryType(current, info.Mode()); err != nil {
			return "", err
		}
	}
	return relative, nil
}

// checkStoreEntryType refuses a store entry that is neither a regular file
// nor a directory: links, named pipes, devices, sockets and, on Windows,
// junctions and other reparse points that are reported as irregular.
func checkStoreEntryType(name string, mode fs.FileMode) error {
	if mode.IsRegular() || mode.IsDir() {
		return nil
	}
	if mode&os.ModeSymlink != 0 {
		return fmt.Errorf("backup object %s is a link", filepath.ToSlash(name))
	}
	return fmt.Errorf("backup object %s is not a regular file or directory", filepath.ToSlash(name))
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
	tree, err := p.openStore(true)
	if err != nil {
		return UploadDigest{}, err
	}
	defer func() { _ = tree.Close() }()
	destPath, err := p.objectRelative(tree, remotePath)
	if err != nil {
		return UploadDigest{}, err
	}
	if destPath == "." {
		return UploadDigest{}, errors.New("backup object key is required")
	}
	if err := p.prepareObjectParents(tree, destPath); err != nil {
		return UploadDigest{}, err
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

	tmpPath := filepath.Join(filepath.Dir(destPath), "."+filepath.Base(destPath)+localUploadTempMarker+rand.Text())
	tmp, err := tree.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return UploadDigest{}, fmt.Errorf("failed to create destination file: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = tree.Remove(tmpPath)
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
	// No explicit fsync: the rename keeps a failed upload
	// from replacing an existing object, and a restore checks every byte
	// against the recorded digest anyway.
	if err := tmp.Close(); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to close destination file: %w", err)
	}

	if !strings.HasSuffix(remotePath, ".gz") {
		if err := tree.Chtimes(tmpPath, srcInfo.ModTime(), srcInfo.ModTime()); err != nil {
			return UploadDigest{}, fmt.Errorf("failed to copy file: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return UploadDigest{}, err
	}
	if err := renameWithRetry(tree, tmpPath, destPath); err != nil {
		return UploadDigest{}, fmt.Errorf("failed to store backup file: %w", err)
	}
	committed = true
	return sum.digest(), nil
}

// localRename renames within the open store root; a test seam.
var localRename = func(tree *os.Root, from, to string) error { return tree.Rename(from, to) }

func setLocalRenameForTest(fn func(*os.Root, string, string) error) (restore func()) {
	old := localRename
	localRename = fn
	return func() { localRename = old }
}

// renameWithRetry renames from over to, retrying a few times over about a
// second: on Windows, replacing a file fails while another process (a
// virus scanner, the search indexer) briefly holds it open.
func renameWithRetry(tree *os.Root, from, to string) error {
	delay := 25 * time.Millisecond
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if err = localRename(tree, from, to); err == nil {
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
	tree, err := p.openStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer func() { _ = tree.Close() }()
	key, err := p.objectRelative(tree, prefix)
	if err != nil {
		return 0, err
	}
	if _, err := tree.Stat(key); errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	cutoff, removed := time.Now().Add(-olderThan), 0
	err = fs.WalkDir(tree.FS(), filepath.ToSlash(key), func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if !entry.Type().IsRegular() {
			// Never act on an entry that is not a regular file.
			return nil
		}
		if !strings.HasPrefix(entry.Name(), ".") || !strings.Contains(entry.Name(), localUploadTempMarker) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().Before(cutoff) {
			if err := tree.Remove(name); err == nil {
				removed++
			}
		}
		return nil
	})
	return removed, err
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
	if remotePath == "" || localPath == "" {
		return errors.New("remote and local paths are required")
	}
	tree, err := p.openStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, err)
	}
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	key, err := p.objectRelative(tree, remotePath)
	if err != nil {
		return err
	}
	source, err := tree.Open(key)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, err)
	}
	if err != nil {
		return fmt.Errorf("open backup object: %w", err)
	}
	defer func() { _ = source.Close() }()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("backup object is not a regular file")
	}
	var reader io.Reader = &contextReader{ctx: ctx, reader: source}
	if strings.HasSuffix(remotePath, ".gz") {
		zipped, err := gzip.NewReader(reader)
		if err != nil {
			return fmt.Errorf("open compressed object: %w", err)
		}
		defer func() { _ = zipped.Close() }()
		reader = io.LimitReader(zipped, maxDecompressSize)
	}
	// localPath is the caller's destination, not a store key: its missing
	// parents get the mode every other provider gives them, and the restored
	// file itself is owner-only.
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return err
	}
	target, err := os.OpenFile(localPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := target.Chmod(0o600); err != nil {
		_ = target.Close()
		return err
	}
	_, copyErr := io.Copy(DownloadProgressWriter(ctx, target), reader)
	closeErr := target.Close()
	if copyErr != nil {
		_ = os.Remove(localPath)
		return fmt.Errorf("copy backup object: %w", copyErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if !strings.HasSuffix(remotePath, ".gz") {
		return os.Chtimes(localPath, info.ModTime(), info.ModTime())
	}
	return nil
}

// List enumerates files under the given prefix.
func (p *LocalProvider) List(prefix string) ([]string, error) {
	tree, err := p.openStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = tree.Close() }()
	key, err := p.objectRelative(tree, prefix)
	if err != nil {
		return nil, err
	}
	if _, err := tree.Stat(key); errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	} else if err != nil {
		return nil, err
	}
	results := []string{}
	err = fs.WalkDir(tree.FS(), filepath.ToSlash(key), func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := checkStoreEntryType(name, entry.Type()); err != nil {
			return err
		}
		if !entry.IsDir() {
			results = append(results, filepath.ToSlash(name))
		}
		return nil
	})
	return results, err
}

// ObjectSizes returns the size of every object under prefix, keyed like
// List, from one walk through one store root.
func (p *LocalProvider) ObjectSizes(prefix string) (map[string]int64, error) {
	tree, err := p.openStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]int64{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = tree.Close() }()
	key, err := p.objectRelative(tree, prefix)
	if err != nil {
		return nil, err
	}
	if _, err := tree.Stat(key); errors.Is(err, fs.ErrNotExist) {
		return map[string]int64{}, nil
	} else if err != nil {
		return nil, err
	}
	sizes := map[string]int64{}
	err = fs.WalkDir(tree.FS(), filepath.ToSlash(key), func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := checkStoreEntryType(name, entry.Type()); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		sizes[filepath.ToSlash(name)] = info.Size()
		return nil
	})
	if err != nil {
		return nil, err
	}
	return sizes, nil
}

// Delete removes a file from the local backup store.
func (p *LocalProvider) Delete(remotePath string) error {
	if remotePath == "" {
		return errors.New("remote path is required")
	}
	tree, err := p.openStore(false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	key, err := p.objectRelative(tree, remotePath)
	if err != nil {
		return err
	}
	if key == "." {
		return errors.New("backup object key is required")
	}
	if err := tree.Remove(key); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	for dir := filepath.Dir(key); dir != "."; dir = filepath.Dir(dir) {
		if err := tree.Remove(dir); err != nil {
			break
		}
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
