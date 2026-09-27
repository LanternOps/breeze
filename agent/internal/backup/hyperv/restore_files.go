package hyperv

// Platform-neutral file placement for restores that rebuild a VM disk from a
// file snapshot (vm_restore_from_backup, vm_instant_boot). Kept free of
// Windows-only calls so the path mapping and outcome rules are tested on any
// OS; the Windows entry points supply the mounted volume root.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VMRestoreFromBackupResult holds the outcome of a VM restore from backup.
type VMRestoreFromBackupResult struct {
	VMName   string `json:"vmName"`
	NewVMID  string `json:"newVmId"`
	VHDXPath string `json:"vhdxPath"`
	// RestorePath is the per-restore directory holding the VM's disk and
	// configuration.
	RestorePath   string   `json:"restorePath,omitempty"`
	Status        string   `json:"status"` // completed, failed
	FilesRestored int      `json:"filesRestored"`
	FilesFailed   int      `json:"filesFailed"`
	BytesRestored int64    `json:"bytesRestored"`
	FailedFiles   []string `json:"failedFiles,omitempty"`
	DurationMs    int64    `json:"durationMs"`
	Warnings      []string `json:"warnings,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// CarryResultOnFailure keeps the counts on a failed command's result.
func (r *VMRestoreFromBackupResult) CarryResultOnFailure() bool { return r != nil }

// InstantBootResult holds the outcome of an instant boot operation.
type InstantBootResult struct {
	VMName               string                   `json:"vmName"`
	NewVMID              string                   `json:"newVmId"`
	Status               string                   `json:"status"` // completed, degraded, failed
	BootTimeMs           int64                    `json:"bootTimeMs"`
	BackgroundSyncActive bool                     `json:"backgroundSyncActive"`
	SyncProgress         *InstantBootSyncProgress `json:"syncProgress,omitempty"`
	Warnings             []string                 `json:"warnings,omitempty"`
	Error                string                   `json:"error,omitempty"`
}

// CarryResultOnFailure keeps the counts on a failed command's result.
func (r *InstantBootResult) CarryResultOnFailure() bool { return r != nil }

// InstantBootSyncProgress counts the non-boot-critical files the sync staged.
type InstantBootSyncProgress struct {
	Total  int `json:"total"`
	Synced int `json:"synced"`
	Failed int `json:"failed"`
}

type vmRestoreManifFile struct {
	SourcePath   string `json:"sourcePath"`
	OriginalPath string `json:"originalPath,omitempty"`
	BackupPath   string `json:"backupPath"`
	Size         int64  `json:"size"`
	Checksum     string `json:"checksum,omitempty"`
	Kind         string `json:"kind,omitempty"`
	Volatile     bool   `json:"volatile,omitempty"`
}

// maxReportedFiles caps FailedFiles and Warnings so a large failed restore
// still fits the result the server accepts (it keeps at most 100 warnings).
const maxReportedFiles = 100

// Entry kinds recorded in a file-snapshot manifest (backup.KindDir,
// backup.KindSymlink). Content-less entries have no object to download.
const (
	manifestKindDir     = "dir"
	manifestKindSymlink = "symlink"
)

// fileRestoreTally is the outcome of placing a set of snapshot files.
type fileRestoreTally struct {
	Total    int
	Restored int
	Failed   int
	Bytes    int64
	// FailedFiles and Warnings are bounded by maxReportedFiles; Failed is the
	// true count.
	FailedFiles []string
	Warnings    []string
}

// maxReportedText caps one reported path or warning; the server refuses a
// restore result whose entries exceed 4096 characters.
const maxReportedText = 1024

func truncateReported(s string) string {
	if len(s) <= maxReportedText {
		return s
	}
	cut := maxReportedText - 3
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

func (t *fileRestoreTally) warn(msg string) {
	if len(t.Warnings) < maxReportedFiles {
		t.Warnings = append(t.Warnings, truncateReported(msg))
	}
}

func (t *fileRestoreTally) fail(display, reason string) {
	t.Failed++
	if len(t.FailedFiles) < maxReportedFiles && display != "" {
		t.FailedFiles = append(t.FailedFiles, truncateReported(display))
	}
	t.warn(fmt.Sprintf("%s: %s", display, reason))
}

// err is non-nil unless every file entry was placed. A restore that placed
// nothing, or dropped any file, is a failed restore — never a completed one.
func (t fileRestoreTally) err() error {
	if t.Failed > 0 {
		return fmt.Errorf("%d of %d files could not be restored (%d restored)", t.Failed, t.Total, t.Restored)
	}
	if t.Restored == 0 {
		return fmt.Errorf("the snapshot has no files to restore")
	}
	return nil
}

// restoreEntryPath is the path an entry was backed up from: OriginalPath when
// VSS rewrote SourcePath to a shadow-copy device path, else SourcePath (the
// same rule as the file restore's restoreSourcePath).
func restoreEntryPath(f vmRestoreManifFile) string {
	if f.OriginalPath != "" {
		return f.OriginalPath
	}
	return f.SourcePath
}

// vmRestoreRelativePath maps an entry's recorded path onto the root of the
// new VM volume, as a slash-separated relative path. The recorded path is a
// Windows path (drive, UNC, \\?\ or a VSS shadow-copy device) or a POSIX one;
// its volume or device prefix is dropped so C:\Users\x lands at Users/x on the
// new disk. Parent components, alternate data streams, drive-relative
// components and NUL bytes are refused rather than cleaned.
func vmRestoreRelativePath(f vmRestoreManifFile) (string, error) {
	recorded := restoreEntryPath(f)
	if recorded == "" {
		return "", fmt.Errorf("entry has no path")
	}
	if strings.ContainsRune(recorded, 0) {
		return "", fmt.Errorf("path contains a NUL byte")
	}
	rest, err := stripWindowsVolume(strings.ReplaceAll(recorded, "/", `\`))
	if err != nil {
		return "", err
	}
	var parts []string
	for _, c := range strings.Split(rest, `\`) {
		if c == "" || c == "." {
			continue
		}
		// Win32 path normalisation drops trailing dots and spaces, so ".. "
		// and "..." name the parent or the directory itself.
		if strings.TrimRight(c, ". ") == "" {
			return "", fmt.Errorf("path %q has a parent or dot component", recorded)
		}
		if strings.ContainsAny(c, `:*?"<>|`) {
			return "", fmt.Errorf("path %q has a component that is not a plain file name", recorded)
		}
		parts = append(parts, c)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("path %q names a volume root, not a file", recorded)
	}
	return strings.Join(parts, "/"), nil
}

