package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// errSourceSnapshotGone marks the mid-run abort in #3260: the point-in-time
// source the run is reading from — on Windows, the VSS shadow copy created at
// the start of the job — stopped resolving while the upload loop was still
// walking it.
//
// Field repro (v0.104.0, Windows Server 2022, 2026-08-07, job b906f40d): 15
// ACL-denied files out of 40 each burned the 30s upload backoff (#3259); at
// roughly +390s the shadow copy `HarddiskVolumeShadowCopy26` stopped resolving,
// and files 14-40 — every one of them readable — then failed with
// ERROR_PATH_NOT_FOUND. Because ERROR_PATH_NOT_FOUND is in the permanent
// fast-skip set, the run drained the rest of its file list at memory speed and
// recorded all of it as per-file failures. The job finished `failed` with zero
// files backed up and an error log that blamed the files.
//
// Recording a dead snapshot's fallout as per-file verdicts is the worst
// available outcome: it is indistinguishable from "those files were bad". This
// error exists so the run stops at the first sign of it and says what actually
// happened.
//
// Deliberately NOT called "expired": a VSS_CTX_BACKUP shadow copy has no TTL,
// so nothing here times out. It becomes unavailable — deleted by the provider,
// lost to diff-area exhaustion, removed externally, or (see the note in
// vss.CreateShadowCopy about releasing IVssBackupComponents) auto-released. The
// guard is agnostic about which; it only reports that the source went away.
var errSourceSnapshotGone = errors.New("backup source snapshot is no longer available (VSS shadow copy deleted or became unavailable mid-run)")

// sourceLivenessFn reports a non-nil error when the point-in-time source that
// sourcePath was read from has gone away. It is scoped to a single file on
// purpose: with several volumes snapshotted, losing volume D's shadow copy says
// nothing about the files still to be read from volume C, and aborting the run
// over an unrelated volume would be its own false-abort bug.
//
// A nil sourceLivenessFn means "this run has no snapshot to defend" — a non-VSS
// run reads the live filesystem, which cannot go away out from under it.
//
// It is only ever consulted AFTER a per-file upload has already failed, so its
// cost is bounded by the number of failures, not the number of files.
type sourceLivenessFn func(sourcePath string) error

// snapshotRootStat is os.Stat, indirected so tests can retire a shadow root
// mid-run without a real VSS session.
var snapshotRootStat = os.Stat

// setSnapshotRootStatForTest overrides snapshotRootStat. Call the returned
// restore func (typically via defer) to put the real os.Stat back.
func setSnapshotRootStatForTest(fn func(string) (os.FileInfo, error)) (restore func()) {
	old := snapshotRootStat
	snapshotRootStat = fn
	return func() { snapshotRootStat = old }
}

// shadowRootConfirmDelay separates the two stats that must BOTH report "gone"
// before a run is aborted. Killing a whole backup is drastic enough to be worth
// one confirmation: a single anomalous stat can never do it, only a root that
// is still missing a moment later.
var shadowRootConfirmDelay = 250 * time.Millisecond

// setShadowRootConfirmDelayForTest overrides shadowRootConfirmDelay. Call the
// returned restore func (typically via defer) to put the real delay back.
func setShadowRootConfirmDelayForTest(d time.Duration) (restore func()) {
	old := shadowRootConfirmDelay
	shadowRootConfirmDelay = d
	return func() { shadowRootConfirmDelay = old }
}

