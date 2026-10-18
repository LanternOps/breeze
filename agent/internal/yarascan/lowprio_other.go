//go:build !windows && !linux

package yarascan

import "sync"

var lowPrioNoticeOnce sync.Once

// EnterBackgroundThread is a logged no-op on macOS (Open Decision 11):
// per-thread I/O policy needs setiopolicy_np, which needs cgo, and the scan
// path stays cgo-free. Follow-up tracked on #6263.
func EnterBackgroundThread() {
	lowPrioNoticeOnce.Do(func() {
		log.Info("IOC scan workers run at normal priority on this platform (background priority not implemented)")
	})
}
