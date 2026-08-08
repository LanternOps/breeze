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
// Field repro (v0.104.0, Windows Server 2022, 2026-08-07, job b906f40d): a
// 40-file set with 15 ACL-denied files. The first ~13 denials each burned the
// 30s upload backoff (#3259) — 13 x 30s is the +390s at which the shadow copy
// `HarddiskVolumeShadowCopy26` stopped resolving, before the run had even
// reached the last of the denied files. From there every remaining file —
// including the 25+ readable ones — failed with ERROR_PATH_NOT_FOUND. Because
// ERROR_PATH_NOT_FOUND is in the permanent fast-skip set, the run drained the
// rest of its file list at memory speed and recorded all of it as per-file
// failures. The job finished `failed` with zero files backed up and an error
// log that blamed the files.
//
// Recording a dead snapshot's fallout as per-file verdicts is the worst
// available outcome: it is indistinguishable from "those files were bad". This
// error exists so the run stops at the first sign of it and says what actually
// happened.
//
// Deliberately NOT called "expired": a VSS_CTX_BACKUP shadow copy has no TTL,
// so nothing here times out. It becomes unavailable — deleted by the provider,
// lost to diff-area exhaustion, removed externally, or auto-released when
// IVssBackupComponents is released (Microsoft-documented behaviour for
// auto-release VSS_CTX_BACKUP copies; the contrary note in
// vss.CreateShadowCopy, which claims reclamation only at requester process
// exit, is tracked as #3269). The guard is agnostic about which; it only
// reports that the source went away.
var errSourceSnapshotGone = errors.New("backup source snapshot is no longer available (VSS shadow copy deleted or became unavailable mid-run)")

// sourceLivenessFn reports a non-nil error when the point-in-time source that
// sourcePath was read from has gone away.
//
// It is scoped to a single file on purpose, but note what that scoping does and
// does not do. It governs which failures TRIGGER an abort — a file on volume C
// is judged against C's shadow copy, so losing volume D cannot condemn it. The
// abort itself is NOT scoped: once triggered it ends the whole run, both
// volumes included. That is intended (a run that can no longer read one of its
// sources is not a run worth finishing), but it means the per-volume check is
// about not firing spuriously, not about limiting the blast radius.
//
// A nil sourceLivenessFn means "this run has no snapshot to defend" — a non-VSS
// run reads the live filesystem, which cannot go away out from under it.
//
// It is only ever consulted AFTER a per-file upload has already failed, so its
// cost is bounded by the number of failures, not the number of files.
type sourceLivenessFn func(sourcePath string) error

// watchedRoot is one shadow-copy root the run is reading from.
//
// prefix and statPath are separate because they answer different questions and
// are NOT always the same string. prefix is the exact text rewritePathsForVSS
// prepended to every source path on that volume, so it is what file paths must
// be matched against. statPath is whatever form of that root os.Stat actually
// accepts.
//
// They diverge on real Windows. vss.CreateShadowCopy returns
// VSS_SNAPSHOT_PROP.SnapshotDeviceObject verbatim — e.g.
// `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy26`, with NO trailing
// separator — and a bare device path of that shape is not reliably stat-able
// even while the snapshot is perfectly healthy and every file under it reads
// fine. Conflating the two would make resolveStatablePath fail on every real
// run and silently disarm the whole guard.
type watchedRoot struct {
	prefix   string
	statPath string
}

// snapshotRootStat is os.Stat, indirected so tests can retire a shadow root
// mid-run without a real VSS session.
var snapshotRootStat = os.Stat

