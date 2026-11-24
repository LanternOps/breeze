package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Whether this PROCESS can still use DXGI Desktop Duplication (#12624).
//
// An IDXGIOutputDuplication that outlives its session makes every later
// DuplicateOutput on that output fail with E_INVALIDARG for as long as the
// process lives; the session itself cannot repair that. This file records what
// the process holds, so that a Windows helper in that state can be replaced
// once it is idle (userhelper/helper_recycle.go). No build tag: the decisions
// are pure Go and asserted on every OS.

// duplicationErrorClass is what a DuplicateOutput HRESULT says about this
// process.
type duplicationErrorClass int

const (
	duplicationOK duplicationErrorClass = iota
	// duplicationHeldByProcess is E_INVALIDARG: "the calling application is
	// already duplicating this desktop output". Not proof on its own; see
	// duplicationLeaked.
	duplicationHeldByProcess
	duplicationFailedOther
)

const hresultInvalidArg = 0x80070057

func classifyDuplicateOutput(hresult uint32) duplicationErrorClass {
	switch {
	case hresult == hresultInvalidArg:
		return duplicationHeldByProcess
	case int32(hresult) < 0:
		return duplicationFailedOther
	default:
		return duplicationOK
	}
}

// duplicationLeakStreak is how many consecutive failures, across retries, a
// capturer must see before the output counts as held by a leaked duplication.
// The fast retries span about a second, which outlasts the legitimate overlaps:
// a monitor switch opening the new capturer before the old one is closed, and
// a one-shot screenshot's own capturer.
const duplicationLeakStreak = 3

type duplicationFailure struct {
	Class          duplicationErrorClass
	EverDuplicated bool // this process has duplicated this output before
	OtherHolders   int  // live capturers in this process that own the output
	Streak         int  // consecutive failures the reporter has seen
}

// duplicationLeaked decides that a duplication of this output is alive in this
// process with no live owner. EverDuplicated is what stops a loop: a process
// that never duplicated the output cannot be the one holding it, so hardware
// that always answers E_INVALIDARG, and a fresh replacement helper, never
// qualify.
func duplicationLeaked(f duplicationFailure) bool {
	return f.Class == duplicationHeldByProcess &&
		f.EverDuplicated &&
		f.OtherHolders == 0 &&
		f.Streak >= duplicationLeakStreak
}

// captureProcessHealth is the process-wide record. Keys are opaque owners
// (capturers, sessions).
type captureProcessHealth struct {
	mu         sync.Mutex
	abandoned  map[any]string // session -> where its pipeline is stuck
	duplicated map[int]bool   // outputs this process has duplicated
	holders    map[any]int    // capturer -> output it holds
	leaked     map[int]bool
	releases   uint64
	teardowns  int
	// changed is signalled (non-blocking) when the process becomes poisoned.
	changed chan struct{}
}

func newCaptureProcessHealth() *captureProcessHealth {
	return &captureProcessHealth{
		abandoned:  make(map[any]string),
		duplicated: make(map[int]bool),
		holders:    make(map[any]int),
		leaked:     make(map[int]bool),
		changed:    make(chan struct{}, 1),
	}
}

// captureHealth is this process's record. A var so tests can isolate it.
var captureHealth = newCaptureProcessHealth()

func (h *captureProcessHealth) signal() {
	select {
	case h.changed <- struct{}{}:
	default:
	}
}

// noteDuplicated records that owner now holds a duplication of display.
func (h *captureProcessHealth) noteDuplicated(owner any, display int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.duplicated[display] = true
	h.holders[owner] = display
	delete(h.leaked, display)
}

// noteDuplicationReleased records that owner released its duplication.
func (h *captureProcessHealth) noteDuplicationReleased(owner any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, held := h.holders[owner]; !held {
		return
	}
	delete(h.holders, owner)
	h.releases++
}

// releaseGeneration moves every time this process releases a duplication, so a
// capturer waiting out its retry delay can retry at once.
func (h *captureProcessHealth) releaseGeneration() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.releases
}

