package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// maxHardwareRestoreAttempts bounds how many times a session will try to swap a
// software-fallback encoder back to hardware before giving up for the rest of
// the session. Without a cap, a hardware encoder that is genuinely broken on a
// given machine would thrash between hardware (stall) and software every backoff
// interval, producing a visible glitch each cycle.
const maxHardwareRestoreAttempts = 3

// hardwareRestoreBackoff returns how long to wait before the Nth restore attempt
// (1-based). The interval grows so a flaky hardware encoder is retried promptly
// once but backs off quickly if it keeps failing.
func hardwareRestoreBackoff(attempt int) time.Duration {
	switch {
	case attempt <= 1:
		return 5 * time.Second
	case attempt == 2:
		return 15 * time.Second
	default:
		return 45 * time.Second
	}
}

// hardwareRestorePolicy is a pure state machine governing when a session that
// fell back to a software encoder should retry restoring the hardware encoder.
//
// On macOS, VideoToolbox can stall on the first frame(s) of a large (5K) capture
// and get demoted to OpenH264 software encoding (see swapToSoftwareEncoder).
// Software-encoding a 5120x2880 frame pins a CPU core, so we periodically try to
// restore VideoToolbox instead of latching software for the whole session. The
// scheduling/cap logic lives here (and is unit tested) while the encoder rebuild
// itself lives in Session.maybeRestoreHardwareEncoder.
//
// A restore attempt no longer swaps the live encoder straight away (#10880): the
// candidate is warmed up off the live path and swapped in only once it has
// returned an encoded frame (see session_encoder_warmup.go). The policy tracks
// that in-flight warm-up and, on failure, decides between backing off and
// giving up for the session.
//
// Owned by the capture-loop goroutine; like reattachWatchdog it uses no atomics
// or locks and must not be driven concurrently. The warm-up goroutine never
// touches it: its result comes back over Session.hwWarmupCh and the capture
// loop applies it here.
type hardwareRestorePolicy struct {
	demoted  bool
	attempts int
	nextAt   time.Time
	// warming is true while a restore candidate is warming up; no further
	// attempt starts until its result has been applied.
	warming bool
	// hardwareProducedOutput records whether any hardware encoder returned an
	// encoded frame in this session. A failed warm-up on a session where
	// hardware never produced anything means this machine's hardware encoder
	// does not work at this resolution, so the policy gives up immediately.
	hardwareProducedOutput bool
}

// onDemotedFromHardware arms the policy after a hardware->software swap. The
// attempt counter is intentionally preserved across re-demotions so the total
// number of restore attempts per session stays bounded even if hardware keeps
// stalling immediately after each successful restore.
func (p *hardwareRestorePolicy) onDemotedFromHardware(now time.Time) {
	p.demoted = true
	p.nextAt = now.Add(hardwareRestoreBackoff(p.attempts + 1))
}

// shouldAttempt reports whether a restore attempt is due now.
func (p *hardwareRestorePolicy) shouldAttempt(now time.Time) bool {
	return p.demoted && !p.warming && p.attempts < maxHardwareRestoreAttempts && !now.Before(p.nextAt)
}

// recordAttempt counts a restore attempt and schedules the next backoff window.
// Call immediately before performing the rebuild.
func (p *hardwareRestorePolicy) recordAttempt(now time.Time) {
	p.attempts++
	p.nextAt = now.Add(hardwareRestoreBackoff(p.attempts + 1))
}

// onRestored clears the demoted flag after a successful restore to hardware. The
// attempt counter is preserved so a subsequent re-demotion remains capped.
func (p *hardwareRestorePolicy) onRestored() {
	p.demoted = false
}

// giveUp permanently stops restore attempts (e.g. the machine has no usable
// hardware encoder).
func (p *hardwareRestorePolicy) giveUp() {
	p.attempts = maxHardwareRestoreAttempts
}

