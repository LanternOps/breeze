package tools

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/wire"
)

// Content-scan scope.
//
// A content scan (the IOC scan) should cover every folder in its scope, and
// a folder's name says little about what it holds. So, unlike the file
// browser's deny-list, its location rules are anchored where the protected
// locations really are:
//
//   - the system locations in sensitiveReadPatterns, only at the root of a
//     volume (after removing a drive letter, a namespace prefix, macOS's
//     /System/Volumes/Data and /private aliases), and a user's keychains
//     folder only at <profiles>/<user>/Library/Keychains;
//   - the agent's configured folder, at its real location;
//   - the credential file-name rules (matchesSensitiveFileName), for files
//     only: a folder named ".env" or "Cookies" is scanned like any other.
//
// Locations are judged at their canonical spelling (from an open handle, or
// resolveForContainment), and each file is opened once, checked through the
// handle, and handed to the scanner as that handle.

// ErrScanSkipped is returned by ScanScope.OpenFile for a file the scan does
// not read and does not report as an error: a protected file, a link, or a
// file that changed since the walk saw it.
var ErrScanSkipped = errors.New("not scanned")

// ScanScope holds the protected-location rules for one content scan.
type ScanScope struct {
	configForms []string
	idsOnce     sync.Once
	ids         protectedIdentitySet

	tableOnce sync.Once
	table     []string // mount points, read once per scan
	tableOK   bool

	topsMu sync.Mutex
	tops   map[string]string // fallback: folder -> top of its volume

	volIDsMu sync.Mutex
	volIDs   map[string]protectedIdentitySet // volume top -> its protected files
}

// NewScanScope captures the agent configuration folder's spellings; the
// protected file identities are collected on first need.
func NewScanScope() *ScanScope {
	return &ScanScope{configForms: agentConfigDirForms(), tops: map[string]string{}, volIDs: map[string]protectedIdentitySet{}}
}

func (s *ScanScope) protectedIDs() protectedIdentitySet {
	s.idsOnce.Do(func() { s.ids = collectProtectedIdentities() })
	return s.ids
}

// volumeIDs returns the identities of the protected files at the root of
// the mounted volume whose top folder is top, collected once per scan.
func (s *ScanScope) volumeIDs(top string) protectedIdentitySet {
	s.volIDsMu.Lock()
	defer s.volIDsMu.Unlock()
	if set, ok := s.volIDs[top]; ok {
		return set
	}
	files, dirs, skips := volumeSourcesOf(top)
	set := collectIdentities(files, dirs, skips)
	s.volIDs[top] = set
	return set
}

// handleFinalPath and handleVolumePath report where an open handle is: its
// final path in the usual (drive-letter) spelling, and on Windows its path
// from the root of its volume, named by the volume's GUID, which does not
// depend on drive letters or the folders the volume is mounted at.
// Variables so a test can stand in for either spelling.
var (
	handleFinalPath  = containmentFinalPathOfFile
	handleVolumePath = volumePathOfFile
)

// volumeGUIDRoot returns the root of the volume named in a volume-GUID path
// (\\?\Volume{GUID}\), or "".
func volumeGUIDRoot(p string) string {
	if i := strings.Index(p, "}"); i >= 0 && i+1 < len(p) && (p[i+1] == '\\' || p[i+1] == '/') {
		return p[:i+2]
	}
	return ""
}

// scanDeviceOf returns the device a path lives on (a variable so a test can
// stand in for a mounted volume).
var scanDeviceOf = deviceOfInfo

// maxFallbackTops bounds the fallback cache of folder tops.
const maxFallbackTops = 100000

