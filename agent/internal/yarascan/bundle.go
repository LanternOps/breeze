// Package yarascan holds the Breeze YARA wire contract (rule-set bundles and
// payload refs), the device-side fetch + compiled-rules cache, and the
// Matcher abstraction the security scanner drives. Contract: plan
// docs/superpowers/plans/security-auth/2026-10-13-yara-ioc-scanning-w02-agent-engine.md §C1–C5.
//
// Rule SOURCE crosses the wire (TLS, device-authenticated, sha256-pinned) and
// is compiled on this device by the yarac subpackage; only the compiled form
// is ever written to disk (cache.go). The server never ships compiled rules.
package yarascan

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

var log = logging.L("yarascan")

const (
	BundleFormat        = "breeze-yara-bundle"
	BundleFormatVersion = 1
	MaxBundleBytes      = 16 << 20
	MaxRuleSets         = 20
	urlPrefix           = "/api/v1/agents/"
	maxDetailLen        = 512
)

// RuleSetError codes (C3). The server matches on these strings.
const (
	CodeFetch             = "fetch"
	CodeHTTP404           = "http_404"
	CodeHTTP409           = "http_409"
	CodeSHA256Mismatch    = "sha256_mismatch"
	CodeBundleInvalid     = "bundle_invalid"
	CodeCompile           = "compile"
	CodeInvalidRefs       = "invalid_refs"
	CodeEngineUnavailable = "engine_unavailable"
)

var (
	ErrSHA256Mismatch = errors.New("bundle sha256 mismatch")
	ErrBundleInvalid  = errors.New("bundle invalid")
)

var validSeverities = map[string]struct{}{"low": {}, "medium": {}, "high": {}, "critical": {}}

// ruleSetIDPattern bounds what a payload/bundle id may contain. The id
// becomes a YARA namespace and part of the cache key, so it is held to the
// shape of a uuid-ish token rather than trusted as arbitrary text.
var ruleSetIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// refURLPattern: server-relative, conservative character set. Combined with
// the explicit ".." and "//" checks in validRefURL this keeps the fetch on
// the agent's own server and inside the agent API prefix.
var refURLPattern = regexp.MustCompile(`^/api/v1/agents/[A-Za-z0-9._~/-]+$`)

// BundleRule is one rule inside a bundle (C2).
type BundleRule struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
}

// Bundle is the fetched rule-set body (C2). Field order is the canonical
// serialization order.
type Bundle struct {
	Format         string       `json:"format"`
	V              int          `json:"v"`
	RuleSetID      string       `json:"ruleSetId"`
	Version        int          `json:"version"`
	AutoQuarantine bool         `json:"autoQuarantine"`
	Rules          []BundleRule `json:"rules"`
}

// RuleSetRef is one validated entry of the scan payload's ruleSets (C1).
type RuleSetRef struct {
	ID      string
	Version int
	SHA256  string
	URL     string
}

// RuleSetError reports a per-set failure in the scan result (C3). It never
// fails the scan: the remaining sets still run, or the scan falls back to
// the legacy signatures.
type RuleSetError struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Code    string `json:"code"`
	Detail  string `json:"detail,omitempty"`
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBundleInvalid, fmt.Sprintf(format, args...))
}

// truncate caps s at n bytes without splitting a UTF-8 sequence.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && cut < len(s) && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}

// ParseBundle verifies the sha256 pin over the exact bytes BEFORE decoding,
// then validates the bundle shape. Errors wrap ErrSHA256Mismatch or
// ErrBundleInvalid.
func ParseBundle(body []byte, wantSHA256 string) (*Bundle, error) {
	if len(body) > MaxBundleBytes {
		return nil, invalid("bundle exceeds %d bytes", MaxBundleBytes)
	}
	if got := sha256Hex(body); got != strings.ToLower(wantSHA256) {
		return nil, fmt.Errorf("%w: got %s", ErrSHA256Mismatch, got)
	}
	return DecodeBundle(body)
}