// noteHardwareOutput records that a hardware encoder returned an encoded frame
// in this session. Called by the capture path on every hardware output; it only
// flips a bool, so it is cheap enough for the per-frame path.
func (p *hardwareRestorePolicy) noteHardwareOutput() {
	p.hardwareProducedOutput = true
}

// onWarmupStarted counts a restore attempt whose candidate is now warming up
// off the live path, and blocks further attempts until its result is applied.
func (p *hardwareRestorePolicy) onWarmupStarted(now time.Time) {
	p.recordAttempt(now)
	p.warming = true
}

// onWarmupSucceeded applies a warm-up that proved the candidate (it is being
// swapped in), disarming the policy like onRestored.
func (p *hardwareRestorePolicy) onWarmupSucceeded() {
	p.warming = false
	p.onRestored()
}

// onWarmupFailed applies a warm-up whose candidate never produced a frame. If
// no hardware encoder has produced output in this session either — it stalled
// at startup and failed again off the live path — retrying is pointless, so the
// policy gives up and reports true so the caller can remember the verdict
// beyond this session. Otherwise the next attempt waits for the backoff that
// onWarmupStarted already scheduled.
func (p *hardwareRestorePolicy) onWarmupFailed() (gaveUp bool) {
	p.warming = false
	if !p.hardwareProducedOutput {
		p.giveUp()
		return true
	}
	return false
}

// onWarmupInconclusive applies a warm-up whose outcome says nothing about the
// hardware (e.g. the display resolution changed while it ran). The attempt
// stays counted and the next one waits for the scheduled backoff.
func (p *hardwareRestorePolicy) onWarmupInconclusive() {
	p.warming = false
}

