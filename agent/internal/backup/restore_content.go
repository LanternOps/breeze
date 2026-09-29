package backup

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// restoreDownloadConcurrency is how many objects the restore's file pass
// downloads and verifies at once (#5623). Object-store round trips, not
// bandwidth, dominate a restore of many small files: a bare-metal rebuild
// of ~100k files at one request per round trip took hours. Eight matches
// verifyDownloadConcurrency (same providers, same reasoning: it stays below
// the AWS SDK's default of 10 idle connections per host) and keeps a
// recovery-token rebuild well inside the API's per-token download limit.
var restoreDownloadConcurrency = 8

// restoreWindowPerWorker bounds how far downloads may run ahead of the
// install point, in files per worker. Installs happen strictly in manifest
// order, so a slow object at the head holds back installation (not
// downloading) of everything behind it; the window keeps the number of
// verified-but-not-yet-installed files in the staging dir bounded.
const restoreWindowPerWorker = 4

// restoreStagedBytesBudget bounds the manifest bytes held in the staging dir
// by downloads that are in flight or waiting to install. The serial restore
// staged one file at a time, so the staging volume only ever had to hold the
// largest file; this keeps that requirement close: a new download starts
// only while the window's total stays under the budget, except that the
// window's first file always starts (a file larger than the budget
// downloads alone, exactly as before).
var restoreStagedBytesBudget int64 = 256 << 20

// setRestoreConcurrencyForTest overrides restoreDownloadConcurrency. Call the
// returned func (typically via defer) to restore it.
func setRestoreConcurrencyForTest(n int) (restore func()) {
	old := restoreDownloadConcurrency
	restoreDownloadConcurrency = n
	return func() { restoreDownloadConcurrency = old }
}

// contentFetchOutcome is what a download worker hands back for one file:
// either a verified staging file ready to install, or a failure (err is the
// download or content-check error). Warnings are carried back rather than
// appended by the worker so the result's warnings stay in manifest order.
type contentFetchOutcome struct {
	failed   bool
	err      error
	warnings []string
}

// contentSlot is one manifest content entry inside the restore window.
type contentSlot struct {
	file           SnapshotFile
	displayPath    string
	relativeTarget string
	targetPath     string
	stagingFile    string
	charged        int64 // bytes counted against restoreStagedBytesBudget

	invalid     error // restoreRelativePath refused the path; nothing downloaded
	blocked     bool  // beneath a directory that could not be restricted; nothing downloaded
	resumed     bool  // the journal says installed; re-checked at install time
	downloading bool
	ready       bool
	outcome     contentFetchOutcome
}

type contentFetchDone struct {
	index   int
	outcome contentFetchOutcome
}

// contentRestorer runs the restore's file pass (#5623). Downloads and their
// size/checksum verification run on up to restoreDownloadConcurrency
// goroutines; EVERYTHING else runs on the caller's goroutine, in manifest
// order, exactly as the serial loop did: the resume-journal check and
// append, the securefs install (so a later manifest entry that maps to the
// same target still wins), result counters and warnings, and progress
// callbacks. Workers touch only their own staging file.
type contentRestorer struct {
	provider       providers.BackupProvider
	files          []SnapshotFile
	targetBase     string
	stagingDir     string
	total          int64
	result         *RestoreResult
	resume         *resumeTracker
	secDescs       *restoreSecurity
	applyOwnership bool
	warnOwnership  func()
	progressFn     ProgressFunc
	checkCancelled func() bool
	// integrity is the command's integrity expectation (nil = none): the
	// staged bytes are checked against it, and a resumed file is skipped
	// only when it still holds the attested content.
	integrity *integrity.Expectation
	// blockedBeneath names the directory above a relative target that could
	// not be restricted, or "" (restore.go).
	blockedBeneath func(relative string) string
}

