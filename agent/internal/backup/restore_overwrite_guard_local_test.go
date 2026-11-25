package backup

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// windowsVolumeName2 is filepath.VolumeName as Windows computes it (drive
// letters, UNC shares, `\\.\`, `\\?\` and `\??\` device paths), so the
// identity check can run over Windows paths on any host.
func windowsVolumeName2(p string) string {
	isSep := func(b byte) bool { return b == '\\' || b == '/' }
	uncEnd := func(start int) int { // the end of `server\share` from start
		seps := 0
		for i := start; i < len(p); i++ {
			if isSep(p[i]) {
				if seps++; seps == 2 {
					return i
				}
			}
		}
		return len(p)
	}
	switch {
	case len(p) >= 2 && p[1] == ':':
		return p[:2]
	case len(p) < 2 || !isSep(p[0]):
		return ""
	case len(p) >= 4 && isSep(p[3]) && (isSep(p[1]) && (p[2] == '.' || p[2] == '?') || p[1] == '?' && p[2] == '?'):
		if len(p) >= 8 && strings.EqualFold(p[4:7], "UNC") && isSep(p[7]) {
			return p[:uncEnd(8)]
		}
		if i := strings.IndexAny(p[4:], `\/`); i >= 0 {
			return p[:4+i]
		}
		return p
	case isSep(p[1]):
		return p[:uncEnd(2)]
	}
	return ""
}

// withWindowsPaths makes the identity check read Windows paths: the real
// filepath.VolumeName on Windows, windowsVolumeName2 elsewhere.
func withWindowsPaths(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	orig := volumeName
	volumeName = windowsVolumeName2
	t.Cleanup(func() { volumeName = orig })
}

func TestLocalPathRoot(t *testing.T) {
	const guid = `Volume{0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9}`
	for _, tc := range []struct {
		path  string
		style pathStyle
		root  string // "" when not a local path
	}{
		{`C:\Users\a\x`, styleWindows, `C:\`},
		{`c:/Users/a/x`, styleWindows, `c:/`},
		{`D:\`, styleWindows, `D:\`},
		{`\\?\C:\Users\a\x`, styleWindows, `\\?\C:\`},
		{`\\?\` + guid + `\x`, styleWindows, `\\?\` + guid + `\`},
		{`\\?\` + guid + `\`, styleWindows, `\\?\` + guid + `\`},
		{`C:`, styleWindows, ""},
		{`C:x`, styleWindows, ""},
		{`1:\x`, styleWindows, ""},
		{`\\srv.invalid\share\x`, styleWindows, ""},
		{`\\srv.invalid/share/x`, styleWindows, ""},
		{`//srv.invalid/share/x`, styleWindows, ""},
		{`\\?\UNC\srv.invalid\share\x`, styleWindows, ""},
		{`\\.\UNC\srv.invalid\share\x`, styleWindows, ""},
		{`\??\UNC\srv.invalid\share\x`, styleWindows, ""},
		{`\\srv.invalid@SSL\DavWWWRoot\x`, styleWindows, ""},
		{`\\srv.invalid@8080\share\x`, styleWindows, ""},
		{`\\.\C:\x`, styleWindows, ""},
		{`\??\C:\x`, styleWindows, ""},
		{`\\?/C:\x`, styleWindows, ""},
		{`\\.\pipe\x`, styleWindows, ""},
		{`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\x`, styleWindows, ""},
		{`\\?\Volume{bad}\x`, styleWindows, ""},
		{`\\?\Volume{0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f}\x`, styleWindows, ""},
		{`\x`, styleWindows, ""},
		{`/x`, styleWindows, ""},
		{`x`, styleWindows, ""},
		{``, styleWindows, ""},
		{`/home/a/x`, stylePOSIX, "/"},
		{`/`, stylePOSIX, "/"},
		{`home/a`, stylePOSIX, ""},
		{`C:\x`, stylePOSIX, ""},
		{`C:\x`, styleUnknown, ""},
	} {
		root, ok := localPathRoot(tc.path, tc.style)
		if ok != (tc.root != "") || root != tc.root {
			t.Errorf("localPathRoot(%q, %v) = %q, %v; want %q", tc.path, tc.style, root, ok, tc.root)
		}
	}
}

// recordingCheck is a fake identity check on a Windows-style host that
// records every path it is asked to examine. dirs maps a path (separators
// unified to `\`, lower case) to its identity; links maps a path to its link
// target. Anything else does not exist.
type recordingCheck struct {
	mu    sync.Mutex
	calls []string
}

func (r *recordingCheck) record(op, p string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, op+" "+p)
}

