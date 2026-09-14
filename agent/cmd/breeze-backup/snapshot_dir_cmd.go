package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(newSnapshotDirCommand())
}

// newSnapshotDirCommand is test-support only — NOT a release artifact, not
// wired into the agent's IPC/backup_run command path. It exists solely to
// seed a whole-machine file snapshot for the QEMU recovery-media
// end-to-end proof (W04b Task 4, agent/recovery-media/e2e/seed-snapshot.sh)
// from an arbitrary directory (an mmdebstrap-built Debian root), without
// reimplementing agent/internal/backup's real (and considerably more
// complex — VSS, dedupe, lease-gated publish, ...) production backup path.
//
// It writes a real backup.Snapshot manifest and raw (uncompressed) file
// content directly under --out, using the exact key scheme
// agent/internal/backup/rebuild/fetch.go and restore.go already read:
// snapshots/<id>/manifest.json and snapshots/<id>/files/<sha256(sourcePath)>.
// Deliberately NOT gzip-compressed: only providers.LocalProvider actually
// compresses ".gz"-suffixed keys (every cloud provider just uses that
// suffix as a naming convention and stores raw bytes — see
// providers/local.go vs providers/s3.go), and the fake recovery server
// this snapshot is served through (agent/internal/backup/bmr/fakeserver)
// streams objects verbatim, matching every real provider except Local.
//
// SourcePath is rooted at "/" + the file's path relative to --root — i.e.
// this only produces a correct snapshot when --root's own layout already
// looks like a real machine's "/" (an mmdebstrap output does). The
// rebuild engine's restore path (resolveTargetPath) strips the leading
// slash and joins onto the mounted staging root, so this must match.
//
// layout.json is NOT written here — agent/recovery-media/e2e/seed-snapshot.sh
// writes it directly (a synthetic single-disk UEFI layout matching the
// QEMU target image's geometry has nothing to do with --root's real
// filesystem layout, so there is nothing for this command to collect).
func newSnapshotDirCommand() *cobra.Command {
	var root, out, snapshotID string
	var exclude []string

	cmd := &cobra.Command{
		Use:    "snapshot-dir",
		Short:  "Test-support only: seed a whole-machine file snapshot from a directory (agent/recovery-media/e2e)",
		Hidden: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if root == "" || out == "" || snapshotID == "" {
				return fmt.Errorf("--root, --out and --snapshot-id are required")
			}
			rootAbs, err := filepath.Abs(root)
			if err != nil {
				return err
			}
			result, err := snapshotDir(rootAbs, out, snapshotID, exclude)
			if err != nil {
				return err
			}
			encoded, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return err
			}
			_, _ = cmd.OutOrStdout().Write(append(encoded, '\n'))
			return nil
		},
	}
	cmd.Flags().StringVar(&root, "root", "", "directory to snapshot, treated as the machine's own \"/\" (required)")
	cmd.Flags().StringVar(&out, "out", "", "snapshot store root (required)")
	cmd.Flags().StringVar(&snapshotID, "snapshot-id", "", "snapshot id (required)")
	cmd.Flags().StringArrayVar(&exclude, "exclude", nil, "directory (relative to --root) to skip entirely, e.g. proc, sys, dev, tmp; may be repeated")
	_ = cmd.MarkFlagRequired("root")
	_ = cmd.MarkFlagRequired("out")
	_ = cmd.MarkFlagRequired("snapshot-id")
	return cmd
}

type snapshotDirResult struct {
	SnapshotID   string `json:"snapshotId"`
	Files        int    `json:"files"`
	Bytes        int64  `json:"bytes"`
	ManifestPath string `json:"manifestPath"`
}

