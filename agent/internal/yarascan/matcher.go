package yarascan

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	yx "github.com/niallnsec/yaraxwasm"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const (
	// PerFileTimeout bounds one file inside the engine so a pathological
	// file cannot pin a worker for the whole scan (Review Focus 3).
	PerFileTimeout = 60 * time.Second
	// MaxMatchedStrings / MaxMatchedBytes cap what a threat carries of the
	// customer's file content (spec §9). The API redacts again at ingest.
	MaxMatchedStrings = 10
	MaxMatchedBytes   = 128
	// recycleAfterBytes: yaraxwasm keeps a Go-side read buffer and a guest
	// linear-memory buffer sized to the largest file a scanner has seen, and
	// wasm memory never shrinks. A worker that just scanned a file larger
	// than this drops its scanner so the next file starts small again.
	recycleAfterBytes = 16 << 20

	EngineYARA   = "yara"
	EngineLegacy = "legacy"
)

var allowedThreatTypes = map[string]struct{}{"malware": {}, "trojan": {}, "ransomware": {}, "pup": {}, "exploit": {}, "hacktool": {}, "webshell": {}, "suspicious": {}}

// MatchedString is one capped, escaped matched-pattern excerpt (C3).
type MatchedString struct {
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Data   string `json:"data"`
}

// Match is one rule hit on one file. RuleSetID is empty for a legacy
// signature hit.
type Match struct {
	RuleSetID, RuleID, RuleName, Severity, ThreatType string
	Tags                                              []string
	Strings                                           []MatchedString
	AutoQuarantine                                    bool
}

// Worker scans files on one goroutine. Not safe for concurrent use.
type Worker interface {
	ScanFile(path string) ([]Match, error)
	Close()
}

// Matcher hands out one Worker per scan goroutine.
type Matcher interface {
	Engine() string
	NewWorker() (Worker, error)
	Close()
}

// ErrWorkerUnavailable: this worker's engine instance is gone and could not
// be re-created; the walk retires the worker instead of failing every
// remaining file on it.
var ErrWorkerUnavailable = errors.New("YARA scan worker unavailable")

type yaraMatcher struct{ entry *CacheEntry }

func (m *yaraMatcher) Engine() string { return EngineYARA }
func (m *yaraMatcher) Close()         {}

func (m *yaraMatcher) NewWorker() (Worker, error) {
	w := &yaraWorker{entry: m.entry}
	if err := w.ensureScanner(); err != nil {
		return nil, err
	}
	return w, nil
}

type yaraWorker struct {
	s     *yx.Scanner
	entry *CacheEntry
}

func (w *yaraWorker) ensureScanner() (err error) {
	if w.s != nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil { // NewScanner / SetTimeout panic on guest failure
			w.s, err = nil, fmt.Errorf("YARA scanner init failed: %v", r)
		}
	}()
	s := yx.NewScanner(w.entry.Rules)
	s.SetTimeout(PerFileTimeout)
	w.s = s
	return nil
}

func (w *yaraWorker) dropScanner() {
	if w.s == nil {
		return
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Warn("YARA scanner teardown panicked", "panic", fmt.Sprint(r))
			}
		}()
		w.s.Destroy()
	}()
	w.s = nil
}

func (w *yaraWorker) Close() { w.dropScanner() }

