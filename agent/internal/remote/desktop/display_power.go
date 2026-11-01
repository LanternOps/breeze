package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Display power for desktop sessions (#10874).
//
// A locked Mac's lock screen switches the display off about 30 s after the
// last input, even with `pmset displaysleep 0`. A sleeping display drops out of
// the active display list, so ScreenCaptureKit and CoreGraphics both report
// zero displays — the same symptom as a headless Mac with nothing attached,
// which used to be the only explanation the error gave. Two things follow:
//
//   - a session holds a PreventUserIdleDisplaySleep assertion for its whole
//     life and declares user activity before its first capture and on every
//     capture restart, so the display is woken and kept on;
//   - when capture still finds zero displays, the online display list (which,
//     unlike the active list, includes sleeping displays) tells "attached but
//     asleep" apart from "nothing attached", and the error says which.
//
// This file carries no build tag on purpose: the IOKit/CoreGraphics calls live
// behind displayPowerOps (display_power_darwin.go), and the Test Agent CI job
// runs on ubuntu-latest, so the decision logic must compile there to be tested.

// displayCounts is one reading of the system's displays.
type displayCounts struct {
	online int // attached: active, mirrored or asleep (CGGetOnlineDisplayList)
	active int // drawable (CGGetActiveDisplayList) — excludes sleeping displays
	asleep int // online displays CGDisplayIsAsleep reports asleep
}

type displayState int

const (
	// displayStateUnknown: the platform cannot report display power (anything
	// but macOS with cgo). Callers behave exactly as before #10874.
	displayStateUnknown displayState = iota
	// displayStateAbsent: nothing is attached, so there is nothing to wake.
	displayStateAbsent
	// displayStateAsleep: a display is attached but asleep or not drawable.
	displayStateAsleep
	// displayStateAwake: every attached display is drawable.
	displayStateAwake
)

func (s displayState) String() string {
	switch s {
	case displayStateAbsent:
		return "absent"
	case displayStateAsleep:
		return "asleep"
	case displayStateAwake:
		return "awake"
	default:
		return "unknown"
	}
}

// classifyDisplays maps a reading to a state. Asleep means nothing is
// drawable, or every attached display reports asleep. One sleeping display
// beside an awake one is not asleep: a lid-closed MacBook keeps its panel
// online and asleep, user activity cannot wake it, and treating it as asleep
// would cost every session open the whole wake budget.
func classifyDisplays(c displayCounts) displayState {
	switch {
	case c.online <= 0:
		return displayStateAbsent
	case c.active <= 0 || c.asleep >= c.online:
		return displayStateAsleep
	default:
		return displayStateAwake
	}
}

// errDisplayPowerUnsupported is returned by the no-op ops on platforms that
// have no display-power control. It is expected there and never logged.
var errDisplayPowerUnsupported = errors.New("display power control is not supported on this platform")

// displayPowerOps is the seam over IOKit power management and the
// CoreGraphics display lists. Tests swap in a fake; no test calls IOKit.
type displayPowerOps interface {
	// counts reads the display lists. ok is false when the platform cannot.
	counts() (c displayCounts, ok bool)
	// declareUserActivity wakes a sleeping display and restarts its idle
	// timer (IOPMAssertionDeclareUserActivity, kIOPMUserActiveLocal — what
	// `caffeinate -u` does).
	declareUserActivity() error
	// preventDisplaySleep takes a kIOPMAssertionTypePreventUserIdleDisplaySleep
	// assertion and returns its release.
	preventDisplaySleep() (release func() error, err error)
}

// displayPower is the platform implementation (newPlatformDisplayPower).
var displayPower displayPowerOps = newPlatformDisplayPower()

func readDisplayState(ops displayPowerOps) (displayState, displayCounts) {
	if ops == nil {
		return displayStateUnknown, displayCounts{}
	}
	c, ok := ops.counts()
	if !ok {
		return displayStateUnknown, displayCounts{}
	}
	return classifyDisplays(c), c
}

// Wake budget: how long a capture open waits for a sleeping display to come
// back after declaring user activity. A display normally lights in 1-2 s.
const (
	displayWakeTimeout      = 3 * time.Second
	displayWakePollInterval = 250 * time.Millisecond
)

// displayWaker opens a capturer, waking a sleeping display first and naming
// the display state in the error when the open still fails.
type displayWaker struct {
	ops     displayPowerOps
	sleep   func(time.Duration)
	timeout time.Duration
	poll    time.Duration
}

func defaultDisplayWaker() displayWaker {
	return displayWaker{
		ops:     displayPower,
		sleep:   time.Sleep,
		timeout: displayWakeTimeout,
		poll:    displayWakePollInterval,
	}
}

// openSessionCapturer is NewScreenCapturer for a desktop session: it wakes a
// sleeping display before opening and reports which display case a failure
// was. Capability probes must keep calling NewScreenCapturer directly — a
// background re-probe must never switch a sleeping display on.
func openSessionCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return defaultDisplayWaker().open(func() (ScreenCapturer, error) {
		return NewScreenCapturer(config)
	})
}