// stripWindowsVolume removes the volume or device prefix from a
// backslash-separated path and returns the remainder.
func stripWindowsVolume(p string) (string, error) {
	hasPrefixFold := func(s, prefix string) bool {
		return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
	}
	// skipComponents drops n leading components (each must be non-empty).
	skipComponents := func(s string, n int) (string, bool) {
		for i := 0; i < n; i++ {
			j := strings.IndexByte(s, '\\')
			if j < 0 {
				if s == "" || i != n-1 {
					return "", false
				}
				return "", true
			}
			if j == 0 {
				return "", false
			}
			s = s[j+1:]
		}
		return s, true
	}
	isDrive := func(s string) bool {
		return len(s) >= 2 && s[1] == ':' && ((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z'))
	}

	switch {
	case hasPrefixFold(p, `\\?\`) || hasPrefixFold(p, `\\.\`):
		rest := p[4:]
		switch {
		case hasPrefixFold(rest, `GLOBALROOT\Device\`):
			// \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN\<path>: the
			// device root is the volume root.
			out, ok := skipComponents(rest[len(`GLOBALROOT\Device\`):], 1)
			if !ok {
				return "", fmt.Errorf("path %q has no device name", p)
			}
			return out, nil
		case hasPrefixFold(rest, `UNC\`):
			out, ok := skipComponents(rest[len(`UNC\`):], 2)
			if !ok {
				return "", fmt.Errorf("path %q has no server and share", p)
			}
			return out, nil
		case isDrive(rest):
			return rest[2:], nil
		case hasPrefixFold(rest, `Volume{`):
			out, ok := skipComponents(rest, 1)
			if !ok {
				return "", fmt.Errorf("path %q has no volume", p)
			}
			return out, nil
		default:
			return "", fmt.Errorf("path %q uses an unsupported device prefix", p)
		}
	case strings.HasPrefix(p, `\\`):
		out, ok := skipComponents(p[2:], 2)
		if !ok {
			return "", fmt.Errorf("path %q has no server and share", p)
		}
		return out, nil
	case isDrive(p):
		return p[2:], nil
	default:
		return p, nil
	}
}

// restoreManifestFiles downloads each regular file in files to its mapped
// path under root. Directory entries are created; symlinks are skipped with a
// warning (a new VM volume gets no links). Every refused, failed or corrupt
// file is counted; tally.err() decides the restore's outcome.
func restoreManifestFiles(ctx context.Context, files []vmRestoreManifFile, provider providers.BackupProvider, root string) fileRestoreTally {
	var t fileRestoreTally
	cleanRoot := filepath.Clean(root)

	// Map every entry first so the download plan names only objects that
	// will actually be fetched.
	type placement struct {
		file    vmRestoreManifFile
		display string
		target  string
		err     error
	}
	placements := make([]placement, 0, len(files))
	var plan []string
	for _, file := range files {
		p := placement{file: file, display: restoreEntryPath(file)}
		rel, err := vmRestoreRelativePath(file)
		if err == nil {
			p.target = filepath.Join(cleanRoot, filepath.FromSlash(rel))
			if !underRoot(cleanRoot, p.target) {
				err = fmt.Errorf("path %q escapes the restore root", p.display)
			}
		}
		p.err = err
		if err == nil && file.Kind == "" && file.BackupPath != "" {
			plan = append(plan, file.BackupPath)
		}
		placements = append(placements, p)
	}
	if planner, ok := provider.(downloadPlanner); ok && len(plan) > 0 {
		planner.PrepareDownloads(plan)
	}

	for _, p := range placements {
		file, display, target := p.file, p.display, p.target
		switch file.Kind {
		case manifestKindDir:
			if p.err != nil {
				t.warn(fmt.Sprintf("directory %s skipped: %v", display, p.err))
			} else if err := os.MkdirAll(target, 0o755); err != nil {
				t.warn(fmt.Sprintf("directory %s not created: %v", display, err))
			}
			continue
		case manifestKindSymlink:
			t.warn(fmt.Sprintf("symbolic link %s not restored", display))
			continue
		}

		t.Total++
		if p.err != nil {
			t.fail(display, p.err.Error())
			continue
		}
		if file.BackupPath == "" {
			t.fail(display, "the manifest has no stored object for this file")
			continue
		}
		if ctx.Err() != nil {
			t.fail(display, fmt.Sprintf("not restored: %v", ctx.Err()))
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.fail(display, fmt.Sprintf("create directory: %v", err))
			continue
		}
		if err := downloadObject(ctx, provider, file.BackupPath, target); err != nil {
			_ = os.Remove(target)
			t.fail(display, fmt.Sprintf("download: %v", err))
			continue
		}
		if msg, ok := verifyRestoredFile(target, file); !ok {
			_ = os.Remove(target)
			t.fail(display, msg)
			continue
		} else if msg != "" {
			t.warn(fmt.Sprintf("%s: %s", display, msg))
		}
		t.Restored++
		t.Bytes += file.Size
	}
	return t
}

// downloadPlanner has the shape of providers.DownloadPlanner: a provider that
// authorizes object access in batches (a brokered storage session) takes the
// ordered keys before the downloads start. Purely an optimisation.
type downloadPlanner interface {
	PrepareDownloads(keys []string)
}

// underRoot reports whether target lies strictly beneath root.
func underRoot(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return len(target) > len(prefix) && strings.HasPrefix(target, prefix)
}

// downloadObject uses the provider's cancellable download when it has one.
func downloadObject(ctx context.Context, provider providers.BackupProvider, key, target string) error {
	if cd, ok := provider.(providers.ContextDownloader); ok {
		return cd.DownloadContext(ctx, key, target)
	}
	return provider.Download(key, target)
}

// verifyRestoredFile checks the downloaded bytes against the manifest's size
// and SHA-256. ok=false fails the file; a non-empty msg with ok=true is a
// warning (a file that kept changing while it was backed up).
func verifyRestoredFile(target string, file vmRestoreManifFile) (msg string, ok bool) {
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Sprintf("stat restored file: %v", err), false
	}
	if info.Size() != file.Size {
		msg := fmt.Sprintf("size differs from the manifest (manifest %d, restored %d)", file.Size, info.Size())
		if !file.Volatile {
			return msg, false
		}
		return msg + "; the file was changing during backup", true
	}
	if file.Checksum == "" {
		return "", true
	}
	f, err := os.Open(target)
	if err != nil {
		return fmt.Sprintf("open restored file: %v", err), false
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Sprintf("hash restored file: %v", err), false
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), file.Checksum) {
		msg := "checksum differs from the manifest"
		if !file.Volatile {
			return msg, false
		}
		return msg + "; the file was changing during backup", true
	}
	return "", true
}

// runBackgroundSync stages the files that were not needed to boot, after the
// VM has started, and records the outcome on result. It returns only when the
// sync has finished or ctx (the command's run budget) has ended: the command
// stays open for the whole sync, because its storage session is revoked the
// moment the command reports a terminal result. An incomplete sync leaves
// result "degraded" with the counts and removes the partial staging
// directory; the booted VM is left running.
func runBackgroundSync(ctx context.Context, result *InstantBootResult, syncDir string, files []vmRestoreManifFile, provider providers.BackupProvider) {
	result.BackgroundSyncActive = false
	if len(files) == 0 {
		return
	}
	progress := &InstantBootSyncProgress{}
	result.SyncProgress = progress

	degrade := func(reason string) {
		result.Status = "degraded"
		result.Error = reason
		if err := os.RemoveAll(syncDir); err != nil {
			slog.Warn("instantboot: failed to remove partial sync staging", "dir", syncDir, "error", err.Error())
		}
	}

	if err := os.MkdirAll(syncDir, 0o755); err != nil {
		progress.Total = len(files)
		progress.Failed = len(files)
		degrade(fmt.Sprintf("background sync could not create its staging directory: %v", err))
		return
	}
	slog.Info("instantboot: background sync started", "vmName", result.VMName, "files", len(files), "syncDir", syncDir)

	tally := restoreManifestFiles(ctx, files, provider, syncDir)
	progress.Total = tally.Total
	progress.Synced = tally.Restored
	progress.Failed = tally.Failed
	for _, w := range tally.Warnings {
		if len(result.Warnings) < maxReportedFiles {
			result.Warnings = append(result.Warnings, w)
		}
	}

	if tally.Failed > 0 {
		reason := fmt.Sprintf("background sync incomplete: %d of %d files synced, %d failed", tally.Restored, tally.Total, tally.Failed)
		if ctx.Err() != nil {
			reason += fmt.Sprintf(" (stopped: %v)", ctx.Err())
		}
		slog.Warn("instantboot: "+reason, "vmName", result.VMName)
		degrade(reason)
		return
	}

	var sb strings.Builder
	for _, file := range files {
		sb.WriteString(restoreEntryPath(file))
		sb.WriteString("\n")
	}
	if err := os.WriteFile(filepath.Join(syncDir, "sync-manifest.txt"), []byte(sb.String()), 0o644); err != nil {
		slog.Warn("instantboot: failed to write sync manifest", "error", err.Error())
	}
	slog.Info("instantboot: background sync completed", "vmName", result.VMName, "synced", tally.Restored, "syncDir", syncDir)
}