func (w *yaraWorker) ScanFile(path string) (out []Match, err error) {
	if err := w.ensureScanner(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrWorkerUnavailable, err)
	}
	var size int64
	if st, statErr := os.Stat(path); statErr == nil {
		size = st.Size()
	}
	defer func() {
		if r := recover(); r != nil {
			// The guest may be in an unknown state: discard this scanner.
			w.dropScanner()
			out, err = nil, fmt.Errorf("YARA scan panicked on %s: %v", path, r)
			return
		}
		if size > recycleAfterBytes {
			w.dropScanner()
		}
	}()
	base := filepath.Base(path)
	for name, val := range map[string]string{
		"filename":  base,
		"filepath":  path,
		"extension": strings.TrimPrefix(strings.ToLower(filepath.Ext(base)), "."),
	} {
		if gerr := w.s.SetGlobal(name, val); gerr != nil {
			return nil, fmt.Errorf("set YARA global %s: %w", name, gerr)
		}
	}
	res, err := w.s.ScanFile(path)
	if err != nil {
		return nil, err
	}
	for _, rule := range res.MatchingRules() {
		ns, name := rule.Namespace(), rule.Identifier()
		meta, ok := w.entry.Index[ns+":"+name]
		if !ok {
			log.Warn("YARA match for a rule missing from the rule index", "ruleSetId", ns, "rule", name)
			meta.Severity = "medium"
		}
		m := Match{RuleSetID: ns, RuleID: meta.RuleID, RuleName: name, Severity: meta.Severity,
			ThreatType: "malware", Tags: rule.Tags(), AutoQuarantine: w.entry.AutoQuarantine[ns]}
		for _, md := range rule.Metadata() {
			if md.Identifier() != "threat_type" {
				continue
			}
			if v, ok := md.Value().(string); ok {
				if _, ok := allowedThreatTypes[v]; ok {
					m.ThreatType = v
				}
			}
		}
		m.Strings = collectStrings(path, rule)
		out = append(out, m)
	}
	return out, nil
}

// collectStrings re-reads at most MaxMatchedBytes per match from the file:
// the engine reports offsets/lengths, and a result never carries more than
// MaxMatchedStrings × MaxMatchedBytes of customer file content (spec §9).
func collectStrings(path string, rule *yx.Rule) []MatchedString {
	f, err := os.Open(path)
	if err != nil {
		log.Warn("could not re-read a matched file for evidence; reporting the match without matched strings", "path", path, "error", err.Error())
		return nil
	}
	defer func() { _ = f.Close() }()
	var out []MatchedString
	for _, p := range rule.Patterns() {
		for _, mt := range p.Matches() {
			if len(out) >= MaxMatchedStrings {
				return out
			}
			n := mt.Length()
			if n > MaxMatchedBytes {
				n = MaxMatchedBytes
			}
			buf := make([]byte, n)
			k, _ := f.ReadAt(buf, int64(mt.Offset()))
			out = append(out, MatchedString{ID: p.Identifier(), Offset: int64(mt.Offset()), Data: escapeMatched(buf[:k])})
		}
	}
	return out
}

// escapeMatched caps b at MaxMatchedBytes and escapes everything outside
// printable ASCII (and the backslash itself) as \xNN.
func escapeMatched(b []byte) string {
	if len(b) > MaxMatchedBytes {
		b = b[:MaxMatchedBytes]
	}
	var sb strings.Builder
	for _, c := range b {
		if c >= 0x20 && c < 0x7f && c != '\\' {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, `\x%02x`, c)
		}
	}
	return sb.String()
}

func compileDetail(re []yarac.RuleError) string {
	if len(re) == 0 {
		return ""
	}
	d := re[0].Message
	if re[0].Name != "" {
		d = re[0].Name + ": " + d
	}
	if len(re) > 1 {
		d = fmt.Sprintf("%s (+%d more)", d, len(re)-1)
	}
	return truncate(d, maxDetailLen)
}

