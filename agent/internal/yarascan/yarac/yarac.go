// Package yarac is breeze-yarac: the single implementation of Breeze's YARA
// compile policy (spec §5.3 as amended by the 2026-10-13 owner decision —
// compilation happens on the agent; the server pre-check runs this same code
// via cmd/breeze-yarac). Nothing else in the repo may call yaraxwasm's
// compiler directly.
//
// Every yaraxwasm call that can panic on a guest failure (NewNamespace, Build,
// NewScanner, …) is reached only through functions here or in the yarascan
// matcher that recover and convert the panic into an "engine" error.
package yarac

import (
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"strings"
	"sync"

	yx "github.com/niallnsec/yaraxwasm"
)

// PolicyVersion identifies this file's compile policy (C5). Bump on ANY
// change to compilerOptions, ruleErrors or DefaultPolicy; it is part of the
// compiled-rules cache key and of `breeze-yarac version`, so the server
// pre-check and the agent can be compared in diagnostics.
const PolicyVersion = 1

// Rule is one rule source to compile. yarascan.Bundle converts to this type
// (yarac must not import yarascan — that would be an import cycle).
type Rule struct{ ID, Name, Severity, Source string }

// Set is one rule set; it compiles into its own YARA namespace = ID.
type Set struct {
	ID    string
	Rules []Rule
}

// Policy holds the C5 caps.
type Policy struct {
	MaxRulesPerSet     int
	MaxRuleSourceBytes int
	MaxStringsPerSet   int
}

// DefaultPolicy is the C5 policy enforced on the agent and by the pre-check.
var DefaultPolicy = Policy{MaxRulesPerSet: 500, MaxRuleSourceBytes: 64 << 10, MaxStringsPerSet: 10000}

