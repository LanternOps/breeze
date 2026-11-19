package desktop

import (
	"image"
	"testing"
	"time"
)

// Tests for the quality refresh after a burst on a static screen (#11639).
//
// cbrModelBackend is a fake encoder with a toy constant-bitrate rate control,
// standing in for Microsoft's software H264 MFT. Like the MFT it is fed
// frame-count timestamps, so its rate control only advances when a frame is
// submitted, however long the screen stays static. The model encodes the
// mechanism inferred in #11639, not measured MFT behaviour:
//
//   - a large change re-codes the picture at the current quantiser (QP) and
//     costs more than a frame's budget, so a burst fills the buffer and the QP
//     climbs;
//   - while the buffer is over budget the QP stays high; one frame's budget
//     drains per submitted frame; once it is empty the QP drops; the buffer
//     is capped at the VBV size, as CBR is;
//   - re-submitting the unchanged picture codes a refinement only when the
//     current QP is finer than the one the picture was last coded at, so the
//     decoded picture sharpens only as further frames let the QP come down.
//
// pictureQP is the QP the viewer's picture was last coded at: lower is sharper.
// It implements optionalIdleCatchUp through the same idleCatchUp,
// qualityRefresh and nextIdleRefeed bookkeeping the MFT uses.
type cbrModelBackend struct {
	stubEncoder
	now time.Time

	qp        int
	pictureQP int
	fullness  int
	forceIDR  bool

	cu idleCatchUp
	qr qualityRefresh

	realSubmits    int
	refreshSubmits int
	idrs           int
}

const (
	cbrModelFPS      = 30
	cbrModelBitrate  = 960_000 // 4000 bytes per frame at 30 FPS
	cbrModelMinQP    = 20
	cbrModelMaxQP    = 51
	cbrModelStartQP  = 24
	cbrModelSharpQP  = 30 // a picture coded at or below this QP counts as sharp
	cbrModelFrameDur = time.Second / cbrModelFPS
)

type modelChange byte

const (
	changeSmall modelChange = 1 // a clock tick or caret blink: a few macroblocks
	changeLarge modelChange = 2 // a menu closing, a window moving: most of the picture
)

func newCBRModelBackend() *cbrModelBackend {
	return &cbrModelBackend{
		now:       time.Unix(1_700_000_000, 0),
		qp:        cbrModelStartQP,
		pictureQP: cbrModelMaxQP,
	}
}

func (b *cbrModelBackend) budget() int { return frameBudgetBytes(cbrModelBitrate, cbrModelFPS) }

// code encodes one input and runs the rate control. change is 0 for a
// re-submit of the unchanged picture.
func (b *cbrModelBackend) code(change modelChange) []byte {
	budget := b.budget()
	idr := b.forceIDR
	b.forceIDR = false
	var cost int
	switch {
	case idr, change == changeLarge:
		cost = 3 * budget
		b.pictureQP = b.qp
	case change == changeSmall:
		cost = budget / 20
	case b.pictureQP > b.qp:
		cost = budget*(b.pictureQP-b.qp)/8 + 64
		b.pictureQP = b.qp
	default:
		cost = 32 // nothing left to refine: a skip frame
	}
	// The buffer holds at most the VBV size the MFT is configured with
	// (vbvSizeForBitrate: 500 ms of bitrate); at that point CBR codes at the
	// coarsest quantiser rather than overflow.
	vbv := budget * cbrModelFPS / 2
	b.fullness = min(max(b.fullness+cost-budget, 0), vbv)
	switch {
	case b.fullness > budget:
		b.qp += 4
	case b.fullness == 0:
		b.qp -= 3
	}
	b.qp = min(max(b.qp, cbrModelMinQP), cbrModelMaxQP)
	if idr {
		b.idrs++
	}
	return modelNAL(idr, cost)
}

// modelNAL builds an Annex B access unit of n bytes whose NAL type is IDR (5)
// or non-IDR slice (1), so h264ContainsIDR classifies it like real output.
func modelNAL(idr bool, n int) []byte {
	if n < 8 {
		n = 8
	}
	out := make([]byte, n)
	for i := range out {
		out[i] = 0xAA
	}
	copy(out, []byte{0, 0, 0, 1, 0x41})
	if idr {
		out[4] = 0x65
	}
	return out
}

func (b *cbrModelBackend) Encode(frame []byte) ([]byte, error) {
	b.realSubmits++
	out := b.code(modelChange(frame[0]))
	b.cu.noteSubmitted(false)
	b.cu.noteEmitted()
	b.qr.noteOutput(b.now, out, b.budget(), cbrModelFPS)
	return out, nil
}

func (b *cbrModelBackend) CatchUpIdle() ([]byte, error) {
	kind := nextIdleRefeed(&b.cu, &b.qr, b.now)
	if kind == idleRefeedNone {
		return nil, nil
	}
	out := b.code(0)
	b.cu.noteSubmitted(true)
	b.cu.noteEmitted()
	if kind == idleRefeedQuality {
		b.refreshSubmits++
		b.qr.noteRefreshResult(out, nil, cbrModelFPS)
	} else {
		b.qr.noteOutput(b.now, out, b.budget(), cbrModelFPS)
	}
	return out, nil
}

