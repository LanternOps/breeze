package x11

import "time"

// rootGeometryCheckEvery bounds how often the capture path re-reads the root
// window size (one GetGeometry round-trip). A RandR mode change or an xrdp
// client resize resizes the root window; without the re-read the capturer
// keeps grabbing the size it saw at connect (#11754).
const rootGeometryCheckEvery = time.Second

// rootGeometryPoll decides when the capture path re-reads the root size.
type rootGeometryPoll struct {
	last time.Time
}

// due reports whether a check runs now, and if so starts a new interval.
// force (a capture just failed) runs it inside the interval: a shrunk root
// makes GetImage at the old, larger size fail with BadMatch.
func (p *rootGeometryPoll) due(now time.Time, force bool) bool {
	if !force && !p.last.IsZero() && now.Sub(p.last) < rootGeometryCheckEvery {
		return false
	}
	p.last = now
	return true
}

// rootSizeChanged reports whether a GetGeometry reply of newW x newH is a new
// root size. A zero dimension is a bogus reply, not a change.
func rootSizeChanged(curW, curH, newW, newH int) bool {
	if newW <= 0 || newH <= 0 {
		return false
	}
	return newW != curW || newH != curH
}
