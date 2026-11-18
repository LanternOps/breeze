package desktop

import "testing"

// holdingEncoderSim models a synchronous encoder that keeps `hold` input
// frames before it emits: input k comes out when input k+hold goes in, in
// order. hold=5 is what Microsoft's software H264 MFT did on a Windows 11
// 21H2 lab VM when low-latency mode was set too late (#11622); hold=0 is a
// one-in-one-out encoder.
type holdingEncoderSim struct {
	hold    int
	queue   []int // frame ids inside the encoder
	stalled bool  // accepts input, never emits
}

// submit feeds frame id and returns the id that came out, or -1 for none.
func (e *holdingEncoderSim) submit(id int) int {
	e.queue = append(e.queue, id)
	if e.stalled || len(e.queue) <= e.hold {
		return -1
	}
	out := e.queue[0]
	e.queue = e.queue[1:]
	return out
}

func (e *holdingEncoderSim) flush() { e.queue = nil }

// catchUpRig drives one simulated encoder and one idleCatchUp the way the MFT
// and the capture loop do, and records the newest frame the viewer received.
type catchUpRig struct {
	enc      holdingEncoderSim
	cu       idleCatchUp
	lastReal int // id of the newest captured frame (the retained frame)
	shown    int // id of the newest frame the viewer received
	refeeds  int
}

func (r *catchUpRig) capture(id int) {
	r.lastReal = id
	r.deliver(r.enc.submit(id), false)
}

// idle is one capture-loop iteration with no new frame.
func (r *catchUpRig) idle() {
	if !r.cu.startRefeed() {
		return
	}
	r.refeeds++
	r.deliver(r.enc.submit(r.lastReal), true)
}

func (r *catchUpRig) deliver(out int, refeed bool) {
	r.cu.noteSubmitted(refeed)
	if out >= 0 {
		r.cu.noteEmitted()
		r.shown = out
	}
}

func (r *catchUpRig) flush() {
	r.enc.flush()
	r.cu.noteReset()
}

func TestIdleCatchUp_HoldingEncoderShowsNewestFrameAfterIdle(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5}}
	for id := 1; id <= 10; id++ {
		r.capture(id)
	}
	if r.shown == 10 {
		t.Fatalf("precondition: a holding encoder must not have emitted the newest frame yet")
	}
	for i := 0; i < 100; i++ {
		r.idle()
	}
	if r.shown != 10 {
		t.Fatalf("viewer shows frame %d after idle, want the newest frame 10", r.shown)
	}
	if r.refeeds != 5 {
		t.Fatalf("re-submits = %d, want exactly the 5 frames the encoder held", r.refeeds)
	}
	if r.cu.wantsRefeed() {
		t.Fatalf("once the newest frame is out, a static screen must stop re-submitting")
	}
}

func TestIdleCatchUp_OneInOneOutEncoderNeverRefeeds(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 0}}
	for id := 1; id <= 10; id++ {
		r.capture(id)
		r.idle()
	}
	if r.refeeds != 0 {
		t.Fatalf("a one-in-one-out encoder (OpenH264, low-latency MFT) must never be re-fed, got %d", r.refeeds)
	}
	if r.shown != 10 {
		t.Fatalf("viewer shows frame %d, want 10", r.shown)
	}
}

func TestIdleCatchUp_EachChangeAtIdleIsPushedOut(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5}}
	r.capture(1)
	// One change a minute (the taskbar clock): each must reach the viewer
	// during the idle that follows it, not five changes later.
	for id := 2; id <= 6; id++ {
		for i := 0; i < 20; i++ {
			r.idle()
		}
		if r.shown != id-1 {
			t.Fatalf("after idle, viewer shows frame %d, want %d", r.shown, id-1)
		}
		r.capture(id)
	}
}

func TestIdleCatchUp_FlushBeforeEmitRefeedsIntoNewStream(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5}}
	for id := 1; id <= 3; id++ {
		r.capture(id)
	}
	// A click or desktop-switch flush discards frames 1–3 before any came out.
	r.flush()
	for i := 0; i < 100; i++ {
		r.idle()
	}
	if r.shown != 3 {
		t.Fatalf("viewer shows frame %d after a flush at idle, want the newest frame 3", r.shown)
	}
	if r.refeeds != 6 {
		t.Fatalf("re-submits = %d, want 6 (one to replace the lost frame, five to push it out)", r.refeeds)
	}
}