// LoadMatcher fetches every ref, compiles the usable bundles together (a
// cache hit skips both compile passes) and reports per-set failures. It
// returns (nil, errs) when no set is usable — the caller falls back to the
// legacy signatures. Never panics. Rule source lives only in memory for the
// duration of this call.
func LoadMatcher(ctx context.Context, refs []RuleSetRef, f Fetcher, c *Cache) (m Matcher, errs []RuleSetError) {
	defer func() {
		if r := recover(); r != nil {
			m = nil
			errs = append(errs, RuleSetError{ID: "*", Code: CodeEngineUnavailable, Detail: truncate(fmt.Sprint(r), maxDetailLen)})
		}
	}()
	var bundles []*Bundle
	var members []string
	for _, ref := range refs {
		b, rerr := f.Fetch(ctx, ref)
		if rerr != nil {
			errs = append(errs, *rerr)
			continue
		}
		bundles = append(bundles, b)
		members = append(members, ref.SHA256+"@"+ref.ID)
	}
	if len(bundles) == 0 {
		return nil, errs
	}
	err := yarac.EnsureEngine()
	noteStderrRedirect(&stderrNoteOnce, yarac.StderrRedirect)
	if err != nil {
		for _, b := range bundles {
			errs = append(errs, RuleSetError{ID: b.RuleSetID, Version: b.Version, Code: CodeEngineUnavailable, Detail: truncate(err.Error(), maxDetailLen)})
		}
		return nil, errs
	}

	key := CacheKey(members)
	cacheUsable := c != nil
	if cacheUsable {
		entry, err := c.Load(key)
		switch {
		case err != nil:
			log.Warn("YARA compiled-rules cache unusable; compiling without it", "error", err.Error())
			cacheUsable = false
		case entry != nil:
			return &yaraMatcher{entry: entry}, errs
		}
	}

	sets := make([]yarac.Set, 0, len(bundles))
	for _, b := range bundles {
		sets = append(sets, ToYaracSet(b))
	}
	rules, setErrs, err := yarac.CompileSets(sets, yarac.DefaultPolicy)
	for _, b := range bundles { // bundle order, so the result is deterministic
		if re, failed := setErrs[b.RuleSetID]; failed {
			code := CodeCompile
			if re[0].Code == yarac.CodeEngine {
				code = CodeEngineUnavailable
			}
			errs = append(errs, RuleSetError{ID: b.RuleSetID, Version: b.Version, Code: code, Detail: compileDetail(re)})
		}
	}
	if err != nil || rules == nil {
		if err != nil {
			errs = append(errs, RuleSetError{ID: "*", Code: CodeCompile, Detail: truncate(err.Error(), maxDetailLen)})
		}
		return nil, errs
	}
	entry := &CacheEntry{Rules: rules, Index: map[string]RuleMeta{}, AutoQuarantine: map[string]bool{}}
	for _, b := range bundles {
		if _, failed := setErrs[b.RuleSetID]; failed {
			continue
		}
		entry.AutoQuarantine[b.RuleSetID] = b.AutoQuarantine
		for _, r := range b.Rules {
			entry.Index[b.RuleSetID+":"+r.Name] = RuleMeta{RuleID: r.ID, Severity: r.Severity}
		}
	}
	// Only cache a fully successful compile: an entry keyed on every member
	// but missing a failed set would be served next time without
	// re-reporting that set's error.
	if cacheUsable && len(setErrs) == 0 {
		if err := c.Store(key, entry); err != nil {
			log.Warn("failed to cache compiled YARA rules", "error", err.Error())
		}
	}
	return &yaraMatcher{entry: entry}, errs
}

var stderrNoteOnce sync.Once

// noteStderrRedirect logs, once per process, that the engine had to point an
// unusable os.Stderr at the null device so its guest could start (#9253) —
// the expected state under a Windows service. INFO, not WARN: the engine
// works. If the engine still fails, LoadMatcher reports engine_unavailable
// per set and the scan handler WARN-logs each one with the error.
func noteStderrRedirect(once *sync.Once, redirect func() (bool, error)) {
	once.Do(func() {
		if replaced, reason := redirect(); replaced && reason != nil {
			log.Info("process has no usable stderr (expected under a Windows service); YARA engine stderr goes to the null device",
				"reason", reason.Error())
		}
	})
}

// NewMatcherFromEntry wraps an already-compiled entry (breeze-yarac scan).
func NewMatcherFromEntry(e *CacheEntry) Matcher { return &yaraMatcher{entry: e} }
