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
	ids         map[fileIdentity]struct{}
}

// NewScanScope captures the agent configuration folder's spellings; the
// protected file identities are collected on first need.
func NewScanScope() *ScanScope {
	return &ScanScope{configForms: agentConfigDirForms()}
}

func (s *ScanScope) protectedIDs() map[fileIdentity]struct{} {
	s.idsOnce.Do(func() { s.ids = collectProtectedIdentities() })
	return s.ids
}

// ScanRoot is a root that passed ScanScope.CheckRoot.
type ScanRoot struct {
	path      string
	canonical string
}

// Path is the root as the walk should spell it.
func (r *ScanRoot) Path() string { return r.path }

// CheckRoot checks a scan root: an absolute path in a form the agent
// accepts (localPathFormError), not a protected location at its canonical
// spelling. A root that does not exist returns an error wrapping
// fs.ErrNotExist.
func (s *ScanScope) CheckRoot(root string) (*ScanRoot, error) {
	if err := localPathFormError(root); err != nil {
		return nil, err
	}
	clean := filepath.Clean(root)
	info, err := os.Lstat(clean)
	if err != nil {
		return nil, err
	}
	isDir := info.IsDir()
	canonical := clean
	if resolved, ok := resolveForContainment(clean); ok {
		canonical = resolved
	}
	if f, oerr := os.OpenFile(clean, os.O_RDONLY|scanRootOpenFlags, 0); oerr == nil {
		if st, serr := f.Stat(); serr == nil {
			isDir = st.IsDir()
		}
		if final, ferr := containmentFinalPathOfFile(f); ferr == nil {
			canonical = final
		}
		_ = f.Close()
	}
	if s.locationProtected(clean, isDir) || s.locationProtected(canonical, isDir) {
		return nil, errorCodef(wire.ErrCodeSensitivePathDenied, "scan denied on protected location: %s", root)
	}
	return &ScanRoot{path: clean, canonical: canonical}, nil
}

// Skip reports whether the walk of r should leave path (an entry below the
// root, as the walk spells it) alone. The entry is judged under its walked
// spelling and under the root's canonical location joined with the same
// relative path; the walk lists real names, so that second form is how the
// filesystem itself spells the entry.
func (s *ScanScope) Skip(r *ScanRoot, path string, isDir bool) bool {
	if s.locationProtected(path, isDir) {
		return true
	}
	rel, err := filepath.Rel(r.path, path)
	if err != nil {
		return false
	}
	return s.locationProtected(filepath.Join(r.canonical, rel), isDir)
}

// OpenFile opens a file the walk queued, for reading, and returns the handle
// the scan must read from. The leaf is not followed if it is a link; the
// opened file must be the one the walk saw (walked, when not nil) and a
// regular file; its canonical location (from the handle) must not be
// protected; and if it has other names, it must not be a protected file.
// Anything refused for those reasons returns ErrScanSkipped; other errors
// are the open's own.
func (s *ScanScope) OpenFile(path string, walked fs.FileInfo) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|scanFileOpenFlags, 0)
	if err != nil {
		if isNoFollowRefusal(err) {
			return nil, ErrScanSkipped
		}
		return nil, err
	}
	fail := func(e error) (*os.File, error) {
		_ = f.Close()
		return nil, e
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
		if s.locationProtected(final, false) {
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
// path.
func (s *ScanScope) locationProtected(p string, isDir bool) bool {
	norm := strings.ToLower(strings.ReplaceAll(p, `\`, "/"))
	forms := []string{norm}
	if runtime.GOOS == "windows" || hasDrivePrefix(norm) || strings.HasPrefix(norm, "//") {
		var settled bool
		if forms, settled = windowsContainmentForms(norm); !settled {
			return true
		}
	}
	for _, form := range forms {
		anchored := volumeRelative(form)
		for _, pattern := range sensitiveReadPatterns {
			if hasComponentPrefix(anchored, pattern) {
				return true
			}
		}
		if underProfileKeychains(anchored) {
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