func TestIdleCatchUp_FlushAfterEmitDoesNotRefeed(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 0}}
	r.capture(1)
	r.flush()
	for i := 0; i < 10; i++ {
		r.idle()
	}
	if r.refeeds != 0 {
		t.Fatalf("the newest frame already reached the viewer; a flush must not trigger re-submits, got %d", r.refeeds)
	}
}

func TestIdleCatchUp_StalledEncoderIsBounded(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5, stalled: true}}
	r.capture(1)
	for i := 0; i < 1000; i++ {
		r.idle()
	}
	if r.refeeds != maxIdleCatchUpRefeeds {
		t.Fatalf("re-submits for a stalled encoder = %d, want the bound %d", r.refeeds, maxIdleCatchUpRefeeds)
	}
	if maxIdleCatchUpRefeeds >= mftSoftwareStallThreshold {
		t.Fatalf("the re-submit bound (%d) must stay below the software stall threshold (%d) so catch-up alone cannot flush",
			maxIdleCatchUpRefeeds, mftSoftwareStallThreshold)
	}
	// A new real frame earns a fresh budget.
	r.capture(2)
	r.idle()
	if r.refeeds != maxIdleCatchUpRefeeds+1 {
		t.Fatalf("a new real frame must reset the re-submit budget")
	}
}

func TestIdleCatchUp_RejectedRefeedStillSpendsBudget(t *testing.T) {
	var cu idleCatchUp
	cu.noteSubmitted(false)
	attempts := 0
	for i := 0; i < 1000; i++ {
		if cu.startRefeed() { // the encoder rejects every re-submit: no noteSubmitted
			attempts++
		}
	}
	if attempts != maxIdleCatchUpRefeeds {
		t.Fatalf("re-submit attempts against a rejecting encoder = %d, want the bound %d", attempts, maxIdleCatchUpRefeeds)
	}
}

func TestIdleCatchUp_PrimingFillersAreNotTheNewestFrame(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5}}
	// A re-initialized encoder is primed with 5 blank frames (id 0).
	for i := 0; i < 5; i++ {
		if out := r.enc.submit(0); out >= 0 {
			t.Fatalf("precondition: priming emits nothing while the encoder holds 5")
		}
		r.cu.noteFiller()
	}
	r.capture(7)
	if r.shown != 0 {
		t.Fatalf("precondition: the first output after priming is a blank, got %d", r.shown)
	}
	for i := 0; i < 100; i++ {
		r.idle()
	}
	if r.shown != 7 {
		t.Fatalf("viewer shows frame %d, want the captured frame 7 (a blank primer must not count as delivered)", r.shown)
	}
}

func TestIdleCatchUp_ClearForgetsOwedFrame(t *testing.T) {
	r := &catchUpRig{enc: holdingEncoderSim{hold: 5}}
	r.capture(1)
	r.flush()
	r.cu.clear()
	if r.cu.wantsRefeed() {
		t.Fatalf("after clear (encoder torn down) there is no valid frame to re-submit")
	}
	if r.cu.held() != 0 {
		t.Fatalf("held = %d after clear, want 0", r.cu.held())
	}
}

func TestMFTNilStallThresholds(t *testing.T) {
	cases := []struct {
		name              string
		isHW, recentFlush bool
		flushAt, refuseAt int
	}{
		// Hardware MFTs keep the pre-#11622 behaviour exactly.
		{"hardware", true, false, mftStallThreshold, mftStallThreshold},
		{"hardware after a recent stall flush", true, true, mftStallThreshold / 2, mftStallThreshold},
		// The software MFT warms up for 5–7 empty outputs after every init or
		// flush (lab log, #11622); a threshold of 4 flushed it mid-warm-up.
		{"software", false, false, mftSoftwareStallThreshold, mftSoftwareStallThreshold},
		{"software after a recent stall flush", false, true, mftSoftwareStallThreshold, mftSoftwareStallThreshold},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flushAt, refuseAt := mftNilStallThresholds(tc.isHW, tc.recentFlush)
			if flushAt != tc.flushAt || refuseAt != tc.refuseAt {
				t.Fatalf("mftNilStallThresholds(%v, %v) = (%d, %d), want (%d, %d)",
					tc.isHW, tc.recentFlush, flushAt, refuseAt, tc.flushAt, tc.refuseAt)
			}
		})
	}
	if mftSoftwareStallThreshold <= 7 {
		t.Fatalf("software stall threshold %d must exceed the observed warm-up of 7 empty outputs", mftSoftwareStallThreshold)
	}
}
