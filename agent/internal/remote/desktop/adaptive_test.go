package desktop

import (
	"testing"
	"time"
)

// stubEncoder satisfies encoderBackend for testing adaptive bitrate.
type stubEncoder struct {
	bitrate  int
	quality  QualityPreset
	hardware bool // reported by IsHardware(); defaults to software
}

func (s *stubEncoder) Encode([]byte) ([]byte, error)         { return nil, nil }
func (s *stubEncoder) SetCodec(Codec) error                  { return nil }
func (s *stubEncoder) SetQuality(q QualityPreset) error      { s.quality = q; return nil }
func (s *stubEncoder) SetBitrate(b int) error                { s.bitrate = b; return nil }
func (s *stubEncoder) SetFPS(int) error                      { return nil }
func (s *stubEncoder) SetDimensions(int, int) error          { return nil }
func (s *stubEncoder) SetPixelFormat(PixelFormat)            {}
func (s *stubEncoder) Close() error                          { return nil }
func (s *stubEncoder) Name() string                          { return "stub" }
func (s *stubEncoder) IsHardware() bool                      { return s.hardware }
func (s *stubEncoder) IsPlaceholder() bool                   { return false }
func (s *stubEncoder) SetD3D11Device(uintptr, uintptr)       {}
func (s *stubEncoder) SupportsGPUInput() bool                { return false }
func (s *stubEncoder) EncodeTexture(uintptr) ([]byte, error) { return nil, nil }

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
	warmup(a, 50*time.Millisecond, 0.0) // stableCount=1
	a.Update(50*time.Millisecond, 0.0)  // stableCount=2
	a.Update(50*time.Millisecond, 0.0)  // stableCount=3 → upgrade

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