func snapshotDir(root, storeDir, snapshotID string, excludeRel []string) (*snapshotDirResult, error) {
	excluded := make(map[string]bool, len(excludeRel))
	for _, e := range excludeRel {
		excluded[filepath.Clean(e)] = true
	}

	var entries []backup.SnapshotFile
	var totalBytes int64

	walkErr := filepath.WalkDir(root, func(fullPath string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if fullPath == root {
			return nil // the root itself has no useful manifest entry
		}
		rel, relErr := filepath.Rel(root, fullPath)
		if relErr != nil {
			return relErr
		}
		relSlash := filepath.ToSlash(rel)
		if excluded[filepath.Clean(rel)] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		sourcePath := "/" + relSlash
		info, lerr := d.Info() // Lstat-based (WalkDir does not follow symlinks)
		if lerr != nil {
			return lerr
		}

		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, rerr := os.Readlink(fullPath)
			if rerr != nil {
				return fmt.Errorf("readlink %s: %w", fullPath, rerr)
			}
			entries = append(entries, backup.SnapshotFile{
				SourcePath: sourcePath,
				Kind:       backup.KindSymlink,
				LinkTarget: target,
				ModTime:    info.ModTime(),
				ModeBits:   uint32(info.Mode().Perm()),
				Owner:      fileOwner(info),
			})
		case d.IsDir():
			entries = append(entries, backup.SnapshotFile{
				SourcePath: sourcePath,
				Kind:       backup.KindDir,
				ModTime:    info.ModTime(),
				ModeBits:   uint32(info.Mode().Perm()),
				Owner:      fileOwner(info),
			})
		case info.Mode().IsRegular():
			sum, size, cerr := copyWithChecksum(fullPath, storeDir, snapshotID, sourcePath)
			if cerr != nil {
				return fmt.Errorf("copy %s: %w", fullPath, cerr)
			}
			backupPath := contentKey(snapshotID, sourcePath)
			entries = append(entries, backup.SnapshotFile{
				SourcePath: sourcePath,
				BackupPath: backupPath,
				Size:       size,
				ModTime:    info.ModTime(),
				Checksum:   sum,
				Mode:       uint32(info.Mode().Perm()),
				ModeBits:   uint32(info.Mode().Perm()),
				Owner:      fileOwner(info),
			})
			totalBytes += size
		default:
			// Device nodes, sockets, FIFOs: skip. A real chroot-built
			// Debian root has none of these outside excluded pseudo-fs
			// mount points (/dev is empty in a fresh mmdebstrap output).
		}
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}

	snap := backup.Snapshot{
		ID:             snapshotID,
		Timestamp:      time.Now().UTC(),
		Files:          entries,
		Size:           totalBytes,
		FormatVersion:  3, // fidelity format: content-less entries + ownership present, see snapshot.go's manifestFormatFidelity
		BackupIdentity: "e2e",
	}
	manifestPath := filepath.Join(storeDir, "snapshots", snapshotID, "manifest.json")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return nil, err
	}

	return &snapshotDirResult{SnapshotID: snapshotID, Files: len(entries), Bytes: totalBytes, ManifestPath: manifestPath}, nil
}

// contentKey mirrors the shape (not the byte-identical algorithm) of the
// real backup package's content-addressed BackupPath: a fixed-length,
// collision-resistant key derived from the source path, under
// snapshots/<id>/files/. Unlike the real ensureGzipExtension it carries no
// ".gz" suffix — see this file's package doc comment for why.
func contentKey(snapshotID, sourcePath string) string {
	sum := sha256.Sum256([]byte(sourcePath))
	return path.Join("snapshots", snapshotID, "files", hex.EncodeToString(sum[:]))
}

// copyWithChecksum streams srcPath to storeDir/<contentKey> while hashing
// it, so the manifest's Checksum is computed from the exact bytes written
// — never a separate re-read that could observe a different (e.g.
// concurrently modified) file.
func copyWithChecksum(srcPath, storeDir, snapshotID, sourcePath string) (checksum string, size int64, err error) {
	destKey := contentKey(snapshotID, sourcePath)
	destPath := filepath.Join(storeDir, filepath.FromSlash(destKey))
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return "", 0, err
	}

	src, err := os.Open(srcPath)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = src.Close() }()

	dest, err := os.Create(destPath)
	if err != nil {
		return "", 0, err
	}

	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(dest, h), src)
	closeErr := dest.Close()
	if copyErr != nil {
		return "", 0, copyErr
	}
	if closeErr != nil {
		return "", 0, closeErr
	}
	return hex.EncodeToString(h.Sum(nil)), written, nil
}
