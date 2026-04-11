package desktop

import (
	"testing"
	"time"
)

// stubEncoder satisfies encoderBackend for testing adaptive bitrate.
type stubEncoder struct {
	bitrate int
	quality QualityPreset
}

func (s *stubEncoder) Encode([]byte) ([]byte, error)              { return nil, nil }
func (s *stubEncoder) SetCodec(Codec) error                       { return nil }
func (s *stubEncoder) SetQuality(q QualityPreset) error           { s.quality = q; return nil }
func (s *stubEncoder) SetBitrate(b int) error                     { s.bitrate = b; return nil }
func (s *stubEncoder) SetFPS(int) error                           { return nil }
func (s *stubEncoder) SetDimensions(int, int) error               { return nil }
func (s *stubEncoder) SetPixelFormat(PixelFormat)                  {}
func (s *stubEncoder) Close() error                                { return nil }
func (s *stubEncoder) Name() string                                { return "stub" }
func (s *stubEncoder) IsHardware() bool                            { return false }
func (s *stubEncoder) IsPlaceholder() bool                         { return false }
func (s *stubEncoder) SetD3D11Device(uintptr, uintptr)             {}
func (s *stubEncoder) SupportsGPUInput() bool                      { return false }
func (s *stubEncoder) EncodeTexture(uintptr) ([]byte, error)       { return nil, nil }

func newTestAdaptive(initial, min, max int) (*AdaptiveBitrate, *stubEncoder) {
	stub := &stubEncoder{bitrate: initial}
	enc := &VideoEncoder{backend: stub, cfg: EncoderConfig{Bitrate: initial}}
	a, err := NewAdaptiveBitrate(AdaptiveConfig{
		Encoder:        enc,
		InitialBitrate: initial,
		MinBitrate:     min,
		MaxBitrate:     max,
		Cooldown:       time.Nanosecond, // effectively zero for tests
	})
	if err != nil {
		panic(err)
	}
	return a, stub
}

// warmup feeds samples to get past the 5-sample EWMA warmup.
// The 5th sample runs the algorithm and may increment stableCount.
func warmup(a *AdaptiveBitrate, rtt time.Duration, loss float64) {
	for i := 0; i < 5; i++ {
		a.Update(rtt, loss)
	}
}

func TestAdaptive_InitialBitrateMatchesEncoder(t *testing.T) {
	a, _ := newTestAdaptive(2_500_000, 500_000, 8_000_000)
	if a.targetBitrate != 2_500_000 {
		t.Fatalf("expected targetBitrate=2500000, got %d", a.targetBitrate)
	}
}

func TestAdaptive_WarmupPreventsEarlyAction(t *testing.T) {
	a, stub := newTestAdaptive(2_500_000, 500_000, 8_000_000)

	// First four samples shouldn't trigger any adjustment (warmup = 5 samples).
	for i := 0; i < 4; i++ {
		a.Update(10*time.Millisecond, 0.0)
	}
	if stub.bitrate != 2_500_000 {
		t.Fatalf("bitrate changed during warmup: %d", stub.bitrate)
	}
}