func (r *recordingCheck) touched(substr string) []string {
	var hits []string
	for _, c := range r.calls {
		if strings.Contains(strings.ToLower(c), strings.ToLower(substr)) {
			hits = append(hits, c)
		}
	}
	return hits
}

// outside is every recorded call on a path that is not base or beneath it.
func (r *recordingCheck) outside(base string) []string {
	base = strings.TrimRight(windowsKey(base), `\`)
	var hits []string
	for _, c := range r.calls {
		_, p, _ := strings.Cut(c, " ")
		if k := windowsKey(p); k != base && !strings.HasPrefix(k, base+`\`) {
			hits = append(hits, c)
		}
	}
	return hits
}

// fakeLink is a symbolic link as Lstat reports it.
type fakeLink struct{ fakeDir }

func (fakeLink) Mode() os.FileMode { return os.ModeSymlink | 0o777 }
func (fakeLink) IsDir() bool       { return false }

// windowsKey is p with separators unified to `\`, runs of them collapsed
// (a leading `\\` kept) and case folded.
func windowsKey(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	prefix := ""
	if strings.HasPrefix(p, `\\`) {
		prefix, p = `\\`, p[2:]
	}
	for strings.Contains(p, `\\`) {
		p = strings.ReplaceAll(p, `\\`, `\`)
	}
	return strings.ToLower(prefix + p)
}

func newRecordingWindowsCheck(target string, dirs map[string]string, links map[string]string) (*dirIdentityCheck, *recordingCheck) {
	r := &recordingCheck{}
	norm := map[string]string{}
	for p, id := range dirs {
		norm[strings.TrimRight(windowsKey(p), `\`)] = id
	}
	normLinks := map[string]string{}
	for p, to := range links {
		normLinks[strings.TrimRight(windowsKey(p), `\`)] = to
	}
	lookup := func(p string) (os.FileInfo, error) {
		k := strings.TrimRight(windowsKey(p), `\`)
		if _, ok := normLinks[k]; ok {
			return fakeLink{fakeDir{id: k}}, nil
		}
		if id, ok := norm[k]; ok {
			return fakeDir{id: id}, nil
		}
		return nil, fs.ErrNotExist
	}
	c := newFakeIdentityCheck(target, styleWindows, nil)
	c.stat = func(p string) (os.FileInfo, error) {
		r.record("stat", p)
		info, err := lookup(p)
		if _, isLink := info.(fakeLink); isLink {
			// Following a link is what must not happen for these tests'
			// links: report it as the far side, which does not answer.
			return nil, fs.ErrNotExist
		}
		return info, err
	}
	c.lstat = func(p string) (os.FileInfo, error) {
		r.record("lstat", p)
		return lookup(p)
	}
	c.readlink = func(p string) (string, error) {
		r.record("readlink", p)
		if to, ok := normLinks[strings.TrimRight(windowsKey(p), `\`)]; ok {
			return to, nil
		}
		return "", errors.New("not a link")
	}
	return c, r
}

// An original that is not a local path is judged without being opened: the
// identity check makes no file system call on it, whatever its form, and an
// ordinary local original is still examined.
func TestDirIdentityCheck_NonLocalOriginalIsNotOpened(t *testing.T) {
	withWindowsPaths(t)
	dirs := map[string]string{`T:\restore`: "t", `T:\restore\docs`: "td", `C:\`: "c", `C:\docs`: "cd"}
	for _, original := range []string{
		`\\srv.invalid\share\docs\x`,
		`\\srv.invalid/share/docs/x`,
		`\\?\UNC\srv.invalid\share\docs\x`,
		`\\.\UNC\srv.invalid\share\docs\x`,
		`\\srv.invalid@SSL\DavWWWRoot\docs\x`,
		`\\srv.invalid@8080\share\docs\x`,
		`\\?\GLOBALROOT\Device\Mup\srv.invalid\share\docs\x`,
		`\\.\srv.invalid\docs\x`,
	} {
		c, r := newRecordingWindowsCheck(`T:\restore`, dirs, nil)
		same, err := c.aliasesOriginal(original)
		if err != nil || same {
			t.Errorf("%s: alias %v, %v; want not an overwrite", original, same, err)
		}
		if hits := r.outside(`T:\restore`); len(hits) > 0 {
			t.Errorf("%s: the original was examined: %v", original, hits)
		}
	}

	// The control: a local original is examined by identity.
	c, r := newRecordingWindowsCheck(`T:\restore`, dirs, nil)
	if _, err := c.aliasesOriginal(`C:\docs\x`); err != nil {
		t.Fatal(err)
	}
	if len(r.touched(`c:`)) == 0 {
		t.Fatalf("local original C:\\docs\\x was not examined: %v", r.calls)
	}
}

// With a target that is itself not a local path, an original that is not
// local either is compared by name: on the target's own share the lexical
// check decides, anywhere else the check cannot tell and refuses.
func TestDirIdentityCheck_NonLocalOriginalAndTarget(t *testing.T) {
	withWindowsPaths(t)
	target := `\\nas.invalid\restore\here`
	c, r := newRecordingWindowsCheck(target, map[string]string{target: "t"}, nil)
	if same, err := c.aliasesOriginal(`\\NAS.invalid\Restore\docs\x`); err != nil || same {
		t.Errorf("same share: alias %v, %v; want left to the lexical check", same, err)
	}
	same, err := c.aliasesOriginal(`\\other.invalid\share\docs\x`)
	if same || !errors.Is(err, errNotLocalPath) {
		t.Errorf("another share: alias %v, %v; want refused as not checkable", same, err)
	}
	if hits := append(r.touched("other.invalid"), r.touched(`\docs`)...); len(hits) > 0 {
		t.Errorf("an original was examined: %v", hits)
	}
	for _, call := range r.calls {
		if _, p, _ := strings.Cut(call, " "); strings.TrimRight(windowsKey(p), `\`) == `\\nas.invalid\restore` {
			t.Errorf("the original's share root was examined: %v", r.calls)
		}
	}
}

// A link beneath the target to a local path is still followed, by a
// relative path too: here one that climbs out of the target to the
// original's directory.
func TestOverwritesOriginals_RelativeLinkToOriginal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX path style")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(dir, "docs", "x.txt")
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		t.Fatal(err)
	}
	nested, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := strings.Cut(strings.TrimPrefix(original, "/"), "/")
	rel, err := filepath.Rel(nested, "/"+first)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(rel, filepath.Join(nested, first)); err != nil {
		t.Fatal(err)
	}
	if _, count, err := overwritesOriginals(nested, []string{original}); err != nil || count != 1 {
		t.Fatalf("target whose %q is a relative link (%s) to /%s: count %d, %v; want 1", first, rel, first, count, err)
	}
}

// A link loop beneath the target ends the resolution with an error, which
// fails the check closed, as the file system's own loop error would.
func TestDirIdentityCheck_LinkLoopFailsClosed(t *testing.T) {
	loop := map[string]string{"/target/home": "/target/home"}
	c := newFakeIdentityCheck("/target", stylePOSIX, nil)
	c.lstat = func(p string) (os.FileInfo, error) {
		if _, ok := loop[p]; ok {
			return fakeLink{fakeDir{id: p}}, nil
		}
		return fakeDirInfo(p), nil
	}
	c.readlink = func(p string) (string, error) {
		if to, ok := loop[p]; ok {
			return to, nil
		}
		return "", errors.New("not a link")
	}
	c.stat = func(p string) (os.FileInfo, error) {
		if _, ok := loop[p]; ok {
			t.Errorf("the link %s was followed by the file system", p)
			return nil, syscall.ELOOP
		}
		return fakeDirInfo(p), nil
	}
	if _, err := c.aliasesOriginal("/home/a/x"); !errors.Is(err, syscall.ELOOP) {
		t.Fatalf("err %v; want the loop reported", err)
	}
}

// The refusal for an original that was not examined says what to do.
func TestOverwriteCheckFailedRefusal_NonLocalOriginal(t *testing.T) {
	msg := overwriteCheckFailedRefusal(`\\nas.invalid\restore`, &uncheckedPathError{what: "original location", path: `\\other.invalid\share\x`, err: errNotLocalPath})
	if !strings.Contains(msg, "choose a folder on a local drive") || strings.Contains(msg, "readable") {
		t.Fatalf("refusal %q; want the local-folder advice", msg)
	}
}
