package systemstate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
)

// modeFromInfo converts info's os.FileMode into the traditional POSIX
// st_mode & 07777 encoding: the low 9 bits (permission bits, i.e.
// info.Mode().Perm()) OR'd with the setuid/setgid/sticky bits translated
// from Go's os.ModeSetuid/os.ModeSetgid/os.ModeSticky (which use different
// bit positions than the traditional octal 04000/02000/01000) into those
// traditional positions. Platform-independent: os.ModeSetuid/Setgid/Sticky
// are always false on Windows, so this degrades to just the permission bits
// there, matching Artifact.Mode's doc comment.
func modeFromInfo(info os.FileInfo) uint32 {
	fm := info.Mode()
	mode := uint32(fm.Perm())
	if fm&os.ModeSetuid != 0 {
		mode |= 0o4000
	}
	if fm&os.ModeSetgid != 0 {
		mode |= 0o2000
	}
	if fm&os.ModeSticky != 0 {
		mode |= 0o1000
	}
	return mode
}

// sha256File streams a file through SHA-256 and returns the lowercase-hex
// digest, mirroring backup.sha256File — this package sits below the backup
// package in the dependency graph (backup imports systemstate) so it cannot
// reuse that one directly.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	// Read-only handle: nothing buffered to lose, so a Close failure here
	// (already-closed fd, or a similarly benign race) is not worth
	// propagating — discard explicitly rather than leaving it unchecked.
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// artifactFromFile creates an Artifact for a single collected file, including
// its SHA-256 checksum (computed here, at collection time, while the file is
// known-good — a BMR consumer verifies downloaded bytes against this before
// applying them) and its mode/uid/gid/modTime (from os.Lstat, never
// following a symlink — see Artifact.Mode/UID/GID/ModTime's doc comments),
// so a BMR restore (Wave 3) can put the restored file back exactly as it was
// collected.
func artifactFromFile(name, category, absPath, stagingDir string) Artifact {
	relPath, _ := filepath.Rel(stagingDir, absPath)
	art := Artifact{
		Name:     name,
		Category: category,
		Path:     filepath.ToSlash(relPath),
	}
	if info, err := os.Lstat(absPath); err == nil {
		art.SizeBytes = info.Size()
		art.Mode = modeFromInfo(info)
		art.ModTime = info.ModTime()
		if uid, gid := uidGidFromInfo(info); uid >= 0 {
			art.UID, art.GID = uid, gid
		}
	}
	checksum, err := sha256File(absPath)
	if err != nil {
		slog.Warn("systemstate: checksum failed, artifact recorded without one",
			"path", absPath, "error", err.Error())
	}
	art.Checksum = checksum
	return art
}

// collectArtifactsInDir walks a directory and returns an Artifact for each
// REGULAR file (with checksum + metadata — see artifactFromFile's doc
// comment) and each SYMLINK (LinkTarget set instead — see Artifact.
// LinkTarget's doc comment; no checksum or metadata, since a symlink has no
// independent file content of its own to hash and copyTree/copyFile don't
// preserve mode/ownership on the link itself in a way worth restoring
// separately from recreating the link). Any other non-regular, non-symlink
// entry (socket, FIFO, device) is skipped entirely, matching copyTree's own
// choice not to stage them.
func collectArtifactsInDir(category, dir, stagingDir string) ([]Artifact, error) {
	var artifacts []Artifact
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip errors
		}
		if d.IsDir() {
			return nil
		}
		relPath, relErr := filepath.Rel(stagingDir, path)
		if relErr != nil {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(path)
			if readErr != nil {
				slog.Warn("systemstate: readlink failed, symlink artifact skipped",
					"path", path, "error", readErr.Error())
				return nil
			}
			artifacts = append(artifacts, Artifact{
				Name:       filepath.Base(path),
				Category:   category,
				Path:       filepath.ToSlash(relPath),
				LinkTarget: target,
			})
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // socket, FIFO, device — see doc comment above
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		checksum, sumErr := sha256File(path)
		if sumErr != nil {
			slog.Warn("systemstate: checksum failed, artifact recorded without one",
				"path", path, "error", sumErr.Error())
		}
		art := Artifact{
			Name:      filepath.Base(path),
			Category:  category,
			Path:      filepath.ToSlash(relPath),
			SizeBytes: info.Size(),
			Checksum:  checksum,
			Mode:      modeFromInfo(info),
			ModTime:   info.ModTime(),
		}
		if uid, gid := uidGidFromInfo(info); uid >= 0 {
			art.UID, art.GID = uid, gid
		}
		artifacts = append(artifacts, art)
		return nil
	})
	return artifacts, err
}

