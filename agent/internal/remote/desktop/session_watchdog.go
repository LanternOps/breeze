package desktop

import (
	"fmt"
	"log/slog"
	"time"
)

// Watchdog escalation thresholds. see reattachCooldown in session_capture.go
// for the wall-clock mapping from counts to elapsed time.
const (
	watchdogEscalateAfter  int32 = 3
	watchdogTerminateAfter int32 = 5
)

// reattachWatchdog tracks consecutive failed ForceReattach attempts.
// Lives on the stack of the capture goroutine — only the pinned capture
// goroutine reads or writes it, so plain int32 (no atomics) is safe.
type reattachWatchdog struct {
	lastAttempt    time.Time
	lastVideoNanos int64
	failures       int32
}

// evaluate is called when the capture loop is about to attempt another
// ForceReattach. Returns true when the retry budget is exhausted and the
// caller should terminate the session.
func (w *reattachWatchdog) evaluate(sessionID string, currentVideoNanos int64) bool {
	if w.lastAttempt.IsZero() {
		// First attempt — no prior snapshot to compare against.
		return false
	}
	if currentVideoNanos > w.lastVideoNanos {
		// Video advanced since last attempt — reattach worked.
		prev := w.failures
		w.failures = 0
		if prev >= watchdogEscalateAfter {
			slog.Info("desktop watchdog: reattach recovered",
				"session", sessionID,
				"priorFailures", prev)
		}
		return false
	}
	w.failures++
	if w.failures == watchdogEscalateAfter {
		slog.Error("desktop watchdog: reattach failing, escalating",
			"session", sessionID,
			"failures", w.failures,
		)
	}
	if w.failures >= watchdogTerminateAfter {
		slog.Error("desktop watchdog: reattach exhausted, terminating session",
			"session", sessionID,
			"failures", w.failures,
		)
		return true
	}
	return false
}

// recordAttempt snapshots the current video timestamp so evaluate can detect
// whether video advanced between successive ForceReattach calls.
func (w *reattachWatchdog) recordAttempt(currentVideoNanos int64) {
	w.lastAttempt = time.Now()
	w.lastVideoNanos = currentVideoNanos
}

// videoStallKind says where frames stopped when no video has been written for
// longer than the no-video timeout (#10880). The watchdog used to treat every
// gap as a dead capturer and rebuild the capture stream (on macOS, the
// ScreenCaptureKit stream) even when the capturer was fine and the encoder had
// stopped returning frames.
type videoStallKind int

const (
	videoStallNone    videoStallKind = iota
	videoStallCapture                // the capturer delivered no frame within the timeout
	videoStallEncoder                // frames are captured, the encoder returns nothing
	videoStallSink                   // frames are captured and encoded, but none are written
)

func (k videoStallKind) String() string {
	switch k {
	case videoStallNone:
		return "none"
	case videoStallCapture:
		return "capture"
	case videoStallEncoder:
		return "encoder"
	case videoStallSink:
		return "sink"
	default:
		return fmt.Sprintf("videoStallKind(%d)", int(k))
	}
}

// classifyVideoStall decides whether video output is stalled and, if so, which
// stage stopped. Inputs are unix-nano timestamps (0 = never) of the last
// written sample (or idle heartbeat), the last frame the capturer delivered,
// and the last encoded output. A never-written session is left to the startup
// stall guard. A stage counts as alive if it did its part within timeout.
func classifyVideoStall(now time.Time, lastWrite, lastCapture, lastEncodeOutput int64, timeout time.Duration) videoStallKind {
	if lastWrite == 0 || now.Sub(time.Unix(0, lastWrite)) <= timeout {
		return videoStallNone
	}
	alive := func(ts int64) bool { return ts != 0 && now.Sub(time.Unix(0, ts)) <= timeout }
	switch {
	case !alive(lastCapture):
		return videoStallCapture
	case !alive(lastEncodeOutput):
		return videoStallEncoder
	default:
		return videoStallSink
	}
}

// noVideoAction is the ticker watchdog's response to a classified stall.
type noVideoAction int

const (
	noVideoActionNone          noVideoAction = iota
	noVideoActionReattach                    // re-attach the desktop / rebuild the capturer
	noVideoActionDemoteEncoder               // swap the stalled hardware encoder to software
	noVideoActionLogOnly                     // re-attaching would not help; just report it
)

func (a noVideoAction) String() string {
	switch a {
	case noVideoActionNone:
		return "none"
	case noVideoActionReattach:
		return "reattach"
	case noVideoActionDemoteEncoder:
		return "demote-encoder"
	case noVideoActionLogOnly:
		return "log-only"
	default:
		return fmt.Sprintf("noVideoAction(%d)", int(a))
	}
}

// decideNoVideoAction maps a stall to the remedy. Only a capture stall
// re-attaches the capturer. An encoder stall on hardware demotes the encoder
// (faster than waiting for the per-frame error strikes, each up to a 2s
// VideoToolbox timeout); on software there is nothing better to swap to.
//
// capturerOwnsEncoderDevice is true for D3D11 capturers (TextureProvider),
// whose encoder is bound to the capturer's device: there a re-attach also
// rebinds the encoder, which is the established recovery for a stale device
// after a Windows desktop switch, so those keep the old re-attach-on-any-stall
// behaviour.
func decideNoVideoAction(kind videoStallKind, capturerOwnsEncoderDevice, encoderIsHardware bool) noVideoAction {
	switch {
	case kind == videoStallNone:
		return noVideoActionNone
	case kind == videoStallCapture, capturerOwnsEncoderDevice:
		return noVideoActionReattach
	case kind == videoStallEncoder && encoderIsHardware:
		return noVideoActionDemoteEncoder
	default:
		return noVideoActionLogOnly
	}
}