// maybeRestoreHardwareEncoder periodically tries to swap a software-fallback
// encoder back to a hardware one (VideoToolbox on macOS). It is the CPU-capture
// counterpart to restoreHardwareEncoder, which is DXGI/TextureProvider-specific
// and event-driven (fires on a Windows secure-desktop->Default transition); this
// path is timer/backoff-driven instead. The macOS ticker capture path has no
// D3D11 device to bind, so we only accept a hardware backend that consumes CPU
// pixels (a non-GPU-only encoder, i.e. VideoToolbox).
//
// The candidate is never swapped in unproven (#10880): it is handed to a
// warm-up goroutine, and the live software encoder keeps streaming until a later
// tick collects a result showing the candidate returned an encoded frame. A
// candidate that never does is discarded without touching the live encoder.
//
// Must be called from the capture loop goroutine (same as swapToSoftwareEncoder).
func (s *Session) maybeRestoreHardwareEncoder(now time.Time) {
	if s.hwWarmupCh != nil {
		s.pollHardwareWarmup()
		return
	}
	if !s.hwRestore.shouldAttempt(now) {
		return
	}
	enc := s.encoder.Load()
	if enc == nil || enc.BackendIsHardware() {
		// Nothing to restore (already on hardware, or no encoder yet).
		s.hwRestore.onRestored()
		return
	}

	var w, h int
	if c := s.capturer; c != nil {
		if bw, bh, err := c.GetScreenBounds(); err == nil {
			w, h = bw, bh
		}
	}
	if w == 0 || h == 0 {
		// Capturer has no bounds yet (nil or a transient GetScreenBounds error).
		// recordAttempt advances the backoff, so this won't tight-loop; log so a
		// session that never recovers hardware is diagnosable.
		s.hwRestore.recordAttempt(now)
		slog.Info("maybeRestoreHardwareEncoder: no screen bounds yet, staying on software",
			"session", s.id, "attempt", s.hwRestore.attempts)
		return
	}

	if hardwareEncoderKnownDead(w, h) {
		// A session in this helper process proved, within the verdict TTL, that
		// the hardware encoder produces nothing at this resolution.
		s.hwRestore.giveUp()
		slog.Info("maybeRestoreHardwareEncoder: hardware encoder known to produce no frames at this resolution, staying on software",
			"session", s.id, "dimensions", fmt.Sprintf("%dx%d", w, h))
		return
	}

	fps := s.getFPS()
	if fps <= 0 {
		fps = 30
	}
	newEnc, err := newHardwareRestoreCandidate(EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        2_500_000,
		FPS:            fps,
		PreferHardware: true,
		GPUVendor:      s.gpuVendor,
	})
	if err != nil {
		s.hwRestore.recordAttempt(now)
		slog.Info("maybeRestoreHardwareEncoder: factory failed, staying on software",
			"session", s.id, "attempt", s.hwRestore.attempts, "error", err.Error())
		return
	}

	// The CPU capture path has no TextureProvider/D3D11 device to bind, so a
	// GPU-only hardware encoder (MFT/AMF/NVENC) can't run here — IsGPUOnly()
	// reports those (SupportsGPUInput() is false until a device is bound, so it
	// would wrongly accept them). Only an encoder that consumes CPU pixels and is
	// truly hardware (VideoToolbox) qualifies. The factory result is deterministic
	// for this machine, so if we don't get a usable backend, stop retrying.
	// (Read name/flags before Close(), which nils the backend.)
	backendName := newEnc.BackendName()
	placeholder := newEnc.BackendIsPlaceholder()
	isHardware := newEnc.BackendIsHardware()
	gpuOnly := newEnc.IsGPUOnly()
	if placeholder || !isHardware || gpuOnly {
		_ = newEnc.Close()
		slog.Info("maybeRestoreHardwareEncoder: no CPU-input hardware encoder available, staying on software permanently",
			"session", s.id, "backend", backendName,
			"placeholder", placeholder, "hardware", isHardware, "gpuOnly", gpuOnly)
		s.hwRestore.giveUp()
		return
	}

	// Hand the candidate to the warm-up goroutine. It owns the candidate until
	// it hands a proven one back on the channel (or discards it), so nothing
	// here touches newEnc again. SetDimensions — which creates the VideoToolbox
	// session — also runs there, keeping all hardware calls off the capture loop.
	s.hwRestore.onWarmupStarted(now)
	ch := make(chan hardwareWarmupResult)
	cancel := make(chan struct{})
	s.hwWarmupCh = ch
	s.hwWarmupCancel = cancel
	slog.Info("Warming up hardware encoder off the live path before restoring it",
		"session", s.id, "backend", backendName, "attempt", s.hwRestore.attempts,
		"dimensions", fmt.Sprintf("%dx%d", w, h), "budget", hardwareWarmupBudget)
	go runHardwareWarmup(newEnc, w, h, s.encoderPF, hardwareWarmupBudget, hardwareWarmupRetryGap, s.done, cancel, ch)
}

// pollHardwareWarmup collects the in-flight warm-up result, if one is ready,
// without blocking the capture loop.
func (s *Session) pollHardwareWarmup() {
	select {
	case res := <-s.hwWarmupCh:
		s.hwWarmupCh = nil
		s.hwWarmupCancel = nil
		s.applyHardwareWarmup(res)
	default:
	}
}

// abandonHardwareWarmup cancels an in-flight warm-up whose result this loop will
// not collect (the capture loop is leaving ticker mode). The goroutine closes
// the candidate itself; the attempt stays counted, with no verdict.
// Capture-loop goroutine only.
func (s *Session) abandonHardwareWarmup() {
	if s.hwWarmupCh == nil {
		return
	}
	close(s.hwWarmupCancel)
	s.hwWarmupCh = nil
	s.hwWarmupCancel = nil
	s.hwRestore.onWarmupInconclusive()
	slog.Info("Abandoned hardware encoder warm-up: capture loop left ticker mode", "session", s.id)
}