// copyFile copies a single filesystem entry from src to dst, preserving its
// permission bits, modification time, and (best-effort, Unix only — see
// lchownBestEffort) owning uid/gid.
//
// src is statted here via os.Lstat (never follows symlinks), so:
//   - a symlink is recreated as a symlink at dst (see copySymlink) rather
//     than silently dereferenced into a copy of its target's content — the
//     bug that would otherwise turn e.g. /etc/localtime (commonly a symlink
//     into /usr/share/zoneinfo) into a plain-file copy that restore can never
//     tell apart from the original;
//   - anything that isn't a regular file or a symlink (socket, FIFO, device)
//     is rejected — callers that walk a tree (copyTree) are expected to
//     filter those out themselves with an info-level log, since "not a
//     regular file" from here reads like a plain error otherwise.
func copyFile(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return fmt.Errorf("lstat %s: %w", src, err)
	}

	if info.Mode()&os.ModeSymlink != 0 {
		return copySymlink(src, dst, info)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("copyFile: %s is not a regular file or symlink (mode %s)", src, info.Mode())
	}

	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}

	if _, err := io.Copy(out, in); err != nil {
		// Best-effort cleanup on the failure path: the io.Copy error below is
		// already the meaningful one to return, and a Close failure here
		// would just be noise on top of it — discard explicitly.
		_ = out.Close()
		return fmt.Errorf("copy %s → %s: %w", src, dst, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("close %s: %w", dst, err)
	}

	applyFileMetadata(dst, info)
	return nil
}

// copySymlink recreates src — a symlink, per copyFile's os.Lstat check — at
// dst pointing at the same target. A dangling target is fine: os.Symlink
// does not validate it, matching how the live source symlink may already be
// dangling (e.g. a stale /etc entry). Mode and mtime are not meaningfully
// settable on a symlink on the platforms this agent targets and are skipped;
// ownership is applied via os.Lchown (see lchownBestEffort) so it lands on
// the LINK itself, never on whatever it points at.
func copySymlink(src, dst string, info os.FileInfo) error {
	target, err := os.Readlink(src)
	if err != nil {
		return fmt.Errorf("readlink %s: %w", src, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	// Best-effort: a stale entry from an earlier, interrupted run must not
	// block os.Symlink with EEXIST. The staging dir is normally fresh
	// (os.MkdirTemp per run), so this is defense-in-depth, not the common
	// case.
	_ = os.Remove(dst)
	if err := os.Symlink(target, dst); err != nil {
		return fmt.Errorf("symlink %s -> %s: %w", dst, target, err)
	}
	lchownBestEffort(dst, info)
	return nil
}

// applyFileMetadata chmods/chtimes dst to match info (a REGULAR file's
// os.Lstat result), then best-effort chowns it (see lchownBestEffort). Each
// step is independently best-effort/warn-only: a staged copy that is missing
// exact metadata is still far more useful for restore than none at all, so
// nothing here fails the collection.
func applyFileMetadata(dst string, info os.FileInfo) {
	if err := os.Chmod(dst, info.Mode().Perm()); err != nil {
		slog.Warn("systemstate: chmod failed on staged copy", "path", dst, "error", err.Error())
	}
	if err := os.Chtimes(dst, info.ModTime(), info.ModTime()); err != nil {
		slog.Warn("systemstate: chtimes failed on staged copy", "path", dst, "error", err.Error())
	}
	lchownBestEffort(dst, info)
}

// dirFixup defers a staged directory's final permissions/mtime/ownership
// until every entry underneath it has been written — see copyTree's doc
// comment for why this can't happen inline during the walk.
type dirFixup struct {
	path string
	info os.FileInfo
}

// copyTree recursively copies a directory tree, preserving each entry's
// permission bits, modification time, and (best-effort) owning uid/gid —
// see copyFile/copySymlink/applyFileMetadata. Permission errors on
// individual files are logged and skipped, not fatal; sockets, FIFOs, and
// device files are skipped with an info log (not staged at all — copying
// their "content" as a plain file is meaningless and os.Open on some of
// these can block).
//
// Directories are created at a permissive 0o700 DURING the walk (so writing
// their own children never fails even when the SOURCE directory is more
// restrictive, e.g. mode 0500) and only chmod/chtimes/chown'd to match the
// source in a second pass after the whole walk completes — fixing them up
// inline, in the same pre-order pass WalkDir uses, would risk locking a
// directory down before its own children are written. The staging ROOT
// (stagingDir itself, created by CollectSystemState via os.MkdirTemp) is
// NOT touched by this function and keeps its own 0700 regardless — it holds
// secret material (registry hives, /etc/shadow-adjacent copies, etc.)
// unrelated to whatever mode any individual copied source directory had.
func copyTree(srcRoot, dstRoot string) error {
	var dirFixups []dirFixup

	walkErr := filepath.WalkDir(srcRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip inaccessible entries
		}

		relPath, err := filepath.Rel(srcRoot, path)
		if err != nil {
			return nil
		}
		dstPath := filepath.Join(dstRoot, relPath)

		info, err := d.Info() // Lstat-based: does not follow symlinks
		if err != nil {
			return nil // vanished between walk and stat; skip
		}

		if d.IsDir() {
			if err := os.MkdirAll(dstPath, 0o700); err != nil {
				return nil
			}
			if relPath != "." {
				dirFixups = append(dirFixups, dirFixup{path: dstPath, info: info})
			}
			return nil
		}

		if d.Type()&os.ModeSymlink != 0 || d.Type().IsRegular() {
			if err := copyFile(path, dstPath); err != nil {
				// Non-fatal: skip files we can't read (e.g. /etc/shadow).
				slog.Warn("systemstate: skipping unreadable file during tree copy",
					"path", path, "error", err.Error())
			}
			return nil
		}

		// Sockets, FIFOs, character/block devices: not meaningful to stage
		// as a file, and opening some of these can block indefinitely.
		// Routine on a live /etc tree — e.g. some distros place sockets
		// under /etc/... — so this is an info log, not a warning.
		slog.Info("systemstate: skipping non-regular, non-symlink entry",
			"path", path, "mode", d.Type().String())
		return nil
	})

	// Fix up every staged directory's real permissions/mtime/ownership now
	// that everything underneath has been written. Order among fixups
	// doesn't matter: this phase only narrows/adjusts metadata and never
	// needs to write anything further inside any of them afterward.
	for _, fx := range dirFixups {
		if err := os.Chmod(fx.path, fx.info.Mode().Perm()); err != nil {
			slog.Warn("systemstate: chmod failed on staged directory", "path", fx.path, "error", err.Error())
		}
		if err := os.Chtimes(fx.path, fx.info.ModTime(), fx.info.ModTime()); err != nil {
			slog.Warn("systemstate: chtimes failed on staged directory", "path", fx.path, "error", err.Error())
		}
		lchownBestEffort(fx.path, fx.info)
	}

	return walkErr
}

