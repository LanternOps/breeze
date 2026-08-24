package tools

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// maxFileReadSize is the maximum file size for reading (1MB)
	maxFileReadSize = 1024 * 1024
	// MaxFileWriteSize is the maximum decoded size a file_write command may
	// carry (~5.46MB base64-encoded on the wire). Exported because the
	// websocket read limit (websocket.maxMessageSize) is derived from it —
	// bumping this constant forces reconsideration of that limit via
	// TestMaxMessageSizeCoversLargestLegitimateFrame. The API-side upload
	// schema (apps/api/src/routes/systemTools/schemas.ts fileUploadBodySchema)
	// mirrors this cap.
	MaxFileWriteSize     = 4 * 1024 * 1024
	defaultFileListLimit = 1000
	maxFileListLimit     = 5000
	maxTrashListItems    = 500
	maxTrashMetadataSize = 64 * 1024
	maxTrashPurgeErrors  = 32
)

// deniedSystemPaths are critical system paths that mutating file operations should never target directly.
var deniedSystemPaths = []string{"/", "/boot", "/proc", "/sys", "/dev", "/bin", "/sbin", "/usr"}

// getTrashDirFunc returns the trash directory path. Variable allows test injection.
var getTrashDirFunc = getTrashDir

func readTrashMetadata(metaPath string) (*TrashMetadata, error) {
	info, err := os.Stat(metaPath)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxTrashMetadataSize {
		return nil, fmt.Errorf("trash metadata exceeds maximum size of %d bytes", maxTrashMetadataSize)
	}
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, err
	}
	var meta TrashMetadata
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

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

// sensitiveReadPatterns are lowercased, forward-slash-normalized path fragments
// for credential/secret stores that must never be exfiltrated via a file read or
// directory list. This is a defense-in-depth deny-list (SR5-01): the primary
// gate is the API re-tiering that forces devices.execute + Tier-3 approval, but
// the agent runs as root/LocalSystem and must not blindly trust the path it is
// handed. Matched at a path-component boundary (see matchesPathFragment) so e.g.
// ".../config/system" does not spuriously match ".../config/systemprofile".
var sensitiveReadPatterns = []string{
	// Unix / Linux credential + secret stores
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers",
	"/etc/sudoers.d",
	"/etc/ssl/private",
	// macOS shadow-equivalent
	"/private/etc/master.passwd",
	"/etc/master.passwd",
	// Windows registry credential hives
	"/windows/system32/config/sam",
	"/windows/system32/config/security",
	"/windows/system32/config/system",
	"/windows/ntds/ntds.dit",
	// macOS keychain stores. Listed without a trailing separator so the
	// Keychains directory node is denied alongside its contents (#3385) — every
	// file under it is credential material, so there is nothing to allow through.
	"/library/keychains",
}

// sensitiveReadBasenames are lowercased filenames that are credential stores
// regardless of directory (browser password databases, etc.).
var sensitiveReadBasenames = map[string]bool{
	"login data":     true, // Chrome / Edge / Brave / Chromium
	"key4.db":        true, // Firefox NSS key DB
	"logins.json":    true, // Firefox saved logins
	"signons.sqlite": true, // legacy Firefox logins
	"cookies.sqlite": true, // Firefox cookies (session theft)
}

// matchesPathFragment reports whether frag occurs in norm at a path-component
// boundary: as an exact match, a trailing component, or an interior directory.
func matchesPathFragment(norm, frag string) bool {
	return norm == frag ||
		strings.HasSuffix(norm, frag) ||
		strings.Contains(norm, frag+"/")
}