// applyHardwareWarmup acts on a collected warm-up result: swap a proven
// candidate in, or record the failure. Capture-loop goroutine only.
func (s *Session) applyHardwareWarmup(res hardwareWarmupResult) {
	dims := fmt.Sprintf("%dx%d", res.width, res.height)
	if errors.Is(res.err, errHardwareWarmupCanceled) {
		// The session is ending; the outcome says nothing about the hardware.
		s.hwRestore.onWarmupInconclusive()
		return
	}
	if res.err != nil {
		// The goroutine already closed the candidate; the live encoder was
		// never touched.
		logArgs := []any{"session", s.id, "dimensions", dims, "attempt", s.hwRestore.attempts,
			"warmupFrames", res.frames, "warmupElapsed", res.elapsed.Round(time.Millisecond),
			"error", res.err.Error()}
		if !s.hwRestore.onWarmupFailed() {
			if s.hwRestore.attempts >= maxHardwareRestoreAttempts {
				slog.Warn("Hardware encoder warm-up failed; restore attempts exhausted, staying on software for this session", logArgs...)
				return
			}
			slog.Info("Hardware encoder warm-up failed, staying on software", logArgs...)
			return
		}
		// Hardware never produced a frame this session and failed again off the
		// live path. Only remember it beyond this session when the warm-up
		// actually fed the encoder and got nothing back; a session-creation
		// failure may be transient and is not proof the encoder is dead.
		if errors.Is(res.err, errHardwareWarmupNoOutput) {
			rememberHardwareEncoderDead(res.width, res.height)
			slog.Warn("Hardware encoder produced no frames at startup or during warm-up; staying on software for this session, and later sessions at this resolution start on software until the verdict expires",
				append(logArgs, "verdictTTL", hardwareEncoderVerdictTTL)...)
			return
		}
		slog.Warn("Hardware encoder produced no frames at startup and its warm-up could not start; staying on software for this session", logArgs...)
		return
	}

	newEnc := res.enc
	cur := s.encoder.Load()
	if cur == nil || cur.BackendIsHardware() {
		// Something else restored hardware (or the session has no encoder)
		// while the candidate warmed up; it is no longer needed.
		_ = newEnc.Close()
		s.hwRestore.onWarmupSucceeded()
		return
	}

	var w, h int
	if c := s.capturer; c != nil {
		if bw, bh, err := c.GetScreenBounds(); err == nil {
			w, h = bw, bh
		}
	}
	if w != res.width || h != res.height {
		// The display changed while the candidate warmed up, so it was proven
		// at the wrong size. Discard it; the next attempt uses the new size.
		_ = newEnc.Close()
		s.hwRestore.onWarmupInconclusive()
		slog.Info("Hardware encoder warm-up finished after a resolution change, discarding candidate",
			"session", s.id, "warmedDimensions", dims,
			"currentDimensions", fmt.Sprintf("%dx%d", w, h), "attempt", s.hwRestore.attempts)
		return
	}

	// Re-apply the live pixel format and frame rate: either may have changed
	// during the warm-up.
	newEnc.SetPixelFormat(s.encoderPF)
	if err := newEnc.SetFPS(s.getFPS()); err != nil {
		slog.Warn("maybeRestoreHardwareEncoder: SetFPS on restored encoder failed",
			"session", s.id, "error", err.Error())
	}

	s.atomicEncoderSwap(newEnc)
	s.gpuEncodeErrors = 0

	// Lift the software bitrate cap — hardware sustains much higher rates.
	// Mirror the resolution-based ceiling used in StartSession.
	if s.adaptive != nil {
		s.adaptive.SetEncoder(newEnc)
		s.adaptive.SetMaxBitrate(resolutionBitrateCeiling(w, h))
	}

	s.hwRestore.onWarmupSucceeded()
	if err := newEnc.ForceKeyframe(); err != nil {
		slog.Warn("maybeRestoreHardwareEncoder: ForceKeyframe on restored encoder failed",
			"session", s.id, "error", err.Error())
	}
	slog.Info("Restored hardware encoder after software fallback",
		"session", s.id,
		"backend", newEnc.BackendName(),
		"attempt", s.hwRestore.attempts,
		"warmupFrames", res.frames,
		"warmupElapsed", res.elapsed.Round(time.Millisecond),
		"dimensions", dims)
}
