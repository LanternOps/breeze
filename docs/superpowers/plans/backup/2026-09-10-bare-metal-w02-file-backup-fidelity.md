---
tracking_issue: TBD-set-by-register_feature
---

# Wave 02 — File-backup fidelity: symlinks, directories, ownership, full modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `file` backup mode capture and restore what a bootable operating-system tree needs and today loses: symbolic links (currently skipped by the walker), empty and non-default directories, file ownership (uid/gid), and the setuid/setgid/sticky bits — so the whole-machine snapshot W01 produces can be put back by the rebuild engine (W03) as a tree that boots.

**Architecture:** `SnapshotFile` gains four optional fields (`kind`, `linkTarget`, `modeBits`, `owner`) and a `HasContent()` predicate; manifests carrying any of them are stamped `formatVersion: 3`. The walker records symlinks and qualifying directories as content-less entries (no object upload). The upload loop, incremental dedupe, journal, verify and GC all skip content-less entries. Restore runs three passes: files (today's loop), then symlinks, then directories (modes/owners applied last). Ownership and full mode bits are applied only when the restoring process is root (Unix); Windows captures symlinks/junctions and empty directories only. The server's result and queue schemas accept the new fields and an empty `backupPath` for content-less entries.

**Tech Stack:** Go 1.26 (`agent/internal/backup`, `agent/internal/backup/bmr`), Hono + zod (`apps/api`).

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §5.4 (file fidelity — added 2026-09-10 after this gap was found during planning), supporting §2 decision 2 (file backup as the rebuild source) and §6 phase 3.

**Depends on:** none (independent of W01; both touch `backup.go`/`backup_test.go` in different regions — rebase whichever merges second). W03 (rebuild engine) depends on this wave.

## Global Constraints

- Manifest additions on `SnapshotFile` (all `omitempty`, so a snapshot with only regular files is byte-identical to today):
  - `Kind string json:"kind,omitempty"` — `""` regular file (content), `"symlink"`, `"dir"`.
  - `LinkTarget string json:"linkTarget,omitempty"` — verbatim `os.Readlink` result.
  - `ModeBits uint32 json:"modeBits,omitempty"` — `uint32(mode & (os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky))`; 0 = unknown.
  - `Owner *FileOwner json:"owner,omitempty"` with `FileOwner{UID int json:"uid"; GID int json:"gid"}`; nil = unknown (Windows, old manifests).
  - Content-less entries have `BackupPath == ""` and `Checksum == ""`, `Size == 0`.
- `Snapshot.FormatVersion` becomes `3` (`manifestFormatFidelity`) when any entry has `Kind != ""` or `Owner != nil`; otherwise unchanged (2 for incremental, omitted for plain full).
- Existing `Mode` (perm-only) keeps being written for every regular file exactly as today — older helpers keep working.
- Directories are recorded only when: empty, or perm != 0755, or owner != 0:0, or any of setgid/sticky set (Unix); on Windows only empty directories. A directory recorded for mode/owner is NOT uploaded — its path exists implicitly through its files.
- Ownership + `ModeBits` are applied on restore only when `os.Geteuid() == 0` (Unix); otherwise one summary warning `"ownership/special mode bits not applied: restore is not running as root"` is emitted once per restore, never per file.
- Server: `backupPath` in both file-item schemas allows `""` only when `kind` is `symlink` or `dir`; the `backup_snapshot_files` index stores `''` for those rows.
- Nothing about upload/download object keys, dedupe references, GC marking or the journal format changes for regular files.
- No internal hostnames/IPs in committed files.

## 0. Ground truth (verified 2026-09-10 against `origin/main` @ `0414a46344`)

- `agent/internal/backup/backup.go:1332-1440` `collectBackupFilesFromPaths` — `:1396-1398` `if entry.Type()&os.ModeSymlink != 0 { return nil }` (symlinks dropped); `:1404` non-regular skipped; `backupFile` (`:1311-1326`) has `sourcePath, snapshotPath, size, modTime, mode, originalPath`.
- `agent/internal/backup/snapshot.go:201-229` `SnapshotFile` (`Mode` = perm bits only, `:214-220`); `:153-175` `Snapshot` with `FormatVersion` (`:531` sets 2); `:955-990` upload loop builds `SnapshotFile{...}` at `:981` and calls `journal.Record(entry)`; `:26` `sha256File`.
- `agent/internal/backup/incremental.go:211-249` `decideFile`/`referenceEntry`; `:250` `isReferenceEntry` (prefix test on `BackupPath` — an empty `BackupPath` would read as a reference: content-less entries must never reach it).
- `agent/internal/backup/journal.go:335-352` `Record`; `:360` `Lookup`.
- `agent/internal/backup/restore.go:46-300` `RestoreFromSnapshotContext` — `:79` `filterFiles(snapshot.Files, cfg.SelectedPaths)`; loop `:122-271` keyed on `file.BackupPath` for resume; `:238-258` mode/mtime reapply; `:403` `restoreSourcePath`, `:424` `resolveTargetPath`, `:489` `moveFile`, `:563` `stagingFileName`.
- `agent/internal/backup/verify.go:48-120` `VerifyIntegrity` downloads every `file.BackupPath`.
- `agent/internal/backup/bmr/bmr.go:772-860` `restoreFiles` downloads every `file.BackupPath` into the live root.
- `apps/api/src/routes/backup/resultSchemas.ts:8-31` `backupSnapshotFileResultSchema` (`backupPath: z.string().min(1)`); `apps/api/src/jobs/queueSchemas.ts:16-32` `backupSnapshotFileSchema` (same); `apps/api/src/services/backupResultPersistence.ts:1190-1206` file-index rows (`backupPath: file.backupPath`).
- `apps/api/src/jobs/backupRetention.ts:924-925` already guards `file.backupPath.length > 0` — no change needed for GC.
- `agent/internal/backup/restore_test.go:40` `setupRestoreTestSnapshot(t, files map[string]string) (*providers.LocalProvider, string)` builds a snapshot with a `LocalProvider`; `snapshot_test.go:46` `newMockProvider()` records `uploadCalls`; `backup_test.go` has `createTempFile`.

---

### Task 1: Manifest fields, `HasContent`, format version

**Files:**
- Modify: `agent/internal/backup/snapshot.go:201-229` (struct), `:153-175` (`Snapshot` doc), `:531` (format version)
- Test: `agent/internal/backup/snapshot_test.go`

**Interfaces:**
- Produces: `SnapshotFile.Kind/LinkTarget/ModeBits/Owner`, `FileOwner`, `KindSymlink = "symlink"`, `KindDir = "dir"`, `func (f SnapshotFile) HasContent() bool`, `manifestFormatFidelity = 3`, `func snapshotNeedsFidelityFormat(files []SnapshotFile) bool`. Every later task uses `HasContent()`.

- [ ] **Step 1: Write the failing test**

```go
func TestSnapshotFile_HasContentAndFormatVersion(t *testing.T) {
	file := SnapshotFile{SourcePath: "/etc/hosts", BackupPath: "snapshots/s/files/path_0/etc/hosts", Size: 3}
	link := SnapshotFile{SourcePath: "/bin", Kind: KindSymlink, LinkTarget: "usr/bin"}
	dir := SnapshotFile{SourcePath: "/var/empty", Kind: KindDir, ModeBits: 0o755}
	if !file.HasContent() || link.HasContent() || dir.HasContent() {
		t.Fatalf("HasContent: file=%v link=%v dir=%v", file.HasContent(), link.HasContent(), dir.HasContent())
	}
	if snapshotNeedsFidelityFormat([]SnapshotFile{file}) {
		t.Error("plain files must not force format 3")
	}
	if !snapshotNeedsFidelityFormat([]SnapshotFile{file, link}) {
		t.Error("a symlink entry must force format 3")
	}
	owned := SnapshotFile{SourcePath: "/home/x", BackupPath: "k", Owner: &FileOwner{UID: 1000, GID: 1000}}
	if !snapshotNeedsFidelityFormat([]SnapshotFile{owned}) {
		t.Error("an owner must force format 3")
	}
	// JSON shape: new fields are omitted when zero so old manifests stay byte-identical.
	data, _ := json.Marshal(file)
	for _, k := range []string{"kind", "linkTarget", "modeBits", "owner"} {
		if strings.Contains(string(data), `"`+k+`"`) {
			t.Errorf("plain file JSON leaked %s: %s", k, data)
		}
	}
	data, _ = json.Marshal(link)
	if !strings.Contains(string(data), `"kind":"symlink"`) || !strings.Contains(string(data), `"linkTarget":"usr/bin"`) {
		t.Errorf("symlink JSON = %s", data)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/ -run TestSnapshotFile_HasContentAndFormatVersion 2>&1 | head -3`
Expected: build error (`KindSymlink` undefined).

- [ ] **Step 3: Implement**

In `snapshot.go` next to `SnapshotFile`:

```go
// Entry kinds. "" (the zero value) is a regular file with uploaded content.
const (
	KindSymlink = "symlink"
	KindDir     = "dir"
)

// manifestFormatFidelity marks a manifest that carries content-less entries
// (symlinks/directories) and/or ownership — bare-metal W02. Readers older
// than W02 ignore the fields and would try to download an empty BackupPath
// for a symlink; every reader in this repo checks HasContent() first.
const manifestFormatFidelity = 3

// FileOwner is the Unix owner of an entry. Nil on Windows and in manifests
// written before W02.
type FileOwner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}
```

Add to `SnapshotFile` after `OriginalPath`:

```go
	// Kind is "" for a regular file (content uploaded at BackupPath),
	// KindSymlink or KindDir for content-less entries (BackupPath, Checksum
	// and Size are empty/zero). LinkTarget is the verbatim readlink result.
	Kind       string `json:"kind,omitempty"`
	LinkTarget string `json:"linkTarget,omitempty"`
	// ModeBits is the full Unix mode (perm + setuid/setgid/sticky), unlike
	// Mode which is perm-only for compatibility. 0 = unknown.
	ModeBits uint32 `json:"modeBits,omitempty"`
	// Owner is nil when unknown (Windows, pre-W02 manifests).
	Owner *FileOwner `json:"owner,omitempty"`
```

and the methods:

```go
// HasContent reports whether the entry has an uploaded object at BackupPath.
func (f SnapshotFile) HasContent() bool { return f.Kind == "" }

func snapshotNeedsFidelityFormat(files []SnapshotFile) bool {
	for _, f := range files {
		if f.Kind != "" || f.Owner != nil {
			return true
		}
	}
	return false
}
```

At `:531` (where `snapshot.FormatVersion = 2` is set) add, after the manifest's file list is final and before `publishSnapshotManifest`:

```go
	if snapshotNeedsFidelityFormat(snapshot.Files) {
		snapshot.FormatVersion = manifestFormatFidelity
	}
```

(Find the exact spot: it must run after the upload loop appends the last entry. If `:531` runs before the loop, place the new block immediately after the loop's `emitProgress(true)` at `:993`.)

- [ ] **Step 4: Run, commit**

Run: `cd agent && go test -race ./internal/backup/ -run 'TestSnapshotFile_HasContentAndFormatVersion|TestCreateSnapshot' 2>&1 | tail -3`
Expected: `ok`.

```bash
git add agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go
git commit -m "feat(backup): manifest entry kinds (symlink/dir), full mode bits and owner on SnapshotFile (W02)"
```

---

### Task 2: Walker captures symlinks, qualifying directories, owner and mode bits

**Files:**
- Create: `agent/internal/backup/owner_unix.go` (`//go:build !windows`), `agent/internal/backup/owner_windows.go` (`//go:build windows`)
- Modify: `agent/internal/backup/backup.go:1311-1326` (`backupFile`), `:1332-1440` (walker)
- Test: `agent/internal/backup/backup_collect_test.go`

**Interfaces:**
- Produces: `backupFile.kind, linkTarget, modeBits, owner` fields; `fileOwner(info os.FileInfo) *FileOwner`; `fullModeBits(mode os.FileMode) uint32`; `dirNeedsEntry(info os.FileInfo, owner *FileOwner, empty bool) bool`. Task 3 turns these into `SnapshotFile` entries.

- [ ] **Step 1: Write the failing walker test** (Unix-only behaviour is guarded; the symlink/empty-dir parts run everywhere)

```go
func TestCollectBackupFiles_FidelityEntries(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, mode os.FileMode) string {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	mk("usr/bin/tool", 0o755)
	mk("usr/bin/sudo", 0o4755)
	if err := os.Symlink("usr/bin", filepath.Join(root, "bin")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "var", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "var", "spool", "cron"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "var", "spool", "cron"), 0o1730); err != nil {
		t.Fatal(err)
	}
	mk("var/spool/cron/root", 0o600)

	mgr := NewBackupManager(BackupConfig{Paths: []string{root}})
	files, err := mgr.collectBackupFilesFromPaths(context.Background(), []string{root}, nil)
	if err != nil {
		t.Fatal(err)
	}
	byRel := map[string]backupFile{}
	for _, f := range files {
		rel, _ := filepath.Rel(root, f.sourcePath)
		byRel[filepath.ToSlash(rel)] = f
	}
	link, ok := byRel["bin"]
	if !ok || link.kind != KindSymlink || link.linkTarget != "usr/bin" || link.size != 0 {
		t.Fatalf("symlink entry = %+v (ok=%v)", link, ok)
	}
	empty, ok := byRel["var/empty"]
	if !ok || empty.kind != KindDir {
		t.Fatalf("empty dir entry = %+v (ok=%v)", empty, ok)
	}
	if _, ok := byRel["usr"]; ok {
		t.Error("a plain non-empty 0755 directory must not get an entry")
	}
	if runtime.GOOS != "windows" {
		cron := byRel["var/spool/cron"]
		if cron.kind != KindDir || cron.modeBits != uint32(0o1730) {
			t.Errorf("sticky dir entry = %+v", cron)
		}
		sudo := byRel["usr/bin/sudo"]
		if sudo.modeBits != uint32(0o4755) || sudo.owner == nil || sudo.owner.UID != os.Getuid() {
			t.Errorf("setuid file = %+v", sudo)
		}
		tool := byRel["usr/bin/tool"]
		if tool.kind != "" || tool.modeBits != 0o755 {
			t.Errorf("regular file = %+v", tool)
		}
	}
	// Symlinked directories are recorded as links, never descended.
	if _, ok := byRel["bin/tool"]; ok {
		t.Error("walker followed a directory symlink")
	}
}
```

Add imports (`context`, `runtime`) as needed.

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/ -run TestCollectBackupFiles_FidelityEntries 2>&1 | head -5`
Expected: build error (`link.kind` undefined).

- [ ] **Step 3: Implement owner helpers**

`owner_unix.go`:

```go
//go:build !windows

package backup

import (
	"os"
	"syscall"
)

// fileOwner returns the Unix uid/gid of info, or nil when unavailable.
func fileOwner(info os.FileInfo) *FileOwner {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return &FileOwner{UID: int(st.Uid), GID: int(st.Gid)}
}

// restoreCanApplyOwnership reports whether chown/setuid will succeed.
func restoreCanApplyOwnership() bool { return os.Geteuid() == 0 }

func applyOwner(path string, owner *FileOwner) error {
	if owner == nil {
		return nil
	}
	return os.Lchown(path, owner.UID, owner.GID)
}
```

`owner_windows.go`:

```go
//go:build windows

package backup

import "os"

func fileOwner(_ os.FileInfo) *FileOwner { return nil }

func restoreCanApplyOwnership() bool { return false }

func applyOwner(_ string, _ *FileOwner) error { return nil }
```

In `backup.go` (untagged):

```go
// fullModeBits keeps perm + setuid/setgid/sticky; everything else (type bits)
// is dropped so the value round-trips through os.Chmod.
func fullModeBits(mode os.FileMode) uint32 {
	return uint32(mode & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
}

// dirNeedsEntry decides whether a directory gets its own manifest entry:
// empty directories always (nothing else recreates them); otherwise only
// when mode/owner differ from the MkdirAll default the restore would apply.
func dirNeedsEntry(info os.FileInfo, owner *FileOwner, empty bool) bool {
	if empty {
		return true
	}
	if runtime.GOOS == "windows" {
		return false
	}
	if fullModeBits(info.Mode()) != 0o755 {
		return true
	}
	return owner != nil && (owner.UID != 0 || owner.GID != 0)
}
```

Extend `backupFile`:

```go
	kind       string     // "" file, KindSymlink, KindDir
	linkTarget string
	modeBits   uint32
	owner      *FileOwner
```

- [ ] **Step 4: Rewrite the walk callback**

Replace the body from `if entry.IsDir() {` through the final `files = append(files, backupFile{...}); return nil` inside `filepath.WalkDir` with:

```go
			relPath, relErr := filepath.Rel(cleanRoot, path)
			if relErr != nil {
				errs = append(errs, fmt.Errorf("failed to resolve relative path for %s: %w", path, relErr))
				return nil
			}
			slashRel := filepath.ToSlash(relPath)
			if entry.IsDir() {
				if path == cleanRoot {
					return nil
				}
				if excl != nil && excl.matches(slashRel) {
					return fs.SkipDir
				}
				// Remember the directory; whether it needs an entry is decided
				// after the walk (emptiness is only known once its children
				// have been visited).
				dirs = append(dirs, walkedDir{path: path, rel: slashRel})
				childCount[filepath.Dir(path)]++
				return nil
			}
			childCount[filepath.Dir(path)]++
			if excl != nil && excl.matches(slashRel) {
				return nil
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, relPath))
			if _, exists := seen[snapshotPath]; exists {
				log.Debug("duplicate backup path skipped", "snapshotPath", snapshotPath)
				return nil
			}
			info, err := entry.Info() // Lstat semantics: never follows the link
			if err != nil {
				errs = append(errs, fmt.Errorf("failed to read info for %s: %w", path, err))
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				target, linkErr := os.Readlink(path)
				if linkErr != nil {
					errs = append(errs, fmt.Errorf("failed to read symlink %s: %w", path, linkErr))
					return nil
				}
				seen[snapshotPath] = struct{}{}
				files = append(files, backupFile{
					sourcePath: path, snapshotPath: snapshotPath, modTime: info.ModTime(), mode: info.Mode(),
					kind: KindSymlink, linkTarget: target, owner: fileOwner(info),
				})
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath:   path,
				snapshotPath: snapshotPath,
				size:         info.Size(),
				modTime:      info.ModTime(),
				mode:         info.Mode(),
				modeBits:     fullModeBits(info.Mode()),
				owner:        fileOwner(info),
			})
			return nil
```

Declare before the `WalkDir` call (per root):

```go
		type walkedDir struct{ path, rel string }
		var dirs []walkedDir
		childCount := map[string]int{}
```

and after `WalkDir` returns (before the `if err != nil` that wraps walk errors), add directory entries:

```go
		for _, d := range dirs {
			info, statErr := os.Lstat(d.path)
			if statErr != nil {
				continue
			}
			owner := fileOwner(info)
			if !dirNeedsEntry(info, owner, childCount[d.path] == 0) {
				continue
			}
			snapshotPath := filepath.ToSlash(filepath.Join(rootLabel, d.rel))
			if _, exists := seen[snapshotPath]; exists {
				continue
			}
			seen[snapshotPath] = struct{}{}
			files = append(files, backupFile{
				sourcePath: d.path, snapshotPath: snapshotPath, modTime: info.ModTime(), mode: info.Mode(),
				kind: KindDir, modeBits: fullModeBits(info.Mode()), owner: owner,
			})
		}
```

Note `childCount` counts every visited child (files, links, subdirs), including excluded ones, so an excluded-only directory still counts as non-empty and gets no entry — that is intended (its exclusion means "do not back this up").

Keep the single-file root branch (`!info.IsDir()`) as is, but add `modeBits: fullModeBits(info.Mode()), owner: fileOwner(info)` to its `backupFile`.

- [ ] **Step 5: Run the collect tests + the whole package**

Run: `cd agent && go test -race ./internal/backup/ 2>&1 | tail -5`
Expected: `ok`. If an existing test counted files under a tree containing directories, it now sees the same count (non-empty 0755 root-owned dirs get no entry; `t.TempDir()` roots are the walk root itself, which is never recorded).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/backup/backup.go agent/internal/backup/owner_unix.go agent/internal/backup/owner_windows.go agent/internal/backup/backup_collect_test.go
git commit -m "feat(backup): walker records symlinks, empty/non-default directories, ownership and full mode bits (W02)"
```

---

### Task 3: Upload loop, dedupe, journal, verify skip content-less entries

**Files:**
- Modify: `agent/internal/backup/snapshot.go` (upload loop `:840-993`), `agent/internal/backup/incremental.go:211` (`decideFile`), `agent/internal/backup/journal.go:335` (`Record`), `agent/internal/backup/verify.go:87` (loop)
- Test: `agent/internal/backup/snapshot_test.go`, `agent/internal/backup/incremental_test.go`, `agent/internal/backup/verify_test.go` (create if absent)

**Interfaces:**
- Consumes: `backupFile.kind` etc. (Task 2), `HasContent()` (Task 1).
- Produces: `func contentlessEntry(f backupFile) SnapshotFile`; manifests whose content-less entries have empty `BackupPath`/`Checksum`, no upload call, no journal line, no verify download.

- [ ] **Step 1: Write the failing tests**

`snapshot_test.go`:

```go
func TestCreateSnapshot_ContentlessEntriesNotUploaded(t *testing.T) {
	provider := newMockProvider()
	now := time.Now().UTC()
	files := []backupFile{
		{sourcePath: "/etc/hosts", snapshotPath: "path_0/etc/hosts", size: 3, modTime: now, mode: 0o644, modeBits: 0o644, owner: &FileOwner{UID: 0, GID: 0}},
		{sourcePath: "/bin", snapshotPath: "path_0/bin", modTime: now, mode: os.ModeSymlink | 0o777, kind: KindSymlink, linkTarget: "usr/bin"},
		{sourcePath: "/var/empty", snapshotPath: "path_0/var/empty", modTime: now, mode: os.ModeDir | 0o755, kind: KindDir, modeBits: 0o755},
	}
	// Only the regular file exists on disk; content-less entries must never be opened.
	tmp := t.TempDir()
	hosts := filepath.Join(tmp, "hosts")
	if err := os.WriteFile(hosts, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	files[0].sourcePath = hosts

	snap, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.uploadCalls) != 2 { // hosts + manifest.json
		t.Fatalf("upload calls = %+v, want file + manifest only", provider.uploadCalls)
	}
	if snap.FormatVersion != manifestFormatFidelity || len(snap.Files) != 3 {
		t.Fatalf("snapshot = %+v", snap)
	}
	var link, dir SnapshotFile
	for _, f := range snap.Files {
		switch f.Kind {
		case KindSymlink:
			link = f
		case KindDir:
			dir = f
		}
	}
	if link.BackupPath != "" || link.Checksum != "" || link.LinkTarget != "usr/bin" || link.Size != 0 {
		t.Errorf("symlink entry = %+v", link)
	}
	if dir.BackupPath != "" || dir.ModeBits != 0o755 {
		t.Errorf("dir entry = %+v", dir)
	}
	// The stored manifest round-trips the fields.
	var stored Snapshot
	if err := json.Unmarshal(provider.files[path.Join("snapshots", snap.ID, "manifest.json")], &stored); err != nil {
		t.Fatal(err)
	}
	if stored.FormatVersion != 3 || stored.Files[0].Owner == nil {
		t.Errorf("stored manifest = %+v", stored)
	}
}
```

`incremental_test.go`:

```go
func TestDecideFile_ContentlessAlwaysUploadPath(t *testing.T) {
	link := backupFile{sourcePath: "/bin", snapshotPath: "path_0/bin", kind: KindSymlink, linkTarget: "usr/bin"}
	prev := map[string]SnapshotFile{"/bin": {SourcePath: "/bin", Kind: KindSymlink, LinkTarget: "usr/lib"}}
	decision, entry := decideFile(link, prev)
	if decision != decideUpload || entry.BackupPath != "" {
		t.Fatalf("decision=%v entry=%+v; content-less entries never dedupe by reference", decision, entry)
	}
}
```

`verify_test.go` (create; use `newMockProvider` + a manifest containing a symlink entry):

```go
func TestVerifyIntegrity_SkipsContentlessEntries(t *testing.T) {
	provider := newMockProvider()
	fileKey := "snapshots/s1/files/path_0/etc/hosts"
	provider.files[fileKey] = []byte("abc")
	manifest := Snapshot{ID: "s1", FormatVersion: manifestFormatFidelity, Files: []SnapshotFile{
		{SourcePath: "/etc/hosts", BackupPath: fileKey, Size: 3, Checksum: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
		{SourcePath: "/bin", Kind: KindSymlink, LinkTarget: "usr/bin"},
		{SourcePath: "/var/empty", Kind: KindDir},
	}}
	data, _ := json.Marshal(manifest)
	provider.files["snapshots/s1/manifest.json"] = data

	res, err := VerifyIntegrity(provider, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "passed" || res.FilesVerified != 1 || res.FilesFailed != 0 {
		t.Fatalf("result = %+v", res)
	}
}
```

(Check `VerifyResult`'s field names in `verify.go:20-46` and the status string it uses for success; adjust the assertion to those exact names.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/ -run 'TestCreateSnapshot_ContentlessEntriesNotUploaded|TestDecideFile_ContentlessAlwaysUploadPath|TestVerifyIntegrity_SkipsContentlessEntries' 2>&1 | tail -8`
Expected: the snapshot test fails (attempts to sha256/upload `/bin`), verify fails (download of empty key), decide test may pass by accident (fine — it stays as a guard).

- [ ] **Step 3: Implement**

`snapshot.go` — add:

```go
// contentlessEntry builds the manifest entry for a symlink or directory:
// nothing is uploaded, so BackupPath/Checksum/Size stay empty.
func contentlessEntry(f backupFile) SnapshotFile {
	return SnapshotFile{
		SourcePath:   f.sourcePath,
		OriginalPath: f.originalPath,
		ModTime:      f.modTime,
		Kind:         f.kind,
		LinkTarget:   f.linkTarget,
		ModeBits:     f.modeBits,
		Owner:        f.owner,
	}
}
```

In the upload loop, at the very top of the per-file iteration (before dedupe/`decideFile`, before any `sha256File`/upload), add:

```go
		if file.kind != "" {
			snapshot.Files = append(snapshot.Files, contentlessEntry(file))
			markDone(1, 0)
			emitProgress(false)
			continue
		}
```

(`markDone`/`emitProgress` are the loop's existing progress helpers — see `:989-991`; if `markDone`'s signature differs, call it the way the regular-file path does with size 0.)

For regular files, extend the `SnapshotFile{...}` literal at `:981` with `ModeBits: file.modeBits, Owner: file.owner,`, and `referenceEntry` in `incremental.go` likewise (`ModeBits: f.modeBits, Owner: f.owner`).

`incremental.go` `decideFile` first line:

```go
	if f.kind != "" {
		return decideUpload, SnapshotFile{} // content-less entries are rebuilt every run; never a reference
	}
```

`journal.go` `Record` first line: `if !f.HasContent() { return nil }`.

`verify.go` loop first line: `if !file.HasContent() { continue }`.

`bmr/bmr.go` `restoreFiles` — the loop currently downloads every entry; change so content-less entries are recreated instead of downloaded: right after `targetPath` is resolved, add

```go
		if !file.HasContent() {
			if applyErr := backup.RestoreContentlessEntry(targetPath, file, false); applyErr != nil {
				addFidelityFailure("recreate %s: %s", file.SourcePath, applyErr.Error())
			} else {
				filesRestored++
			}
			continue
		}
```

`RestoreContentlessEntry` is defined in Task 4; `bmr`'s `manifestFile` type must expose the new fields — if `snapshotManifest`/`manifestFile` in `bmr.go` are local mirrors of `backup.Snapshot`/`SnapshotFile`, replace them with the `backup` types (import `github.com/breeze-rmm/agent/internal/backup`) or add the four fields + `HasContent()` to the mirror. Do whichever `bmr.go:249` (`restoreSourcePath(file manifestFile)`) makes smaller; the test in Task 4 covers the behaviour either way.

- [ ] **Step 4: Run the package**

Run: `cd agent && go test -race ./internal/backup/... 2>&1 | tail -5`
Expected: `ok` for `backup` and `backup/bmr` (bmr may fail to compile until Task 4 adds `RestoreContentlessEntry` — if so, do Task 4 Step 3 first and re-run).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/backup/snapshot.go agent/internal/backup/snapshot_test.go agent/internal/backup/incremental.go agent/internal/backup/incremental_test.go agent/internal/backup/journal.go agent/internal/backup/verify.go agent/internal/backup/verify_test.go
git commit -m "feat(backup): content-less manifest entries bypass upload, dedupe, journal and verify (W02)"
```

---

### Task 4: Restore recreates symlinks and directories, applies owner and mode bits

**Files:**
- Modify: `agent/internal/backup/restore.go:79` (split entries), `:122-271` (loop), `:238-258` (mode), new passes after the loop
- Modify: `agent/internal/backup/bmr/bmr.go:772` (Task 3's hook)
- Test: `agent/internal/backup/restore_test.go`, `agent/internal/backup/bmr/bmr_test.go`

**Interfaces:**
- Produces: exported `func RestoreContentlessEntry(targetPath string, entry SnapshotFile, applyOwnership bool) error` (creates the symlink or directory at `targetPath` and applies `ModeBits`/`Owner` when `applyOwnership`); `func applyEntryMetadata(targetPath string, entry SnapshotFile, applyOwnership bool) []string` (mode bits + owner for regular files, returns warnings). W03 relies on `RestoreFromSnapshotContext` producing a bootable tree under `TargetPath`.

- [ ] **Step 1: Write the failing restore test**

```go
func TestRestore_RecreatesSymlinksDirsAndModes(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshot(t, map[string]string{"usr/bin/tool": "#!/bin/sh\n"})
	// Append content-less entries + a setuid file to the manifest.
	manifestKey := filepath.ToSlash(filepath.Join("snapshots", snapshotID, "manifest.json"))
	tmp := filepath.Join(t.TempDir(), "m.json")
	if err := provider.Download(manifestKey, tmp); err != nil {
		t.Fatal(err)
	}
	var snap Snapshot
	data, _ := os.ReadFile(tmp)
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatal(err)
	}
	for i := range snap.Files {
		snap.Files[i].ModeBits = 0o4755 // setuid tool
	}
	snap.Files = append(snap.Files,
		SnapshotFile{SourcePath: "/original/bin", Kind: KindSymlink, LinkTarget: "usr/bin", ModTime: time.Now().UTC()},
		SnapshotFile{SourcePath: "/original/var/empty", Kind: KindDir, ModeBits: 0o700, ModTime: time.Now().UTC()},
		SnapshotFile{SourcePath: "/original/usr/bin", Kind: KindDir, ModeBits: 0o1777, ModTime: time.Now().UTC()},
	)
	snap.FormatVersion = manifestFormatFidelity
	out, _ := json.Marshal(snap)
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(tmp, manifestKey); err != nil {
		t.Fatal(err)
	}

	target := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.FilesFailed != 0 {
		t.Fatalf("result = %+v", res)
	}
	if res.FilesRestored != 4 {
		t.Errorf("FilesRestored = %d, want 4 (1 file + 1 link + 2 dirs)", res.FilesRestored)
	}
	link := filepath.Join(target, "original", "bin")
	if got, err := os.Readlink(link); err != nil || got != "usr/bin" {
		t.Fatalf("symlink = %q err=%v", got, err)
	}
	if fi, err := os.Stat(filepath.Join(target, "original", "var", "empty")); err != nil || !fi.IsDir() {
		t.Fatalf("empty dir missing: %v", err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(target, "original", "var", "empty"))
		if fi.Mode().Perm() != 0o700 {
			t.Errorf("empty dir perm = %o", fi.Mode().Perm())
		}
		fi, _ = os.Stat(filepath.Join(target, "original", "usr", "bin"))
		if fi.Mode()&os.ModeSticky == 0 || fi.Mode().Perm() != 0o777 {
			t.Errorf("usr/bin mode = %v, want sticky 1777 applied AFTER files were placed", fi.Mode())
		}
		fi, _ = os.Stat(filepath.Join(target, "original", "usr", "bin", "tool"))
		if fi.Mode()&os.ModeSetuid == 0 {
			t.Errorf("tool mode = %v, want setuid", fi.Mode())
		}
		if os.Geteuid() != 0 {
			found := false
			for _, w := range res.Warnings {
				if strings.Contains(w, "not running as root") {
					found = true
				}
			}
			if len(res.Warnings) > 0 && !found {
				t.Errorf("warnings = %v", res.Warnings)
			}
		}
	}
}
```

Note: `os.Chmod` with setuid on a file you own succeeds as non-root on Linux/macOS, so the setuid assertion holds without root; ownership is the only root-gated part, and the test tolerates the single summary warning.

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test ./internal/backup/ -run TestRestore_RecreatesSymlinksDirsAndModes 2>&1 | tail -6`
Expected: FAIL — `FilesFailed` > 0 (download of empty `BackupPath`), symlink missing.

- [ ] **Step 3: Implement**

`restore.go` — after `files := filterFiles(...)` (`:79`) split:

```go
	var contentFiles, links, dirs []SnapshotFile
	for _, f := range files {
		switch f.Kind {
		case KindSymlink:
			links = append(links, f)
		case KindDir:
			dirs = append(dirs, f)
		default:
			contentFiles = append(contentFiles, f)
		}
	}
	files = contentFiles
	total := int64(len(contentFiles) + len(links) + len(dirs))
	applyOwnership := restoreCanApplyOwnership()
	ownershipWarned := false
	warnOwnership := func() {
		if applyOwnership || ownershipWarned {
			return
		}
		ownershipWarned = true
		result.Warnings = append(result.Warnings, "ownership/special mode bits not applied: restore is not running as root")
	}
```

Change the existing `if len(files) == 0 {` early-return to `if total == 0 {`, and the existing `total := int64(len(files))` to reuse the new `total` (delete the old line).

In the loop, replace the mode block (`:238-247`) with:

```go
		for _, w := range applyEntryMetadata(targetPath, file, applyOwnership) {
			result.Warnings = append(result.Warnings, w)
		}
		if !applyOwnership && (file.Owner != nil || file.ModeBits&uint32(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0) {
			warnOwnership()
		}
```

After the loop (before the final `checkCancelled`/status switch), add the two passes:

```go
	base := cfg.TargetPath
	if base == "" {
		base = filepath.Join(os.TempDir(), "breeze-restore")
	}
	contained := func(p string) bool {
		cleaned, cleanBase := filepath.Clean(p), filepath.Clean(base)
		return cleaned == cleanBase || strings.HasPrefix(cleaned, cleanBase+string(filepath.Separator))
	}
	// Pass 2: symlinks (parents exist now). Pass 3: directories last so their
	// modes/owners are applied after every child has been written.
	for _, entry := range append(links, dirs...) {
		if checkCancelled() {
			return result, nil
		}
		displayPath := restoreSourcePath(entry)
		targetPath := resolveTargetPath(cfg.TargetPath, displayPath)
		if !contained(targetPath) {
			result.Warnings = append(result.Warnings, fmt.Sprintf("path traversal blocked: %s", displayPath))
			result.FilesFailed++
			continue
		}
		if err := RestoreContentlessEntry(targetPath, entry, applyOwnership); err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, displayPath)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not recreate %s: %v", displayPath, err))
			continue
		}
		if !applyOwnership && entry.Owner != nil {
			warnOwnership()
		}
		result.FilesRestored++
	}
```

New functions (same file):

```go
// applyEntryMetadata reapplies mode bits (full ModeBits when known, else the
// perm-only Mode), owner (root only) and mtime to a restored regular file.
func applyEntryMetadata(targetPath string, entry SnapshotFile, applyOwnership bool) []string {
	var warnings []string
	switch {
	case entry.ModeBits != 0 && (applyOwnership || entry.ModeBits&uint32(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == 0):
		if err := os.Chmod(targetPath, os.FileMode(entry.ModeBits)); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mode %o to %s: %v", entry.ModeBits, entry.SourcePath, err))
		}
	case entry.Mode != 0:
		if err := os.Chmod(targetPath, os.FileMode(entry.Mode).Perm()); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mode %o to %s: %v", os.FileMode(entry.Mode).Perm(), entry.SourcePath, err))
		}
	}
	if applyOwnership {
		if err := applyOwner(targetPath, entry.Owner); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply owner to %s: %v", entry.SourcePath, err))
		}
	}
	if !entry.ModTime.IsZero() {
		if err := os.Chtimes(targetPath, entry.ModTime, entry.ModTime); err != nil {
			warnings = append(warnings, fmt.Sprintf("could not reapply mtime to %s: %v", entry.SourcePath, err))
		}
	}
	return warnings
}

// RestoreContentlessEntry recreates a symlink or directory entry at
// targetPath. Exported because bmr's reinstall-then-recover path and the
// rebuild engine (W03) recreate the same entries.
func RestoreContentlessEntry(targetPath string, entry SnapshotFile, applyOwnership bool) error {
	switch entry.Kind {
	case KindSymlink:
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if existing, err := os.Lstat(targetPath); err == nil {
			if existing.Mode()&os.ModeSymlink != 0 {
				if cur, rerr := os.Readlink(targetPath); rerr == nil && cur == entry.LinkTarget {
					break // already correct (resume)
				}
				if err := os.Remove(targetPath); err != nil {
					return err
				}
			} else {
				return fmt.Errorf("%s exists and is not a symlink", targetPath)
			}
		}
		if err := os.Symlink(entry.LinkTarget, targetPath); err != nil {
			return err
		}
	case KindDir:
		if err := os.MkdirAll(targetPath, 0o755); err != nil {
			return err
		}
		mode := os.FileMode(entry.ModeBits)
		if !applyOwnership {
			mode &^= os.ModeSetuid | os.ModeSetgid | os.ModeSticky
		}
		if entry.ModeBits != 0 {
			if err := os.Chmod(targetPath, mode); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("entry %s has content; use the file path", entry.SourcePath)
	}
	if applyOwnership {
		if err := applyOwner(targetPath, entry.Owner); err != nil {
			return err
		}
	}
	return nil
}
```

Wait — the sticky bit on a directory the test asserts is applied as non-root: on Linux/macOS a non-root owner may set sticky/setgid on its own directory, so do NOT strip those for directories when `!applyOwnership`; strip only setuid. Adjust the `KindDir` branch to `mode &^= os.ModeSetuid` under `!applyOwnership`. (Setuid on files is likewise permitted for the owner; the file path already handles that through `applyEntryMetadata`'s condition — simplify that condition to `entry.ModeBits != 0` and let `os.Chmod` report the rare EPERM as a warning.)

- [ ] **Step 4: bmr test**

In `bmr/bmr_test.go`, find the existing `restoreFiles` test that builds a manifest with a fake provider and add a symlink entry (`Kind: "symlink", LinkTarget: "usr/bin"`) for `/original/bin` with a `TargetPaths` override into a temp dir; assert the link exists with that target and that no download was attempted for it (the fake provider's call log must not contain an empty key).

- [ ] **Step 5: Run both packages**

Run: `cd agent && go test -race ./internal/backup/... 2>&1 | tail -6`
Expected: `ok` for both. Also `GOOS=windows go vet ./internal/backup/...`.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/backup/restore.go agent/internal/backup/restore_test.go agent/internal/backup/bmr/bmr.go agent/internal/backup/bmr/bmr_test.go
git commit -m "feat(backup): restore recreates symlinks/directories and reapplies owner + full mode bits (W02)"
```

---

### Task 5: Server accepts content-less entries

**Files:**
- Modify: `apps/api/src/routes/backup/resultSchemas.ts:8-31`, `apps/api/src/jobs/queueSchemas.ts:16-32`, `apps/api/src/services/backupResultPersistence.ts:1190-1206`
- Test: `apps/api/src/routes/backup/resultSchemas.test.ts`, `apps/api/src/jobs/queueSchemas.test.ts`, `apps/api/src/services/backupResultPersistence.test.ts`

**Interfaces:**
- Produces: `kind?: 'symlink' | 'dir'`, `linkTarget?: string` on both file-item schemas; `backupPath` may be `''` only with a `kind`.

- [ ] **Step 1: Write the failing tests**

`resultSchemas.test.ts`:

```ts
  it('accepts symlink/dir entries with an empty backupPath and rejects an empty backupPath on a file', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 's',
      snapshot: { id: 's', files: [
        { sourcePath: '/bin', backupPath: '', kind: 'symlink', linkTarget: 'usr/bin' },
        { sourcePath: '/var/empty', backupPath: '', kind: 'dir' },
        { sourcePath: '/etc/hosts', backupPath: 'snapshots/s/files/path_0/etc/hosts', size: 3 },
      ] },
    });
    expect(parsed.snapshot?.files?.[0]).toMatchObject({ kind: 'symlink', linkTarget: 'usr/bin' });
    expect(() => backupCommandResultSchema.parse({ snapshotId: 's', snapshot: { id: 's', files: [{ sourcePath: '/x', backupPath: '' }] } })).toThrow();
  });
```

`queueSchemas.test.ts` — same shape against `backupProcessResultSchema` (with `status: 'completed'`).

`backupResultPersistence.test.ts` — extend the existing test that asserts `backupSnapshotFiles` rows (grep `snapshotDbId:` in that file): add a symlink file to the input and assert the inserted row has `backupPath: ''` and `sourcePath: '/bin'`.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && npx vitest run src/routes/backup/resultSchemas.test.ts src/jobs/queueSchemas.test.ts src/services/backupResultPersistence.test.ts 2>&1 | tail -8
```
Expected: the new tests fail on `backupPath` `min(1)`.

- [ ] **Step 3: Implement**

Both file-item schemas: change `backupPath: z.string().min(1)` to `backupPath: z.string()`, add

```ts
  // W02 fidelity: content-less entries (symlinks/directories) carry no object.
  kind: z.enum(['symlink', 'dir']).optional(),
  linkTarget: z.string().optional(),
```

and wrap the object with

```ts
.superRefine((file, ctx) => {
  if (!file.kind && file.backupPath.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['backupPath'], message: 'backupPath is required for file entries' });
  }
})
```

(`superRefine` on the item keeps the outer schemas' `.strict()`/`.optional()` behaviour unchanged.) `backupEnqueue.ts`'s payload type for `snapshot.files` (see `:106-115`) gets `kind?: 'symlink' | 'dir'; linkTarget?: string;`.

Persistence: `backupPath: file.backupPath ?? ''` (the column is `NOT NULL`, empty string is the documented value for content-less rows).

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd apps/api && npx vitest run src/routes/backup/resultSchemas.test.ts src/jobs/queueSchemas.test.ts src/services/backupResultPersistence.test.ts src/routes/backup/snapshots.test.ts 2>&1 | tail -6 && npx tsc --noEmit -p . 2>&1 | tail -3
git add apps/api/src/routes/backup/resultSchemas.ts apps/api/src/routes/backup/resultSchemas.test.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/queueSchemas.test.ts apps/api/src/jobs/backupEnqueue.ts apps/api/src/services/backupResultPersistence.ts apps/api/src/services/backupResultPersistence.test.ts
git commit -m "feat(api): accept symlink/dir manifest entries with empty backupPath in backup results (W02)"
```

---

### Task 6: Whole-wave verification, live proof, PR

- [ ] **Step 1: Agent suites on every GOOS**

```bash
cd agent && go test -race ./... 2>&1 | grep -v "^ok" | head -20
GOOS=windows go vet ./... && GOOS=darwin go vet ./... && echo VET-ALL-OK
golangci-lint run ./internal/backup/... 2>&1 | tail -5
```

- [ ] **Step 2: Live proof on the Linux lab rig (Ubuntu, agent running as root)**

Back up a directory tree that contains: a relative symlink, an absolute symlink, an empty directory, a `1777` directory, a `4755` file, and a file owned by a non-root user (`chown 1000:1000`). Restore it to `/tmp/fidelity-restore` through the normal restore command and compare:

```bash
sudo find /srv/fidelity-src -printf '%P %y %m %U:%G %l\n' | sort > /tmp/src.txt
sudo find /tmp/fidelity-restore/srv/fidelity-src -printf '%P %y %m %U:%G %l\n' | sort > /tmp/dst.txt
diff /tmp/src.txt /tmp/dst.txt && echo FIDELITY-OK
```
Expected: `FIDELITY-OK` (mtime is not compared by this listing; modes, owners, types and link targets are). Record the command output in the PR body. Run the same on WIN-A for a tree with a directory junction and an empty directory; expected: junction recreated as a symlink pointing at the same target, empty directory present.

- [ ] **Step 3: PR**

Branch `feature/<parent#>-bare-metal/wave-<W02 sub-issue#>`; body lists the manifest additions verbatim (Global Constraints), the compatibility argument (old manifests byte-identical), the lab evidence, `Closes #<W02 sub-issue>`. One `/review-pr` round, fix confirmed findings, `gh pr merge <N> --squash`.

---

## Self-review notes (plan author)

- Spec §5.4 requirements: symlinks (Tasks 2, 4), directories (2, 4), ownership (2, 4), full modes (2, 4), no upload for content-less (3), dedupe/journal/verify/GC safe (3 + GC already guarded), server acceptance (5), bmr reinstall-then-recover parity (3, 4).
- Names are consistent: `KindSymlink`/`KindDir`, `LinkTarget`, `ModeBits`, `Owner`/`FileOwner`, `HasContent()`, `manifestFormatFidelity`, `contentlessEntry`, `RestoreContentlessEntry`, `applyEntryMetadata`, `fileOwner`/`applyOwner`/`restoreCanApplyOwnership`, `fullModeBits`, `dirNeedsEntry`.
- Deliberately out of scope (say so in the PR): hard links (restored as independent copies), extended attributes and file capabilities (`ping` loses `cap_net_raw`; the rebuild engine's boot phase can re-run `setcap` for known binaries later), Windows ACLs (W06), device nodes (excluded trees only).
