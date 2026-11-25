package bmr

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Target path mappings (#12650).
//
// RecoveryConfig.TargetPaths maps an original path to a destination on the
// recovery machine. A mapping applies to a manifest entry when:
//
//  1. its source is exactly the entry's original path (string equality; the
//     behaviour every helper has had), otherwise
//  2. its source names the entry's path, or a directory above it, compared
//     on whole path components. Of those, the longest source wins, and the
//     entry keeps its path below that source under the mapping's target
//     (`/home=/restore/home` puts `/home/alice/doc.txt` at
//     `/restore/home/alice/doc.txt`; `/home` never matches `/homework`).
//
// How sources and entries are compared depends on the path style of the
// manifest entry, not on the OS this helper runs on, because a Linux
// recovery environment restores Windows manifests:
//
//   - Windows style (`C:\...`, `\\server\share\...`, `\\?\C:\...`): case is
//     ignored and `\` and `/` are the same separator.
//   - Anything else is POSIX: case matters and `\` is an ordinary filename
//     character.
//
// Doubled and trailing separators never matter. A source or entry with a
// `.` or `..` component is only ever matched exactly (rule 1).
//
// planTargetPaths refuses the whole recovery, before anything is written,
// when a mapping matches no manifest entry, when two sources name the same
// path with different targets, when a folder mapping's target is not an
// absolute path on this machine, or when a folder mapping would make two
// entries land on the same destination.

type pathStyle int

const (
	posixPathStyle pathStyle = iota
	windowsPathStyle
)

// matchPath is a path split for mapping comparison. comps keeps the
// original spelling; key() folds it for comparison.
type matchPath struct {
	style pathStyle
	// root is "/" for an absolute POSIX path, "" for a relative one, the
	// lower-case drive ("c:") or `\\` (UNC) for a Windows path.
	root  string
	comps []string
}

func isASCIILetter(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }

// stripWindowsNamespacePrefix removes a Win32 file-namespace prefix in front
// of a drive or UNC path (`\\?\C:\x` → `C:\x`, `\\?\UNC\srv\sh` →
// `\\srv\sh`). Any other `\\?\` path (a volume GUID, GLOBALROOT) is kept.
func stripWindowsNamespacePrefix(p string) string {
	for _, prefix := range []string{`\\?\`, `\\.\`} {
		if !strings.HasPrefix(p, prefix) {
			continue
		}
		rest := p[len(prefix):]
		if len(rest) >= 4 && strings.EqualFold(rest[:3], "UNC") && (rest[3] == '\\' || rest[3] == '/') {
			return `\\` + rest[4:]
		}
		if len(rest) >= 2 && rest[1] == ':' && isASCIILetter(rest[0]) {
			return rest
		}
		return p
	}
	return p
}

// pathStyleOf reports whether p is a Windows path (a drive letter followed by
// a separator or nothing, or a `\\` UNC/device path).
func pathStyleOf(p string) pathStyle {
	if strings.HasPrefix(p, `\\`) {
		return windowsPathStyle
	}
	if len(p) >= 2 && p[1] == ':' && isASCIILetter(p[0]) && (len(p) == 2 || p[2] == '\\' || p[2] == '/') {
		return windowsPathStyle
	}
	return posixPathStyle
}

// parseMatchPath splits p for comparison. ok is false for an empty path or
// one with a `.` or `..` component, which is never matched by prefix.
func parseMatchPath(p string) (mp matchPath, ok bool) {
	mp.style = pathStyleOf(p)
	var rest string
	isSep := func(r rune) bool { return r == '/' }
	switch mp.style {
	case windowsPathStyle:
		p = stripWindowsNamespacePrefix(p)
		isSep = func(r rune) bool { return r == '/' || r == '\\' }
		if strings.HasPrefix(p, `\\`) {
			mp.root, rest = `\\`, p[2:]
		} else if len(p) >= 2 && p[1] == ':' && isASCIILetter(p[0]) {
			mp.root, rest = strings.ToLower(p[:2]), p[2:]
		} else {
			// A `\\?\` path that is not a drive or UNC path.
			mp.root, rest = `\\`, strings.TrimLeft(p, `\/`)
		}
	default:
		if strings.HasPrefix(p, "/") {
			mp.root = "/"
		}
		rest = p
	}
	mp.comps = strings.FieldsFunc(rest, isSep)
	for _, c := range mp.comps {
		if c == "." || c == ".." {
			return matchPath{}, false
		}
	}
	if mp.root == "" && len(mp.comps) == 0 {
		return matchPath{}, false
	}
	return mp, true
}

// key is the comparison form of the path's first n components.
func (mp matchPath) key(n int) string {
	var b strings.Builder
	if mp.style == windowsPathStyle {
		b.WriteString("w|")
	} else {
		b.WriteString("p|")
	}
	b.WriteString(mp.root)
	for _, c := range mp.comps[:n] {
		b.WriteByte('/')
		if mp.style == windowsPathStyle {
			c = strings.ToLower(c)
		}
		b.WriteString(c)
	}
	return b.String()
}

// folderMapping is one or more TargetPaths sources that name the same path
// (after normalisation) with the same target.
type folderMapping struct {
	sources []string
	target  string
}

// targetPathMap is RecoveryConfig.TargetPaths prepared for lookup.
type targetPathMap struct {
	exact   map[string]string
	folders map[string]*folderMapping
	// hostSep is the path separator of the machine the files are restored
	// on; a folder mapping joins the entry's remaining components onto its
	// target with it.
	hostSep byte
}

// newTargetPathMap prepares overrides for lookup. Two sources that name the
// same path with different targets are an error: which one applied would
// otherwise depend on map iteration order.
func newTargetPathMap(overrides map[string]string, hostSep byte) (*targetPathMap, error) {
	if len(overrides) == 0 {
		return nil, nil
	}
	m := &targetPathMap{exact: overrides, folders: map[string]*folderMapping{}, hostSep: hostSep}
	sources := make([]string, 0, len(overrides))
	for source := range overrides {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	for _, source := range sources {
		if strings.TrimSpace(source) == "" || strings.TrimSpace(overrides[source]) == "" {
			return nil, fmt.Errorf("target path mapping %q=%q needs a non-empty source and target", source, overrides[source])
		}
	}
	for _, source := range sources {
		mp, ok := parseMatchPath(source)
		if !ok {
			continue
		}
		k := mp.key(len(mp.comps))
		target := overrides[source]
		if existing, dup := m.folders[k]; dup {
			if existing.target != target {
				return nil, fmt.Errorf("target path mappings %q and %q name the same path with different targets (%q, %q)",
					existing.sources[0], source, existing.target, target)
			}
			existing.sources = append(existing.sources, source)
			continue
		}
		m.folders[k] = &folderMapping{sources: []string{source}, target: target}
	}
	return m, nil
}

// restoreTarget is where one manifest entry is restored.
type restoreTarget struct {
	path string
	// mapped is true when a TargetPaths mapping redirects the entry.
	mapped bool
	// folderRoot is the mapping target the entry was placed beneath, set
	// only when a folder mapping matched a directory above the entry (not
	// the entry itself). It is the trusted base the symlink guard walks
	// from for that entry.
	folderRoot string
	// folderSource is the source of the folder mapping whose target is
	// folderRoot.
	folderSource string
	// matched lists every mapping source that names this entry or a
	// directory above it, including ones a longer source shadowed.
	matched []string
}

// resolve returns the restore destination of a manifest entry whose
// original path is origPath. It touches no filesystem. An error means the
// entry cannot be placed safely under the mapping that covers it; the
// caller refuses that entry; matched is still filled in, so the mapping
// that covers it counts as matched.
func (m *targetPathMap) resolve(origPath string) (restoreTarget, error) {
	if m == nil {
		return restoreTarget{path: origPath}, nil
	}
	var matched []string
	var best *folderMapping
	bestDepth := -1
	mp, parsed := parseMatchPath(origPath)
	if parsed {
		for n := len(mp.comps); n >= 0; n-- {
			fm, ok := m.folders[mp.key(n)]
			if !ok {
				continue
			}
			matched = append(matched, fm.sources...)
			if best == nil {
				best, bestDepth = fm, n
			}
		}
	}

	// Rule 1: an exact source keeps its exact meaning.
	if target, ok := m.exact[origPath]; ok {
		matched = append(matched, origPath)
		return restoreTarget{path: target, mapped: true, matched: matched}, nil
	}
	if !parsed {
		if len(m.folders) > 0 {
			return restoreTarget{matched: matched}, fmt.Errorf("path %q has a . or .. component and cannot be compared with the folder mappings", origPath)
		}
		return restoreTarget{path: origPath}, nil
	}
	if best == nil {
		return restoreTarget{path: origPath}, nil
	}
	if bestDepth == len(mp.comps) {
		// The source names this entry itself, spelled differently.
		return restoreTarget{path: best.target, mapped: true, matched: matched}, nil
	}

	sep := string(m.hostSep)
	rest := mp.comps[bestDepth:]
	for _, c := range rest {
		// A POSIX name may contain `\`; on a Windows host it would split
		// into more components (`..\..\x`), so it cannot be restored there.
		if strings.ContainsRune(c, rune(m.hostSep)) || strings.ContainsRune(c, '/') {
			return restoreTarget{matched: matched}, fmt.Errorf("path %q has a component %q that cannot be a file name on this machine", origPath, c)
		}
	}
	base := strings.TrimRight(best.target, `/`+sep)
	return restoreTarget{
		path:         base + sep + strings.Join(rest, sep),
		mapped:       true,
		folderRoot:   best.target,
		folderSource: best.sources[0],
		matched:      matched,
	}, nil
}

// checkFolderTarget refuses a folder-mapping target that exists but is not
// a real directory. Everything restored under the mapping is created
// beneath it, so a symlink there (or, on Windows, a junction, which
// os.Lstat reports as irregular rather than as a directory) would carry
// those writes somewhere other than the destination the operator named.
// Only the target itself is checked, not the directories above it: like
// the root the exact-mapping guard derives (symlinkAncestorBase), the
// operator chose it, and system-level links above it (macOS /var, a Linux
// /home link) are legitimate. A target that does not exist yet is created
// by the restore as a real directory.
func checkFolderTarget(target, source string, lstat func(string) (fs.FileInfo, error)) error {
	info, err := lstat(filepath.Clean(target))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("the target %q of folder mapping %q cannot be checked: %w", target, source, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("the target %q of folder mapping %q is not a directory; a folder mapping must name a real directory, not a link to one", target, source)
	}
	return nil
}

// targetPathPlan is the checked plan for one recovery's mappings.
type targetPathPlan struct {
	m *targetPathMap
	// linkDests holds the destinations (hostPathKey form) of mapped
	// symlink entries. A mapped entry at or below one of them would be
	// written through a link this same recovery creates (or an earlier,
	// interrupted run of it created) and is refused.
	linkDests map[string]struct{}
	// folderTargets lists, once each, the folder-mapping targets this
	// recovery places entries beneath, for planTargetPaths to check on
	// disk before the first write; folderTargetKeys indexes them by
	// hostPathKey.
	folderTargets    []folderTarget
	folderTargetKeys map[string]folderTarget
}

// requiredDirectory returns the folder-mapping target that must be a real
// directory for an entry resolved to rt to be written safely: the target
// the entry is placed beneath, or, for a directory entry restored AT a
// target this recovery places entries beneath (the mapping source's own
// directory, whose mode and attributes are applied there), that target.
func (p *targetPathPlan) requiredDirectory(rt restoreTarget, kind string) (folderTarget, bool) {
	if p == nil {
		return folderTarget{}, false
	}
	if rt.folderRoot != "" {
		return folderTarget{target: rt.folderRoot, source: rt.folderSource}, true
	}
	if kind == "dir" && rt.mapped {
		ft, ok := p.folderTargetKeys[hostPathKey(rt.path, p.m.hostSep)]
		return ft, ok
	}
	return folderTarget{}, false
}

// folderTarget is one folder-mapping target and the source it maps.
type folderTarget struct{ target, source string }

// maxNamedMappings bounds how many mapping sources one refusal names.
const maxNamedMappings = 10

// hostPathKey is the comparison form of a destination on this machine.
func hostPathKey(p string, hostSep byte) string {
	p = filepath.Clean(p)
	if hostSep == '\\' {
		p = strings.ToLower(p)
	}
	return p
}

// planTargetPaths resolves every manifest entry against overrides and
// refuses the recovery — before anything is written — when the mappings
// cannot be honoured as given. A nil plan (no overrides) restores every
// entry to its original path.
func planTargetPaths(manifest *snapshotManifest, overrides map[string]string) (*targetPathPlan, error) {
	plan, err := planTargetPathsFor(manifest, overrides, os.PathSeparator, filepath.IsAbs)
	if err != nil || plan == nil {
		return plan, err
	}
	for _, ft := range plan.folderTargets {
		if err := checkFolderTarget(ft.target, ft.source, os.Lstat); err != nil {
			return nil, fmt.Errorf("bmr: refusing target path mappings: %w; nothing was restored", err)
		}
	}
	return plan, nil
}

func planTargetPathsFor(manifest *snapshotManifest, overrides map[string]string, hostSep byte, isAbs func(string) bool) (*targetPathPlan, error) {
	m, err := newTargetPathMap(overrides, hostSep)
	if err != nil {
		return nil, fmt.Errorf("bmr: refusing target path mappings: %w", err)
	}
	if m == nil {
		return nil, nil
	}
	plan := &targetPathPlan{m: m, linkDests: map[string]struct{}{}, folderTargetKeys: map[string]folderTarget{}}

	unmatched := make(map[string]bool, len(overrides))
	for source := range overrides {
		unmatched[source] = true
	}
	badTarget := map[string]string{}
	type placed struct {
		orig   string
		folder bool
		dir    bool
	}
	var dests map[string]placed
	if len(m.folders) > 0 {
		dests = make(map[string]placed, len(manifest.Files))
	}
	var collision error
	// allLinkDests holds the destination of every symlink entry, mapped or
	// restored in place (hostPathKey form).
	allLinkDests := map[string]struct{}{}

	for _, file := range manifest.Files {
		origPath := restoreSourcePath(file)
		rt, resolveErr := m.resolve(origPath)
		for _, source := range rt.matched {
			delete(unmatched, source)
		}
		if resolveErr != nil {
			// Refused per entry by restoreFiles; the entry still counts
			// as covered by its mapping.
			continue
		}
		if rt.folderRoot != "" && !isAbs(rt.folderRoot) {
			badTarget[rt.folderRoot] = rt.matched[0]
		}
		if file.Kind == "symlink" {
			if rt.mapped {
				plan.linkDests[hostPathKey(rt.path, hostSep)] = struct{}{}
			}
			allLinkDests[hostPathKey(rt.path, hostSep)] = struct{}{}
		}
		if rt.folderRoot != "" && isAbs(rt.folderRoot) {
			k := hostPathKey(rt.folderRoot, hostSep)
			if _, seen := plan.folderTargetKeys[k]; !seen {
				ft := folderTarget{target: rt.folderRoot, source: rt.folderSource}
				plan.folderTargetKeys[k] = ft
				plan.folderTargets = append(plan.folderTargets, ft)
			}
		}
		if dests == nil || collision != nil {
			continue
		}
		k := hostPathKey(rt.path, hostSep)
		cur := placed{orig: origPath, folder: rt.folderRoot != "", dir: file.Kind == "dir"}
		prev, seen := dests[k]
		if !seen {
			dests[k] = cur
			continue
		}
		bothDirs := prev.dir && cur.dir
		if (prev.folder || cur.folder) && !bothDirs && !sameOriginalPath(prev.orig, origPath) {
			collision = fmt.Errorf("bmr: refusing target path mappings: %q and %q would both be restored to %q", prev.orig, origPath, rt.path)
		}
	}

	if len(unmatched) > 0 {
		names := make([]string, 0, len(unmatched))
		for source := range unmatched {
			names = append(names, source)
		}
		sort.Strings(names)
		more := ""
		if len(names) > maxNamedMappings {
			more = fmt.Sprintf(" and %d more", len(names)-maxNamedMappings)
			names = names[:maxNamedMappings]
		}
		quoted := make([]string, len(names))
		for i, n := range names {
			quoted[i] = fmt.Sprintf("%q", n)
		}
		return nil, fmt.Errorf("bmr: refusing target path mappings: %s%s matched no file in the snapshot; nothing was restored",
			strings.Join(quoted, ", "), more)
	}
	if len(badTarget) > 0 {
		roots := make([]string, 0, len(badTarget))
		for root := range badTarget {
			roots = append(roots, root)
		}
		sort.Strings(roots)
		return nil, fmt.Errorf("bmr: refusing target path mappings: the target %q of folder mapping %q is not an absolute path on this machine",
			roots[0], badTarget[roots[0]])
	}
	if collision != nil {
		return nil, collision
	}
	for _, ft := range plan.folderTargets {
		if _, ok := allLinkDests[hostPathKey(ft.target, hostSep)]; ok {
			return nil, fmt.Errorf("bmr: refusing target path mappings: the target %q of folder mapping %q is where this snapshot restores a symlink; a folder mapping must name a real directory; nothing was restored",
				ft.target, ft.source)
		}
	}
	return plan, nil
}

// sameOriginalPath reports whether two manifest paths name the same file (a
// manifest may list one path twice, e.g. overlapping backup roots).
func sameOriginalPath(a, b string) bool {
	if a == b {
		return true
	}
	ma, okA := parseMatchPath(a)
	mb, okB := parseMatchPath(b)
	return okA && okB && ma.key(len(ma.comps)) == mb.key(len(mb.comps))
}

// resolve is targetPathMap.resolve for a plan that may be nil.
func (p *targetPathPlan) resolve(origPath string) (restoreTarget, error) {
	if p == nil {
		return restoreTarget{path: origPath}, nil
	}
	return p.m.resolve(origPath)
}

// throughPlannedLink reports the planned symlink destination at or above
// target, if any. A symlink entry itself is checked only against its
// ancestors.
func (p *targetPathPlan) throughPlannedLink(target string, isLink bool) (string, bool) {
	if p == nil || len(p.linkDests) == 0 {
		return "", false
	}
	cur := filepath.Clean(target)
	if isLink {
		cur = filepath.Dir(cur)
	}
	for {
		if _, ok := p.linkDests[hostPathKey(cur, p.m.hostSep)]; ok {
			return cur, true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", false
		}
		cur = parent
	}
}
