package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Warm-up before swap (#10880).
//
// On some Intel Macs VideoToolbox creates a session but never returns an encoded
// frame: every Encode times out after 2s. The old restore path swapped such an
// encoder straight into the live session, so each restore attempt froze the
// viewer for ~10s until the stall detector demoted it again. A restore
// candidate is now warmed up first, on its own goroutine, and swapped in only
// after it has returned an encoded frame.
//
// Why a goroutine rather than an inline warm-up on the capture loop: a dead
// VideoToolbox encoder blocks each Encode for its full 2s timeout, so even a
// one-frame inline probe would freeze the live stream for 2s per attempt. The
// goroutine owns the candidate exclusively until the handoff; the capture loop
// polls for the result without blocking (Session.pollHardwareWarmup) and stays
// the only writer of hardwareRestorePolicy, so the policy keeps its no-locks
// ownership rule.
//
// The warm-up encodes a synthetic frame instead of copying live captures: it
// needs no plumbing into the capture path, works on a static screen (where the
// frame differ would starve it of frames), and only has to show that the
// encoder emits output at this resolution. The keyframe queued on success makes
// the first live frame after the swap an IDR, so no decoder ever references the
// synthetic content.

// hardwareWarmupBudget bounds how long a candidate may take to return its first
// encoded frame. Nothing waits on it (the live encoder keeps streaming), so it
// can be generous: long enough for a slow cold start like the 5K first-frame
// stall in #1292, which recovered after the first frame(s); a dead encoder
// uses it up in two or three 2s Encode timeouts. Variable so tests can shorten it.
var hardwareWarmupBudget = 6 * time.Second

// hardwareWarmupRetryGap spaces Encode calls that returned quickly without
// output, so a buffering encoder isn't spun in a tight loop.
var hardwareWarmupRetryGap = 33 * time.Millisecond

// newHardwareRestoreCandidate builds the encoder a restore attempt warms up.
// Variable so tests can substitute a scripted backend for VideoToolbox.
var newHardwareRestoreCandidate = NewVideoEncoder

var errHardwareWarmupCanceled = errors.New("session ended during hardware encoder warm-up")

// errHardwareWarmupNoOutput marks a warm-up whose encoder accepted frames but
// never returned one within the budget — the only failure that proves the
// hardware encoder dead at this resolution. A session-creation failure is
// reported without it.
var errHardwareWarmupNoOutput = errors.New("no encoded frame within the warm-up budget")

// hardwareWarmupResult is what the warm-up goroutine hands the capture loop. On
// success enc is the proven candidate and ownership passes to the receiver; on
// failure enc is nil (already closed) and err says why.
type hardwareWarmupResult struct {
	enc           *VideoEncoder
	width, height int
	frames        int // Encode calls made
	elapsed       time.Duration
	err           error
}

// runHardwareWarmup warms enc up and hands the result to the capture loop over
// out (unbuffered, so ownership changes hands only when the loop receives). If
// the session ends (done) or the loop abandons the warm-up (cancel) first, it
// closes a proven candidate itself rather than leaking it. It touches no
// Session state.
func runHardwareWarmup(enc *VideoEncoder, w, h int, pf PixelFormat, budget, retryGap time.Duration, done, cancel <-chan struct{}, out chan<- hardwareWarmupResult) {
	res := warmUpHardwareEncoder(enc, w, h, pf, budget, retryGap, done, cancel)
	select {
	case out <- res:
	case <-done:
		if res.enc != nil {
			res.enc.Close()
		}
	case <-cancel:
		if res.enc != nil {
			res.enc.Close()
		}
	}
}

// warmUpHardwareEncoder sizes enc for w x h and encodes a synthetic frame until
// it returns encoded data or the budget runs out. On success it queues a
// keyframe and returns enc; on any failure (including done or cancel closing)
// it closes enc and returns the error. A nil cancel never fires.
func warmUpHardwareEncoder(enc *VideoEncoder, w, h int, pf PixelFormat, budget, retryGap time.Duration, done, cancel <-chan struct{}) hardwareWarmupResult {
	start := time.Now()
	res := hardwareWarmupResult{width: w, height: h}
	fail := func(err error) hardwareWarmupResult {
		enc.Close()
		res.elapsed = time.Since(start)
		res.err = err
		return res
	}

	if err := enc.SetDimensions(w, h); err != nil {
		return fail(fmt.Errorf("set dimensions: %w", err))
	}
	enc.SetPixelFormat(pf)

	// A black frame at the capture size (the encoder handles the even-rounding
	// exactly as it does for live frames).
	frame := make([]byte, w*h*4)
	deadline := start.Add(budget)
	var lastErr error
	for {
		select {
		case <-done:
			return fail(errHardwareWarmupCanceled)
		case <-cancel:
			return fail(errHardwareWarmupCanceled)
		default:
		}

		data, err := enc.Encode(frame)
		res.frames++
		if err == nil && len(data) > 0 {
			if kfErr := enc.ForceKeyframe(); kfErr != nil {
				// applyHardwareWarmup forces one again after the swap; log so
				// a P-frame against the synthetic frame is traceable.
				slog.Warn("Hardware encoder warm-up: ForceKeyframe failed", "error", kfErr.Error())
			}
			res.enc = enc
			res.elapsed = time.Since(start)
			return res
		}
		if err != nil {
			lastErr = err
		}

		if !time.Now().Before(deadline) {
			if lastErr == nil {
				lastErr = errors.New("encoder returned no output")
			}
			return fail(fmt.Errorf("%w (%v, %d encodes): %w", errHardwareWarmupNoOutput, budget, res.frames, lastErr))
		}
		select {
		case <-done:
			return fail(errHardwareWarmupCanceled)
		case <-cancel:
			return fail(errHardwareWarmupCanceled)
		case <-time.After(retryGap):
		}
	}
}

// Process-lifetime hardware-encoder verdicts.
//
// When a session's hardware encoder produced no frames at startup and a warm-up
// also failed, the resolution is recorded here so later sessions in the same
// helper process start straight on software instead of re-learning it with a
// 3s startup stall. Keyed by the encoder's even-rounded dimensions rather than
// global: VideoToolbox creates its session per resolution, and the #1292 stall
// was resolution-specific (cold 5K first frame), so one bad resolution must not
// disable hardware on the same Mac's other displays. On a machine whose encoder
// is dead everywhere, each distinct resolution costs one startup stall per
// helper lifetime. Not persisted: a helper restart (agent update, re-login)
// re-probes, which is what you want after an OS or driver update.
//
// Shared across sessions, so it has its own lock (unlike the per-session,
// capture-loop-owned hardwareRestorePolicy).

// maxHardwareEncoderVerdicts bounds the store; a helper sees a handful of
// resolutions at most, so hitting it means something is cycling sizes and the
// oldest verdicts are the least useful.
const maxHardwareEncoderVerdicts = 16

type encoderDims struct{ w, h int }

var hardwareEncoderVerdicts struct {
	mu    sync.Mutex
	dead  map[encoderDims]struct{}
	order []encoderDims
}

func verdictKey(w, h int) encoderDims { return encoderDims{w &^ 1, h &^ 1} }

// rememberHardwareEncoderDead records that the hardware encoder produced no
// frames at w x h for the rest of this process.
func rememberHardwareEncoderDead(w, h int) {
	if w <= 0 || h <= 0 {
		return
	}
	k := verdictKey(w, h)
	v := &hardwareEncoderVerdicts
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dead == nil {
		v.dead = make(map[encoderDims]struct{})
	}
	if _, ok := v.dead[k]; ok {
		return
	}
	if len(v.order) >= maxHardwareEncoderVerdicts {
		delete(v.dead, v.order[0])
		v.order = v.order[1:]
	}
	v.dead[k] = struct{}{}
	v.order = append(v.order, k)
}

// knownDeadHardwareForCPUCapture reports whether a new session on this
// capturer should skip the hardware encoder because an earlier session found it
// produces no frames at w x h. The verdict comes from the CPU-input restore
// path, so it never applies to D3D11 capturers (TextureProvider), whose
// zero-copy hardware path it never exercised.
func knownDeadHardwareForCPUCapture(capturer ScreenCapturer, w, h int) bool {
	if _, gpuCapture := capturer.(TextureProvider); gpuCapture {
		return false
	}
	return hardwareEncoderKnownDead(w, h)
}

// hardwareEncoderKnownDead reports whether a session in this process already
// found the hardware encoder produces no frames at w x h.
func hardwareEncoderKnownDead(w, h int) bool {
	if w <= 0 || h <= 0 {
		return false
	}
	v := &hardwareEncoderVerdicts
	v.mu.Lock()
	defer v.mu.Unlock()
	_, ok := v.dead[verdictKey(w, h)]
	return ok
}

func hardwareEncoderVerdictCount() int {
	v := &hardwareEncoderVerdicts
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.dead)
}

func resetHardwareEncoderVerdicts() {
	v := &hardwareEncoderVerdicts
	v.mu.Lock()
	defer v.mu.Unlock()
	v.dead = nil
	v.order = nil
}