// isSensitiveReadPath reports whether reading/listing the given path would expose
// a well-known secret store. The comparison is OS-agnostic (backslashes are
// normalized to forward slashes and case is folded), so a Windows target checked
// on a Unix host still matches.
//
// Every deny-list entry is anchored at a path-component boundary, and a
// directory entry denies the directory node itself as well as everything under
// it (#3385) — matchesPathFragment covers both, so entries must NOT carry a
// trailing separator.
func isSensitiveReadPath(p string) bool {
	// Resolve against the working directory first: the deny-list entries are all
	// rooted, so a relative path ("etc/shadow") would slip past every rule while
	// still opening the sensitive target, because the OS resolves it against the
	// same CWD. Agent services routinely run with CWD "/" (Unix) or
	// C:\Windows\System32 (Windows), which puts the deny-list squarely in reach.
	// If the CWD cannot be determined, fall back to the caller's path — the
	// rooted-path rules below still apply.
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}

	// Normalize backslashes explicitly: filepath.ToSlash is a no-op on Unix, but
	// the agent may be asked to read a Windows path (or a Windows path may reach
	// a Unix test host), so fold both separators unconditionally.
	norm := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))

	for _, frag := range sensitiveReadPatterns {
		if matchesPathFragment(norm, frag) {
			return true
		}
	}

	base := norm
	if i := strings.LastIndex(norm, "/"); i >= 0 {
		base = norm[i+1:]
	}
	if sensitiveReadBasenames[base] {
		return true
	}

	// SSH private keys: any file under a .ssh directory whose name looks like a
	// private key (id_*, identity) and is not the public half (*.pub).
	if strings.Contains(norm, "/.ssh/") {
		if base == "identity" || base == "authorized_keys" {
			return true
		}
		if strings.HasPrefix(base, "id_") && !strings.HasSuffix(base, ".pub") {
			return true
		}
	}

	// macOS keychain files outside the standard Keychains directory. The
	// directory itself (and everything under it) is covered by the
	// "/library/keychains" entry in sensitiveReadPatterns.
	if strings.HasSuffix(base, ".keychain") || strings.HasSuffix(base, ".keychain-db") {
		return true
	}

	return false
}

// enforcePathContainment blocks an operation against an obviously-sensitive
// credential store. Symlinks are resolved first (filepath.EvalSymlinks) so a
// symlink whose own name is innocuous cannot be used to escape the deny-list;
// both the literal path and the resolved path are checked.
//
// verb names the operation in the error ("read", "copy", "rename", …) so the
// denial is attributable in agent logs and command results.
//
// KNOWN LIMITATION: this is path-string matching, so a HARD link to a credential
// store under an innocuous name is invisible to it — a hard link has no
// "resolved path" for EvalSymlinks to follow, and os.Lstat reports it as an
// ordinary regular file. Closing that would mean comparing inode/device
// identity against the deny-list, which is a different mechanism. It is not
// reachable through this toolset (nothing here creates links) and requires a
// hard link already present on the target filesystem; it is called out so the
// next reader does not mistake the symlink handling for complete link coverage.
func EnforcePathContainment(verb, cleanPath string) error {
	if isSensitiveReadPath(cleanPath) {
		return fmt.Errorf("%s denied on sensitive path: %s", verb, cleanPath)
	}
	if resolved, ok := resolveForContainment(cleanPath); ok && resolved != cleanPath {
		if isSensitiveReadPath(resolved) {
			return fmt.Errorf("%s denied on sensitive path (via symlink): %s", verb, cleanPath)
		}
	}
	return nil
}

