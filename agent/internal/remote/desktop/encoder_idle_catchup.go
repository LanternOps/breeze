package desktop

// Idle catch-up for synchronous encoders that hold input frames (#11622).
//
// Screen capture only submits a frame when the screen changes, so on a quiet
// desktop the encoder may go minutes between inputs. An encoder that keeps N
// input frames before it emits the first output (Microsoft's software H264 MFT
// keeps 5 unless low-latency mode is set before media-type negotiation) then
// holds the last N screen changes until N more changes arrive, and the viewer
// shows a picture that is minutes old.
//
// idleCatchUp is the platform-neutral bookkeeping for the fix: the encoder
// records every frame it submits and every output it returns, and the capture
// loop, when it has no new frame, asks whether the newest submitted frame is
// still inside the encoder. If it is, the encoder re-submits a copy of that
// frame, which pushes one held frame out. The work is bounded per real frame
// so a static screen stops costing CPU once the viewer has caught up.

// maxIdleCatchUpRefeeds bounds the re-submits made for one real frame. It
// covers the 5-frame hold measured on the software MFT plus the same again for
// a warm-up after a flush, and stays below mftSoftwareStallThreshold so the
// re-submits alone cannot trip the stall flush. Only the software MFT uses
// the catch-up; hardware MFTs, whose stall flush fires at 4–8 empty outputs,
// never re-submit.
const maxIdleCatchUpRefeeds = 12

// idleCatchUp counts inputs and outputs in the current encoder stream. A
// stream ends at a flush or re-initialization (reset), which discards every
// frame still inside the encoder. It assumes the encoder returns outputs in
// input order, one per input, once it has warmed up.
type idleCatchUp struct {
	submitted uint64 // inputs accepted in this stream
	emitted   uint64 // outputs returned in this stream
	// newest is the submit index (1-based, this stream) of the frame the viewer
	// must eventually see: the newest real frame, or the re-submit that stands
	// in for it after a reset. 0 means nothing is owed in this stream.
	newest uint64
	// lost is set when a reset discarded the newest frame before it came out;
	// the next re-submit carries the same pixels into the new stream.
	lost bool
	// refeeds counts re-submits since the newest real frame.
	refeeds int
}

// noteSubmitted records an input the encoder accepted. refeed is true for an
// idle re-submit of the last frame (made after startRefeed), false for a newly
// captured frame.
func (c *idleCatchUp) noteSubmitted(refeed bool) {
	c.submitted++
	if !refeed {
		c.newest = c.submitted
		c.refeeds = 0
		c.lost = false
		return
	}
	if c.lost {
		c.newest = c.submitted
		c.lost = false
	}
}

// noteFiller records an input that is neither a captured frame nor a
// re-submit (the blank frames that prime a freshly re-initialized encoder),
// so their outputs are not mistaken for the newest frame.
func (c *idleCatchUp) noteFiller() {
	c.submitted++
}

// noteEmitted records one output returned by the encoder.
func (c *idleCatchUp) noteEmitted() {
	if c.emitted < c.submitted {
		c.emitted++
	}
}

// noteReset records a flush or re-initialization: every frame still inside
// the encoder is gone.
func (c *idleCatchUp) noteReset() {
	if c.newest > c.emitted {
		c.lost = true
	}
	c.submitted = 0
	c.emitted = 0
	c.newest = 0
}

// clear forgets everything, for when the retained frame is no longer valid
// (encoder torn down, dimensions changed).
func (c *idleCatchUp) clear() {
	*c = idleCatchUp{}
}

// held is the number of submitted frames that have not come out yet.
func (c *idleCatchUp) held() int {
	return int(c.submitted - c.emitted)
}

// wantsRefeed reports whether an idle capture loop should re-submit the last
// frame: the newest frame has not come out (or was discarded by a reset) and
// the per-frame budget is not spent.
func (c *idleCatchUp) wantsRefeed() bool {
	if c.refeeds >= maxIdleCatchUpRefeeds {
		return false
	}
	return c.lost || c.newest > c.emitted
}

// startRefeed claims one re-submit from the budget when one is wanted. The
// attempt counts even if the encoder then rejects the input, so a failing
// encoder cannot turn a static screen into a busy loop.
func (c *idleCatchUp) startRefeed() bool {
	if !c.wantsRefeed() {
		return false
	}
	c.refeeds++
	return true
}