// volumeTop returns the top folder of the mounted volume that holds the
// canonical path p (whose Lstat info is info). It is the nearest mount point
// at or above p, from the mount table read once per scan; every mount point
// counts, bind mounts included. If the table cannot be read, it falls back to
// the highest ancestor on the same device, remembered per folder. It is ""
// where neither is available (Windows, which anchors by drive letter).
func (s *ScanScope) volumeTop(p string, info fs.FileInfo) string {
	s.tableOnce.Do(func() { s.table, s.tableOK = loadMountTable() })
	if s.tableOK {
		return longestMountPoint(s.table, p)
	}
	dev, ok := scanDeviceOf(p, info)
	if !ok {
		return ""
	}
	dir := p
	if !info.IsDir() {
		dir = filepath.Dir(p)
	}
	s.topsMu.Lock()
	top, known := s.tops[dir]
	s.topsMu.Unlock()
	if known {
		return top
	}
	cur := dir
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		pinfo, err := os.Lstat(parent)
		if err != nil {
			break
		}
		pdev, ok := scanDeviceOf(parent, pinfo)
		if !ok || pdev != dev {
			break
		}
		cur = parent
	}
	s.topsMu.Lock()
	if len(s.tops) < maxFallbackTops {
		s.tops[dir] = cur
	}
	s.topsMu.Unlock()
	return cur
}

// ScanRoot is a root that passed ScanScope.CheckRoot.
type ScanRoot struct {
	path      string
	walk      string
	canonical string
}

// Path is the root as checked and reported.
func (r *ScanRoot) Path() string { return r.path }

// WalkPath is the path to walk: Path, or for a volume mounted at a folder
// (Windows), Path with a trailing separator so the walk enters the volume.
func (r *ScanRoot) WalkPath() string { return r.walk }

// CheckRoot checks a scan root: an absolute path in a form the agent
// accepts (localPathFormError), naming a folder or a regular file, and not a
// protected location at its canonical spelling, at the top of the system
// volume or of the mounted volume it is on. A root that does not exist
// returns an error wrapping fs.ErrNotExist. Nothing is opened before its
// type is known (openForInspection).
func (s *ScanScope) CheckRoot(root string) (*ScanRoot, error) {
	if err := localPathFormError(root); err != nil {
		return nil, err
	}
	clean := filepath.Clean(root)
	info, err := os.Lstat(clean)
	if err != nil {
		return nil, err
	}
	walk := clean
	if !inspectableInfo(info) && isVolumeMountPoint(clean) {
		// A volume mounted at a folder (Windows) is scanned as that
		// volume's root; a junction or link to an ordinary folder is not.
		st, serr := os.Stat(clean)
		if serr != nil {
			return nil, serr
		}
		info = st
		walk = clean + string(filepath.Separator)
	} else if info.Mode()&fs.ModeSymlink != 0 {
		// The walk itself skips a root that is a link; judge what it names.
		if st, serr := os.Stat(clean); serr == nil {
			info = st
		}
	}
	if !inspectableInfo(info) {
		return nil, errorCodef(wire.ErrCodeInvalidArgument, "scan root is not a folder or a file: %s", root)
	}
	isDir := info.IsDir()
	canonical := clean
	if resolved, ok := resolveForContainment(clean); ok {
		canonical = resolved
	}
	if f, oerr := openForInspection(canonical); oerr == nil {
		if final, ferr := containmentFinalPathOfFile(f); ferr == nil {
			canonical = final
		}
		_ = f.Close()
	}
	if walk != clean {
		// A volume mounted at a folder: entries are judged from that
		// volume's root, named by its GUID, so the protected locations
		// anchor there whatever drive letter the volume has, if any.
		if f, oerr := os.Open(walk); oerr == nil {
			if vol, ok := handleVolumePath(f); ok {
				canonical = vol
			}
			_ = f.Close()
		}
	}
	top := ""
	if cinfo, cerr := os.Lstat(canonical); cerr == nil {
		top = s.volumeTop(canonical, cinfo)
	}
	if s.locationProtected(clean, isDir, "") || s.locationProtected(canonical, isDir, top) {
		return nil, errorCodef(wire.ErrCodeSensitivePathDenied, "scan denied on protected location: %s", root)
	}
	return &ScanRoot{path: clean, walk: walk, canonical: canonical}, nil
}

