package desktop

import (
	"hash/crc32"
	"sync"
	"sync/atomic"
)

// frameDiffer detects unchanged frames via CRC32 hash of raw pixel data.
type frameDiffer struct {
	mu          sync.Mutex
	lastHash    uint32
	hasLastHash bool
	skipped     atomic.Uint64
	total       atomic.Uint64
}

func newFrameDiffer() *frameDiffer {
	return &frameDiffer{}
}

// HasChanged computes CRC32 of the Pix slice and returns true if it
// differs from the last sent frame. Returns true on the first frame.
func (d *frameDiffer) HasChanged(pix []byte) bool {
	d.total.Add(1)
	h := crc32.ChecksumIEEE(pix)

	d.mu.Lock()
	defer d.mu.Unlock()
	if d.hasLastHash && h == d.lastHash {
		d.skipped.Add(1)
		return false
	}
	d.lastHash = h
	d.hasLastHash = true
	return true
}

// HasChangedHint uses a pre-computed frame count from the capturer (e.g. DXGI
// AccumulatedFrames) to decide whether the frame changed, without hashing.
// Returns true when accumulatedFrames > 0, meaning the desktop was redrawn.
func (d *frameDiffer) HasChangedHint(accumulatedFrames uint32) bool {
	d.total.Add(1)
	if accumulatedFrames == 0 {
		d.skipped.Add(1)
		return false
	}
	return true
}

// Reset clears the stored hash (e.g. on config change).
func (d *frameDiffer) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.hasLastHash = false
}

// Stats returns (total frames checked, frames skipped).
func (d *frameDiffer) Stats() (total, skipped uint64) {
	return d.total.Load(), d.skipped.Load()
}