// wake declares user activity and polls, within the budget, until the
// display is no longer asleep. It returns the last reading and the
// declaration's error: when the declaration itself failed, the display never
// had a chance to wake, and the error must say so.
func (w displayWaker) wake() (displayState, displayCounts, error) {
	declareErr := w.ops.declareUserActivity()
	if errors.Is(declareErr, errDisplayPowerUnsupported) {
		declareErr = nil
	}
	if declareErr != nil {
		slog.Warn("could not declare user activity to wake the display", "error", declareErr.Error())
	}
	state, c := readDisplayState(w.ops)
	for waited := time.Duration(0); state == displayStateAsleep && waited < w.timeout; waited += w.poll {
		w.sleep(w.poll)
		state, c = readDisplayState(w.ops)
	}
	return state, c, declareErr
}

func (w displayWaker) open(open func() (ScreenCapturer, error)) (ScreenCapturer, error) {
	state, c := readDisplayState(w.ops)
	waited := false
	var wakeErr error
	if state == displayStateAsleep {
		slog.Info("display is asleep; declaring user activity before capture",
			"online", c.online, "active", c.active, "asleep", c.asleep)
		state, c, wakeErr = w.wake()
		waited = true
		slog.Info("display wake finished", "state", state.String(),
			"online", c.online, "active", c.active, "asleep", c.asleep)
	}

	capturer, err := open()
	if err == nil {
		return capturer, nil
	}

	state, c = readDisplayState(w.ops)
	if state == displayStateAsleep && !waited {
		// Awake at the check, asleep by the open: the display went off in
		// between. Wake it and try once more.
		slog.Info("capture open failed with the display asleep; waking it and retrying",
			"error", err.Error(), "online", c.online, "active", c.active, "asleep", c.asleep)
		state, c, wakeErr = w.wake()
		if state == displayStateAwake {
			capturer, retryErr := open()
			if retryErr == nil {
				return capturer, nil
			}
			err = retryErr
			state, c = readDisplayState(w.ops)
		}
	}
	return nil, describeDisplayStateError(err, state, c, wakeErr)
}

// displayStatePhrase is the technician-facing description of a display state
// that explains a zero-displays failure, or "" for a state that does not.
// wakeErr is the user-activity declaration's failure, if it failed.
func displayStatePhrase(state displayState, c displayCounts, wakeErr error) string {
	switch state {
	case displayStateAbsent:
		return "no display is attached (0 online); on a headless Mac this is normal once a Screen Sharing " +
			"session ends, attach a display or a dummy plug"
	case displayStateAsleep:
		if wakeErr != nil {
			return fmt.Sprintf("a display is attached but asleep (%d online, %d asleep, %d active) and could not "+
				"be woken (%v). Not a headless Mac", c.online, c.asleep, c.active, wakeErr)
		}
		return fmt.Sprintf("a display is attached but asleep (%d online, %d asleep, %d active) and did not wake "+
			"when Breeze declared user activity. Not a headless Mac", c.online, c.asleep, c.active)
	default:
		return ""
	}
}

// describeDisplayStateError prefixes a zero-displays error with the display
// case, so the viewer reads which one it was. Any other error — a permission
// denial, a ScreenCaptureKit refusal — is returned unchanged even when the
// display happens to be asleep: the display state does not explain it, and
// labelling it would send the technician the wrong way. The case comes first
// so a truncated viewer message still carries it.
func describeDisplayStateError(err error, state displayState, c displayCounts, wakeErr error) error {
	if err == nil || !errors.Is(err, errZeroDisplays) {
		return err
	}
	phrase := displayStatePhrase(state, c, wakeErr)
	if phrase == "" {
		return err
	}
	return fmt.Errorf("%s: %w", phrase, err)
}

// describeCurrentDisplayState annotates err with a fresh reading, without
// waking anything. The ScreenCaptureKit stream restart uses it.
func describeCurrentDisplayState(ops displayPowerOps, err error) error {
	if err == nil || !errors.Is(err, errZeroDisplays) {
		return err
	}
	state, c := readDisplayState(ops)
	return describeDisplayStateError(err, state, c, nil)
}

