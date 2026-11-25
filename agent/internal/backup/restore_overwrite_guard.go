package backup

import (
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"
)

// Alternate-location restores must not write over the originals (#12638).
//
// A restore to a target keeps each entry's full path beneath it: every
// writer places an entry at filepath.Join(targetBase, restoreRelativePath(p))
// (the volume, by this host's filepath.VolumeName, and the leading
// separators are stripped; the rest is joined under the target). That join
// is the identity whenever the target IS the entry's own volume root (`C:\`
// for `C:\Users\a\x`, `/` for `/home/a/x`), so such a restore writes every
// file back over the original it was backed up from.
// RestoreConfig.AllowOverwriteOriginals asks for exactly that (an in-place
// restore); without it, a restore whose destinations would land on an
// original is refused before anything is written under the target.
//
// The guard is lexical and never touches the file system: it compares the
// destination placement computes with the location each recorded path
// names on this host, both read by one parser in this host's convention.
// A target that reaches the original tree through an alias (a substituted
// drive, a mount, a link to a volume root) is not detected, with one
// exception on macOS: /System/Volumes/Data is read as / there
// (withoutDarwinDataVolume).

// ResultCodeRestoreWouldOverwriteOriginals is RestoreResult.Code for a restore to
// a target that was refused because entries would be written over the
// originals the snapshot holds (#12638).
const ResultCodeRestoreWouldOverwriteOriginals = "restore_would_overwrite_originals"

// ResultCodeRestoreOverwriteCheckFailed is RestoreResult.Code for a restore
// to a target that was refused because the check could not establish that
// the originals are safe: a recorded path it cannot place on this host, or
// a second read of the snapshot that failed (#12638).
const ResultCodeRestoreOverwriteCheckFailed = "restore_overwrite_check_failed"

type pathStyle int

const (
	stylePOSIX pathStyle = iota + 1
	styleWindows
	// styleDarwin is POSIX with names compared as the default macOS volume
	// (APFS) compares them: ignoring case and Unicode normalisation.
	styleDarwin
)

