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
}

// NewScanScope captures the agent configuration folder's spellings; the
// protected file identities are collected on first need.
func NewScanScope() *ScanScope {
	return &ScanScope{configForms: agentConfigDirForms(), tops: map[string]string{}}
}

func (s *ScanScope) protectedIDs() protectedIdentitySet {
	s.idsOnce.Do(func() { s.ids = collectProtectedIdentities() })
	return s.ids
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
	canonical string
}

// Path is the root as the walk should spell it.
func (r *ScanRoot) Path() string { return r.path }

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
	if info.Mode()&fs.ModeSymlink != 0 {
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
	top := ""
	if cinfo, cerr := os.Lstat(canonical); cerr == nil {
		top = s.volumeTop(canonical, cinfo)
	}
	if s.locationProtected(clean, isDir, "") || s.locationProtected(canonical, isDir, top) {
		return nil, errorCodef(wire.ErrCodeSensitivePathDenied, "scan denied on protected location: %s", root)
	}
	return &ScanRoot{path: clean, canonical: canonical}, nil
}

// Skip reports whether the walk of r should leave path (an entry below the
// root, as the walk spells it, with its Lstat info) alone. The entry is
// judged under its walked spelling and under the root's canonical location
// joined with the same relative path (the walk lists real names, so that
// second form is how the filesystem itself spells the entry), including at
// the top of the mounted volume it is on.
func (s *ScanScope) Skip(r *ScanRoot, path string, info fs.FileInfo) bool {
	isDir := info.IsDir()
	if s.locationProtected(path, isDir, "") {
		return true
	}
	rel, err := filepath.Rel(r.path, path)
	if err != nil {
		return false
	}
	canonical := filepath.Join(r.canonical, rel)
	return s.locationProtected(canonical, isDir, s.volumeTop(canonical, info))
}

// OpenFile opens a file the walk queued, for reading, and returns the handle
// the scan must read from. The open does not follow a link at the leaf and
// never opens anything but a regular file (openScanFile); the opened file
// must be the one the walk saw (walked, when not nil; its file ID was loaded
// during the walk); its canonical location (from the handle) must not be
// protected, also at the top of the mounted volume it is on; and if it has
// other names, it must not be a protected file. Anything refused for those
// reasons returns ErrScanSkipped; other errors are the open's own.
func (s *ScanScope) OpenFile(path string, walked fs.FileInfo) (*os.File, error) {
	f, err := openScanFile(path)
	if err != nil {
		return nil, err
	}
	fail := func(e error) (*os.File, error) {
		_ = f.Close()
		return nil, e
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
	final, err := containmentFinalPathOfFile(f)
	switch {
	case err == nil:
		if s.locationProtected(final, false, s.volumeTop(final, info)) {
			return fail(ErrScanSkipped)
		}
	case handleCheckMandatory:
		return fail(fmt.Errorf("cannot determine where %s resolves: %w", path, err))
	}
	if isOtherNameOfProtectedFile(f, s.protectedIDs) {
		return fail(ErrScanSkipped)
	}
	return f, nil
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
	top = filepath.Clean(top)
	if top == filepath.Dir(top) {
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

// volumeRelative rewrites a lowercased, forward-slashed path to its path
// from the root of its volume: without a namespace prefix or drive letter,
// without macOS's /System/Volumes/Data, and with /private/etc and
// /private/var spelled /etc and /var.
func volumeRelative(form string) string {
	p := stripWindowsNamespacePrefix(form)
	if hasDrivePrefix(p) {
		p = p[2:]
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