// noteDuplicationFailed records a failed DuplicateOutput by owner. It reports
// whether this failure is what concluded the output is held by a leak (and
// then has already logged it at Warn).
func (h *captureProcessHealth) noteDuplicationFailed(owner any, display int, class duplicationErrorClass, streak int) (concluded bool) {
	h.mu.Lock()
	others := 0
	for o, d := range h.holders {
		if o != owner && d == display {
			others++
		}
	}
	leaked := !h.leaked[display] && duplicationLeaked(duplicationFailure{
		Class:          class,
		EverDuplicated: h.duplicated[display],
		OtherHolders:   others,
		Streak:         streak,
	})
	if leaked {
		h.leaked[display] = true
	}
	h.mu.Unlock()
	if leaked {
		slog.Warn("DXGI duplication of this output outlived its session; this process can no longer capture it with DXGI, staying on GDI",
			"display", display, "failures", streak)
		h.signal()
	}
	return leaked
}

// noteAbandoned records that a session's capture pipeline could not be
// released because something is still stuck in it.
func (h *captureProcessHealth) noteAbandoned(session any, stage string) {
	h.mu.Lock()
	h.abandoned[session] = stage
	h.mu.Unlock()
	h.signal()
}

// clearAbandoned records that the pipeline was released after all.
func (h *captureProcessHealth) clearAbandoned(session any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.abandoned, session)
}

func (h *captureProcessHealth) beginTeardown() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.teardowns++
}

func (h *captureProcessHealth) endTeardown() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.teardowns--
}

func (h *captureProcessHealth) teardownInProgress() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.teardowns > 0
}

// poisonReason names why this process can no longer be trusted to capture
// with DXGI, or "" when nothing is wrong.
func (h *captureProcessHealth) poisonReason() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.abandoned) > 0 {
		stage := ""
		for _, s := range h.abandoned {
			if stage == "" || s < stage {
				stage = s
			}
		}
		return fmt.Sprintf("%d stopped desktop session(s) could not release capture (stuck in %s)", len(h.abandoned), stage)
	}
	if len(h.leaked) > 0 {
		return fmt.Sprintf("DXGI duplication of %d output(s) outlived its session (DuplicateOutput E_INVALIDARG)", len(h.leaked))
	}
	return ""
}

// CaptureProcessPoisoned names why this process can no longer capture with
// DXGI, or "" when it can.
func CaptureProcessPoisoned() string { return captureHealth.poisonReason() }

// CaptureProcessChanged is signalled when CaptureProcessPoisoned may have
// become non-empty.
func CaptureProcessChanged() <-chan struct{} { return captureHealth.changed }

// SessionTeardownInProgress reports whether a session stop is still running in
// this process. HasActiveSessions is already false then.
func SessionTeardownInProgress() bool { return captureHealth.teardownInProgress() }

// dxgiRetry paces attempts to leave the GDI fallback. The first attempts run
// on every desktop check, as before; a persistent failure then backs off, since
// each attempt creates and destroys a D3D11 device.
type dxgiRetry struct {
	failures    int
	lastAttempt time.Time
	lastGen     uint64
}

const (
	dxgiRetryFastAttempts = 3
	dxgiRetryMaxDelay     = 5 * time.Second
)

// dxgiRetryDelay is how long to wait after the nth consecutive failure.
func dxgiRetryDelay(failures int) time.Duration {
	if failures < dxgiRetryFastAttempts {
		return 0
	}
	delay := time.Second
	for i := dxgiRetryFastAttempts; i < failures && delay < dxgiRetryMaxDelay; i++ {
		delay *= 2
	}
	return min(delay, dxgiRetryMaxDelay)
}

// due reports whether to attempt now. releaseGen is
// captureProcessHealth.releaseGeneration: a duplication released in this
// process since the last attempt may be the one that was in the way.
func (r *dxgiRetry) due(now time.Time, releaseGen uint64) bool {
	return r.failures == 0 || releaseGen != r.lastGen ||
		now.Sub(r.lastAttempt) >= dxgiRetryDelay(r.failures)
}

// failed records a failed attempt and reports whether to log it at Warn: once
// per streak, when it is persistent enough to start backing off.
func (r *dxgiRetry) failed(now time.Time, releaseGen uint64) (warn bool) {
	r.failures++
	r.lastAttempt = now
	r.lastGen = releaseGen
	return r.failures == dxgiRetryFastAttempts
}

// reset ends the streak and returns how many attempts had failed. It is
// also how a desktop change starts over without a delay.
func (r *dxgiRetry) reset() int {
	n := r.failures
	*r = dxgiRetry{}
	return n
}
