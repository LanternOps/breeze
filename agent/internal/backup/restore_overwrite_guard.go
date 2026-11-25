package backup

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// Alternate-location restores must not write over the originals (#12638).
//
// A restore to a target keeps each entry's full path beneath it: the volume
// and leading separators are stripped and the rest is joined under the
// target (filepath.Join(targetBase, restoreRelativePath(...)), the same as
// RestoreKey). That join is the identity whenever the target IS the entry's
// own volume root (`C:\` for `C:\Users\a\x`, `/` for `/home/a/x`), so such
// a restore writes every file back over the original it was backed up from.
// RestoreConfig.AllowOverwriteOriginals asks for exactly that (an in-place
// restore); without it, a restore whose destinations would land on an
// original is refused before anything is written under the target.

// ResultCodeRestoreWouldOverwriteOriginals is RestoreResult.Code for a restore to
// a target that was refused because entries would be written over the
// originals the snapshot holds (#12638).
const ResultCodeRestoreWouldOverwriteOriginals = "restore_would_overwrite_originals"

// ResultCodeRestoreOverwriteCheckFailed is RestoreResult.Code for a restore
// to a target that was refused because the check could not establish that
// the originals are safe: a destination directory, or an original one,
// could not be examined (#12638).
const ResultCodeRestoreOverwriteCheckFailed = "restore_overwrite_check_failed"

type pathStyle int

const (
	styleUnknown pathStyle = iota
	stylePOSIX
	styleWindows
)

// recordedPathStyle is the convention a recorded (manifest) path is written
// in, read from the path itself rather than from the host: a snapshot taken
// on Windows can be restored on a Linux helper and the other way round.
func recordedPathStyle(p string) pathStyle {
	switch {
	case strings.HasPrefix(p, `\\`), len(p) >= 2 && p[1] == ':' && isASCIILetter(p[0]):
		return styleWindows
	case strings.HasPrefix(p, "/"):
		return stylePOSIX
	default:
		return styleUnknown
	}
}

func isASCIILetter(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }

// pathKey is an absolute path reduced to a comparable form in one path style:
// a volume ("c:", `unc\srv\share`, `volume{…}`, "" for POSIX) and its
// components, with "." and ".." resolved and, for Windows, case folded and
// separators unified.
type pathKey struct {
	volume string
	parts  []string
}

func (k pathKey) String() string {
	return k.volume + "/" + strings.Join(k.parts, "/")
}

// contains reports whether other is k or lies beneath it.
func (k pathKey) contains(other pathKey) bool {
	if k.volume != other.volume || len(other.parts) < len(k.parts) {
		return false
	}
	for i, part := range k.parts {
		if other.parts[i] != part {
			return false
		}
	}
	return true
}

// parsePathKey reduces an absolute path written in style to a pathKey. ok is
// false for a path that is not absolute in that style (a relative path, a
// Windows drive-relative `C:x`, a POSIX path read as Windows, …): such a path
// can never name the same location as an absolute one of that style.
func parsePathKey(p string, style pathStyle) (pathKey, bool) {
	switch style {
	case stylePOSIX:
		if !strings.HasPrefix(p, "/") {
			return pathKey{}, false
		}
		return pathKey{parts: cleanParts(strings.Split(p, "/"), false)}, true
	case styleWindows:
		return parseWindowsPathKey(p)
	default:
		return pathKey{}, false
	}
}