func (b *cbrModelBackend) ForceKeyframe() error { b.forceIDR = true; return nil }

func (b *cbrModelBackend) Flush() error {
	b.cu.noteReset()
	b.forceIDR = true
	return nil
}

// changeCapturer delivers the changes the test queues, one per capture. With
// nothing queued it reports a static screen: DXGI-style "no new frame"
// (nil, nil), or with sameFrame the previous frame again, which the session's
// frame differ skips (the GDI/CRC path the #11639 lab session took).
type changeCapturer struct {
	pending   []modelChange
	seq       int
	last      *image.RGBA
	sameFrame bool
}

func (c *changeCapturer) Capture() (*image.RGBA, error) {
	if len(c.pending) == 0 {
		if c.sameFrame && c.last != nil {
			img := image.NewRGBA(c.last.Rect)
			copy(img.Pix, c.last.Pix)
			return img, nil
		}
		return nil, nil
	}
	change := c.pending[0]
	c.pending = c.pending[1:]
	c.seq++
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Pix[0] = byte(change)
	img.Pix[1] = byte(c.seq)
	img.Pix[2] = byte(c.seq >> 8)
	c.last = img
	out := image.NewRGBA(img.Rect)
	copy(out.Pix, img.Pix)
	return out, nil
}
func (c *changeCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return c.Capture()
}
func (c *changeCapturer) GetScreenBounds() (int, int, error) { return 4, 4, nil }
func (c *changeCapturer) Close() error                       { return nil }
func (c *changeCapturer) IsBGRA() bool                       { return true }

type refreshRig struct {
	t   *testing.T
	s   *Session
	b   *cbrModelBackend
	cap *changeCapturer
}

func newRefreshRig(t *testing.T, sameFrame bool) *refreshRig {
	t.Helper()
	b := newCBRModelBackend()
	s := newIdleCatchUpSession(t, 0, b)
	c := &changeCapturer{sameFrame: sameFrame}
	s.capturer = c
	return &refreshRig{t: t, s: s, b: b, cap: c}
}

// tick runs one capture iteration, one frame interval after the previous one.
func (r *refreshRig) tick() {
	r.b.now = r.b.now.Add(cbrModelFrameDur)
	r.s.captureAndSendFrame(cbrModelFrameDur)
}

// change delivers one screen change on the next iteration.
func (r *refreshRig) change(c modelChange) {
	r.cap.pending = append(r.cap.pending, c)
	r.tick()
}

// idle runs capture iterations over d of static screen.
func (r *refreshRig) idle(d time.Duration) {
	for i := 0; i < int(d/cbrModelFrameDur); i++ {
		r.tick()
	}
}

// settleSharp starts the session with a large change (the first picture) and
// lets it settle, so later steps start from a sharp picture with an empty
// buffer, like the lab session before the Esc burst.
func (r *refreshRig) settleSharp() {
	r.t.Helper()
	r.change(changeLarge)
	r.idle(5 * time.Second)
	if r.b.pictureQP > cbrModelSharpQP {
		r.t.Fatalf("precondition: the first picture must end sharp, pictureQP=%d", r.b.pictureQP)
	}
}

func (r *refreshRig) burst(frames int) {
	for i := 0; i < frames; i++ {
		r.change(changeLarge)
	}
}

// #11639: after a 7-frame burst on a static screen, the picture must recover
// on its own, within a bounded number of re-submits, and a static screen must
// then cost nothing.
func TestQualityRefresh_RecoversAfterBurstOnStaticScreen(t *testing.T) {
	for _, tc := range []struct {
		name      string
		sameFrame bool
	}{
		{"dxgi no new frame", false},
		{"frame differ unchanged", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRefreshRig(t, tc.sameFrame)
			r.settleSharp()
			refreshBefore := r.b.refreshSubmits

			r.burst(7)
			if r.b.pictureQP <= cbrModelSharpQP {
				t.Fatalf("precondition: the model's burst must leave a blocky picture, pictureQP=%d", r.b.pictureQP)
			}

			r.idle(3 * time.Second)
			if r.b.pictureQP > cbrModelSharpQP {
				t.Fatalf("picture still blocky 3 s after the burst: pictureQP=%d (sharp is <= %d), refresh re-submits=%d",
					r.b.pictureQP, cbrModelSharpQP, r.b.refreshSubmits-refreshBefore)
			}
			if got, limit := r.b.refreshSubmits-refreshBefore, qualityRefreshFrames(cbrModelFPS); got > limit {
				t.Fatalf("refresh re-submits after one burst = %d, want at most %d", got, limit)
			}

			// A long static screen afterwards: no submits at all.
			submits := r.b.realSubmits + r.b.refreshSubmits
			r.idle(30 * time.Second)
			if got := r.b.realSubmits + r.b.refreshSubmits; got != submits {
				t.Fatalf("static screen after the refresh cost %d submits, want 0", got-submits)
			}
		})
	}
}

