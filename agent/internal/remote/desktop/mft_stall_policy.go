package desktop

// mftStallThreshold is the maximum consecutive nil outputs from a hardware MFT
// before the pipeline is flushed and restarted. Hardware MFTs (Intel Quick
// Sync, etc.) can stall permanently on certain GPUs. Flushing at 8 frames
// (~133ms at 60fps) breaks the stall with acceptable quality loss (one IDR
// keyframe) and must trigger before the screen goes idle, otherwise the stall
// counter freezes.
const mftStallThreshold = 8

// mftSoftwareStallThreshold is the same limit for Microsoft's software H264
// MFT. That encoder returns no output for its first 5–7 inputs after every
// initialization or flush (lab log, #11622), so the hardware threshold — 4
// after a recent stall flush — flushed it mid-warm-up and discarded the very
// frames it was about to emit. A wedged software MFT is still detected within
// about half a second of continuous input.
const mftSoftwareStallThreshold = 16

// mftNilStallThresholds returns, for an MFT, how many consecutive empty
// outputs trigger a stall flush (flushAt) and how many make Encode refuse
// further input and mark the encoder permanently stalled (refuseAt).
// recentStallFlush is true within 10 s of the last stall flush.
func mftNilStallThresholds(isHW, recentStallFlush bool) (flushAt, refuseAt int) {
	if !isHW {
		return mftSoftwareStallThreshold, mftSoftwareStallThreshold
	}
	flushAt = mftStallThreshold
	if recentStallFlush {
		flushAt = mftStallThreshold / 2
	}
	return flushAt, mftStallThreshold
}
