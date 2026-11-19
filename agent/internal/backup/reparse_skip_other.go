//go:build !windows

package backup

import "os"

// platformSkippedReparsePoint: reparse points exist only on Windows. A Unix
// FIFO, socket or device node the collector skips is not recorded (#7051).
func platformSkippedReparsePoint(string, os.FileInfo) (skippedReparsePoint, bool) {
	return skippedReparsePoint{}, false
}

// platformRawWinAttrs: Windows file attributes do not exist here (#7326).
func platformRawWinAttrs(os.FileInfo) uint32 { return 0 }
