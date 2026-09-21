//go:build !windows

package backup

import "os"

// winFileAttrs/applyWinAttrs are no-ops off Windows — SnapshotFile.WinAttrs
// stays 0 ("unknown") there. See winattrs_windows.go and
// securefs.PreservedWinAttrs.
func winFileAttrs(_ os.FileInfo) uint32 { return 0 }

func applyWinAttrs(_ string, _ uint32) error { return nil }
