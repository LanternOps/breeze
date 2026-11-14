package security

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// countingOpens wraps the scan's file open, counting opens by base name and
// failing the open of the named files with err.
func countingOpens(t *testing.T, fail map[string]error) (opened func(string) int) {
	t.Helper()
	var mu sync.Mutex
	counts := map[string]int{}
	orig := scanOpen
	scanOpen = func(s *tools.ScanScope, p string, walked fs.FileInfo) (*os.File, fs.FileInfo, error) {
		mu.Lock()
		counts[filepath.Base(p)]++
		mu.Unlock()
		if err := fail[filepath.Base(p)]; err != nil {
			return nil, nil, &fs.PathError{Op: "open", Path: p, Err: err}
		}
		return orig(s, p, walked)
	}
	t.Cleanup(func() { scanOpen = orig })
	return func(name string) int {
		mu.Lock()
		defer mu.Unlock()
		return counts[name]
	}
}

// Files over the size limit are judged by the size the walk measured and
// never opened; the built-in signatures still match their names.
func TestOversizeFilesAreNotOpened(t *testing.T) {
	root := t.TempDir()
	name := credToolToken() + ".bin"
	writeFixture(t, filepath.Join(root, name), "content that is over the limit")
	opened := countingOpens(t, nil)
	options := scanOptionsForTest()
	options.MaxFileSize = 4

	threats, _, err := detectThreatsCtx(context.Background(), []string{root}, options)
	if err != nil {
		t.Fatalf("detectThreatsCtx: %v", err)
	}
	if n := opened(name); n != 0 {
		t.Fatalf("an oversize file was opened %d time(s)", n)
	}
	if len(threats) == 0 {
		t.Fatal("the filename signature did not match the oversize file")
	}
}

// A file the system refuses to open (an antivirus block, a sharing
// violation, access denied) is a per-file failure: the scan goes on, with
// either engine.
func TestScanContinuesPastFilesThatCannotBeOpened(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "blocked.bin"), "x")
	writeFixture(t, filepath.Join(root, "normal.txt"), syntheticMarker)
	countingOpens(t, map[string]error{"blocked.bin": perFileBlockedErrno})

	if _, _, err := detectThreatsCtx(context.Background(), []string{root}, scanOptionsForTest()); err != nil {
		t.Fatalf("built-in signatures: the scan failed on one blocked file: %v", err)
	}
	res, err := walkAndMatch(context.Background(), []string{root}, scanOptionsForTest(), syntheticMatcher(t), yaraCfg(1))
	if err != nil {
		t.Fatalf("rule sets: the scan failed on one blocked file: %v", err)
	}
	if len(res.Threats) != 1 || filepath.Base(res.Threats[0].Path) != "normal.txt" || res.FilesFailed != 1 {
		t.Fatalf("threats=%+v failed=%d, want normal.txt matched and one failed file", res.Threats, res.FilesFailed)
	}
}