// resolveForContainment resolves cleanPath through any symlinks, returning
// false only when nothing along the path can be resolved at all.
//
// filepath.EvalSymlinks requires EVERY component including the leaf to exist,
// which is never true for a write destination — so a naive
// `EvalSymlinks(path); if err == nil` check silently no-ops on exactly the case
// enforceWriteContainment cares about. That left a real bypass: with a
// pre-existing symlinked PARENT (/tmp/innocent -> ~/.ssh),
// WriteFile("/tmp/innocent/authorized_keys") passed both legs of the check —
// the literal string carries no "/.ssh/" to match, and EvalSymlinks errored on
// the missing leaf so the symlink leg never ran — and implanted the key.
//
// So walk up to the nearest ancestor that EXISTS and re-attach the unresolved
// remainder. That also covers destinations several levels below a symlink,
// which WriteFile/RenameFile/CopyFile happily MkdirAll into.
//
// Two properties of this loop are load-bearing, and an earlier version of this
// fix got both wrong by capping the iteration count at a constant:
//
//   - NO DEPTH CAP. The caller controls the destination string, so any fixed
//     cap is a bypass, not a safety valve: padding the path with more junk
//     segments than the cap ("<link>/a/a/a/…/authorized_keys") exhausts the
//     budget before the resolvable ancestor is reached, the function reports
//     "could not resolve", and EnforcePathContainment reads that as "nothing to
//     check" — reopening the exact hole. Termination needs no cap: each step
//     strictly shortens the path and the loop exits at the root.
//   - CHEAP PROBE, ONE RESOLVE. The ascent probes with os.Lstat (one syscall
//     per level) and calls EvalSymlinks once, on the ancestor that exists.
//     Calling EvalSymlinks on every level instead is quadratic in path depth,
//     which hands the same attacker a CPU-exhaustion knob.
func resolveForContainment(cleanPath string) (string, bool) {
	current := cleanPath
	remainder := ""
	for {
		if _, err := os.Lstat(current); err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", false
			}
			if remainder != "" {
				resolved = filepath.Join(resolved, remainder)
			}
			return resolved, true
		}
		parent, base := filepath.Split(current)
		if base == "" {
			return "", false
		}
		remainder = filepath.Join(base, remainder)
		parent = filepath.Clean(parent)
		if parent == current {
			return "", false
		}
		current = parent
	}
}

// enforceReadContainment blocks reads/lists of obviously-sensitive credential
// stores.
func enforceReadContainment(cleanPath string) error {
	return EnforcePathContainment("read", cleanPath)
}

// maxContainmentWalkEntries bounds the pre-relocation subtree scan. Far above
// any directory an operator moves through a file browser; exceeding it fails
// CLOSED, because an unbounded tree is precisely where an unnoticed credential
// store hides.
const maxContainmentWalkEntries = 500_000