// resolveStatablePath finds a form of root that os.Stat accepts, and returns
// it. Tries the root verbatim first, then with a trailing separator appended.
//
// The trailing-separator fallback is the difference between a working guard and
// an inert one on Windows: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyNN`
// names a device object, and the Win32 attribute query behind os.Stat wants a
// directory path. Everything that has ever been shown to work on a real shadow
// copy — the live VSS test's ReadDir, the file walk itself — goes through a
// path with a separator after the device name, never the bare device name.
//
// The error returned is the FIRST failure (the verbatim one), since that is the
// form the caller asked about.
func resolveStatablePath(root string) (string, error) {
	_, err := snapshotRootStat(root)
	if err == nil {
		return root, nil
	}
	if withSep := root + `\`; withSep != root {
		if _, sepErr := snapshotRootStat(withSep); sepErr == nil {
			return withSep, nil
		}
	}
	return "", err
}

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
	var roots []watchedRoot
	type exclusion struct {
		root string
		err  error
	}
	var excluded []exclusion

	for _, root := range shadowPaths {
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		statPath, err := resolveStatablePath(root)
		if err != nil {
			// Not watchable: it never resolved, so its later failure would say
			// nothing about the snapshot going away. Logged after the loop,
			// where we know whether this was a total or partial loss of cover.
			excluded = append(excluded, exclusion{root: root, err: err})
			continue
		}
		roots = append(roots, watchedRoot{prefix: root, statPath: statPath})
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
			for _, ex := range excluded {
				log.Warn("shadow copy root is not stat-able", "root", ex.root, "error", ex.err.Error())
			}
		}
		return nil
	}

	// PARTIAL cover is the dangerous middle case: the guard is armed, so the
	// run looks protected, but files on an excluded volume can still be
	// misattributed exactly as #3260 describes. Warn per excluded root —
	// silence here would hide a half-disarmed guard behind an armed one.
	for _, ex := range excluded {
		log.Warn("shadow copy root is not stat-able; mid-run snapshot-loss detection is disabled for FILES ON THIS VOLUME ONLY",
			"root", ex.root,
			"error", ex.err.Error(),
			"rootsStillWatched", len(roots),
		)
	}

	// Longest root first so prefix matching picks the most specific one, and
	// deterministically (map iteration order is randomized).
	sort.Slice(roots, func(i, j int) bool {
		if len(roots[i].prefix) != len(roots[j].prefix) {
			return len(roots[i].prefix) > len(roots[j].prefix)
		}
		return roots[i].prefix < roots[j].prefix
	})

	// Info, not Debug: this is the one line that lets a production log
	// positively confirm the #3260 guard was armed for a given run, and say
	// over how much of it. Without it, "armed and quiet" and "never armed"
	// look the same after the fact.
	log.Info("mid-run snapshot-loss detection armed",
		"rootsWatched", len(roots),
		"rootsExcluded", len(excluded),
	)

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
			// system-state staging file, a path on an unprotected volume that
			// rewritePathsForVSS left pointing at the live filesystem, or a
			// volume excluded above. There is no watched snapshot behind it.
			return nil
		}
		missing, inconclusive := shadowRootMissing(root.statPath)
		if inconclusive != nil {
			// The stat failed for a reason other than "does not exist", so it
			// is not evidence of anything and the run continues. But a root
			// that answers this way every time leaves the guard unable to
			// decide, for the rest of the run, whether a failure is the file's
			// fault or the snapshot's — the same ambiguity as having no guard
			// at all, so it has to be visible above Debug.
			mu.Lock()
			first := !warnedInconclusive[root.prefix]
			warnedInconclusive[root.prefix] = true
			mu.Unlock()
			if first {
				log.Warn("shadow copy root liveness check is inconclusive; treating the snapshot as alive and cannot confirm this root for the rest of the run",
					"root", root.prefix,
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
		confirmed, confirmErr := shadowRootMissing(root.statPath)
		if confirmErr != nil {
			// The second look neither confirmed nor cleared it. Report that
			// honestly rather than as "came back" — an unactionable message
			// that misdescribes what happened is the #3260 complaint itself.
			log.Warn("shadow copy root went missing then answered inconclusively; not aborting the run",
				"root", root.prefix,
				"error", confirmErr.Error(),
			)
			return nil
		}
		if !confirmed {
			log.Warn("shadow copy root briefly failed to resolve but came back, continuing",
				"root", root.prefix,
			)
			return nil
		}
		return fmt.Errorf("%w: %s", errSourceSnapshotGone, root.prefix)
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
func matchShadowRoot(roots []watchedRoot, sourcePath string) (watchedRoot, bool) {
	for _, root := range roots {
		if !strings.HasPrefix(sourcePath, root.prefix) {
			continue
		}
		rest := sourcePath[len(root.prefix):]
		if rest == "" || rest[0] == '\\' || rest[0] == '/' {
			return root, true
		}
	}
	return watchedRoot{}, false
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