// hostPathStyle is the convention this host's filepath package (and so the
// restore's placement) reads paths in, and how its default volume compares
// names.
func hostPathStyle() pathStyle {
	switch runtime.GOOS {
	case "windows":
		return styleWindows
	case "darwin":
		return styleDarwin
	}
	return stylePOSIX
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

// parsePathKey reduces a fully qualified path written in style to a pathKey.
// ok is false for a path that is not fully qualified in that style (a
// relative path, a Windows drive-relative `C:x` or rooted `\x`, …).
func parsePathKey(p string, style pathStyle) (pathKey, bool) {
	switch style {
	case stylePOSIX:
		if !strings.HasPrefix(p, "/") {
			return pathKey{}, false
		}
		return pathKey{parts: cleanParts(strings.Split(p, "/"), false)}, true
	case styleDarwin:
		if !strings.HasPrefix(p, "/") {
			return pathKey{}, false
		}
		// Folded (case and normalisation, foldObjectKey) because the
		// default APFS volume treats such names as one. On a case-sensitive
		// volume this only adds refusals, the safe direction.
		parts := cleanParts(strings.Split(p, "/"), false)
		for i, part := range parts {
			parts[i] = foldObjectKey(part)
		}
		// Targets, destinations and recorded paths all pass here, so a
		// path beneath /System/Volumes/Data meets its firmlinked twin.
		return pathKey{parts: withoutDarwinDataVolume(parts)}, true
	case styleWindows:
		return parseWindowsPathKey(p)
	default:
		return pathKey{}, false
	}
}

// darwinDataVolume is /System/Volumes/Data, folded as styleDarwin folds
// components. On macOS it is the data volume's own mount point: the
// firmlinked folders under / (/Users, /Applications, /private, …) are the
// same directories as the ones beneath it.
var darwinDataVolume = []string{foldObjectKey("System"), foldObjectKey("Volumes"), foldObjectKey("Data")}

// withoutDarwinDataVolume keys a folded, cleaned macOS path beneath
// /System/Volumes/Data as if that prefix were /, so a target or a recorded
// path spelled either way names the same location (#12671). Not every
// folder under / is firmlinked to the data volume (/System is not), so this
// can refuse a restore that would not have touched an original: the safe
// direction. The prefix is removed once.
func withoutDarwinDataVolume(parts []string) []string {
	if len(parts) < len(darwinDataVolume) {
		return parts
	}
	for i, part := range darwinDataVolume {
		if parts[i] != part {
			return parts
		}
	}
	return parts[len(darwinDataVolume):]
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
		if rest == "" || rest[0] != '\\' {
			return pathKey{}, false // drive-relative: `C:foo`, or the bare `C:`
		}
	default:
		return pathKey{}, false
	}
	// Components fold to upper case, as NTFS compares names (its upcase
	// table); a fold that differs only over-refuses.
	return pathKey{volume: strings.ToLower(volume), parts: cleanParts(strings.Split(strings.ToUpper(rest), `\`), win32)}, true
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

// errUnplaceablePath is why the check could not read a path: it is not a
// location the check can name on this host.
var errUnplaceablePath = errors.New("the check cannot tell which location on this computer this path names")

// errDestinationOutsideTarget is why a target fails the check: a computed
// destination does not fall under it as the check reads it.
var errDestinationOutsideTarget = errors.New("a restored file's location under this target does not fall under it as the check reads it; choose a folder on a drive or a share")

// uncheckedPathError is a path the check could not read: the first one is
// named in the refusal.
type uncheckedPathError struct {
	what string // "restore target", "restore destination" or "recorded path"
	path string
	err  error
}

func (e *uncheckedPathError) Error() string {
	return fmt.Sprintf("examine %s %s: %v", e.what, e.path, e.err)
}

func (e *uncheckedPathError) Unwrap() error { return e.err }

// originalsGuard checks, before anything is written under targetBase,
// whether an alternate-location restore would write any selected entry over
// an original location the snapshot was backed up from.
//
// The check is lexical, in this host's convention: a selected entry's
// destination (destinationKey, placement's own expression) equals the
// location some recorded path names (originalKey): its own, when the target
// is its volume root; another's, when the target lies inside the backed-up
// tree and a nested copy was itself backed up, selected or not. Every
// destination lies beneath the target, so only an original beneath it can
// collide. A path the guard cannot read fails the check: it is never
// assumed safe.
//
// Memory follows the selection, not the snapshot (the #11234 bound): while
// the manifest streams, the guard keeps one flag (does any original lie
// beneath the target?) and the first path it could not read, not the
// originals. check indexes the selected entries' destinations and streams
// the originals a second time against that index (its originals argument).
type originalsGuard struct {
	targetBase string
	host       pathStyle
	target     pathKey
	targetOK   bool
	// originalsBeneath is set when an original noted while the manifest
	// streamed lies beneath the target: without one, no destination can
	// be another entry's original and the second pass is skipped.
	originalsBeneath bool
	// unreadable is the first noted original the guard could not read.
	unreadable error
}

func newOriginalsGuard(targetBase string) *originalsGuard {
	return newOriginalsGuardFor(targetBase, hostPathStyle())
}

func newOriginalsGuardFor(targetBase string, host pathStyle) *originalsGuard {
	g := &originalsGuard{targetBase: targetBase, host: host}
	g.target, g.targetOK = parsePathKey(targetBase, host)
	if g.targetOK && host == styleWindows && g.target.volume == "unc" {
		// `\\?\UNC` (any spelling) with no server and share names no
		// folder: Go's volume rule and the parser part ways under it.
		g.targetOK = false
	}
	return g
}

// destinationKey is where the restore writes the entry recorded at
// recorded: filepath.Join(targetBase, restoreRelativePath(recorded)), the
// expression every writer uses (the link/directory pass and
// restrictDirectoriesFirst in restore.go, contentRestorer.admit,
// restoreJunctions). placed is false when restoreRelativePath refuses the
// path: every writer then skips the entry and counts it failed, so it
// writes nothing and cannot overwrite anything.
func (g *originalsGuard) destinationKey(recorded string) (dest pathKey, placed bool, err error) {
	rel, relErr := restoreRelativePath(recorded)
	if relErr != nil {
		return pathKey{}, false, nil
	}
	joined := filepath.Join(g.targetBase, rel)
	dest, ok := parsePathKey(joined, g.host)
	if !ok {
		return pathKey{}, true, &uncheckedPathError{what: "restore destination", path: joined, err: errUnplaceablePath}
	}
	return dest, true, nil
}

// originalKey is the location the recorded path names on this host. A fully
// qualified path names itself. Any other is read where an in-place restore
// would place it, by placement's own expression with the target at a
// volume root: filepath.Join(root, stripVolumeAndLeadingSeparators(p)),
// where root is the path's own volume (`C:x` → `C:\x`) or, when it has no
// volume by this host's filepath.VolumeName (`\Users\x`, a POSIX path on
// Windows, any Windows path on POSIX), the target's: the only reading
// under which placement's join is the identity. A path that still does not
// parse (`\\srv` with no share, `\\?\c:x`) is an error: never assumed safe.
func (g *originalsGuard) originalKey(recorded string) (pathKey, error) {
	if k, ok := parsePathKey(recorded, g.host); ok {
		return k, nil
	}
	vol := volumeName(recorded)
	if vol == "" {
		vol = volumeName(g.targetBase)
	}
	// vol + separator + rest is filepath.Join's operands; the parser does
	// Join's cleaning (and reads it the same on a host emulating the other).
	if k, ok := parsePathKey(vol+g.separator()+stripVolumeAndLeadingSeparators(recorded), g.host); ok {
		return k, nil
	}
	return pathKey{}, &uncheckedPathError{what: "recorded path", path: recorded, err: errUnplaceablePath}
}

func (g *originalsGuard) separator() string {
	if g.host == styleWindows {
		return `\`
	}
	return "/"
}

// noteOriginal sees a recorded path the snapshot holds, selected or not, and
// remembers only whether one lies beneath the target, and the first it
// could not read.
func (g *originalsGuard) noteOriginal(recorded string) {
	k, err := g.originalKey(recorded)
	if err != nil {
		if g.unreadable == nil {
			g.unreadable = err
		}
		return
	}
	if !g.originalsBeneath && g.targetOK && g.target.contains(k) {
		g.originalsBeneath = true
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
// overwrite, and the first error that left the check unfinished.
type overwriteFinding struct {
	count            int
	entry, overwrite string
	uncheckedErr     error
}

// originalSource streams every recorded path the snapshot holds (each by
// restoreSourcePath's rule), selected or not, to yield.
type originalSource func(yield func(recorded string)) error

// originalsOf is an originalSource over paths already in memory.
func originalsOf(recorded ...[]string) originalSource {
	return func(yield func(string)) error {
		for _, group := range recorded {
			for _, p := range group {
				yield(p)
			}
		}
		return nil
	}
}

// check examines the selected entries (each by its recorded path,
// restoreSourcePath's rule) against every original the snapshot holds:
// noteOriginal must have seen each of them, and originals streams them
// again when one lies beneath the target. Only the selected entries'
// destinations are held. A path that could not be read does not stop the
// check: definite hits are still counted and reported first.
func (g *originalsGuard) check(recorded []string, originals originalSource) overwriteFinding {
	var f overwriteFinding
	fail := func(err error) {
		if f.uncheckedErr == nil {
			f.uncheckedErr = err
		}
	}
	if !g.targetOK {
		// The restore refuses a target that is not absolute before this
		// runs; one the parser still cannot read fails closed.
		f.uncheckedErr = &uncheckedPathError{what: "restore target", path: g.targetBase, err: errUnplaceablePath}
		return f
	}
	if g.unreadable != nil {
		fail(g.unreadable)
	}
	dests := make([]string, len(recorded)) // "" for an entry placement skips
	overwrites := map[string]string{}      // destination key → the original found there
	for i, p := range recorded {
		dest, placed, err := g.destinationKey(p)
		if !placed {
			continue
		}
		if err != nil {
			fail(err)
			continue
		}
		if !g.target.contains(dest) {
			// Every destination lies under the target by placement's
			// construction; one that does not, as the guard reads it, means
			// the guard and placement disagree about this target. With this
			// held for every placed destination, the single
			// originalsBeneath flag cannot hide a colliding original: an
			// original whose key equals a destination's lies under the
			// target too, so noteOriginal set the flag.
			fail(&uncheckedPathError{what: "restore target", path: g.targetBase, err: errDestinationOutsideTarget})
			continue
		}
		own, err := g.originalKey(p)
		if err != nil {
			fail(err)
			continue
		}
		// An entry landing on its own original (a target at its volume
		// root, #12638's case) is found even if the second pass cannot
		// finish.
		key := dest.String()
		dests[i] = key
		if key == own.String() {
			overwrites[key] = p
		} else if _, seen := overwrites[key]; !seen {
			overwrites[key] = ""
		}
	}
	if g.originalsBeneath && len(overwrites) > 0 {
		err := originals(func(original string) {
			k, err := g.originalKey(original)
			if err != nil {
				fail(err)
				return
			}
			if !g.target.contains(k) {
				return
			}
			if found, ok := overwrites[k.String()]; ok && found == "" {
				overwrites[k.String()] = original
			}
		})
		if err != nil {
			fail(fmt.Errorf("re-read the snapshot's original paths: %w", err))
		}
	}
	for i, p := range recorded {
		if dests[i] == "" {
			continue
		}
		if overwritten := overwrites[dests[i]]; overwritten != "" {
			if f.count == 0 {
				f.entry, f.overwrite = p, overwritten
			}
			f.count++
		}
	}
	return f
}

// refuseRestoreOverOriginals runs the guard over every entry the restore
// selected (files, symlinks, directories, junctions), against every original
// the snapshot holds (streamed by originals), and, when any would land on an
// original or could not be checked, marks result failed and reports true:
// the caller returns it without writing anything. Reported as a result body
// (nil error) so the code and the reason reach the server.
func refuseRestoreOverOriginals(g *originalsGuard, files, links, dirs []SnapshotFile, junctions []SnapshotJunction, originals originalSource, result *RestoreResult) bool {
	recorded := make([]string, 0, len(files)+len(links)+len(dirs)+len(junctions))
	for _, group := range [][]SnapshotFile{files, links, dirs} {
		for _, f := range group {
			recorded = append(recorded, restoreSourcePath(f))
		}
	}
	for _, j := range junctions {
		recorded = append(recorded, j.restorePath())
	}
	f := g.check(recorded, originals)
	switch {
	case f.count > 0:
		result.Code = ResultCodeRestoreWouldOverwriteOriginals
		result.Error = alternateRestoreRefusal(g.targetBase, f)
	case f.uncheckedErr != nil:
		result.Code = ResultCodeRestoreOverwriteCheckFailed
		result.Error = overwriteCheckFailedRefusal(g.targetBase, f.uncheckedErr)
	default:
		return false
	}
	result.Status = "failed"
	slog.Warn("restore refused by the originals guard",
		"snapshotId", result.SnapshotID, "targetPath", g.targetBase, "code", result.Code, "entries", f.count, "error", result.Error)
	return true
}

// maxRefusalPathRunes caps each path quoted in a refusal: a path comes from
// the snapshot or the host, and the advice must survive the server's limit
// on a result's error text (wire.CriticalResultErrorMaxChars).
const maxRefusalPathRunes = 512

func refusalPath(p string) string {
	if utf8.RuneCountInString(p) <= maxRefusalPathRunes {
		return p
	}
	return string([]rune(p)[:maxRefusalPathRunes]) + "…"
}

// overwriteCheckFailedRefusal is the error text for a restore refused
// because the check could not finish: what to do first, then the first
// path that could not be read.
func overwriteCheckFailedRefusal(targetBase string, err error) string {
	msg := fmt.Sprintf("restore refused: could not confirm that restoring to %s leaves the original files untouched; nothing was written", refusalPath(targetBase))
	if unchecked, ok := errors.AsType[*uncheckedPathError](err); ok {
		next := "Choose a new, empty folder as the target"
		if unchecked.what == "recorded path" {
			// No other target helps: the path is the snapshot's.
			next = "Restore to the default staging location instead"
		}
		return fmt.Sprintf("%s. %s. First path that could not be checked (%s): %s (%v)", msg, next, unchecked.what, refusalPath(unchecked.path), unchecked.err)
	}
	return fmt.Sprintf("%s. Choose a new, empty folder as the target. (%v)", msg, err)
}

// alternateRestoreRefusal is the error text for a refused restore: what was
// refused, why, and what the operator can do instead.
func alternateRestoreRefusal(targetBase string, f overwriteFinding) string {
	example := refusalPath(f.entry)
	if f.overwrite != f.entry {
		example = fmt.Sprintf("%s would overwrite %s", refusalPath(f.entry), refusalPath(f.overwrite))
	}
	return fmt.Sprintf("restore refused: restoring to %s would write %d item(s) over files this snapshot was backed up from; nothing was written. Choose a new, empty folder outside the backed-up folders as the target. To overwrite the originals on purpose, restore to the root of the drive they came from and confirm overwriting the original files. For example: %s",
		refusalPath(targetBase), f.count, example)
}