func parseWindowsPathKey(p string) (pathKey, bool) {
	p = strings.ReplaceAll(p, "/", `\`)
	// Win32 normalisation (trailing dots and spaces dropped from each
	// component) applies to every form except `\\?\` and `\??\`, which
	// reach the file system as written.
	win32 := true
	var volume, rest string
	switch {
	case strings.HasPrefix(p, `\\?\`), strings.HasPrefix(p, `\??\`), strings.HasPrefix(p, `\\.\`):
		win32 = strings.HasPrefix(p, `\\.\`)
		after := p[4:]
		switch {
		case len(after) >= 2 && after[1] == ':' && isASCIILetter(after[0]):
			volume, rest = after[:2], after[2:]
			if rest != "" && rest[0] != '\\' {
				return pathKey{}, false
			}
		case len(after) >= 4 && strings.EqualFold(after[:4], `UNC\`):
			server, share, tail, ok := splitUNC(after[4:])
			if !ok {
				return pathKey{}, false
			}
			volume, rest = `unc\`+server+`\`+share, tail
		default:
			// A device or volume GUID path: its first component names the
			// volume (`Volume{…}`, `GLOBALROOT`, …).
			first, tail, _ := strings.Cut(after, `\`)
			if first == "" {
				return pathKey{}, false
			}
			volume, rest = first, tail
		}
	case strings.HasPrefix(p, `\\`):
		server, share, tail, ok := splitUNC(p[2:])
		if !ok {
			return pathKey{}, false
		}
		volume, rest = `unc\`+server+`\`+share, tail
	case len(p) >= 2 && p[1] == ':' && isASCIILetter(p[0]):
		volume, rest = p[:2], p[2:]
		if rest != "" && rest[0] != '\\' {
			return pathKey{}, false // drive-relative, e.g. `C:foo`
		}
	default:
		return pathKey{}, false
	}
	return pathKey{volume: strings.ToLower(volume), parts: cleanParts(strings.Split(strings.ToLower(rest), `\`), win32)}, true
}

func splitUNC(p string) (server, share, rest string, ok bool) {
	server, after, found := strings.Cut(p, `\`)
	if !found || server == "" {
		return "", "", "", false
	}
	share, rest, _ = strings.Cut(after, `\`)
	if share == "" {
		return "", "", "", false
	}
	return server, share, rest, true
}

// cleanParts drops empty and "." components and resolves ".." lexically (at
// the root it stays at the root, as both conventions do). trimWin32 also
// drops the trailing dots and spaces Win32 strips from a component.
func cleanParts(raw []string, trimWin32 bool) []string {
	parts := make([]string, 0, len(raw))
	for _, part := range raw {
		if trimWin32 && part != "." && part != ".." {
			part = strings.TrimRight(part, ". ")
		}
		switch part {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, part)
		}
	}
	return parts
}

// restoreDestinationKey is where an alternate-location restore under
// targetBase writes the entry recorded at sourcePath, and the entry's own
// original location, both as pathKeys in the style of the recorded path. The
// destination is targetBase plus sourcePath's components with its volume
// stripped, exactly as the restore places it (see RestoreKey). ok is false when the
// recorded path is not absolute, or the target is not an absolute path of
// the same style (a Windows snapshot restored under a POSIX target): then no
// destination can be an original location of that style.
func restoreDestinationKey(targetBase, sourcePath string) (dest, original pathKey, ok bool) {
	style := recordedPathStyle(sourcePath)
	original, ok = parsePathKey(sourcePath, style)
	if !ok {
		return pathKey{}, pathKey{}, false
	}
	target, ok := parsePathKey(targetBase, style)
	if !ok {
		return pathKey{}, pathKey{}, false
	}
	parts := make([]string, 0, len(target.parts)+len(original.parts))
	dest = pathKey{volume: target.volume, parts: append(append(parts, target.parts...), original.parts...)}
	return dest, original, true
}

// originalsGuard checks, before anything is written under targetBase,
// whether an alternate-location restore would write any selected entry over
// an original location the snapshot was backed up from.
//
// Two checks, both needed:
//   - lexical, in the entry's own path style: the destination equals the
//     recorded path of some entry in the snapshot (itself, when the target is
//     its volume root; another, when the target lies inside the backed-up
//     tree and a nested copy was itself backed up — selected or not). Only
//     originals beneath the target can collide, so only those are kept
//     (noteOriginal sees every manifest entry as it is decoded).
//   - by identity, for entries recorded in this host's style: a destination
//     directory that is the original's directory under another name (a
//     volume GUID or `\\?\` spelling, a SUBST drive, a bind mount, a link to
//     the root). Each distinct directory is compared once, from the target
//     down, stopping at the first destination or original directory that
//     does not exist.
//
// A safety check, not an atomic guarantee: a mount or link created under the
// target after it runs is not seen (the per-file writes still refuse links).
type originalsGuard struct {
	targetBase string
	targetKeys map[pathStyle]pathKey
	under      map[string]string // pathKey string → the recorded path it came from
	identity   *dirIdentityCheck
}

func newOriginalsGuard(targetBase string) *originalsGuard {
	g := &originalsGuard{targetBase: targetBase, targetKeys: map[pathStyle]pathKey{}, under: map[string]string{}, identity: newDirIdentityCheck(targetBase)}
	for _, style := range []pathStyle{stylePOSIX, styleWindows} {
		if k, ok := parsePathKey(targetBase, style); ok {
			g.targetKeys[style] = k
		}
	}
	return g
}

// noteOriginal records a recorded path the snapshot holds, selected or not,
// when it lies beneath the target.
func (g *originalsGuard) noteOriginal(recorded string) {
	style := recordedPathStyle(recorded)
	target, ok := g.targetKeys[style]
	if !ok {
		return
	}
	if original, ok := parsePathKey(recorded, style); ok && target.contains(original) {
		g.under[original.String()] = recorded
	}
}

// observing wraps a manifest-decode predicate so every entry is noted before
// keep decides whether the restore selected it (nil keep: all are).
func (g *originalsGuard) observing(keep func(*SnapshotFile) bool) func(*SnapshotFile) bool {
	return func(f *SnapshotFile) bool {
		g.noteOriginal(restoreSourcePath(*f))
		return keep == nil || keep(f)
	}
}

// overwriteFinding is the outcome of originalsGuard.check: how many selected
// entries would land on an original, one of them with the original it would
// overwrite, and the first error that left an entry unchecked.
type overwriteFinding struct {
	count            int
	entry, overwrite string
	uncheckedErr     error
}

// check examines the selected entries (each by its recorded path,
// restoreSourcePath's rule). Every original the snapshot holds must have
// been noted first. An entry whose identity could not be examined does not
// stop the check: definite hits are still counted and reported first.
func (g *originalsGuard) check(recorded []string) overwriteFinding {
	var f overwriteFinding
	for _, p := range recorded {
		overwritten := ""
		if len(g.under) > 0 {
			if dest, _, ok := restoreDestinationKey(g.targetBase, p); ok {
				overwritten = g.under[dest.String()]
			}
		}
		if overwritten == "" {
			same, err := g.identity.aliasesOriginal(p)
			if err != nil {
				if f.uncheckedErr == nil {
					f.uncheckedErr = err
				}
				continue
			}
			if same {
				overwritten = p
			}
		}
		if overwritten != "" {
			if f.count == 0 {
				f.entry, f.overwrite = p, overwritten
			}
			f.count++
		}
	}
	return f
}

// dirIdentityCheck compares destination directories with original ones by
// file identity (os.SameFile), caching each directory's verdict.
type dirIdentityCheck struct {
	targetBase string
	hostStyle  pathStyle
	stat       func(string) (os.FileInfo, error)
	sameFile   func(a, b os.FileInfo) bool
	verdicts   map[string]dirVerdict
}

type dirVerdict int

const (
	dirDistinct dirVerdict = iota + 1 // both exist, different directories: look deeper
	dirAbsent                         // the destination does not exist yet: nothing deeper can alias
	dirAlias                          // the destination IS the original directory
)

func newDirIdentityCheck(targetBase string) *dirIdentityCheck {
	host := stylePOSIX
	if runtime.GOOS == "windows" {
		host = styleWindows
	}
	return &dirIdentityCheck{targetBase: targetBase, hostStyle: host, stat: os.Stat, sameFile: os.SameFile, verdicts: map[string]dirVerdict{}}
}

// aliasesOriginal reports whether the entry recorded at sourcePath restores
// onto, or beneath, a path that is the matching original itself. Entries recorded in another path style
// than the host's never name a directory on this host.
func (c *dirIdentityCheck) aliasesOriginal(sourcePath string) (bool, error) {
	if recordedPathStyle(sourcePath) != c.hostStyle {
		return false, nil
	}
	relative, err := restoreRelativePath(sourcePath)
	if err != nil {
		return false, nil // refused per entry by the restore passes
	}
	volume := volumeName(sourcePath)
	originalRoot := volume + string(filepath.Separator)
	// The entry's ancestors and the entry itself: a directory entry sitting
	// exactly where an alias begins would otherwise put its metadata on the
	// original directory unseen.
	dirs := strings.Split(relative, string(filepath.Separator))
	rel := ""
	for depth := 0; depth <= len(dirs); depth++ {
		if depth > 0 {
			rel = filepath.Join(rel, dirs[depth-1])
		}
		// Keyed by the original's volume too: `C:\x` and `D:\x` restore to
		// the same destination directory but are different originals.
		key := strings.ToLower(volume) + "|" + rel
		verdict, ok := c.verdicts[key]
		if !ok {
			verdict, err = c.compare(filepath.Join(c.targetBase, rel), filepath.Join(originalRoot, rel))
			if err != nil {
				return false, err
			}
			c.verdicts[key] = verdict
		}
		switch verdict {
		case dirAlias:
			return true, nil
		case dirAbsent:
			return false, nil
		}
	}
	return false, nil
}

func (c *dirIdentityCheck) compare(dest, original string) (dirVerdict, error) {
	destInfo, err := c.stat(dest)
	if notADirectory(err) {
		return dirAbsent, nil
	}
	if err != nil {
		// Fail closed: a destination that exists but cannot be examined
		// cannot be shown not to be an original.
		return 0, fmt.Errorf("examine restore destination %s: %w", dest, err)
	}
	originalInfo, err := c.stat(original)
	if errors.Is(err, fs.ErrPermission) {
		// It may well exist, so it may be what the destination is: fail
		// closed.
		return 0, fmt.Errorf("examine original location %s: %w", original, err)
	}
	if err != nil {
		// No reachable original directory (gone since the backup, a share
		// that cannot be reached, a drive with no media): the destination,
		// which this host could open, cannot be it, and nothing at or
		// beneath it can be overwritten through this directory. The
		// lexical check still applies.
		return dirAbsent, nil
	}
	if c.sameFile(destInfo, originalInfo) {
		return dirAlias, nil
	}
	return dirDistinct, nil
}

// refuseRestoreOverOriginals runs the guard over every entry the restore
// selected (files, symlinks, directories, junctions) and, when any would
// land on an original or could not be checked, marks result failed and
// reports true: the caller returns it without writing anything. Reported as
// a result body (nil error) so the code and the reason reach the server.
func refuseRestoreOverOriginals(g *originalsGuard, files, links, dirs []SnapshotFile, junctions []SnapshotJunction, result *RestoreResult) bool {
	recorded := make([]string, 0, len(files)+len(links)+len(dirs)+len(junctions))
	for _, group := range [][]SnapshotFile{files, links, dirs} {
		for _, f := range group {
			recorded = append(recorded, restoreSourcePath(f))
		}
	}
	for _, j := range junctions {
		recorded = append(recorded, j.restorePath())
	}
	f := g.check(recorded)
	switch {
	case f.count > 0:
		result.Code = ResultCodeRestoreWouldOverwriteOriginals
		result.Error = alternateRestoreRefusal(g.targetBase, f)
	case f.uncheckedErr != nil:
		result.Code = ResultCodeRestoreOverwriteCheckFailed
		result.Error = fmt.Sprintf("restore refused: could not confirm that restoring to %s leaves the original files untouched (%v). Choose a new, empty folder as the target; nothing was written", g.targetBase, f.uncheckedErr)
	default:
		return false
	}
	result.Status = "failed"
	slog.Warn("restore refused by the originals guard",
		"snapshotId", result.SnapshotID, "targetPath", g.targetBase, "code", result.Code, "entries", f.count, "error", result.Error)
	return true
}

// notADirectory reports a stat error that establishes there is no directory
// at the path: it does not exist, or a component is not a directory. Any
// other error leaves the identity unresolved.
func notADirectory(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// alternateRestoreRefusal is the error text for a refused restore: what was
// refused, why, and what the operator can do instead.
func alternateRestoreRefusal(targetBase string, f overwriteFinding) string {
	example := f.entry
	if f.overwrite != f.entry {
		example = fmt.Sprintf("%s would overwrite %s", f.entry, f.overwrite)
	}
	return fmt.Sprintf("restore refused: restoring to %s would write %d item(s) over files this snapshot was backed up from (for example %s); nothing was written. Choose a new, empty folder outside the backed-up folders as the target. To overwrite the originals on purpose, restore to the root of the drive they came from and confirm overwriting the original files",
		targetBase, f.count, example)
}