// RuleError is one per-rule (or per-set, when RuleID is empty) policy or
// compile failure. Its JSON shape is the C5 contract W03's pre-check parses.
type RuleError struct {
	RuleID  string `json:"ruleId"`
	Name    string `json:"name"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
}

// Error codes in RuleError.Code.
const (
	CodeCapRules   = "cap_rules"
	CodeCapSource  = "cap_source"
	CodeCapStrings = "cap_strings"
	CodeOneRule    = "one_rule"
	CodeCompile    = "compile"
	CodeEngine     = "engine"
)

const (
	modulePath       = "github.com/niallnsec/yaraxwasm"
	guestOverrideEnv = "YARAX_GUEST_WASM"
	maxMessageLen    = 1024
)

// EngineVersion returns the pinned yaraxwasm module version compiled into
// this binary ("unknown" when build info is unavailable, e.g. some test
// binaries). It is part of the compiled-rules cache key.
func EngineVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == modulePath {
				if d.Replace != nil && d.Replace.Version != "" {
					return d.Replace.Version
				}
				return d.Version
			}
		}
	}
	return "unknown"
}

var (
	engineOnce sync.Once
	engineErr  error
)

// EnsureEngine loads and compiles the embedded YARA-X guest module once per
// process. yaraxwasm would otherwise honour a YARAX_GUEST_WASM environment
// variable and execute whatever wasm file it names; the agent only ever runs
// the guest embedded in its own (signed) binary, so the override is cleared
// before the first load.
func EnsureEngine() error {
	engineOnce.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				engineErr = fmt.Errorf("YARA engine init panicked: %v", r)
			}
		}()
		if os.Getenv(guestOverrideEnv) != "" {
			_ = os.Unsetenv(guestOverrideEnv)
		}
		if err := yx.Initialise(); err != nil {
			engineErr = fmt.Errorf("YARA engine init failed: %w", err)
		}
	})
	return engineErr
}

func compilerOptions() []yx.CompileOption {
	return []yx.CompileOption{
		yx.BanModule("console", "banned module", "the console module is not allowed in Breeze detection rules"),
		yx.ErrorOnSlowPattern(true),
		yx.ErrorOnSlowLoop(true),
		yx.Globals(map[string]any{"filename": "", "filepath": "", "extension": ""}),
		// Upstream defaults includes ON (quorum finding, compiler.go:261 @ v1.1.0).
		yx.EnableIncludes(false),
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}

// compileMessage turns an engine error into a one-line message + line number.
func compileMessage(err error) (string, int) {
	var ce yx.CompileError
	if errors.As(err, &ce) || asCompileError(err, &ce) {
		msg := ce.Title
		if ce.Code != "" {
			msg = ce.Code + ": " + msg
		}
		for _, l := range ce.Labels {
			if l.Text != "" {
				msg += " — " + l.Text
				break
			}
		}
		if msg == "" {
			msg = ce.Text
		}
		return truncate(msg, maxMessageLen), ce.Line
	}
	return truncate(err.Error(), maxMessageLen), 0
}

func asCompileError(err error, out *yx.CompileError) bool {
	if p, ok := err.(*yx.CompileError); ok && p != nil {
		*out = *p
		return true
	}
	return false
}

func engineError(r any) RuleError {
	return RuleError{Code: CodeEngine, Message: truncate(fmt.Sprintf("YARA engine failure: %v", r), maxMessageLen)}
}

func shapeErrors(s Set, p Policy) []RuleError {
	var out []RuleError
	if len(s.Rules) > p.MaxRulesPerSet {
		out = append(out, RuleError{Code: CodeCapRules, Message: fmt.Sprintf("%d rules exceeds the cap of %d", len(s.Rules), p.MaxRulesPerSet)})
	}
	for _, r := range s.Rules {
		if len(r.Source) > p.MaxRuleSourceBytes {
			out = append(out, RuleError{RuleID: r.ID, Name: r.Name, Code: CodeCapSource,
				Message: fmt.Sprintf("rule source is %d bytes (max %d)", len(r.Source), p.MaxRuleSourceBytes)})
		}
	}
	return out
}

// ValidateSet applies the full C5 policy to one set and returns every
// violation (empty = OK). Each rule is compiled in its own scratch namespace
// so a failure is attributed to exactly one rule and a rule source that
// declares zero, two, or a differently named rule is caught from the
// engine's own view of the compiled rules — not from a regex over source.
func ValidateSet(s Set, p Policy) (errs []RuleError) {
	if errs = shapeErrors(s, p); len(errs) > 0 {
		return errs
	}
	if err := EnsureEngine(); err != nil {
		return []RuleError{{Code: CodeEngine, Message: truncate(err.Error(), maxMessageLen)}}
	}
	defer func() {
		if r := recover(); r != nil {
			errs = []RuleError{engineError(r)}
		}
	}()

	c, err := yx.NewCompiler(compilerOptions()...)
	if err != nil {
		return []RuleError{{Code: CodeEngine, Message: truncate(err.Error(), maxMessageLen)}}
	}
	defer c.Destroy()

	seenErrs := 0
	for i, r := range s.Rules {
		// Scratch namespace per rule; the index keeps namespaces unique even
		// if a malformed caller repeats a rule id.
		c.NewNamespace(fmt.Sprintf("r%d", i))
		if err := c.AddSource(r.Source); err != nil {
			msg, line := compileMessage(err)
			// AddSource returns the rendered report as a plain error; the
			// structured form (code, title, line) is in Errors(), which
			// accumulates across calls — take the first entry this call added.
			if all := c.Errors(); len(all) > seenErrs {
				msg, line = compileMessage(all[seenErrs])
				seenErrs = len(all)
			}
			errs = append(errs, RuleError{RuleID: r.ID, Name: r.Name, Code: CodeCompile, Message: msg, Line: line})
		}
	}
	if len(errs) > 0 {
		return errs
	}

	rules := c.Build()
	declared := make(map[string][]string, len(s.Rules))
	patterns := 0
	for _, cr := range rules.Slice() {
		declared[cr.Namespace()] = append(declared[cr.Namespace()], cr.Identifier())
		patterns += len(cr.Patterns())
	}
	for i, r := range s.Rules {
		got := declared[fmt.Sprintf("r%d", i)]
		if len(got) != 1 || got[0] != r.Name {
			errs = append(errs, RuleError{RuleID: r.ID, Name: r.Name, Code: CodeOneRule,
				Message: fmt.Sprintf("each rule source must declare exactly one rule named %s (found: %s)", r.Name, strings.Join(got, ", "))})
		}
	}
	if len(errs) > 0 {
		return errs
	}
	if patterns > p.MaxStringsPerSet {
		return []RuleError{{Code: CodeCapStrings, Message: fmt.Sprintf("%d strings exceeds the cap of %d", patterns, p.MaxStringsPerSet)}}
	}
	return nil
}

func buildSets(sets []Set) (rules *yx.Rules, err error) {
	defer func() {
		if r := recover(); r != nil {
			rules, err = nil, fmt.Errorf("YARA engine failure during build: %v", r)
		}
	}()
	c, err := yx.NewCompiler(compilerOptions()...)
	if err != nil {
		return nil, err
	}
	defer c.Destroy()
	for _, s := range sets {
		c.NewNamespace(s.ID)
		for _, r := range s.Rules {
			if err := c.AddSource(r.Source); err != nil {
				msg, _ := compileMessage(err)
				return nil, fmt.Errorf("set %s rule %s: %s", s.ID, r.Name, msg)
			}
		}
	}
	return c.Build(), nil
}

// CompileSets validates every set, then compiles the valid ones into ONE
// Rules with namespace = set ID (DECISION W02-b: one wasm scanner per worker,
// not one per set). Sets that fail validation are omitted and reported in the
// map; a nil Rules with a nil error means no set was usable. A non-nil error
// means the combined build failed after every set validated alone (engine
// failure) — callers treat that as all sets unusable.
func CompileSets(sets []Set, p Policy) (*yx.Rules, map[string][]RuleError, error) {
	errs := make(map[string][]RuleError)
	var ok []Set
	for _, s := range sets {
		if e := ValidateSet(s, p); len(e) > 0 {
			errs[s.ID] = e
			continue
		}
		ok = append(ok, s)
	}
	if len(ok) == 0 {
		return nil, errs, nil
	}
	rules, err := buildSets(ok)
	if err != nil {
		return nil, errs, err
	}
	return rules, errs, nil
}