// newShadowRootLiveness builds a liveness probe over the VSS shadow-copy device
// roots this run's files were rewritten onto (`vss.VSSSession.ShadowPaths`,
// values like `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy26`; see
// rewritePathsForVSS, which prefixes exactly these strings onto each source
// path). Returns nil — meaning "nothing to defend" — when the run is not
// reading from a shadow copy at all.
//
// SELF-CALIBRATING BY DESIGN. Each root is stat'd once here, at construction,
// and only the roots that resolve at that moment are watched. This is what
// makes a false abort structurally impossible rather than merely unlikely: the
// probe can never fail on a path form that os.Stat was never able to resolve in
// the first place (`\\?\GLOBALROOT\...` is an unusual shape, and a probe that
// assumed it stats cleanly would abort every healthy backup if that assumption
// were ever wrong). A root only counts as gone if it demonstrably resolved at
// the start of the run and stopped resolving later — which is exactly the
// transition #3260 describes and nothing else.
func newShadowRootLiveness(shadowPaths map[string]string) sourceLivenessFn {
	seen := map[string]bool{}
	var roots []string
	for _, root := range shadowPaths {
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		if _, err := snapshotRootStat(root); err != nil {
			// Not watchable: it never resolved, so its later failure would say
			// nothing about the snapshot going away. Debug, not warn — on an
			// odd path form this is expected, and the run is unaffected either
			// way (it simply keeps the pre-#3260 behaviour for those files).
			log.Debug("shadow copy root is not stat-able, excluding it from mid-run liveness checks",
				"root", root,
				"error", err.Error(),
			)
			continue
		}
		roots = append(roots, root)
	}
	if len(roots) == 0 {
		if len(shadowPaths) > 0 {
			// VSS really was active for this run, yet not one of its roots
			// could be watched — so the #3260 guard is OFF and a shadow copy
			// that dies mid-run will once again be recorded as a pile of
			// per-file failures. Warn, not Debug: at production verbosity a
			// silent nil here is indistinguishable from "the guard is armed
			// and saw nothing wrong", which is exactly the ambiguity this
			// whole change exists to remove.
			log.Warn("VSS is active but no shadow copy root could be watched; mid-run snapshot-loss detection is disabled for this run",
				"rootsOffered", len(shadowPaths),
			)
		}
		return nil
	}
	// Longest root first so prefix matching picks the most specific one, and
	// deterministically (map iteration order is randomized).
	sort.Slice(roots, func(i, j int) bool {
		if len(roots[i]) != len(roots[j]) {
			return len(roots[i]) > len(roots[j])
		}
		return roots[i] < roots[j]
	})

	log.Debug("watching shadow copy roots for mid-run disappearance", "roots", len(roots))

	// warnedInconclusive tracks roots already reported as un-checkable, so the
	// warning below fires once per root per run rather than once per failing
	// file. Guarded because nothing in the contract promises the probe is only
	// ever called from the single upload goroutine.
	var mu sync.Mutex
	warnedInconclusive := map[string]bool{}

	return func(sourcePath string) error {
		root, ok := matchShadowRoot(roots, sourcePath)
		if !ok {
			// This file was not read through a watched shadow root — a
			// system-state staging file, or a path on an unprotected volume
			// that rewritePathsForVSS left pointing at the live filesystem.
			// There is no snapshot behind it to have gone away.
			return nil
		}
		missing, inconclusive := shadowRootMissing(root)
		if inconclusive != nil {
			// The stat failed for a reason other than "does not exist", so it
			// is not evidence of anything and the run continues. But a root
			// that answers this way every time leaves the guard unable to
			// decide, for the rest of the run, whether a failure is the file's
			// fault or the snapshot's — the same ambiguity as having no guard
			// at all, so it has to be visible above Debug.
			mu.Lock()
			first := !warnedInconclusive[root]
			warnedInconclusive[root] = true
			mu.Unlock()
			if first {
				log.Warn("shadow copy root liveness check is inconclusive; treating the snapshot as alive and cannot confirm this root for the rest of the run",
					"root", root,
					"error", inconclusive.Error(),
				)
			}
			return nil
		}
		if !missing {
			return nil
		}
		// Confirm before killing the run. A root that is genuinely gone stays
		// gone; a one-off anomalous stat resolves on the second look.
		time.Sleep(shadowRootConfirmDelay)
		if confirmed, _ := shadowRootMissing(root); !confirmed {
			log.Warn("shadow copy root briefly failed to resolve but came back, continuing",
				"root", root,
			)
			return nil
		}
		return fmt.Errorf("%w: %s", errSourceSnapshotGone, root)
	}
}

// matchShadowRoot returns the watched root that sourcePath was read through.
// roots must be ordered longest-first.
//
// The match is on a path BOUNDARY, not a bare string prefix: shadow-copy device
// paths are numbered (`...HarddiskVolumeShadowCopy2` vs `...ShadowCopy26`), so a
// bare prefix test would let a file under ShadowCopy26 be checked against
// ShadowCopy2's root whenever 26 itself is unwatched — and abort a healthy run
// because some other volume's snapshot went away.
func matchShadowRoot(roots []string, sourcePath string) (string, bool) {
	for _, root := range roots {
		if !strings.HasPrefix(sourcePath, root) {
			continue
		}
		rest := sourcePath[len(root):]
		if rest == "" || rest[0] == '\\' || rest[0] == '/' {
			return root, true
		}
	}
	return "", false
}

// shadowRootMissing reports whether a root has stopped existing.
//
// Three-way, not boolean: (false, nil) alive, (true, nil) confirmed gone, and
// (false, err) inconclusive. Only a not-exist answer counts as gone. Any OTHER
// stat error — a momentary I/O hiccup, a permission oddity — is NOT evidence
// that the snapshot went away, and aborting a whole run on it would recreate
// the bug this guards against in a new form. The error is returned rather than
// swallowed so the caller can surface a root it can no longer vouch for.
func shadowRootMissing(root string) (missing bool, inconclusive error) {
	_, err := snapshotRootStat(root)
	if err == nil {
		return false, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return true, nil
	}
	return false, err
}