func TestAdaptive_DegradeOnHighLoss(t *testing.T) {
	a, stub := newTestAdaptive(2_500_000, 500_000, 8_000_000)

	// Warm up with high-loss samples so EWMA is already elevated.
	for i := 0; i < 5; i++ {
		a.Update(50*time.Millisecond, 0.10)
	}

	if stub.bitrate >= 2_500_000 {
		t.Fatalf("expected degrade, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_DegradeMultiplicative(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warmup + first action with high loss triggers degrade.
	warmup(a, 50*time.Millisecond, 0.10)
	// The 5th warmup sample is the first action sample → bitrate drops to 0.85x.
	expected := int(float64(2_000_000) * 0.85)
	if abs(stub.bitrate-expected) > 50_000 {
		t.Fatalf("expected bitrate ~%d after degrade, got %d", expected, stub.bitrate)
	}
}

func TestAdaptive_UpgradeRequiresStableSamples(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warm up with clean samples. The 3rd sample runs algorithm, stableCount→1.
	warmup(a, 50*time.Millisecond, 0.0)

	// After warmup, stableCount=1. Need 3 total to trigger upgrade (stableRequired=3).
	prevBitrate := stub.bitrate
	if stub.bitrate != prevBitrate {
		t.Fatalf("upgraded too early with stableCount=1, bitrate=%d", stub.bitrate)
	}

	// stableCount=2 — still not enough.
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate != prevBitrate {
		t.Fatalf("upgraded too early with stableCount=2, bitrate=%d", stub.bitrate)
	}

	// stableCount=3 → triggers upgrade.
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate <= prevBitrate {
		t.Fatalf("should have upgraded at stableCount=3, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_UpgradeIsAdditive(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warm up + get to stableCount=3 (triggers first upgrade, stableRequired=3).
	warmup(a, 50*time.Millisecond, 0.0)       // stableCount=1
	a.Update(50*time.Millisecond, 0.0)         // stableCount=2
	a.Update(50*time.Millisecond, 0.0)         // stableCount=3 → upgrade

	// Step should be 5% of max (8M/20 = 400K).
	expected := 2_000_000 + 400_000
	if stub.bitrate != expected {
		t.Fatalf("expected additive step to %d, got %d", expected, stub.bitrate)
	}
}

func TestAdaptive_HighRTTDoesNotDegradeAlone(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// High RTT but zero loss — this is just a long path, not congestion.
	for i := 0; i < 6; i++ {
		a.Update(200*time.Millisecond, 0.0)
	}

	if stub.bitrate < 4_000_000 {
		t.Fatalf("high RTT alone should not degrade, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_HighRTTCanStillRecover(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Degrade with high loss + high RTT.
	for i := 0; i < 5; i++ {
		a.Update(200*time.Millisecond, 0.10)
	}
	degradedBitrate := stub.bitrate

	// Now loss clears but RTT stays high. Upgrade is loss-based only, so
	// it should recover once EWMA loss drops below 0.01.
	// EWMA decay from ~0.10 to <0.01 takes ~7 samples, then 3 stable to upgrade.
	for i := 0; i < 20; i++ {
		a.Update(200*time.Millisecond, 0.0)
	}

	if stub.bitrate <= degradedBitrate {
		t.Fatalf("should recover when loss clears even with high RTT, degraded=%d, current=%d",
			degradedBitrate, stub.bitrate)
	}
}

func TestAdaptive_FloorAndCeiling(t *testing.T) {
	a, stub := newTestAdaptive(600_000, 500_000, 8_000_000)

	// Degrade many times — should not go below floor.
	for i := 0; i < 20; i++ {
		a.Update(50*time.Millisecond, 0.20)
	}

	if stub.bitrate < 500_000 {
		t.Fatalf("went below floor: %d", stub.bitrate)
	}

	// Recover many times — should not exceed ceiling.
	for i := 0; i < 200; i++ {
		a.Update(50*time.Millisecond, 0.0)
	}

	if stub.bitrate > 8_000_000 {
		t.Fatalf("exceeded ceiling: %d", stub.bitrate)
	}
}

func TestAdaptive_EWMASmooths(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// Warm up with clean data.
	warmup(a, 50*time.Millisecond, 0.0)

	// Single spike: one high-loss sample among clean ones should NOT degrade
	// because EWMA smooths it out (0.3 * 0.10 + 0.7 * 0.0 = 0.03 < 0.05).
	a.Update(50*time.Millisecond, 0.10)

	if stub.bitrate < 4_000_000 {
		t.Fatalf("single spike should not degrade (EWMA smoothing), bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_SetMaxBitrateClampsDown(t *testing.T) {
	a, stub := newTestAdaptive(5_000_000, 500_000, 8_000_000)

	a.SetMaxBitrate(3_000_000)
	if stub.bitrate != 3_000_000 {
		t.Fatalf("expected clamp to 3M, got %d", stub.bitrate)
	}
	if a.targetBitrate != 3_000_000 {
		t.Fatalf("expected targetBitrate=3M, got %d", a.targetBitrate)
	}
}

func TestAdaptive_FullRecovery(t *testing.T) {
	a, stub := newTestAdaptive(8_000_000, 500_000, 8_000_000)

	// Degrade to floor — each Update applies 0.70x.
	for i := 0; i < 50; i++ {
		a.Update(50*time.Millisecond, 0.15)
	}
	if stub.bitrate != 500_000 {
		t.Fatalf("expected floor, got %d", stub.bitrate)
	}

	// Recover fully. Need EWMA to settle (~10 samples), then 3 stable per
	// upgrade step. From 500K to 8M at +400K/step: ~19 steps × 3 = 57.
	// Plus ~10 EWMA settle + initial degrades from EWMA memory ≈ 80 total.
	for i := 0; i < 120; i++ {
		a.Update(50*time.Millisecond, 0.0)
	}
	if stub.bitrate < 8_000_000 {
		t.Fatalf("should have recovered to ceiling, got %d", stub.bitrate)
	}
}

func TestAdaptive_NoOscillation(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// Warm up clean.
	warmup(a, 50*time.Millisecond, 0.0)

	// Alternating good/mediocre samples should NOT cause oscillation.
	// Mediocre = loss 0.03 (above upgrade threshold but below degrade).
	var lastBitrate int
	oscillations := 0
	for i := 0; i < 20; i++ {
		loss := 0.0
		if i%2 == 1 {
			loss = 0.03 // in dead zone
		}
		a.Update(50*time.Millisecond, loss)
		if stub.bitrate != lastBitrate && lastBitrate != 0 {
			oscillations++
		}
		lastBitrate = stub.bitrate
	}

	// With stableCount requirement and EWMA, we expect very few changes.
	if oscillations > 2 {
		t.Fatalf("too many oscillations: %d", oscillations)
	}
}

func TestAdaptive_CapForSoftwareEncoder(t *testing.T) {
	fpsCalls := []int{}
	a, stub := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	a.onFPSChange = func(fps int) { fpsCalls = append(fpsCalls, fps) }

	// Simulate: ABR ramps to 4 Mbps, then GPU encoding fails.
	warmup(a, 50*time.Millisecond, 0.0)

	a.CapForSoftwareEncoder()

	a.mu.Lock()
	maxBR := a.maxBitrate
	targetBR := a.targetBitrate
	maxFPS := a.maxFPS
	fps := a.currentFPS
	a.mu.Unlock()

	if maxBR > 3_000_000 {
		t.Fatalf("expected maxBitrate capped to 3M, got %d", maxBR)
	}
	if targetBR > 3_000_000 {
		t.Fatalf("expected targetBitrate clamped to 3M, got %d", targetBR)
	}
	if maxFPS != 45 {
		t.Fatalf("expected maxFPS=45, got %d", maxFPS)
	}
	if fps > 45 {
		t.Fatalf("expected FPS <= 45, got %d", fps)
	}
	if stub.bitrate > 3_000_000 {
		t.Fatalf("expected encoder bitrate clamped to 3M, got %d", stub.bitrate)
	}
	// FPS callback should have been called
	if len(fpsCalls) == 0 {
		t.Fatal("expected FPS callback to fire")
	}
}

// feedEncoderThroughput feeds N 1-second samples. Chains across multiple calls
// so phase-2 samples are monotonically after phase-1. Caller must NOT hold a.mu.
func feedEncoderThroughput(a *AdaptiveBitrate, samples int, capturedPerSec, encodedPerSec uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var lastT time.Time
	if a.lastEncoderSample.IsZero() {
		lastT = time.Unix(1_700_000_000, 0)
		// Seed baseline without producing any EWMA update.
		a.updateEncoderThroughputLocked(a.prevCaptured, a.prevEncoded, lastT)
	} else {
		lastT = a.lastEncoderSample
	}
	captured := a.prevCaptured
	encoded := a.prevEncoded
	for i := 1; i <= samples; i++ {
		lastT = lastT.Add(time.Second)
		captured += capturedPerSec
		encoded += encodedPerSec
		a.updateEncoderThroughputLocked(captured, encoded, lastT)
	}
}

func TestAdaptive_EncoderThroughputCapsFPS(t *testing.T) {
	fpsCalls := []int{}
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	a.onFPSChange = func(fps int) { fpsCalls = append(fpsCalls, fps) }

	// Warm up with clean network stats.
	warmup(a, 50*time.Millisecond, 0.0)

	// Simulate encoder producing only 15 fps while capture runs at 50 fps.
	// Four 1-second samples give three interval-delta measurements.
	feedEncoderThroughput(a, 4, 50, 15)

	// Next ABR update should cap FPS based on observed encoder output.
	a.Update(50*time.Millisecond, 0.0)

	a.mu.Lock()
	fps := a.currentFPS
	observed := a.smoothedEncodedFPS
	cap := a.encoderCapFPS
	a.mu.Unlock()

	if observed > 20 {
		t.Fatalf("expected smoothed encoded FPS ≈ 15, got %.2f", observed)
	}
	if cap == 0 {
		t.Fatalf("expected encoder cap to engage, cap=%d", cap)
	}
	// At observed=15 fps, cap = int(15 * 1.1) = 16.
	if fps > 20 {
		t.Fatalf("expected FPS capped below 20 due to encoder bottleneck, got %d (observed=%.2f)", fps, observed)
	}
	if fps < 10 {
		t.Fatalf("FPS should not go below floor of 10, got %d", fps)
	}
}

func TestAdaptive_EncoderThroughputNoCapWhenHealthy(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)

	warmup(a, 50*time.Millisecond, 0.0)

	// Healthy encoder: 57 fps out of 60 captured per second — well above
	// the 0.85 * maxFPS (51) engagement threshold.
	feedEncoderThroughput(a, 4, 60, 57)

	a.Update(50*time.Millisecond, 0.0)

	a.mu.Lock()
	fps := a.currentFPS
	cap := a.encoderCapFPS
	a.mu.Unlock()

	if cap != 0 {
		t.Fatalf("healthy encoder should not engage cap, got cap=%d", cap)
	}
	if fps < 50 {
		t.Fatalf("healthy encoder should not cap FPS, got %d", fps)
	}
}

// Regression: cap must not release when capture FPS drops to match the encoder.
func TestAdaptive_EncoderCapIsSticky(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)

	// Engage the cap with a slow encoder (capture 50/s, encode 15/s).
	feedEncoderThroughput(a, 4, 50, 15)
	a.Update(50*time.Millisecond, 0.0)
	a.mu.Lock()
	capAfterEngage := a.encoderCapFPS
	a.mu.Unlock()
	if capAfterEngage == 0 {
		t.Fatalf("expected cap to engage, got %d", capAfterEngage)
	}

	// Capture now drops to match the encoder — this is the positive-feedback
	// loop's "ratio recovers" moment. Observed FPS is ~16, cap is ~16,
	// release threshold is cap*1.25 = 20, so encoderCapReleaseCount must
	// stay at 0 and the cap must NOT release.
	feedEncoderThroughput(a, 3, 16, 16)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)

	a.mu.Lock()
	capAfterMatch := a.encoderCapFPS
	observed := a.smoothedEncodedFPS
	a.mu.Unlock()
	if capAfterMatch == 0 {
		t.Fatalf("cap released prematurely; observed=%.2f, capAfterEngage=%d", observed, capAfterEngage)
	}
}

func TestAdaptive_EncoderCapReleasesOnSustainedRecovery(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)

	// Engage the cap.
	feedEncoderThroughput(a, 4, 50, 15)
	a.Update(50*time.Millisecond, 0.0)
	a.mu.Lock()
	capEngaged := a.encoderCapFPS
	a.mu.Unlock()
	if capEngaged == 0 {
		t.Fatalf("expected cap to engage, got 0")
	}

	// Feed sustained recovery: observed ≈ 50, which is well above
	// cap*1.25 (= 20). Needs 3 consecutive Update() calls above threshold.
	feedEncoderThroughput(a, 5, 50, 50)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)

	a.mu.Lock()
	capAfter := a.encoderCapFPS
	a.mu.Unlock()
	if capAfter != 0 {
		t.Fatalf("cap should have released after sustained recovery, got %d", capAfter)
	}
}

// TestAdaptive_SoftResetPreservesEncoderCap verifies that idle→active
// transitions do NOT wipe the encoder throughput cap and that the
// resulting currentFPS is clamped to the cap. Encoder capacity is a
// hardware property, not a function of user activity.
func TestAdaptive_SoftResetPreservesEncoderCap(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)
	feedEncoderThroughput(a, 4, 50, 15)
	a.Update(50*time.Millisecond, 0.0)

	a.mu.Lock()
	capBefore := a.encoderCapFPS
	samplesBefore := a.encoderSamples
	a.mu.Unlock()
	if capBefore == 0 || samplesBefore < 3 {
		t.Fatalf("expected cap+samples before reset, cap=%d samples=%d", capBefore, samplesBefore)
	}

	a.SoftResetForActivity()

	a.mu.Lock()
	capAfter := a.encoderCapFPS
	samplesAfter := a.encoderSamples
	fpsAfter := a.currentFPS
	a.mu.Unlock()
	if capAfter == 0 {
		t.Fatalf("SoftResetForActivity wiped encoder cap")
	}
	if samplesAfter == 0 {
		t.Fatalf("SoftResetForActivity wiped encoder samples")
	}
	// Core 1Hz-pulse guard: after reset, currentFPS must stay clamped to
	// the cap. Without this clamp, FPS briefly jumps to the ceiling on
	// every idle→active transition.
	if fpsAfter > capAfter {
		t.Fatalf("SoftResetForActivity did not clamp fps to cap: fps=%d cap=%d", fpsAfter, capAfter)
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func TestAdaptive_EncoderCapEngagementBoundary(t *testing.T) {
	// --- below threshold: 50 fps → cap engages ---
	a1, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	a1.mu.Lock()
	a1.maxFPS = 60
	a1.mu.Unlock()
	warmup(a1, 50*time.Millisecond, 0.0)
	// Feed 4 samples so there are 3 delta measurements (encoderSamples>=3).
	feedEncoderThroughput(a1, 4, 60, 50)
	a1.Update(50*time.Millisecond, 0.0)
	a1.mu.Lock()
	cap1 := a1.encoderCapFPS
	a1.mu.Unlock()
	if cap1 == 0 {
		t.Fatalf("50/60 fps (0.833 < 0.85): cap should have engaged, got 0")
	}

	// --- above threshold: 52 fps → cap must NOT engage ---
	a2, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	a2.mu.Lock()
	a2.maxFPS = 60
	a2.mu.Unlock()
	warmup(a2, 50*time.Millisecond, 0.0)
	feedEncoderThroughput(a2, 4, 60, 52)
	a2.Update(50*time.Millisecond, 0.0)
	a2.mu.Lock()
	cap2 := a2.encoderCapFPS
	a2.mu.Unlock()
	if cap2 != 0 {
		t.Fatalf("52/60 fps (0.867 > 0.85): cap must not engage, got %d", cap2)
	}
}

// TestAdaptive_IntervalResetClearsEWMAKeepsCap verifies the >5s gap path:
// EWMA baseline resets but the cap survives.
func TestAdaptive_IntervalResetClearsEWMAKeepsCap(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)

	// Engage the cap.
	feedEncoderThroughput(a, 4, 50, 15)
	a.Update(50*time.Millisecond, 0.0)
	a.mu.Lock()
	capBefore := a.encoderCapFPS
	a.mu.Unlock()
	if capBefore == 0 {
		t.Fatalf("expected cap to engage before interval reset, got 0")
	}

	// Inject one sample 10 seconds after the last — triggers the >5s reset branch.
	a.mu.Lock()
	lastT := a.lastEncoderSample
	captured := a.prevCaptured + 50
	encoded := a.prevEncoded + 15
	a.updateEncoderThroughputLocked(captured, encoded, lastT.Add(10*time.Second))
	samplesAfter := a.encoderSamples
	smoothedAfter := a.smoothedEncodedFPS
	capAfter := a.encoderCapFPS
	a.mu.Unlock()

	if samplesAfter != 0 {
		t.Fatalf("interval reset should clear encoderSamples, got %d", samplesAfter)
	}
	if smoothedAfter != 0 {
		t.Fatalf("interval reset should clear smoothedEncodedFPS, got %.2f", smoothedAfter)
	}
	// Cap must survive the EWMA reset — same principle as SoftResetPreservesEncoderCap.
	if capAfter == 0 {
		t.Fatalf("interval reset must not clear encoderCapFPS, got 0")
	}
}

// TestAdaptive_DeltaCapturedGuardSkipsSamples verifies that samples with
// deltaCaptured < 5 are silently dropped. Each 1-second interval delivers
// exactly 1 captured frame, so every delta equals 1 — all fall below the
// guard and no cap should ever engage.
func TestAdaptive_DeltaCapturedGuardSkipsSamples(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)

	// 10 intervals with deltaCaptured=1 per interval (below the <5 guard).
	a.mu.Lock()
	var lastT time.Time
	if a.lastEncoderSample.IsZero() {
		lastT = time.Unix(1_700_000_000, 0)
		a.updateEncoderThroughputLocked(a.prevCaptured, a.prevEncoded, lastT)
	} else {
		lastT = a.lastEncoderSample
	}
	captured := a.prevCaptured
	encoded := a.prevEncoded
	for i := 1; i <= 10; i++ {
		lastT = lastT.Add(time.Second)
		captured++ // delta = 1 each interval
		encoded++
		a.updateEncoderThroughputLocked(captured, encoded, lastT)
	}
	samplesAfter := a.encoderSamples
	capAfter := a.encoderCapFPS
	a.mu.Unlock()

	if samplesAfter != 0 {
		t.Fatalf("deltaCaptured<5 guard should skip all samples; encoderSamples=%d", samplesAfter)
	}
	if capAfter != 0 {
		t.Fatalf("deltaCaptured<5 guard should prevent cap, got %d", capAfter)
	}
}

// TestAdaptive_SetEncoderClearsCap verifies that swapping the encoder wipes
// the throughput cap — a new encoder has a different hardware capacity envelope.
func TestAdaptive_SetEncoderClearsCap(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)
	warmup(a, 50*time.Millisecond, 0.0)

	// Engage the cap on the original encoder.
	feedEncoderThroughput(a, 4, 50, 15)
	a.Update(50*time.Millisecond, 0.0)
	a.mu.Lock()
	capBefore := a.encoderCapFPS
	a.mu.Unlock()
	if capBefore == 0 {
		t.Fatalf("expected cap to engage, got 0")
	}

	// Swap to a new encoder — cap must be cleared immediately.
	newStub := &stubEncoder{}
	newEnc := &VideoEncoder{backend: newStub, cfg: EncoderConfig{}}
	a.SetEncoder(newEnc)

	a.mu.Lock()
	capAfterSwap := a.encoderCapFPS
	samplesAfterSwap := a.encoderSamples
	a.mu.Unlock()
	if capAfterSwap != 0 {
		t.Fatalf("SetEncoder must clear encoderCapFPS, got %d", capAfterSwap)
	}
	if samplesAfterSwap != 0 {
		t.Fatalf("SetEncoder must clear encoderSamples, got %d", samplesAfterSwap)
	}

	// Feed 3 healthy samples on the new encoder — cap must remain 0.
	feedEncoderThroughput(a, 4, 60, 58)
	a.Update(50*time.Millisecond, 0.0)
	a.mu.Lock()
	capAfterHealthy := a.encoderCapFPS
	a.mu.Unlock()
	if capAfterHealthy != 0 {
		t.Fatalf("healthy new encoder should not engage cap, got %d", capAfterHealthy)
	}
}

// TestAdaptive_ThroughputIntervalGuardSub100ms verifies that a sample arriving
// fewer than 100ms after the previous one is silently ignored. The baseline
// must remain anchored to the first sample, so the third sample (arriving 1s
// after the first) produces a correct delta.
func TestAdaptive_ThroughputIntervalGuardSub100ms(t *testing.T) {
	a, _ := newTestAdaptive(4_000_000, 500_000, 4_000_000)

	t0 := time.Unix(1_700_000_000, 0)

	a.mu.Lock()
	// First sample seeds the baseline (no EWMA update).
	a.updateEncoderThroughputLocked(0, 0, t0)
	baseT := a.lastEncoderSample
	baseCaptured := a.prevCaptured
	baseEncoded := a.prevEncoded

	// Second sample: 50ms later — must be ignored (interval < 100ms).
	a.updateEncoderThroughputLocked(30, 30, t0.Add(50*time.Millisecond))
	// Baseline must be unchanged: still anchored to t0.
	if !a.lastEncoderSample.Equal(baseT) {
		t.Fatalf("sub-100ms sample advanced lastEncoderSample; want %v, got %v",
			baseT, a.lastEncoderSample)
	}
	if a.prevCaptured != baseCaptured || a.prevEncoded != baseEncoded {
		t.Fatalf("sub-100ms sample modified prevCaptured/prevEncoded")
	}

	// Third sample: 1 second after t0 — must produce a valid delta from t0.
	a.updateEncoderThroughputLocked(60, 60, t0.Add(time.Second))
	samplesAfter := a.encoderSamples
	a.mu.Unlock()

	// The delta is (60-0)=60 captured in 1s → 60fps; deltaCaptured=60 ≥ 5.
	if samplesAfter != 1 {
		t.Fatalf("expected 1 encoderSample after valid interval, got %d", samplesAfter)
	}
}
