//go:build windows

package backup

import (
	"os"
	"syscall"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// winFileAttrs extracts the preserved Windows file attributes (#5407) from
// info for the manifest. Returns 0 ("unknown") when info did not come from a
// Windows stat — a synthetic os.FileInfo in a test, or a manifest replayed
// from another platform. The preserved set and its rationale live in
// securefs.PreservedWinAttrs, the single source of truth shared with the
// restore side.
func winFileAttrs(info os.FileInfo) uint32 {
	if info == nil {
		return 0
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || data == nil {
		return 0
	}
	return data.FileAttributes & securefs.PreservedWinAttrs
}

func applyWinAttrs(path string, attrs uint32) error { return securefs.ApplyWinAttrs(path, attrs) }