// run restores every content file. It returns true when the run was
// cancelled (result already carries the cancelled status); it never returns
// while a download it started is still running.
func (c *contentRestorer) run(ctx context.Context) (cancelled bool) {
	n := len(c.files)
	if n == 0 {
		return false
	}
	workers := restoreDownloadConcurrency
	if workers < 1 {
		workers = 1
	}
	window := workers * restoreWindowPerWorker

	var ctxDone <-chan struct{}
	if ctx != nil {
		ctxDone = ctx.Done()
	}
	// Buffered to the worker bound so a worker never blocks handing back its
	// outcome, even while the coordinator is draining on cancellation.
	doneCh := make(chan contentFetchDone, workers)
	slots := make(map[int]*contentSlot, window)
	inWindow := make(map[string]int) // staging file -> window entries using it
	var stagedBytes int64
	inflight := 0
	next, head := 0, 0

	defer func() {
		// Every return (cancellation) waits for the downloads it started:
		// they write into the staging dir, which the caller may delete or
		// compact the resume state in as soon as this returns.
		for inflight > 0 {
			d := <-doneCh
			inflight--
			if s := slots[d.index]; s != nil {
				s.ready, s.outcome = true, d.outcome
			}
		}
		for _, s := range slots {
			if s.ready && !s.outcome.failed && s.stagingFile != "" {
				_ = os.Remove(s.stagingFile)
			}
		}
	}()

	for head < n {
		// Admit entries in manifest order while the window, the worker bound
		// and the staged-bytes budget allow.
		for next < n && next-head < window && inflight < workers {
			file := c.files[next]
			stagingFile := filepath.Join(c.stagingDir, stagingFileName(file.BackupPath))
			if inWindow[stagingFile] > 0 {
				// The same object is already downloading or awaiting install
				// under this staging name; admit this entry once it is gone.
				break
			}
			charge := file.Size
			if charge < 0 {
				charge = 0
			}
			if stagedBytes > 0 && stagedBytes+charge > restoreStagedBytesBudget {
				break
			}
			index := next
			s := c.admit(file, stagingFile)
			slots[index] = s
			next++
			if s.invalid != nil || s.blocked {
				s.ready = true
				continue
			}
			inWindow[stagingFile]++
			if s.resumed {
				// Decided at install time, in order (see finish).
				s.ready = true
				continue
			}
			s.downloading = true
			s.charged = charge
			stagedBytes += charge
			inflight++
			go func(index int, s contentSlot) {
				doneCh <- contentFetchDone{index: index, outcome: c.fetchAndVerify(ctx, s)}
			}(index, *s)
		}

		if s := slots[head]; s != nil && s.ready {
			if c.checkCancelled() {
				return true
			}
			c.finish(ctx, head, s)
			delete(slots, head)
			if s.invalid == nil && !s.blocked {
				if inWindow[s.stagingFile]--; inWindow[s.stagingFile] <= 0 {
					delete(inWindow, s.stagingFile)
				}
			}
			stagedBytes -= s.charged
			head++
			continue
		}

		select {
		case d := <-doneCh:
			inflight--
			if s := slots[d.index]; s != nil {
				s.ready, s.outcome = true, d.outcome
			}
		case <-ctxDone:
			if c.checkCancelled() {
				return true
			}
		}
	}
	return false
}

// admit computes a slot's paths and resume disposition. Caller's goroutine.
func (c *contentRestorer) admit(file SnapshotFile, stagingFile string) *contentSlot {
	s := &contentSlot{file: file, displayPath: restoreSourcePath(file), stagingFile: stagingFile}
	rel, err := restoreRelativePath(s.displayPath)
	if err != nil {
		s.invalid = err
		return s
	}
	s.relativeTarget = rel
	s.targetPath = filepath.Join(c.targetBase, rel)
	if c.blockedBeneath != nil && c.blockedBeneath(rel) != "" {
		s.blocked = true
		return s
	}
	s.resumed = c.resume.completed(file.BackupPath)
	return s
}

