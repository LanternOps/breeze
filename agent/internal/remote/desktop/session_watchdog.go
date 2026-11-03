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

// nonCaptureStallBudget bounds how long an encoder or sink stall may keep the
// viewer frozen. Re-attaching cannot fix those stalls, so they no longer go
// through reattachWatchdog, but a session whose video never recovers must still
// end with a reason (#5300) rather than stay open frozen. Owned by the capture
// goroutine, like reattachWatchdog.
type nonCaptureStallBudget struct {
	lastVideoNanos int64
	strikes        int32
}

// strike records one encoder/sink stall response and reports whether the
// budget is exhausted. Video advancing since the previous strike resets it.
// Strikes are spaced by the watchdog cooldown, so the default budget ends a
// session after roughly half a minute without video, like the re-attach path.
func (b *nonCaptureStallBudget) strike(currentVideoNanos int64) (exhausted bool) {
	if currentVideoNanos > b.lastVideoNanos {
		b.strikes = 0
	}
	b.lastVideoNanos = currentVideoNanos
	b.strikes++
	return b.strikes > watchdogTerminateAfter
}

// nonCaptureStallStopReason is the stop reason recorded when the stall budget
// runs out; it names the stage that stopped instead of blaming screen capture.
func nonCaptureStallStopReason(kind videoStallKind) string {
	if kind == videoStallSink {
		return "video frames could not be sent to the viewer and did not recover"
	}
	return "the video encoder stopped producing frames and did not recover"
}

// noVideoDecision classifies the current no-video state for the ticker
// watchdog and picks the response. Capture-loop goroutine only.
func (s *Session) noVideoDecision(now time.Time, timeout time.Duration) (videoStallKind, noVideoAction) {
	kind := classifyVideoStall(now, s.lastVideoWriteUnixNano.Load(),
		s.lastCaptureUnixNano.Load(), s.lastEncodeOutputUnixNano.Load(), timeout)
	if kind == videoStallNone {
		return kind, noVideoActionNone
	}
	s.mu.RLock()
	capturer := s.capturer
	s.mu.RUnlock()
	_, ownsDevice := capturer.(TextureProvider)
	enc := s.encoder.Load()
	return kind, decideNoVideoAction(kind, ownsDevice, enc != nil && enc.BackendIsHardware())
}

// handleNonCaptureStall responds to an encoder or sink stall without touching
// the capturer: a stalled hardware encoder is swapped to software, anything
// else is reported. It returns a non-empty stop reason once the stall budget
// is exhausted and the session should end. Capture-loop goroutine only.
func (s *Session) handleNonCaptureStall(kind videoStallKind, action noVideoAction, budget *nonCaptureStallBudget, lastWriteNanos int64, now time.Time) (stopReason string) {
	backend := ""
	if enc := s.encoder.Load(); enc != nil {
		backend = enc.BackendName()
	}
	sinceLastWrite := now.Sub(time.Unix(0, lastWriteNanos)).Round(time.Millisecond)
	if budget.strike(lastWriteNanos) {
		slog.Error("Capture watchdog (ticker): video stalled after capture and did not recover, ending session",
			"session", s.id, "stalledStage", kind.String(), "backend", backend,
			"strikes", budget.strikes, "sinceLastWrite", sinceLastWrite)
		return nonCaptureStallStopReason(kind)
	}
	switch {
	case action == noVideoActionDemoteEncoder:
		slog.Warn("Capture watchdog (ticker): hardware encoder stalled while the capturer delivers frames; swapping encoder to software instead of re-attaching capture",
			"session", s.id, "backend", backend, "sinceLastWrite", sinceLastWrite)
		s.swapToSoftwareEncoder()
	case kind == videoStallSink:
		slog.Warn("Capture watchdog (ticker): frames are captured and encoded but not written; not re-attaching capture",
			"session", s.id, "backend", backend, "strikes", budget.strikes, "sinceLastWrite", sinceLastWrite)
	default:
		slog.Warn("Capture watchdog (ticker): encoder stalled while the capturer delivers frames; not re-attaching capture",
			"session", s.id, "backend", backend, "strikes", budget.strikes, "sinceLastWrite", sinceLastWrite)
	}
	return ""
}
