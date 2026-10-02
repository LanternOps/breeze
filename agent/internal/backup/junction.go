package backup

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// NTFS junctions backed up as links (#7325).
//
// A junction (IO_REPARSE_TAG_MOUNT_POINT whose target is a drive path) is not
// traversed: following one can back the same data up twice or loop, and the
// legacy profile junctions ("Application Data", "My Music", ...) point back up
// their own tree. Before #7325 they were skipped and only named on the job
// Warning (#7051). Now each one whose target is an ordinary drive path is
// recorded as a link and recreated on restore. Volume mount points (and any
// junction whose target is not a drive path) are still skipped and still
// reported: restoring one means re-mounting a volume, which is outside a file
// restore.
//
// Manifest format. Junctions live in their own top-level array,
// Snapshot.Junctions, never in Snapshot.Files. Every reader shipped before
// #7325 ignores an unknown top-level JSON field, so an older agent, an older
// recovery medium or an older API reads a new manifest exactly as it read a
// pre-#7325 one: the junction is simply absent, as it always was. A new entry
// kind in Files would not be safe: the agent restore treats an unknown kind as
// a content file and fails it with an empty object key (status partial), the
// bare-metal reinstall-then-recover path counts it toward its
// consecutive-failure breaker, and the API's result schema enumerates the
// kinds it accepts, so the whole result would fail to parse.

// SnapshotJunction is one NTFS directory junction captured as a link.
type SnapshotJunction struct {
	// SourcePath is where the walk found the junction (a VSS shadow-copy
	// device path on a VSS run); OriginalPath is the live path it mirrors,
	// set only when VSS rewrote SourcePath. Same pair as SnapshotFile.
	SourcePath   string `json:"sourcePath"`
	OriginalPath string `json:"originalPath,omitempty"`
	// Target is the junction's substitute name without its "\??\" prefix,
	// an ordinary drive path such as `C:\Users\a\Music` (see
	// securefs.ValidJunctionTarget). It is recorded as captured: a restore
	// to another location rewrites it (junctionRestoreTarget).
	Target  string    `json:"target"`
	ModTime time.Time `json:"modTime"`
	// WinAttrs is the junction's own preserved Windows attributes; the
	// legacy profile junctions are Hidden and System.
	WinAttrs uint32 `json:"winAttrs,omitempty"`
}

// restorePath is the path the junction restores under: OriginalPath when VSS
// rewrote SourcePath, else SourcePath (restoreSourcePath's rule).
func (j SnapshotJunction) restorePath() string {
	if j.OriginalPath != "" {
		return j.OriginalPath
	}
	return j.SourcePath
}

// RestoreJunctionVolume is the drive (e.g. "C:") a junction restores from,
// for the rebuild engine's single-volume preflight (RestoreVolume's
// counterpart). "" when the recorded path carries no drive letter.
func RestoreJunctionVolume(j SnapshotJunction) string {
	return driveVolume(j.restorePath())
}

// capturedJunction turns a reparse point the walk met into a junction entry
// when it is one this build can restore. ok is false for a volume mount point,
// any other tag, and a junction whose target is not an ordinary drive path;
// for the last, sp.detail is set so the skip on the Warning says why.
func capturedJunction(sp *skippedReparsePoint, info os.FileInfo) (SnapshotJunction, bool) {
	if sp.kind != reparseKindJunction {
		return SnapshotJunction{}, false
	}
	if err := securefs.ValidJunctionTarget(sp.target); err != nil {
		if sp.detail == "" {
			sp.detail = "target is not a drive path, not captured"
		}
		return SnapshotJunction{}, false
	}
	return SnapshotJunction{
		SourcePath: sp.path,
		Target:     sp.target,
		ModTime:    info.ModTime(),
		WinAttrs:   winFileAttrs(info),
	}, true
}

// driveVolume returns p's drive ("C:") or "" when p does not start with one.
// Written out rather than taken from filepath.VolumeName so that Windows
// manifest paths are read the same way on every platform.
func driveVolume(p string) string {
	if len(p) >= 2 && p[1] == ':' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) {
		return p[:2]
	}
	return ""
}