// Changes too small to have pushed the rate control over budget (a clock
// tick, a blinking caret) must not start a refresh: the steady-state cost of
// a near-static screen stays one encode per change.
func TestQualityRefresh_CheapChangesDoNotRefresh(t *testing.T) {
	r := newRefreshRig(t, false)
	r.settleSharp()
	real, refresh := r.b.realSubmits, r.b.refreshSubmits

	for i := 0; i < 60; i++ { // a seconds clock for a minute
		r.change(changeSmall)
		r.idle(time.Second)
	}
	for i := 0; i < 60; i++ { // a caret blinking every 530 ms
		r.change(changeSmall)
		r.idle(530 * time.Millisecond)
	}
	if got := r.b.realSubmits - real; got != 120 {
		t.Fatalf("real submits = %d, want 120", got)
	}
	if got := r.b.refreshSubmits - refresh; got != 0 {
		t.Fatalf("refresh re-submits for cheap changes = %d, want 0", got)
	}
}

// A keyframe armed while the screen is static (the DXGI loop arms one after
// ~30 idle iterations and every 10 s) must not by itself cause a submit, and
// when the next change lands as an IDR at a congested QP the refresh that
// follows must still end sharp. This is the lab's "later single change, also
// blocky" step.
func TestQualityRefresh_PendingKeyframeAtIdleThenSingleChange(t *testing.T) {
	r := newRefreshRig(t, false)
	r.settleSharp()
	r.burst(7)
	r.idle(3 * time.Second)

	submits := r.b.realSubmits + r.b.refreshSubmits
	_ = r.s.encoder.Load().ForceKeyframe()
	r.idle(15 * time.Second)
	if got := r.b.realSubmits + r.b.refreshSubmits; got != submits {
		t.Fatalf("a pending keyframe on a static screen cost %d submits, want 0", got-submits)
	}

	r.change(changeSmall) // coded as the pending IDR
	if r.b.idrs == 0 {
		t.Fatal("precondition: the change must have been coded as an IDR")
	}
	r.idle(3 * time.Second)
	if r.b.pictureQP > cbrModelSharpQP {
		t.Fatalf("picture after the IDR'd single change is blocky: pictureQP=%d", r.b.pictureQP)
	}
}

// An IDR inside a refresh (a keyframe armed or a click flush mid-refresh)
// re-codes the whole picture at the current QP; the refresh must carry on
// after it rather than end on it, and stay bounded.
func TestQualityRefresh_IDRMidRefreshStillEndsSharp(t *testing.T) {
	for _, tc := range []struct {
		name string
		hit  func(r *refreshRig)
	}{
		{"keyframe", func(r *refreshRig) { _ = r.s.encoder.Load().ForceKeyframe() }},
		{"flush", func(r *refreshRig) { r.s.encoder.Load().Flush() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRefreshRig(t, false)
			r.settleSharp()
			refreshBefore := r.b.refreshSubmits
			r.burst(7)
			// Into the refresh, before the QP has come down.
			for i := 0; r.b.refreshSubmits-refreshBefore < 3; i++ {
				if i > cbrModelFPS*5 {
					t.Fatalf("no refresh started within 5 s of the burst (re-submits=%d)", r.b.refreshSubmits-refreshBefore)
				}
				r.tick()
			}
			tc.hit(r)
			idrs := r.b.idrs
			r.idle(5 * time.Second)
			if r.b.idrs != idrs+1 {
				t.Fatalf("IDRs during the rest of the refresh = %d, want 1", r.b.idrs-idrs)
			}
			if r.b.pictureQP > cbrModelSharpQP {
				t.Fatalf("picture after an IDR mid-refresh is blocky: pictureQP=%d", r.b.pictureQP)
			}
			if got, limit := r.b.refreshSubmits-refreshBefore, 2*qualityRefreshFrames(cbrModelFPS); got > limit {
				t.Fatalf("refresh re-submits = %d, want at most %d (one extension)", got, limit)
			}
		})
	}
}

// Activity that keeps the screen changing never settles, so there is no
// refresh until it stops: during motion the stream is exactly the changes.
func TestQualityRefresh_NoRefreshDuringContinuousMotion(t *testing.T) {
	r := newRefreshRig(t, false)
	r.settleSharp()
	refresh := r.b.refreshSubmits
	for i := 0; i < 90; i++ {
		r.change(changeLarge)
		r.idle(100 * time.Millisecond)
	}
	if got := r.b.refreshSubmits - refresh; got != 0 {
		t.Fatalf("refresh re-submits during continuous motion = %d, want 0", got)
	}
	r.idle(3 * time.Second)
	if r.b.pictureQP > cbrModelSharpQP {
		t.Fatalf("picture after the motion stopped is blocky: pictureQP=%d", r.b.pictureQP)
	}
}