// enforceTreeContainment refuses to RELOCATE a directory whose subtree contains
// a credential store, even when the directory itself is not on the deny-list.
//
// This exists because the deny-list is a path-string match and several of its
// rules only fire on a path component BELOW the directory: "~/.ssh" does not
// match (the rule keys on "/.ssh/"), while "~/.ssh/id_rsa" does. A move carries
// the whole subtree to a new prefix in one syscall, and the relocated copy no
// longer matches anything — DeleteFile("~/.ssh") to trash left the private key
// readable at <trash>/<id>/content/id_rsa, and RenameFile("~/.ssh", "/tmp/x")
// left it at /tmp/x/id_rsa. Found by the security review of #3397.
//
// CopyFile does not need this: copyDir walks and evaluates every entry against
// its ORIGINAL path, which still carries the telltale component.
//
// Applied only to relocating operations. Permanent delete does not need it —
// destroying a directory discloses nothing, and the top-level gate still
// refuses a directory that is itself deny-listed.
func enforceTreeContainment(verb, root string) error {
	entries := 0
	var offender string
	err := filepath.Walk(root, func(path string, _ os.FileInfo, walkErr error) error {
		if walkErr != nil {
			// An unreadable subtree cannot be cleared, and a move would carry
			// it wholesale. Fail closed.
			return walkErr
		}
		entries++
		if entries > maxContainmentWalkEntries {
			return fmt.Errorf("directory too large to clear for %s (over %d entries)", verb, maxContainmentWalkEntries)
		}
		if isSensitiveReadPath(path) {
			offender = path
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("%s denied: cannot verify directory contents: %w", verb, err)
	}
	if offender != "" {
		return fmt.Errorf("%s denied on sensitive path: %s (inside %s)", verb, offender, root)
	}
	return nil
}

// enforceWriteContainment blocks an operation that would CREATE or OVERWRITE
// content at a sensitive path. The deny-list is shared with the read side on
// purpose: writing to /etc/shadow, /etc/sudoers.d, ~/.ssh/authorized_keys or a
// keychain is a credential-implant / privilege-escalation primitive, and the
// file browser has no legitimate reason to reach them (#3397).
//
// The destination usually does not exist yet; resolveForContainment handles
// that by resolving the nearest existing ancestor, so a symlinked parent
// directory cannot smuggle a write into a denied location.
func enforceWriteContainment(cleanPath string) error {
	return EnforcePathContainment("write", cleanPath)
}

// ListDrives enumerates available drives/mount points.
func ListDrives(_ map[string]any) CommandResult {
	return listDrivesOS(time.Now())
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

	// Defense-in-depth: never enumerate a credential store directory (SR5-01).
	if err := enforceReadContainment(cleanPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// A macOS Finder alias to a folder is a regular file, so navigating into one
	// would otherwise fail with "not a directory". Resolve it and list the
	// target, re-running containment against the target — alias resolution
	// deliberately leaves the listed directory, so the deny-list has to be
	// applied again on the far side (issue #3344).
	if target, ok := resolveMacAliasPath(cleanPath); ok {
		if err := enforceReadContainment(target); err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
		cleanPath = target
	}

	limit := GetPayloadInt(payload, "limit", defaultFileListLimit)
	if limit < 1 {
		limit = 1
	}
	if limit > maxFileListLimit {
		limit = maxFileListLimit
	}

	dir, err := os.Open(cleanPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to open directory: %w", err), time.Since(start).Milliseconds())
	}
	defer dir.Close()

	entries, err := dir.ReadDir(limit + 1)
	if err != nil && err != io.EOF {
		return NewErrorResult(fmt.Errorf("failed to read directory: %w", err), time.Since(start).Milliseconds())
	}

	truncated := false
	if len(entries) > limit {
		entries = entries[:limit]
		truncated = true
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

		entryPath := filepath.Join(cleanPath, entry.Name())

		// macOS Finder aliases are regular files holding a bookmark blob, so
		// without this they list as ordinary ~1KB files and the UI offers the
		// blob itself for download (issue #3344). Only Type is taken from the
		// target, because Type is what drives the client's navigate-vs-download
		// affordance. Path, Size, Modified and Permissions keep describing the
		// alias file itself: those are what the mutating operations act on, and
		// a delete confirmation that quoted the target's size while removing
		// only a 1KB alias would be actively misleading.
		aliasTarget := ""
		if target, targetInfo, ok := resolveMacAliasTarget(entryPath, info); ok {
			// Never surface an alias that leads into a credential store: leaving
			// it unresolved keeps both the target path and its contents hidden.
			if err := enforceReadContainment(target); err == nil {
				aliasTarget = target
				entryType = "file"
				if targetInfo.IsDir() {
					entryType = "directory"
				}
			}
		}

		fileEntries = append(fileEntries, FileEntry{
			Name:        entry.Name(),
			Path:        entryPath,
			Type:        entryType,
			Size:        info.Size(),
			Modified:    info.ModTime().Format(time.RFC3339),
			Permissions: info.Mode().String(),
			IsAlias:     aliasTarget != "",
			AliasTarget: aliasTarget,
		})
	}

	return NewSuccessResult(FileListResponse{
		Path:      cleanPath,
		Entries:   fileEntries,
		Limit:     limit,
		Truncated: truncated,
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

	// Defense-in-depth: never read a credential store, even symlinked (SR5-01).
	if err := enforceReadContainment(cleanPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Downloading a macOS Finder alias should deliver the file it points at, not
	// the bookmark blob (issue #3344). Containment is re-checked against the
	// target because an alias can point anywhere, including at a credential
	// store that filepath.EvalSymlinks would never have surfaced.
	if target, ok := resolveMacAliasPath(cleanPath); ok {
		if err := enforceReadContainment(target); err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
		cleanPath = target
	}

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

	// Containment (#3397): the direct write primitive. Gating CopyFile's and
	// RenameFile's destinations while leaving this one open would be no gate at
	// all — WriteFile is the shortest path to implanting an SSH authorized_keys
	// entry or a /etc/sudoers.d drop-in.
	if err := enforceWriteContainment(cleanPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Ensure parent directory exists
	parentDir := filepath.Dir(cleanPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create parent directory: %w", err), time.Since(start).Milliseconds())
	}

	// Decode content based on encoding
	var data []byte
	if encoding == "base64" {
		if len(content) > base64.StdEncoding.EncodedLen(MaxFileWriteSize) {
			return NewErrorResult(fmt.Errorf("file write payload too large (max %d bytes decoded)", MaxFileWriteSize), time.Since(start).Milliseconds())
		}
		var err error
		data, err = base64.StdEncoding.DecodeString(content)
		if err != nil {
			return NewErrorResult(fmt.Errorf("failed to decode base64 content: %w", err), time.Since(start).Milliseconds())
		}
	} else {
		data = []byte(content)
	}
	if len(data) > MaxFileWriteSize {
		return NewErrorResult(fmt.Errorf("file write payload too large: %d bytes (max %d bytes)", len(data), MaxFileWriteSize), time.Since(start).Milliseconds())
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

	// Containment (#3397). Applied to BOTH the trash and permanent branches:
	//   - trash is disclosing: it relocates the content to
	//     ~/.breeze-trash/<id>/content, a path the deny-list does not recognise
	//     and that TrashList happily enumerates, so delete-then-read is a
	//     complete bypass;
	//   - permanent delete is destructive-but-not-disclosing, and is gated on
	//     purpose anyway: irrecoverably destroying a credential store (bricking
	//     sshd via /etc/shadow, wiping a keychain) is not something the file
	//     browser has any legitimate reason to do, and leaving the MORE
	//     destructive branch open while blocking the recoverable one would be
	//     an incoherent policy.
	if err := EnforcePathContainment("delete", cleanPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Block recursive deletes on any filesystem root or top-level directory
	// (e.g. /, /home, /var, C:\, C:\Windows, \\server\share). See
	// isRecursiveDeleteBoundary (fileops_delete_boundary.go) for the boundary
	// semantics and why a plain slash-separated component count was wrong on
	// Windows (#3932).
	if recursive && isRecursiveDeleteBoundary(cleanPath) {
		return NewErrorResult(fmt.Errorf("recursive delete denied on top-level path: %s", cleanPath), time.Since(start).Milliseconds())
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

	// Moving to trash relocates the whole subtree under a prefix the deny-list
	// no longer recognises, so a directory must be cleared entry-by-entry — the
	// top-level gate above misses "~/.ssh" and friends. Not needed on the
	// permanent branch above, which discloses nothing.
	if info.IsDir() {
		if err := enforceTreeContainment("delete", cleanPath); err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
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

	// Calculate size (walk directory for recursive total)
	var sizeBytes int64
	if info.IsDir() {
		filepath.Walk(cleanPath, func(_ string, fi os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return nil // skip inaccessible entries
			}
			if !fi.IsDir() {
				sizeBytes += fi.Size()
			}
			return nil
		})
	} else {
		sizeBytes = info.Size()
	}

	// Write metadata.json
	meta := TrashMetadata{
		OriginalPath: cleanPath,
		TrashID:      trashID,
		DeletedAt:    now.Format(time.RFC3339),
		DeletedBy:    GetPayloadString(payload, "deletedBy", ""),
		IsDirectory:  info.IsDir(),
		SizeBytes:    sizeBytes,
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
			// skipSensitive=false: this is the fallback half of a MOVE — the
			// source is removed below, so an omitted entry would be destroyed.
			// The sensitive-source gate ran at the top of DeleteFile.
			if cpErr := copyDir(cleanPath, contentPath, false); cpErr != nil {
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

	// Lazily purge items older than trashMaxAgeDays (pass trashDir to avoid
	// racing with test code that swaps getTrashDirFunc).
	go lazyPurgeOldTrash(trashDir)

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
	truncated := false
	if len(entries) > maxTrashListItems {
		entries = entries[:maxTrashListItems]
		truncated = true
	}

	items := make([]TrashMetadata, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		meta, err := readTrashMetadata(metaPath)
		if err != nil {
			continue // skip entries without valid metadata
		}
		items = append(items, *meta)
	}

	return NewSuccessResult(TrashListResponse{
		Items:     items,
		Path:      trashDir,
		Truncated: truncated,
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

	// Sanitize trashID to prevent path traversal
	safeTrashID := filepath.Base(trashID)
	trashItemDir := filepath.Join(trashDir, safeTrashID)
	metaPath := filepath.Join(trashItemDir, "metadata.json")

	meta, err := readTrashMetadata(metaPath)
	if err != nil {
		return NewErrorResult(fmt.Errorf("trash item not found: %s", safeTrashID), time.Since(start).Milliseconds())
	}

	contentPath := filepath.Join(trashItemDir, "content")

	// Containment (#3397): restore is an arbitrary-destination WRITE, and the
	// destination comes from metadata.json — a file on disk that a preceding
	// WriteFile could have forged. Without this gate, restore is a
	// credential-implant primitive (drop attacker content at
	// ~/.ssh/authorized_keys or /etc/sudoers.d/x). DeleteFile now refuses to
	// trash a sensitive path in the first place, so no honestly-created trash
	// item can trip this.
	cleanOriginal := filepath.Clean(meta.OriginalPath)
	if err := enforceWriteContainment(cleanOriginal); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Check if something already exists at the original path to prevent silent overwrite
	if _, existErr := os.Stat(cleanOriginal); existErr == nil {
		return NewErrorResult(fmt.Errorf("cannot restore: path already exists: %s", cleanOriginal), time.Since(start).Milliseconds())
	}

	// Ensure the parent directory of the original path exists
	parentDir := filepath.Dir(cleanOriginal)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return NewErrorResult(fmt.Errorf("failed to create parent directory: %w", err), time.Since(start).Milliseconds())
	}

	// Move content back to original location
	if err := os.Rename(contentPath, cleanOriginal); err != nil {
		// Rename may fail across devices; fall back to copy + remove
		info, statErr := os.Stat(contentPath)
		if statErr != nil {
			return NewErrorResult(fmt.Errorf("failed to stat trash content: %w", statErr), time.Since(start).Milliseconds())
		}
		if info.IsDir() {
			// skipSensitive=false: MOVE semantics, see DeleteFile above. The
			// restore destination is gated at the top of TrashRestore.
			if cpErr := copyDir(contentPath, cleanOriginal, false); cpErr != nil {
				return NewErrorResult(fmt.Errorf("failed to restore directory: %w", cpErr), time.Since(start).Milliseconds())
			}
		} else {
			if cpErr := copyFile(contentPath, cleanOriginal, info.Mode()); cpErr != nil {
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
		"restoredPath": cleanOriginal,
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
		var errors []string
		for _, id := range trashIds {
			itemDir := filepath.Join(trashDir, filepath.Base(id))
			if err := os.RemoveAll(itemDir); err != nil {
				if len(errors) < maxTrashPurgeErrors {
					errors = append(errors, fmt.Sprintf("%s: %v", id, err))
				}
			} else {
				purged++
			}
		}
		result := map[string]any{"purged": purged}
		if len(errors) > 0 {
			result["errors"] = errors
		}
		return NewSuccessResult(result, time.Since(start).Milliseconds())
	}

	// Purge everything
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read trash directory: %w", err), time.Since(start).Milliseconds())
	}

	purged := 0
	var errors []string
	for _, entry := range entries {
		itemDir := filepath.Join(trashDir, entry.Name())
		if err := os.RemoveAll(itemDir); err != nil {
			if len(errors) < maxTrashPurgeErrors {
				errors = append(errors, fmt.Sprintf("%s: %v", entry.Name(), err))
			}
		} else {
			purged++
		}
	}

	result := map[string]any{"purged": purged}
	if len(errors) > 0 {
		result["errors"] = errors
	}
	return NewSuccessResult(result, time.Since(start).Milliseconds())
}

// lazyPurgeOldTrash removes trash items older than trashMaxAgeDays.
// trashDir is passed in so the goroutine doesn't read the package-level
// getTrashDirFunc (which tests swap out).
func lazyPurgeOldTrash(trashDir string) {
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		log.Printf("[WARN] lazyPurgeOldTrash: failed to read trash dir: %v", err)
		return
	}

	cutoff := time.Now().AddDate(0, 0, -trashMaxAgeDays)

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(trashDir, entry.Name(), "metadata.json")
		meta, err := readTrashMetadata(metaPath)
		if err != nil {
			log.Printf("[WARN] lazyPurgeOldTrash: skipping %s, cannot read metadata: %v", entry.Name(), err)
			continue
		}
		deletedAt, err := time.Parse(time.RFC3339, meta.DeletedAt)
		if err != nil {
			continue
		}
		if deletedAt.Before(cutoff) {
			if rmErr := os.RemoveAll(filepath.Join(trashDir, entry.Name())); rmErr != nil {
				log.Printf("[WARN] lazyPurgeOldTrash: failed to remove expired item %s: %v", entry.Name(), rmErr)
			}
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

	// Containment (#3397): rename is the cheapest laundering primitive there is
	// — `mv /etc/shadow /tmp/x` followed by ReadFile(/tmp/x) defeats the
	// deny-list without ever "reading" anything. Relocating content out from
	// under the deny-list is therefore treated as disclosure, not as a merely
	// destructive op. The destination is gated for the same implant reason as
	// CopyFile's.
	if err := EnforcePathContainment("rename", cleanOldPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := enforceWriteContainment(cleanNewPath); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Check if source exists
	oldInfo, err := os.Stat(cleanOldPath)
	if err != nil {
		if os.IsNotExist(err) {
			return NewErrorResult(fmt.Errorf("source path does not exist: %s", cleanOldPath), time.Since(start).Milliseconds())
		}
		return NewErrorResult(fmt.Errorf("failed to stat source: %w", err), time.Since(start).Milliseconds())
	}

	// A directory rename relocates the entire subtree in one syscall, so clear
	// it entry-by-entry — the top-level gate misses directories that are not
	// themselves deny-listed but hold credential stores (e.g. "~/.ssh").
	if oldInfo.IsDir() {
		if err := enforceTreeContainment("rename", cleanOldPath); err != nil {
			return NewErrorResult(err, time.Since(start).Milliseconds())
		}
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

	// Containment (#3397): a copy is a content-disclosing read — copy-then-read
	// would otherwise defeat the deny-list outright. The destination is gated
	// too, so a copy cannot implant credential material over a secret store.
	if err := EnforcePathContainment("copy", cleanSrc); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := enforceWriteContainment(cleanDst); err != nil {
		return NewErrorResult(err, time.Since(start).Milliseconds())
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
		// Prevent copying a directory into itself (infinite recursion via filepath.Walk)
		if strings.HasPrefix(cleanDst, cleanSrc+string(filepath.Separator)) || cleanDst == cleanSrc {
			return NewErrorResult(fmt.Errorf("cannot copy directory into itself: %s -> %s", cleanSrc, cleanDst), time.Since(start).Milliseconds())
		}
		if err := copyDir(cleanSrc, cleanDst, true); err != nil {
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

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		dstFile.Close()
		return fmt.Errorf("copy data: %w", err)
	}

	if err := dstFile.Sync(); err != nil {
		dstFile.Close()
		return fmt.Errorf("sync destination: %w", err)
	}

	if err := dstFile.Close(); err != nil {
		return fmt.Errorf("close destination: %w", err)
	}

	return nil
}

// copyDir recursively copies a directory tree from src to dst.
// Symlinks are skipped to prevent security boundary escapes.
//
// skipSensitive controls whether entries matching the read-containment
// deny-list are omitted from the copy. Pass true for the operator-facing
// CopyFile: gating only the copy ROOT is not enough, because copying a parent
// directory (`/Users/alice` → `/tmp/x`) would relocate every credential store
// beneath it to a path the deny-list no longer recognises, and a plain ReadFile
// of the copy would then hand it over (#3397).
//
// Pass false wherever copyDir is the fallback half of a MOVE (DeleteFile →
// trash, TrashRestore): those call sites delete the source afterwards, so
// silently omitting an entry would destroy it. Those operations gate their own
// source path up front instead, which is the containment check that applies to
// a move.
func copyDir(src, dst string, skipSensitive bool) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip symlinks to prevent escaping the source tree
		realInfo, lstatErr := os.Lstat(path)
		if lstatErr != nil {
			return fmt.Errorf("lstat %s: %w", path, lstatErr)
		}
		if realInfo.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		if skipSensitive && isSensitiveReadPath(path) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
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