// DecodeBundle validates a bundle WITHOUT a sha256 pin. Only for callers that
// built the bytes themselves (breeze-yarac validate, run by the server
// pre-check); the agent's fetch path always goes through ParseBundle.
func DecodeBundle(body []byte) (*Bundle, error) {
	if len(body) > MaxBundleBytes {
		return nil, invalid("bundle exceeds %d bytes", MaxBundleBytes)
	}
	var b Bundle
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, invalid("decode: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, invalid("trailing data after bundle object")
	}
	if b.Format != BundleFormat || b.V != BundleFormatVersion {
		return nil, invalid("unsupported format %q v%d", b.Format, b.V)
	}
	if !ruleSetIDPattern.MatchString(b.RuleSetID) || b.Version < 1 {
		return nil, invalid("missing or malformed ruleSetId or version")
	}
	seen := make(map[string]struct{}, len(b.Rules))
	for _, r := range b.Rules {
		if r.ID == "" || r.Name == "" || r.Source == "" {
			return nil, invalid("rule missing id/name/source")
		}
		if _, ok := validSeverities[r.Severity]; !ok {
			return nil, invalid("rule %s: severity %q", r.Name, r.Severity)
		}
		if _, dup := seen[r.Name]; dup {
			return nil, invalid("duplicate rule name %s", r.Name)
		}
		seen[r.Name] = struct{}{}
	}
	return &b, nil
}

// ToYaracSet converts a bundle to the compiler's input type. yarac cannot
// import this package (cycle), so the conversion lives here.
func ToYaracSet(b *Bundle) yarac.Set {
	s := yarac.Set{ID: b.RuleSetID, Rules: make([]yarac.Rule, 0, len(b.Rules))}
	for _, r := range b.Rules {
		s.Rules = append(s.Rules, yarac.Rule{ID: r.ID, Name: r.Name, Severity: r.Severity, Source: r.Source})
	}
	return s
}

func validRefURL(u string) bool {
	if !strings.HasPrefix(u, urlPrefix) || !refURLPattern.MatchString(u) {
		return false
	}
	return !strings.Contains(u, "..") && !strings.Contains(u, "//")
}

// wholeNumber accepts the numeric shapes a JSON-decoded payload can carry and
// rejects anything that is not an exact positive integer.
func wholeNumber(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 1 || n > math.MaxInt32 {
			return 0, false
		}
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		if err != nil || i < 1 || i > math.MaxInt32 {
			return 0, false
		}
		return int(i), true
	case int:
		return n, n >= 1 && n <= math.MaxInt32
	case int64:
		return int(n), n >= 1 && n <= math.MaxInt32
	default:
		return 0, false
	}
}

// ParseRuleSetRefs validates the payload's ruleSets value (C1). raw is
// cmd.Payload["ruleSets"]; absent/null returns (nil, nil). Any malformed entry
// rejects the whole list: a half-applied rule list would report coverage the
// operator did not configure.
func ParseRuleSetRefs(raw any) ([]RuleSetRef, error) {
	if raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("ruleSets is not an array")
	}
	if len(items) > MaxRuleSets {
		return nil, fmt.Errorf("ruleSets has %d entries (max %d)", len(items), MaxRuleSets)
	}
	refs := make([]RuleSetRef, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for i, it := range items {
		m, ok := it.(map[string]any)
		if !ok || len(m) != 4 {
			return nil, fmt.Errorf("ruleSets[%d]: want object with exactly id, version, sha256, url", i)
		}
		id, _ := m["id"].(string)
		ver, verOK := wholeNumber(m["version"])
		sum, _ := m["sha256"].(string)
		u, _ := m["url"].(string)
		if !ruleSetIDPattern.MatchString(id) {
			return nil, fmt.Errorf("ruleSets[%d]: invalid id", i)
		}
		if !verOK {
			return nil, fmt.Errorf("ruleSets[%d]: version must be a whole number >= 1", i)
		}
		if len(sum) != 64 {
			return nil, fmt.Errorf("ruleSets[%d]: sha256 must be 64 hex characters", i)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return nil, fmt.Errorf("ruleSets[%d]: sha256 not hex", i)
		}
		if !validRefURL(u) {
			return nil, fmt.Errorf("ruleSets[%d]: url must be a server-relative %s path", i, urlPrefix)
		}
		if _, dup := seen[id]; dup {
			return nil, fmt.Errorf("ruleSets[%d]: duplicate id %s", i, id)
		}
		seen[id] = struct{}{}
		refs = append(refs, RuleSetRef{ID: id, Version: ver, SHA256: strings.ToLower(sum), URL: u})
	}
	return refs, nil
}
