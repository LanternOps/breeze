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
	"unicode/utf8"
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

// localPathRoot is the root of p when p is an absolute path on a volume of
// this machine, written in style. It is an allow-list decided from the
// string alone: on Windows a drive letter (`C:\`), its `\\?\C:\` spelling
// or a volume GUID path (`\\?\Volume{…}\`); on POSIX any path from "/".
// Anything else (a share, any other device path, a relative path) is not
// local, and the identity check never opens it.
func localPathRoot(p string, style pathStyle) (string, bool) {
	switch style {
	case stylePOSIX:
		if strings.HasPrefix(p, "/") {
			return "/", true
		}
	case styleWindows:
		if len(p) >= 3 && isASCIILetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/') {
			return p[:3], true
		}
		const device = `\\?\`
		if rest, ok := strings.CutPrefix(p, device); ok {
			if len(rest) >= 3 && isASCIILetter(rest[0]) && rest[1] == ':' && rest[2] == '\\' {
				return p[:len(device)+3], true
			}
			if n := len(volumeGUIDTemplate); len(rest) > n && isVolumeGUIDName(rest[:n]) && rest[n] == '\\' {
				return p[:len(device)+n+1], true
			}
		}
	}
	return "", false
}

// volumeGUIDTemplate is the shape of a volume GUID name: x is a hex digit.
const volumeGUIDTemplate = "Volume{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"

func isVolumeGUIDName(s string) bool {
	if len(s) != len(volumeGUIDTemplate) || !strings.EqualFold(s[:7], volumeGUIDTemplate[:7]) {
		return false
	}
	for i := 7; i < len(s); i++ {
		c, want := s[i], volumeGUIDTemplate[i]
		hex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if want == 'x' && !hex || want != 'x' && c != want {
			return false
		}
	}
	return true
}

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
//     tree and a nested copy was itself backed up — selected or not). Every
//     destination lies beneath the target, so only an original beneath it
//     can collide.
//   - by identity, for entries recorded in this host's style: a destination
//     directory that is the original's directory under another name (a
//     volume GUID or `\\?\` spelling, a SUBST drive, a bind mount, a link to
//     the root). Each distinct directory is compared once, from the target
//     down, stopping at the first destination or original directory that
//     does not exist.
//
// Memory follows the selection, not the snapshot (the #11234 bound): while
// the manifest streams, the guard keeps one flag (does any original lie
// beneath the target?), not the originals. The lexical check indexes the
// selected entries' destinations and streams the originals a second time
// against that index (check's originals argument).
//
// A safety check, not an atomic guarantee: a mount or link created under the
// target after it runs is not seen (the per-file writes still refuse links).
type originalsGuard struct {
	targetBase string
	targetKeys map[pathStyle]pathKey
	// originalsBeneath is set when an original noted while the manifest
	// streamed lies beneath the target: without one, no destination can
	// be an original lexically and the second pass is skipped.
	originalsBeneath bool
	identity         *dirIdentityCheck
}

func newOriginalsGuard(targetBase string) *originalsGuard {
	g := &originalsGuard{targetBase: targetBase, targetKeys: map[pathStyle]pathKey{}, identity: newDirIdentityCheck(targetBase)}
	for _, style := range []pathStyle{stylePOSIX, styleWindows} {
		if k, ok := parsePathKey(targetBase, style); ok {
			g.targetKeys[style] = k
		}
	}
	return g
}

// noteOriginal sees a recorded path the snapshot holds, selected or not, and
// remembers only whether one lies beneath the target.
func (g *originalsGuard) noteOriginal(recorded string) {
	if !g.originalsBeneath {
		_, g.originalsBeneath = g.originalKeyBeneath(recorded)
	}
}

// originalKeyBeneath is recorded's pathKey string when it lies beneath the
// target in its own path style.
func (g *originalsGuard) originalKeyBeneath(recorded string) (string, bool) {
	style := recordedPathStyle(recorded)
	target, ok := g.targetKeys[style]
	if !ok {
		return "", false
	}
	original, ok := parsePathKey(recorded, style)
	if !ok || !target.contains(original) {
		return "", false
	}
	return original.String(), true
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
// destinations are held. An entry whose identity could not be examined
// does not stop the check: definite hits are still counted and reported
// first.
func (g *originalsGuard) check(recorded []string, originals originalSource) overwriteFinding {
	var f overwriteFinding
	overwrites := map[string]string{} // destination key → the original found there
	if g.originalsBeneath {
		// Each selected destination, and at once any that is the entry's
		// own original (a target at its volume root, #12638's case: found
		// even if the second pass cannot finish).
		for _, p := range recorded {
			if dest, original, ok := restoreDestinationKey(g.targetBase, p); ok {
				key := dest.String()
				if key == original.String() {
					overwrites[key] = p
				} else if _, seen := overwrites[key]; !seen {
					overwrites[key] = ""
				}
			}
		}
		if len(overwrites) > 0 {
			err := originals(func(original string) {
				key, beneath := g.originalKeyBeneath(original)
				if !beneath {
					return
				}
				if found, ok := overwrites[key]; ok && found == "" {
					overwrites[key] = original
				}
			})
			if err != nil {
				f.uncheckedErr = fmt.Errorf("re-read the snapshot's original paths: %w", err)
			}
		}
	}
	for _, p := range recorded {
		overwritten := ""
		if len(overwrites) > 0 {
			if dest, _, ok := restoreDestinationKey(g.targetBase, p); ok {
				overwritten = overwrites[dest.String()]
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
	lstat      func(string) (os.FileInfo, error)
	readlink   func(string) (string, error)
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
	return &dirIdentityCheck{targetBase: targetBase, hostStyle: host, stat: os.Stat, lstat: os.Lstat, readlink: os.Readlink, sameFile: os.SameFile, verdicts: map[string]dirVerdict{}}
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
	if root, local := localPathRoot(sourcePath, c.hostStyle); !local || !strings.EqualFold(volume, strings.TrimRight(root, `\/`)) {
		return c.nonLocalOriginal(sourcePath)
	}
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
		if depth == len(dirs) && depth > 0 {
			// The entry itself is compared only when a real directory is
			// already there. A file, a link or a junction at the
			// destination (an earlier run of this restore) is replaced by
			// name, never written through, so following it would wrongly
			// equate a restored absolute symlink with its original.
			if info, lerr := c.lstat(filepath.Join(c.targetBase, rel)); lerr != nil || !info.IsDir() {
				return false, nil
			}
		}
		// Keyed by the original's volume too: `C:\x` and `D:\x` restore to
		// the same destination directory but are different originals.
		key := strings.ToLower(volume) + "|" + rel
		verdict, ok := c.verdicts[key]
		if !ok {
			verdict, err = c.compare(originalRoot, dirs[:depth])
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

// errNotLocalPath is why the identity check did not examine a path: it is
// not a local path (localPathRoot), or reaching it would follow a link to
// one that is not.
var errNotLocalPath = errors.New("not a local path, so it was not examined")

// uncheckedPathError is a path the identity check could not examine: the
// first one is named in the refusal so the operator knows what to fix.
type uncheckedPathError struct {
	what string // "restore destination" or "original location"
	path string
	err  error
}

func (e *uncheckedPathError) Error() string {
	return fmt.Sprintf("examine %s %s: %v", e.what, e.path, e.err)
}

func (e *uncheckedPathError) Unwrap() error { return e.err }

// nonLocalOriginal decides, without opening it, an entry whose original is
// not a local path (localPathRoot). Against a local target it is not the
// same place; the lexical check still applies. Against a target that is not
// local either, the lexical check decides on the target's own share, and
// anywhere else the check cannot tell and fails closed.
func (c *dirIdentityCheck) nonLocalOriginal(sourcePath string) (bool, error) {
	if _, local := localPathRoot(c.targetBase, c.hostStyle); local {
		return false, nil
	}
	target, targetOK := parsePathKey(c.targetBase, c.hostStyle)
	original, originalOK := parsePathKey(sourcePath, c.hostStyle)
	if targetOK && originalOK && target.volume == original.volume {
		return false, nil
	}
	return false, &uncheckedPathError{what: "original location", path: sourcePath, err: errNotLocalPath}
}

// compare examines the destination directory targetBase/parts and the
// original directory originalRoot/parts.
func (c *dirIdentityCheck) compare(originalRoot string, parts []string) (dirVerdict, error) {
	// The destination first: one that does not exist cannot be an
	// original, whatever the original's state, so an unreadable original
	// never refuses a restore whose destination is not there yet.
	destInfo, err := c.resolveStat(c.targetBase, parts)
	if notADirectory(err) || errors.Is(err, syscall.ENAMETOOLONG) || errors.Is(err, errNotLocalPath) {
		// Nothing there to alias. A path too long to stat is equally past
		// every directory already compared as distinct. A link to a path
		// that is not local is not followed, and the restore writes
		// through no link beneath the target.
		return dirAbsent, nil
	}
	if err != nil {
		// Fail closed: a destination that exists but cannot be examined
		// cannot be shown not to be an original.
		return 0, &uncheckedPathError{what: "restore destination", path: filepath.Join(append([]string{c.targetBase}, parts...)...), err: err}
	}
	original := filepath.Join(append([]string{originalRoot}, parts...)...)
	originalInfo, err := c.resolveStat(originalRoot, parts)
	if notADirectory(err) || errors.Is(err, syscall.ENAMETOOLONG) || unreachableVolume(err) || errors.Is(err, errNotLocalPath) {
		// No original there to overwrite: gone since the backup, on a
		// volume or share this host cannot reach at all, or behind a link
		// to a path that is not local. The destination, which it just
		// opened, cannot be it. The lexical check still applies.
		return dirAbsent, nil
	}
	if err != nil {
		// Denied, or unreadable for a reason that does not establish the
		// original is gone: it may be what the destination is, so fail
		// closed. Nothing short of its own identity rules that out; its
		// parent's device does not (the original may be a mount point, or
		// an APFS firmlink such as /Users, whose device differs from its
		// parent's).
		return 0, &uncheckedPathError{what: "original location", path: original, err: err}
	}
	if c.sameFile(destInfo, originalInfo) {
		return dirAlias, nil
	}
	return dirDistinct, nil
}

// maxLinkHops bounds the links resolveStat follows for one path.
const maxLinkHops = 64

// resolveStat is stat(base/parts...) with every link beneath base resolved
// here rather than by the file system: a link is followed only to a local
// path (localPathRoot) or a relative one, so the lookup stays on this
// machine whatever links the tree holds. base itself (the operator's
// target, or a local volume root) is examined as it is.
func (c *dirIdentityCheck) resolveStat(base string, parts []string) (os.FileInfo, error) {
	if len(parts) == 0 {
		return c.stat(base)
	}
	cur := base
	pending := append([]string(nil), parts...)
	var info os.FileInfo // cur's, when cur was reached by a plain component
	for hops := 0; len(pending) > 0; {
		name := pending[0]
		pending = pending[1:]
		switch name {
		case "", ".":
			continue
		case "..":
			cur, info = filepath.Dir(cur), nil
			continue
		}
		next := filepath.Join(cur, name)
		fi, err := c.lstat(next)
		if err != nil {
			return nil, err
		}
		if fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			target, err := c.readlink(next)
			if err == nil {
				if hops++; hops > maxLinkHops {
					return nil, &fs.PathError{Op: "resolve", Path: next, Err: syscall.ELOOP}
				}
				if root, local := localPathRoot(target, c.hostStyle); local {
					cur, info = root, nil
					pending = append(linkComponents(target[len(root):], c.hostStyle), pending...)
				} else if relativeLink(target, c.hostStyle) {
					info = nil
					pending = append(linkComponents(target, c.hostStyle), pending...)
				} else {
					return nil, &fs.PathError{Op: "resolve", Path: next, Err: errNotLocalPath}
				}
				continue
			}
			if fi.Mode()&fs.ModeSymlink != 0 {
				return nil, err // a link that cannot be read: fail closed
			}
			// Another kind of reparse point, not a link: examined as it is.
		}
		cur, info = next, fi
	}
	if info == nil {
		// Ended on a link or "..": cur is where it resolved to, with no
		// link beneath its base or root.
		return c.stat(cur)
	}
	return info, nil
}

// relativeLink reports a link target resolved against the link's own
// directory: no volume, no root.
func relativeLink(target string, style pathStyle) bool {
	switch {
	case target == "", target[0] == '/':
		return false
	case style == styleWindows:
		return target[0] != '\\' && (len(target) < 2 || target[1] != ':')
	}
	return true
}

// linkComponents splits a link target into its components.
func linkComponents(target string, style pathStyle) []string {
	return strings.FieldsFunc(target, func(r rune) bool { return r == '/' || style == styleWindows && r == '\\' })
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
// path that could not be examined.
func overwriteCheckFailedRefusal(targetBase string, err error) string {
	msg := fmt.Sprintf("restore refused: could not confirm that restoring to %s leaves the original files untouched; nothing was written. Choose a new, empty folder as the target", refusalPath(targetBase))
	if unchecked, ok := errors.AsType[*uncheckedPathError](err); ok {
		reason := unchecked.err
		if pathErr, ok := errors.AsType[*fs.PathError](reason); ok {
			reason = pathErr.Err // the path is named already
		}
		next := "make the path below readable and try again"
		switch {
		case errors.Is(reason, fs.ErrPermission):
			next = "give the Breeze backup helper access to the path below (on macOS, Full Disk Access) and try again"
		case errors.Is(reason, errNotLocalPath):
			next = "choose a folder on a local drive"
		}
		return fmt.Sprintf("%s, or %s. First path that could not be checked (%s): %s (%v)", msg, next, unchecked.what, refusalPath(unchecked.path), reason)
	}
	return fmt.Sprintf("%s. (%v)", msg, err)
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
	example := refusalPath(f.entry)
	if f.overwrite != f.entry {
		example = fmt.Sprintf("%s would overwrite %s", refusalPath(f.entry), refusalPath(f.overwrite))
	}
	return fmt.Sprintf("restore refused: restoring to %s would write %d item(s) over files this snapshot was backed up from; nothing was written. Choose a new, empty folder outside the backed-up folders as the target. To overwrite the originals on purpose, restore to the root of the drive they came from and confirm overwriting the original files. For example: %s",
		refusalPath(targetBase), f.count, example)
}