// Skip reports whether the walk of r should leave path (an entry below the
// root, as the walk spells it, with its Lstat info) alone. The entry is
// judged under its walked spelling and under the root's canonical location
// joined with the same relative path (the walk lists real names, so that
// second form is how the filesystem itself spells the entry), including at
// the top of the mounted volume it is on.
func (s *ScanScope) Skip(r *ScanRoot, path string, info fs.FileInfo) bool {
	isDir := info.IsDir()
	rel, err := filepath.Rel(r.path, path)
	if err != nil {
		return s.locationProtected(path, isDir, "")
	}
	canonical := filepath.Join(r.canonical, rel)
	// When the root's canonical spelling is the walked one, the two forms
	// are the same path: judge it once.
	if r.canonical != r.path && s.locationProtected(path, isDir, "") {
		return true
	}
	return s.locationProtected(canonical, isDir, s.volumeTop(canonical, info))
}

// OpenFile opens a file the walk queued, for reading, and returns the handle
// the scan must read from with its stat information. The open does not
// follow a link at the leaf and never opens anything but a regular file
// (openScanFile); the opened file must be the one the walk saw (walked, when
// not nil; its file ID was loaded during the walk); its canonical location
// (from the handle) must not be protected, also at the top of the mounted
// volume it is on; and if it has other names, it must not be a protected
// file. Anything refused for those reasons returns ErrScanSkipped; other
// errors are the open's own.
func (s *ScanScope) OpenFile(path string, walked fs.FileInfo) (*os.File, fs.FileInfo, error) {
	f, err := openScanFile(path)
	if err != nil {
		return nil, nil, err
	}
	fail := func(e error) (*os.File, fs.FileInfo, error) {
		_ = f.Close()
		return nil, nil, e
	}
	if requireDiskHandle(f) != nil {
		return fail(ErrScanSkipped)
	}
	info, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if !info.Mode().IsRegular() || (walked != nil && !os.SameFile(walked, info)) {
		return fail(ErrScanSkipped)
	}
	sets := []func() protectedIdentitySet{s.protectedIDs}
	final, err := handleFinalPath(f)
	switch {
	case err == nil:
		top := s.volumeTop(final, info)
		if s.locationProtected(final, false, top) {
			return fail(ErrScanSkipped)
		}
		if mounted := mountedVolumeTop(top); mounted != "" {
			sets = append(sets, func() protectedIdentitySet { return s.volumeIDs(mounted) })
		}
	case handleCheckMandatory:
		if _, ok := handleVolumePath(f); !ok {
			return fail(fmt.Errorf("cannot determine where %s resolves: %w", path, err))
		}
	}
	// On Windows the file is also judged from the root of its own volume,
	// whatever drive letter or mount folder the DOS spelling went through.
	// (A volume root named by its GUID is its own parent folder: it is not
	// passed through mountedVolumeTop.)
	if vol, ok := handleVolumePath(f); ok {
		if s.locationProtected(vol, false, "") {
			return fail(ErrScanSkipped)
		}
		if root := volumeGUIDRoot(vol); root != "" {
			sets = append(sets, func() protectedIdentitySet { return s.volumeIDs(root) })
		}
	}
	if isOtherNameOfProtectedFile(f, info, sets...) {
		return fail(ErrScanSkipped)
	}
	return f, info, nil
}

