package desktop

import (
	"hash/crc32"
	"sync/atomic"
)

// frameDiffer detects unchanged frames via CRC32 hash of raw pixel data.
type frameDiffer struct {
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
	if d.hasLastHash && h == d.lastHash {
		d.skipped.Add(1)
		return false
	}
	d.lastHash = h
	d.hasLastHash = true
	return true
}

// Reset clears the stored hash (e.g. on config change).
func (d *frameDiffer) Reset() {
	d.hasLastHash = false
}

// Stats returns (total frames checked, frames skipped).
func (d *frameDiffer) Stats() (total, skipped uint64) {
	return d.total.Load(), d.skipped.Load()
}