// ---------------------------------------------------------------------------
// Windows registry hive collection and Certificate Services detection
//
// These live here (rather than in state_windows.go, which is build-tagged
// windows) so the decision logic — which hives failed, whether AD CS looks
// installed — is exercisable in unit tests on any platform, without a real
// Windows machine or reg.exe/certutil.exe. The package-level var seams below
// are overridden by tests; state_windows.go uses the defaults unmodified.
// ---------------------------------------------------------------------------

// runRegSave executes `reg save HKLM\<hive> <outPath> /y`, capturing combined
// output for diagnostics. It is a package-level var (rather than a direct
// exec.Command call in collectRegistryHives) purely so tests can substitute a
// fake.
var runRegSave = func(hive, outPath string) ([]byte, error) {
	return exec.Command("reg", "save", `HKLM\`+hive, outPath, "/y").CombinedOutput()
}

// registrySaveError reports that one or more registry hives failed to save.
// FailedHives names exactly which ones, so callers can log or surface the
// specific hive instead of only "the registry step failed".
type registrySaveError struct {
	FailedHives []string
	Err         error // the first hive's error, representative of the failure
}

func (e *registrySaveError) Error() string {
	return fmt.Sprintf("reg save failed for hive(s) %v: %s", e.FailedHives, e.Err)
}

func (e *registrySaveError) Unwrap() error { return e.Err }

// collectRegistryHives saves each named hive from dir via runRegSave. Hives
// that succeed are kept as artifacts even when others fail — a partial
// registry capture is more useful for diagnosis than none — while a non-nil
// *registrySaveError tells the caller exactly which hive(s) are missing so it
// can decide whether that's acceptable.
func collectRegistryHives(dir, stagingDir string, hives []string) ([]Artifact, error) {
	var artifacts []Artifact
	var failed []string
	var firstErr error
	for _, hive := range hives {
		outPath := filepath.Join(dir, hive)
		out, err := runRegSave(hive, outPath)
		if err != nil {
			slog.Warn("systemstate: reg save failed", "hive", hive, "error", err.Error(), "output", string(out))
			failed = append(failed, hive)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		artifacts = append(artifacts, artifactFromFile("registry_"+hive, "registry", outPath, stagingDir))
	}
	if len(failed) > 0 {
		return artifacts, &registrySaveError{FailedHives: failed, Err: firstErr}
	}
	return artifacts, nil
}

// certSvcInstalled reports whether the AD CS (Certificate Services) role
// appears to be installed, checked the same way collectIIS checks for IIS:
// existence of the role's binary under %WINDIR%\system32. A package-level var
// so tests can fake it without a real Windows machine.
var certSvcInstalled = func() bool {
	certsrv := filepath.Join(os.Getenv("WINDIR"), "system32", "certsrv.exe")
	_, err := os.Stat(certsrv)
	return err == nil
}