// finish accounts for, and installs, the entry at manifest index i. It runs
// on the caller's goroutine in manifest order, so result, resume and
// progress see files in exactly the order the serial loop produced.
func (c *contentRestorer) finish(ctx context.Context, i int, s *contentSlot) {
	current := int64(i + 1)
	file := s.file
	if s.invalid != nil {
		c.result.Warnings = append(c.result.Warnings, fmt.Sprintf("invalid restore path %s: %v", s.displayPath, s.invalid))
		c.fail(s.displayPath)
		return
	}
	if s.blocked {
		c.fail(s.displayPath)
		c.result.Warnings = append(c.result.Warnings, fmt.Sprintf("not restored %s: its directory could not be restricted", s.displayPath))
		return
	}

	if s.resumed {
		// Checked now rather than at admission: an earlier entry that maps
		// to the same target (a case twin restored onto NTFS) has just been
		// installed, and the serial loop's decision saw its result. In
		// attested mode the file on disk must still hold exactly the
		// attested bytes: a size match alone would keep content that
		// changed since the earlier run.
		if resumedFileIntact(c.targetBase, s.relativeTarget, file, c.integrity) {
			c.result.FilesRestored++
			c.result.BytesRestored += file.Size
			if c.progressFn != nil {
				c.progressFn("restoring", current, c.total, fmt.Sprintf("skipped (resumed): %s", s.displayPath))
			}
			return
		}
		c.resume.forget(file.BackupPath)
		// Rare (the target changed since it was journaled): fetch inline.
		// No other window entry shares this staging file (see run).
		s.outcome = c.fetchAndVerify(ctx, *s)
	}

	if s.outcome.failed {
		c.fail(s.displayPath)
		if c.result.Code == "" {
			c.result.Code = integrityResultCode(c.integrity, s.outcome.err)
		}
		if w := storedBytesFailureWarning(s.displayPath, file, s.outcome.err, c.integrity); w != "" {
			c.result.Warnings = append(c.result.Warnings, w)
		}
		return
	}
	c.result.Warnings = append(c.result.Warnings, s.outcome.warnings...)

	// Publish only verified bytes. Linux, macOS and Windows pin the target
	// hierarchy with directory descriptors/handles and never follow a
	// destination symlink/reparse point. Mode (full ModeBits when the
	// manifest carries them, else the perm-only Mode), owner, mtime, Windows
	// attributes and the captured NTFS security descriptor (W06a) are all
	// applied to the pinned temporary's handle BEFORE the atomic replace, so
	// #5520's fidelity is preserved without any post-publication pathname
	// chmod/chown/chtimes/SetSecurity — the exact operations this boundary
	// (SEC-121) exists to remove. That walk also subsumes a lexical
	// containment check and EnsureNoSymlinkAncestor, including the RESUMED
	// case where an earlier pass recreated an ancestor as a symlink.
	mode := os.FileMode(file.Mode).Perm()
	if file.ModeBits != 0 {
		mode = os.FileMode(file.ModeBits)
	}
	// A descriptor naming principals this machine does not recognise, or
	// one that cannot be read, is replaced by the restrictive quarantine
	// descriptor (restore_sd.go).
	secPlan := c.secDescs.entryPlan(file)
	installWarnings, err := securefs.InstallFileWithSecurity(c.targetBase, s.relativeTarget, s.stagingFile, mode, file.ModTime, entryOwner(file, c.applyOwnership), file.WinAttrs, secPlan.applier)
	if err != nil {
		c.fail(s.displayPath)
		c.result.Warnings = append(c.result.Warnings, fmt.Sprintf("could not restore %s: %v", s.displayPath, err))
		_ = os.Remove(s.stagingFile)
		slog.Warn("failed to install restored file", "target", s.targetPath, "error", err.Error())
		return
	}
	for _, warning := range installWarnings {
		c.result.Warnings = append(c.result.Warnings, fmt.Sprintf("restored %s with reduced fidelity: %v", s.displayPath, warning))
	}
	c.secDescs.record(c.result, s.displayPath, secPlan)
	if !c.applyOwnership && (file.Owner != nil || file.ModeBits&uint32(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0) {
		c.warnOwnership()
	}

	c.result.FilesRestored++
	c.result.BytesRestored += file.Size
	// One journal append per file, only after its bytes and metadata landed.
	c.resume.markCompleted(file.BackupPath, file.Size)

	if c.progressFn != nil {
		c.progressFn("restoring", current, c.total, fmt.Sprintf("restored: %s", s.displayPath))
	}
}

func (c *contentRestorer) fail(displayPath string) {
	c.result.FilesFailed++
	c.result.FailedFiles = append(c.result.FailedFiles, displayPath)
}

// fetchAndVerify downloads one object into its staging file and checks the
// staged bytes against the manifest entry BEFORE the file can be declared
// restored: exactly in attested mode, with the earlier size/checksum rules
// otherwise (downloadAndCheckStaged, integrity.CheckStoredBytes). Safe to
// call from a worker goroutine: it reads only s (a copy), the provider and
// the expectation, and writes only s.stagingFile. A failed outcome has
// already removed the staging file, including any partial object a provider
// left behind on a mid-body error.
func (c *contentRestorer) fetchAndVerify(ctx context.Context, s contentSlot) contentFetchOutcome {
	file := s.file
	check, dlWarnings, err := downloadAndCheckStaged(ctx, c.provider, file, s.stagingFile, c.integrity)
	if err != nil {
		_ = os.Remove(s.stagingFile)
		slog.Warn("restored file failed its download or content check",
			"backupPath", file.BackupPath, "target", s.targetPath, "error", err.Error())
		return contentFetchOutcome{failed: true, err: err}
	}
	out := contentFetchOutcome{warnings: dlWarnings}
	if check.Warning != "" {
		out.warnings = append(out.warnings, fmt.Sprintf("restored %s: %s", s.displayPath, check.Warning))
		slog.Warn("restored volatile file differs from its manifest entry (advisory, not a failure)", "target", s.targetPath)
	}
	return out
}