// junctionRestoreTarget decides what a restored junction points at.
//
//   - asCaptured (a whole-machine rebuild, never a command payload): the
//     target as recorded. The rebuilt volume becomes the machine the target
//     names, even though the restore writes through another drive letter or a
//     volume GUID path.
//   - In place (the restore root is the junction's own volume root, e.g.
//     `C:\`): the target as recorded. That is the original.
//   - Any other location: the target rewritten the way every entry is placed,
//     restore root plus the path with its drive stripped, so
//     `C:\Users\a\Music` restored under `D:\restore` points at
//     `D:\restore\Users\a\Music`. Refused when the target is on a different
//     volume than the junction: there is nothing under the restore root it
//     could mean, and pointing outside the restore location is exactly what
//     an alternate-location restore must never do. rewritten reports this
//     case; the caller must then also refuse a target that resolves through
//     a reparse point (see restoreJunctions).
//
// The recorded target is manifest input and is validated in every case.
func junctionRestoreTarget(targetBase, source, target string, asCaptured bool) (resolved string, rewritten bool, err error) {
	if err := securefs.ValidJunctionTarget(target); err != nil {
		return "", false, err
	}
	if asCaptured {
		return target, false, nil
	}
	sourceVol := driveVolume(source)
	base := strings.TrimRight(targetBase, `\/`)
	if sourceVol != "" && strings.EqualFold(base, sourceVol) {
		return target, false, nil
	}
	if sourceVol == "" || !strings.EqualFold(driveVolume(target), sourceVol) {
		return "", false, fmt.Errorf("target %s is on another volume than the junction, outside the restore location", target)
	}
	switch rest := target[3:]; {
	case rest != "":
		resolved = base + `\` + rest
	case driveVolume(base) == base:
		resolved = base + `\` // restore root is itself a volume root, e.g. `D:\`
	default:
		resolved = base
	}
	if err := securefs.ValidJunctionTarget(resolved); err != nil {
		return "", false, fmt.Errorf("target %s cannot be placed under the restore location %s: %w", target, targetBase, err)
	}
	return resolved, true, nil
}

// Seams over the securefs calls, so the junction pass can be driven on hosts
// that have no junctions.
var (
	installJunction            = securefs.InstallJunction
	ensureNoReparsePointsAlong = securefs.EnsureNoReparsePointsAlong
)

// restoreJunctions recreates the selected junctions under targetBase. It runs
// after every file, symlink and directory is in place, so no other entry is
// ever written through a junction this pass creates.
//
// Outcomes: a created (or already-correct) junction counts as restored; one
// whose placement path is invalid or whose creation fails counts as failed,
// like a symlink; one whose target is refused (outside the restore location,
// unsafe, or resolving through a reparse point) is a warning, not a failure:
// it is a deliberate skip, as the backup's own skip of a volume mount point
// is. A host with no junctions (a Windows snapshot restored elsewhere) gets
// one summary warning.
func restoreJunctions(targetBase string, junctions []SnapshotJunction, asCaptured bool, result *RestoreResult) {
	unsupported := 0
	for _, j := range junctions {
		display := j.restorePath()
		relative, err := restoreRelativePath(display)
		if err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, display)
			result.Warnings = append(result.Warnings, fmt.Sprintf("invalid restore path for junction %s: %v", display, err))
			continue
		}
		target, rewritten, err := junctionRestoreTarget(targetBase, display, j.Target, asCaptured)
		if err == nil && rewritten {
			// Lexical containment is not enough: a component of the
			// rewritten target that is itself a link (a restored symlink,
			// say) would carry the junction outside the restore location.
			// The rewritten target is targetBase plus the recorded target
			// with its drive stripped, so that remainder is the path to
			// walk. Empty for a volume-root target: the restore root itself.
			if rest := j.Target[3:]; rest != "" {
				if alongErr := ensureNoReparsePointsAlong(targetBase, rest); alongErr != nil {
					err = fmt.Errorf("target %s resolves through a link: %w", target, alongErr)
				}
			}
		}
		if err != nil {
			result.Warnings = append(result.Warnings, fmt.Sprintf("junction %s not recreated: %v", display, err))
			continue
		}
		warnings, err := installJunction(targetBase, relative, target, j.WinAttrs)
		if errors.Is(err, securefs.ErrJunctionUnsupported) {
			unsupported++
			continue
		}
		if err != nil {
			result.FilesFailed++
			result.FailedFiles = append(result.FailedFiles, display)
			result.Warnings = append(result.Warnings, fmt.Sprintf("could not recreate junction %s: %v", display, err))
			continue
		}
		for _, w := range warnings {
			result.Warnings = append(result.Warnings, fmt.Sprintf("recreated junction %s with reduced fidelity: %v", display, w))
		}
		result.FilesRestored++
	}
	if unsupported > 0 {
		result.Warnings = append(result.Warnings, fmt.Sprintf("%d junction(s) not recreated: %v", unsupported, securefs.ErrJunctionUnsupported))
	}
}

// filterJunctions is filterFiles for junctions: the same selection rule,
// applied to the path the junction restores under.
func filterJunctions(junctions []SnapshotJunction, selectedPaths []string) []SnapshotJunction {
	if len(selectedPaths) == 0 {
		return junctions
	}
	var matched []SnapshotJunction
	for _, j := range junctions {
		for _, selected := range selectedPaths {
			if pathSelectionMatches(j.restorePath(), selected) {
				matched = append(matched, j)
				break
			}
		}
	}
	return matched
}