// locationProtected applies the content-scan rules described above to one
// path. top, when not empty, is the top folder of the mounted volume p is on;
// the location rules then also apply to p's path from that folder.
func (s *ScanScope) locationProtected(p string, isDir bool, top string) bool {
	if mounted := pathFromVolumeTop(p, top); mounted != "" {
		if anchoredLocationProtected(volumeRelative(mounted)) {
			return true
		}
	}
	norm := strings.ToLower(strings.ReplaceAll(p, `\`, "/"))
	forms := []string{norm}
	if runtime.GOOS == "windows" || hasDrivePrefix(norm) || strings.HasPrefix(norm, "//") {
		var settled bool
		if forms, settled = windowsContainmentForms(norm); !settled {
			return true
		}
	}
	for _, form := range forms {
		if anchoredLocationProtected(volumeRelative(form)) {
			return true
		}
		for _, configForm := range s.configForms {
			if hasComponentPrefix(stripDataVolume(form), stripDataVolume(configForm)) {
				return true
			}
		}
		if !isDir && matchesSensitiveFileName(form) {
			return true
		}
	}
	return false
}

// anchoredLocationProtected applies the location rules to a lowercased,
// forward-slashed path from the top of a volume.
func anchoredLocationProtected(anchored string) bool {
	for _, pattern := range sensitiveReadPatterns {
		if hasComponentPrefix(anchored, pattern) {
			return true
		}
	}
	return underProfileKeychains(anchored)
}

// pathFromVolumeTop returns p relative to top, lowercased, forward-slashed
// and rooted ("/etc/shadow" for p = top + "/etc/shadow"), or "" when top is
// empty, the filesystem root, or not an ancestor of p.
func pathFromVolumeTop(p, top string) string {
	if top == "" {
		return ""
	}
	top = mountedVolumeTop(filepath.Clean(top))
	if top == "" {
		return ""
	}
	rel, err := filepath.Rel(top, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	if rel == "." {
		return "/"
	}
	return "/" + strings.ToLower(filepath.ToSlash(rel))
}

// stripVolumeGUID removes a leading volume{GUID} component from a
// lowercased, forward-slashed path, returning the rooted rest.
func stripVolumeGUID(p string) (string, bool) {
	q := strings.TrimPrefix(p, "/")
	if !strings.HasPrefix(q, "volume{") {
		return p, false
	}
	end := strings.IndexByte(q, '}')
	if end < 0 || (len(q) > end+1 && q[end+1] != '/') {
		return p, false
	}
	rest := q[end+1:]
	if rest == "" {
		rest = "/"
	}
	return rest, true
}

// volumeRelative rewrites a lowercased, forward-slashed path to its path
// from the root of its volume: without a namespace prefix or drive letter,
// without macOS's /System/Volumes/Data, and with /private/etc and
// /private/var spelled /etc and /var.
func volumeRelative(form string) string {
	p := stripWindowsNamespacePrefix(form)
	if hasDrivePrefix(p) {
		p = p[2:]
	}
	// A volume without a drive letter is named by its GUID
	// (\Volume{...}\ from the handle's final path): the rest is the path
	// from that volume's root.
	if rest, ok := stripVolumeGUID(p); ok {
		p = rest
	}
	p = stripDataVolume(p)
	for _, alias := range []string{"/private/etc", "/private/var"} {
		if hasComponentPrefix(p, alias) {
			p = p[len("/private"):]
			break
		}
	}
	return p
}

// stripDataVolume removes macOS's /System/Volumes/Data prefix, under which
// the writable half of the system volume can also be reached.
func stripDataVolume(p string) string {
	const dataVolume = "/system/volumes/data"
	if !hasComponentPrefix(p, dataVolume) {
		return p
	}
	if rest := p[len(dataVolume):]; rest != "" {
		return rest
	}
	return "/"
}

// underProfileKeychains reports a path at or below a user's keychains
// folder: /Users/<name>/Library/Keychains, or root's home on macOS.
func underProfileKeychains(p string) bool {
	if hasComponentPrefix(p, "/var/root/library/keychains") {
		return true
	}
	const users = "/users/"
	if !strings.HasPrefix(p, users) {
		return false
	}
	rest := p[len(users):]
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 {
		return false
	}
	return hasComponentPrefix(rest[slash+1:], "library/keychains")
}
