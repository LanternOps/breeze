package backup

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// restoreApplyWinAttrs is applyWinAttrs (winattrs_windows.go/winattrs_other.go)
// as the restore's directory post-pass calls it. A var only so untagged tests
// can record which directories get attributes, and when, on any host.
var restoreApplyWinAttrs = applyWinAttrs

// pendingDirAttrs is one restored directory whose preserved Windows
// attributes (#5407) are still to be applied.
type pendingDirAttrs struct {
	relative, display string
	attrs             uint32
}

// applyDirWinAttrs is the restore's directory-attribute post-pass (#6506).
// It runs once every file, symlink and directory is in place, so a
// directory's attributes are never set while its contents are still being
// written beneath it, and BEFORE the directory security-descriptor
// post-pass, whose restrictive DACL could otherwise deny the
// FILE_WRITE_ATTRIBUTES this needs. Deepest first, matching that pass.
// Best-effort: losing a directory attribute is a fidelity warning, never a
// failed restore.
func applyDirWinAttrs(targetBase string, pending []pendingDirAttrs) []string {
	sort.SliceStable(pending, func(i, j int) bool {
		return strings.Count(pending[i].relative, string(filepath.Separator)) > strings.Count(pending[j].relative, string(filepath.Separator))
	})
	var warnings []string
	for _, p := range pending {
		if err := restoreApplyWinAttrs(filepath.Join(targetBase, p.relative), p.attrs); err != nil {
			warnings = append(warnings, fmt.Sprintf("recreated %s with reduced fidelity: could not reapply windows attributes: %v", p.display, err))
		}
	}
	return warnings
}
