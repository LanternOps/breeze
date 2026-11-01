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

// classifyDisplays maps a reading to a state. Any sleeping display counts as
// asleep even when another is awake: the session may be targeting it, and a
// wake costs nothing when it was not.
func classifyDisplays(c displayCounts) displayState {
	switch {
	case c.online <= 0:
		return displayStateAbsent
	case c.asleep > 0 || c.active <= 0:
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

// wake declares user activity and polls, within the budget, until no display
// is asleep. It returns the last reading.
func (w displayWaker) wake() (displayState, displayCounts) {
	if err := w.ops.declareUserActivity(); err != nil && !errors.Is(err, errDisplayPowerUnsupported) {
		slog.Warn("could not declare user activity to wake the display", "error", err.Error())
	}
	state, c := readDisplayState(w.ops)
	for waited := time.Duration(0); state == displayStateAsleep && waited < w.timeout; waited += w.poll {
		w.sleep(w.poll)
		state, c = readDisplayState(w.ops)
	}
	return state, c
}

func (w displayWaker) open(open func() (ScreenCapturer, error)) (ScreenCapturer, error) {
	state, c := readDisplayState(w.ops)
	waited := false
	if state == displayStateAsleep {
		slog.Info("display is asleep; declaring user activity before capture",
			"online", c.online, "active", c.active, "asleep", c.asleep)
		state, c = w.wake()
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
		state, c = w.wake()
		if state == displayStateAwake {
			capturer, retryErr := open()
			if retryErr == nil {
				return capturer, nil
			}
			err = retryErr
			state, c = readDisplayState(w.ops)
		}
	}
	return nil, describeDisplayStateError(err, state, c)
}

// displayStatePhrase is the technician-facing description of a display state
// that explains a capture failure, or "" for a state that does not.
func displayStatePhrase(state displayState, c displayCounts) string {
	switch state {
	case displayStateAbsent:
		return "no display is attached (0 online); on a headless Mac this is normal once a Screen Sharing " +
			"session ends, attach a display or a dummy plug. Not a permissions failure"
	case displayStateAsleep:
		return fmt.Sprintf("a display is attached but asleep (%d online, %d asleep, %d active) and did not wake "+
			"when Breeze declared user activity. Not a headless Mac, not a permissions failure",
			c.online, c.asleep, c.active)
	default:
		return ""
	}
}

// describeDisplayStateError prefixes err with the display case when the
// display state explains the failure, and returns err unchanged otherwise.
// The case comes first so a truncated viewer message still carries it.
func describeDisplayStateError(err error, state displayState, c displayCounts) error {
	if err == nil {
		return nil
	}
	phrase := displayStatePhrase(state, c)
	if phrase == "" {
		return err
	}
	return fmt.Errorf("%s: %w", phrase, err)
}

// displayStateStopReason is the no-video watchdog's reason when the display
// state explains the outage, or "".
func displayStateStopReason(ops displayPowerOps) string {
	state, c := readDisplayState(ops)
	phrase := displayStatePhrase(state, c)
	if phrase == "" {
		return ""
	}
	reason := "screen capture stopped: " + phrase
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
	h.mu.Lock()
	released := h.released
	h.mu.Unlock()
	if released {
		return
	}
	if err := h.ops.declareUserActivity(); err != nil && !errors.Is(err, errDisplayPowerUnsupported) {
		slog.Warn("could not declare user activity to wake the display",
			"session", h.sessionID, "error", err.Error())
	}
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
