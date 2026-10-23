package yarascan

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	yx "github.com/niallnsec/yaraxwasm"
)

// ScanSample scans an in-memory sample with entry's rules (#6267 W04-2: the
// API's rule test upload, via `breeze-yarac match`). The sample is never
// written to disk: yaraxwasm copies the bytes straight into guest memory, and
// matched strings are read back from the same buffer with the caps and
// escaping on-device scans use.
//
// The YARA globals are set the way ScanFile sets them on a device: filename
// and extension from filename, and filepath from virtualPath — the path
// the tech types to emulate where the file would sit — defaulting to the
// filename when empty. Engine panics are recovered into an error.
func ScanSample(entry *CacheEntry, filename, virtualPath string, data []byte, timeout time.Duration) (out []Match, err error) {
	if entry == nil || entry.Rules == nil {
		return nil, fmt.Errorf("no compiled rules")
	}
	if virtualPath == "" {
		virtualPath = filename
	}
	var s *yx.Scanner
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("YARA sample scan panicked: %v", r)
		}
		if s != nil {
			func() {
				defer func() { _ = recover() }()
				s.Destroy()
			}()
		}
	}()
	s = yx.NewScanner(entry.Rules)
	s.SetTimeout(timeout)
	for name, val := range map[string]string{
		"filename":  filename,
		"filepath":  virtualPath,
		"extension": sampleExtension(filename),
	} {
		if gerr := s.SetGlobal(name, val); gerr != nil {
			return nil, fmt.Errorf("set YARA global %s: %w", name, gerr)
		}
	}
	res, err := s.Scan(data)
	if err != nil {
		return nil, err
	}
	rules := res.MatchingRules()
	if len(rules) == 0 {
		return nil, nil
	}
	return buildMatches(entry, rules, bytes.NewReader(data)), nil
}

func sampleExtension(name string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
}