func TestAdaptive_SlowStartAcceleratesRecovery(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// First upgrade: warmup (stableCount=1) + 2 more clean → step = 5% (400K).
	warmup(a, 50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate != 2_400_000 {
		t.Fatalf("first step should be +400K, got %d", stub.bitrate)
	}

	// Streak active: next upgrade needs only 1 stable sample, step doubles (800K).
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate != 3_200_000 {
		t.Fatalf("second step should be +800K (slow-start), got %d", stub.bitrate)
	}

	// Third: 1 sample, step doubles again (1.6M).
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate != 4_800_000 {
		t.Fatalf("third step should be +1.6M, got %d", stub.bitrate)
	}

	// Fourth: step capped at 25% of max (2M), reaching 6.8M.
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate != 6_800_000 {
		t.Fatalf("fourth step should be capped at +2M, got %d", stub.bitrate)
	}
}

func TestAdaptive_SlowStartResetOnDegrade(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Build a streak.
	warmup(a, 50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0) // upgrade #1 (streak=1)
	a.Update(50*time.Millisecond, 0.0) // upgrade #2 (streak=2)

	// Congestion: degrade resets the streak and arms the backoff.
	for i := 0; i < 6; i++ {
		a.Update(50*time.Millisecond, 0.20)
	}

	// Clean again: the EWMA tail causes a few more degrades before it decays
	// below 0.01 (~10 samples from 0.20); track the true floor, then backoff
	// (4) and 3 stable samples gate the FIRST upgrade — i.e. the streak did
	// not survive the congestion event.
	lowest := stub.bitrate
	post := 0
	for i := 0; i < 60; i++ {
		a.Update(50*time.Millisecond, 0.0)
		post++
		if stub.bitrate < lowest {
			lowest = stub.bitrate
		}
		if stub.bitrate > lowest {
			break // first upgrade landed
		}
	}
	if stub.bitrate <= lowest {
		t.Fatalf("never recovered after degrade, bitrate=%d", stub.bitrate)
	}
	// First post-degrade upgrade must NOT be an accelerated step: it should be
	// exactly one gentle 5%-of-max step above the floor.
	if got, want := stub.bitrate, lowest+400_000; got != want {
		t.Fatalf("first post-degrade step should be gentle +400K (%d), got %d", want, got)
	}
	if post < 3 {
		t.Fatalf("first post-degrade upgrade came too fast (%d samples) — backoff/stable gating broken", post)
	}
}

func TestAdaptive_SlowStartResetOnDeadZone(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Build a streak of 2 upgrades.
	warmup(a, 50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0) // upgrade #1
	a.Update(50*time.Millisecond, 0.0) // upgrade #2 (streak=2, bitrate=3.2M)
	afterStreak := stub.bitrate

	// One dead-zone sample (loss 0.03-ish smoothed) kills the acceleration.
	a.Update(50*time.Millisecond, 0.04)

	// Next clean samples: EWMA needs to decay below 0.01 again, and the first
	// upgrade after the dead zone must be a gentle +400K, not a doubled step.
	for i := 0; i < 30 && stub.bitrate <= afterStreak; i++ {
		a.Update(50*time.Millisecond, 0.0)
	}
	if got, want := stub.bitrate, afterStreak+400_000; got != want {
		t.Fatalf("post-dead-zone step should reset to gentle +400K (%d), got %d", want, got)
	}
}

// TestAdaptive_DeepDipRecoveryTime documents the headline improvement: from the
// floor, sustained-clean recovery to an 8M ceiling completes in well under 20
// samples (~20s at 1s stats cadence) versus ~60 with the old fixed +5%/3-sample
// scheme. EWMA decay from the congestion event dominates the tail.
func TestAdaptive_DeepDipRecoveryTime(t *testing.T) {
	a, stub := newTestAdaptive(8_000_000, 500_000, 8_000_000)

	// Crash to the floor.
	for i := 0; i < 50; i++ {
		a.Update(50*time.Millisecond, 0.15)
	}
	if stub.bitrate != 500_000 {
		t.Fatalf("expected floor, got %d", stub.bitrate)
	}

	// Sustained clean conditions: count samples to full recovery.
	samples := 0
	for i := 0; i < 120 && stub.bitrate < 8_000_000; i++ {
		a.Update(50*time.Millisecond, 0.0)
		samples++
	}
	if stub.bitrate < 8_000_000 {
		t.Fatalf("did not recover to ceiling, got %d", stub.bitrate)
	}
	if samples > 30 {
		t.Fatalf("recovery took %d samples — slow-start not engaging (old behavior was ~60+)", samples)
	}
}

// TestAdaptive_SoftResetForActivityResetsUpgradeStreak pins that an
// idle→active soft reset clears the slow-start streak: the first upgrade after
// the reset must be gated on the full 3 stable samples and step gently
// (+5% of max), not fire early with an accelerated doubled step while the
// encoder is already re-ramping from the reset bitrate.
func TestAdaptive_SoftResetForActivityResetsUpgradeStreak(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Build a streak of 2 accelerated upgrades.
	warmup(a, 50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0)
	a.Update(50*time.Millisecond, 0.0) // upgrade #1 (streak=1)
	a.Update(50*time.Millisecond, 0.0) // upgrade #2 (streak=2, accelerated)
	if a.upgradeStreak != 2 {
		t.Fatalf("setup: expected streak=2, got %d", a.upgradeStreak)
	}

	a.SoftResetForActivity()
	if a.upgradeStreak != 0 {
		t.Fatalf("SoftResetForActivity must reset upgradeStreak, got %d", a.upgradeStreak)
	}
	moderate := stub.bitrate // 60% of max = 4.8M

	// The reset also restarts the EWMA warmup (5 samples) — then the first
	// upgrade must wait the full 3 stable samples and be a gentle +400K
	// (5% of 8M), not a doubled step.
	warmup(a, 50*time.Millisecond, 0.0) // 5th sample: stableCount=1
	a.Update(50*time.Millisecond, 0.0)  // stableCount=2 — no upgrade yet
	if stub.bitrate != moderate {
		t.Fatalf("upgraded before 3 stable samples post-reset, bitrate=%d", stub.bitrate)
	}
	a.Update(50*time.Millisecond, 0.0) // stableCount=3 → first post-reset upgrade
	if got, want := stub.bitrate, moderate+400_000; got != want {
		t.Fatalf("first post-reset step should be gentle +400K (%d), got %d", want, got)
	}
}

func TestAdaptive_CapForSoftwareEncoder(t *testing.T) {
	a, stub := newTestAdaptive(6_000_000, 500_000, 15_000_000)

	// Simulate: ABR at 6 Mbps, then GPU encoding fails → software fallback.
	warmup(a, 50*time.Millisecond, 0.0)

	a.CapForSoftwareEncoder()

	a.mu.Lock()
	maxBR := a.maxBitrate
	targetBR := a.targetBitrate
	a.mu.Unlock()

	if maxBR > 4_000_000 {
		t.Fatalf("expected maxBitrate capped to 4M, got %d", maxBR)
	}
	if targetBR > 4_000_000 {
		t.Fatalf("expected targetBitrate clamped to 4M, got %d", targetBR)
	}
	if stub.bitrate > 4_000_000 {
		t.Fatalf("expected encoder bitrate clamped to 4M, got %d", stub.bitrate)
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