// declareForStreamRestart wakes the display before a capture stream is
// rebuilt mid-session. It is reached only from a stream restart, which only a
// live session's capturer performs: capability probes capture one frame and
// close, so they never get here and never light a sleeping display.
func declareForStreamRestart(ops displayPowerOps) {
	if ops == nil {
		return
	}
	if err := ops.declareUserActivity(); err != nil && !errors.Is(err, errDisplayPowerUnsupported) {
		slog.Warn("could not declare user activity before restarting the capture stream", "error", err.Error())
	}
}

// displayStopReason words a display state as the no-video watchdog's stop
// reason, or "" for a state that does not explain the outage. Unlike
// displayStatePhrase it makes no claim about permissions: the watchdog does
// not know which capture error it is ending on.
func displayStopReason(state displayState, c displayCounts) string {
	var reason string
	switch state {
	case displayStateAbsent:
		reason = "screen capture stopped: no display is attached (0 online); on a headless Mac attach a display or a dummy plug"
	case displayStateAsleep:
		reason = fmt.Sprintf("screen capture stopped: the display went to sleep (%d online, %d asleep, %d active) "+
			"and did not wake for the session. Not a headless Mac", c.online, c.asleep, c.active)
	default:
		return ""
	}
	if len(reason) > maxStopReasonBytes {
		reason = reason[:maxStopReasonBytes]
	}
	return reason
}

// displayWakeHold keeps the display on for one desktop session: a
// PreventUserIdleDisplaySleep assertion from acquire to release, and a user
// activity declaration on acquire and on every nudge. It never fails a
// session: an assertion that cannot be taken is logged and the session runs
// as it did before #10874.
type displayWakeHold struct {
	ops       displayPowerOps
	sessionID string

	mu        sync.Mutex
	releaseFn func() error
	released  bool
	// observed is the display state read by the latest nudge, before it
	// declared activity: what the display was doing when a capture restart
	// was needed. The watchdog's stop reason reads it, because by the time
	// the watchdog gives up its own nudges may have lit the display again.
	observed       displayState
	observedCounts displayCounts
}

func acquireDisplayWakeHold(ops displayPowerOps, sessionID string) *displayWakeHold {
	h := &displayWakeHold{ops: ops, sessionID: sessionID}
	if ops == nil {
		return h
	}
	h.nudge()
	release, err := ops.preventDisplaySleep()
	if err != nil {
		if !errors.Is(err, errDisplayPowerUnsupported) {
			slog.Warn("could not hold the display awake for the desktop session; a locked Mac may switch its display off mid-session",
				"session", sessionID, "error", err.Error())
		}
		return h
	}
	h.releaseFn = release
	slog.Info("holding the display awake for the desktop session", "session", sessionID)
	return h
}

// nudge declares user activity: before a capture restart, so a display that
// went off anyway is woken for the new stream.
func (h *displayWakeHold) nudge() {
	if h == nil || h.ops == nil {
		return
	}
	state, c := readDisplayState(h.ops)
	h.mu.Lock()
	released := h.released
	if !released {
		h.observed, h.observedCounts = state, c
	}
	h.mu.Unlock()
	if released {
		return
	}
	if err := h.ops.declareUserActivity(); err != nil && !errors.Is(err, errDisplayPowerUnsupported) {
		slog.Warn("could not declare user activity to wake the display",
			"session", h.sessionID, "error", err.Error())
	}
}

// stopReason is the no-video watchdog's reason when the display state seen
// at the latest capture restart explains the outage, else a fresh reading's,
// else "". Nil-safe: a session without a hold reads the display directly.
func (h *displayWakeHold) stopReason(ops displayPowerOps) string {
	if h != nil {
		h.mu.Lock()
		state, c := h.observed, h.observedCounts
		h.mu.Unlock()
		if reason := displayStopReason(state, c); reason != "" {
			return reason
		}
	}
	state, c := readDisplayState(ops)
	return displayStopReason(state, c)
}

// release drops the assertion. Idempotent and nil-safe.
func (h *displayWakeHold) release() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.released {
		return
	}
	h.released = true
	if h.releaseFn == nil {
		return
	}
	if err := h.releaseFn(); err != nil {
		slog.Warn("could not release the display-sleep assertion", "session", h.sessionID, "error", err.Error())
	} else {
		slog.Info("released the display-sleep assertion", "session", h.sessionID)
	}
	h.releaseFn = nil
}
