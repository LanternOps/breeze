package desktop

import (
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
// Owned by the capture-loop goroutine; like reattachWatchdog it uses no atomics
// or locks and must not be driven concurrently.
type hardwareRestorePolicy struct {
	demoted  bool
	attempts int
	nextAt   time.Time
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
	return p.demoted && p.attempts < maxHardwareRestoreAttempts && !now.Before(p.nextAt)
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

// maybeRestoreHardwareEncoder periodically tries to swap a software-fallback
// encoder back to a hardware one (VideoToolbox on macOS). It is the CPU-capture
// counterpart to restoreHardwareEncoder, which is DXGI/TextureProvider-specific
// and event-driven (fires on a Windows secure-desktop->Default transition); this
// path is timer/backoff-driven instead. The macOS ticker capture path has no
// D3D11 device to bind, so we only accept a hardware backend that consumes CPU
// pixels (a non-GPU-only encoder, i.e. VideoToolbox).
//
// Must be called from the capture loop goroutine (same as swapToSoftwareEncoder).
func (s *Session) maybeRestoreHardwareEncoder(now time.Time) {
	if !s.hwRestore.shouldAttempt(now) {
		return
	}
	enc := s.encoder.Load()
	if enc == nil || enc.BackendIsHardware() {
		// Nothing to restore (already on hardware, or no encoder yet).
		s.hwRestore.onRestored()
		return
	}

	s.hwRestore.recordAttempt(now)

	var w, h int
	if c := s.capturer; c != nil {
		if bw, bh, err := c.GetScreenBounds(); err == nil {
			w, h = bw, bh
		}
	}
	if w == 0 || h == 0 {
		// Capturer has no bounds yet (nil or a transient GetScreenBounds error).
		// recordAttempt already advanced the backoff, so this won't tight-loop;
		// log so a session that never recovers hardware is diagnosable.
		slog.Info("maybeRestoreHardwareEncoder: no screen bounds yet, staying on software",
			"session", s.id, "attempt", s.hwRestore.attempts)
		return
	}

	fps := s.getFPS()
	if fps <= 0 {
		fps = 30
	}
	newEnc, err := NewVideoEncoder(EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        2_500_000,
		FPS:            fps,
		PreferHardware: true,
		GPUVendor:      s.gpuVendor,
	})
	if err != nil {
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
		newEnc.Close()
		slog.Info("maybeRestoreHardwareEncoder: no CPU-input hardware encoder available, staying on software permanently",
			"session", s.id, "backend", backendName,
			"placeholder", placeholder, "hardware", isHardware, "gpuOnly", gpuOnly)
		s.hwRestore.giveUp()
		return
	}

	if err := newEnc.SetDimensions(w, h); err != nil {
		slog.Warn("maybeRestoreHardwareEncoder: SetDimensions failed, staying on software",
			"session", s.id, "attempt", s.hwRestore.attempts, "error", err.Error())
		newEnc.Close()
		return
	}
	newEnc.SetPixelFormat(s.encoderPF)

	s.atomicEncoderSwap(newEnc)
	s.gpuEncodeErrors = 0

	// Lift the software bitrate cap — hardware sustains much higher rates.
	// Mirror the resolution-based ceiling used in StartSession.
	if s.adaptive != nil {
		s.adaptive.SetEncoder(newEnc)
		hwMaxBitrate := 8_000_000
		if w*h > 1920*1080 {
			hwMaxBitrate = 15_000_000
		}
		s.adaptive.SetMaxBitrate(hwMaxBitrate)
	}

	s.hwRestore.onRestored()
	_ = newEnc.ForceKeyframe()
	slog.Info("Restored hardware encoder after software fallback",
		"session", s.id,
		"backend", newEnc.BackendName(),
		"attempt", s.hwRestore.attempts,
		"dimensions", fmt.Sprintf("%dx%d", w, h))
}
