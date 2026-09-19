package tools

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
)

// cleanup_rules.json is a byte-identical COPY of
// packages/shared/src/utils/cleanupRules.json. go:embed patterns may not
// contain ".." or leave the package directory, and this module's root is
// agent/, so the shared file cannot be embedded directly. The copy is enforced
// by TestEmbeddedCleanupRulesMatchSharedSource (and by the mirror assertion in
// packages/shared/src/utils/cleanupRules.test.ts).
//
//go:embed cleanup_rules.json
var cleanupRulesJSON []byte

// CleanupGuardRejectedPrefix marks a file_delete refused by the cleanupGuard.
// CommandResult.Status has no `rejected` member, so the refusal rides the error
// string and the API maps this prefix onto the `rejected` per-path status
// (spec §5.2). Mirrored by CLEANUP_GUARD_REJECTED_PREFIX in packages/shared.
const CleanupGuardRejectedPrefix = "cleanup guard rejected:"

type cleanupRuleSpec struct {
	Category    string   `json:"category"`
	OS          string   `json:"os"`
	Patterns    []string `json:"patterns"`
	Exclude     []string `json:"exclude"`
	MinAgeHours int      `json:"minAgeHours"`
	Granularity string   `json:"granularity"`
}

type cleanupDeniedRootSpec struct {
	OS    string   `json:"os"`
	Roots []string `json:"roots"`
}

type cleanupRuleFile struct {
	Version     int                     `json:"version"`
	Rules       []cleanupRuleSpec       `json:"rules"`
	DeniedRoots []cleanupDeniedRootSpec `json:"deniedRoots"`
}

type compiledCleanupRule struct {
	category    string
	granularity string
	minAge      time.Duration
	patterns    [][]string
	exclude     [][]string
}

type cleanupRuleMatch struct {
	Category    string
	Granularity string
	MinAge      time.Duration
	// Number of leading WILDCARD-FREE components in the pattern that matched.
	// This is the confinement anchor (spec §13 row 1): everything from here
	// down is traversed through an os.Root handle, never by pathname.
	LiteralPrefix int
}

type cleanupRuleTable struct {
	byOS   map[string][]compiledCleanupRule
	denied map[string][]string
}

var (
	cleanupRulesOnce  sync.Once
	cleanupRuleTables *cleanupRuleTable
	cleanupRulesErr   error
)

// loadCleanupRules parses and compiles the embedded table exactly once. A
// malformed table is a build-time authoring error, not a runtime condition: the
// scanner treats a load failure as "nothing is classifiable", which is the
// fail-closed direction (no candidates rather than wrong candidates).
func loadCleanupRules() (*cleanupRuleTable, error) {
	cleanupRulesOnce.Do(func() {
		var file cleanupRuleFile
		if err := json.Unmarshal(cleanupRulesJSON, &file); err != nil {
			cleanupRulesErr = fmt.Errorf("parse cleanup rules: %w", err)
			return
		}
		table := &cleanupRuleTable{
			byOS:   map[string][]compiledCleanupRule{},
			denied: map[string][]string{},
		}
		for _, spec := range file.Rules {
			patterns, err := compileCleanupPatterns(spec.Patterns)
			if err != nil {
				cleanupRulesErr = err
				return
			}
			exclude, err := compileCleanupPatterns(spec.Exclude)
			if err != nil {
				cleanupRulesErr = err
				return
			}
			table.byOS[spec.OS] = append(table.byOS[spec.OS], compiledCleanupRule{
				category:    spec.Category,
				granularity: spec.Granularity,
				minAge:      time.Duration(spec.MinAgeHours) * time.Hour,
				patterns:    patterns,
				exclude:     exclude,
			})
		}
		for _, spec := range file.DeniedRoots {
			table.denied[spec.OS] = append(table.denied[spec.OS], spec.Roots...)
		}
		cleanupRuleTables = table
	})
	return cleanupRuleTables, cleanupRulesErr
}

func compileCleanupPatterns(patterns []string) ([][]string, error) {
	out := make([][]string, 0, len(patterns))
	for _, pattern := range patterns {
		expanded, err := expandCleanupBraces(pattern)
		if err != nil {
			return nil, err
		}
		for _, concrete := range expanded {
			out = append(out, splitCleanupComponents(concrete))
		}
	}
	return out, nil
}

// expandCleanupBraces turns `a/{b/c,d}/e` into [a/b/c/e a/d/e]. Alternation is
// expanded BEFORE component splitting because the spec's alternatives cross
// component boundaries ({google/chrome,microsoft/edge}).
func expandCleanupBraces(pattern string) ([]string, error) {
	open := strings.IndexByte(pattern, '{')
	if open < 0 {
		return []string{pattern}, nil
	}
	rel := strings.IndexByte(pattern[open:], '}')
	if rel < 0 {
		return nil, fmt.Errorf("unbalanced brace in cleanup pattern %q", pattern)
	}
	closeAt := open + rel
	group := pattern[open+1 : closeAt]
	if strings.Contains(group, "{") {
		return nil, fmt.Errorf("nested brace alternation is not supported: %q", pattern)
	}
	prefix := pattern[:open]
	suffix := pattern[closeAt+1:]
	out := []string{}
	for _, alt := range strings.Split(group, ",") {
		expanded, err := expandCleanupBraces(prefix + alt + suffix)
		if err != nil {
			return nil, err
		}
		out = append(out, expanded...)
	}
	return out, nil
}

func splitCleanupComponents(normalized string) []string {
	parts := strings.Split(normalized, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// normalizeCleanupPathFor normalises a path for matching. Normalisation is PER
// OS (spec §13 row 10): windows folds case and converts '\\'→'/'; darwin folds
// case only (default APFS is case-insensitive) and keeps backslashes as
// ordinary filename characters; linux does neither. Folding on POSIX changes
// path identity — `/TMP/x` is a DIFFERENT directory from `/tmp/x` on Linux, and
// a file literally named `.cache\\v` is not inside `.cache`.
//
// On Windows the drive specifier becomes the `<vol>` token, so one rule covers
// every fixed volume — the fix for defect 2's `C:\$Recycle.Bin` hardcode.
func normalizeCleanupPathFor(goos, path string) string {
	n := strings.TrimSpace(path)
	if goos == "windows" {
		n = strings.ReplaceAll(n, "\\", "/")
	}
	for strings.Contains(n, "//") {
		n = strings.ReplaceAll(n, "//", "/")
	}
	if goos != "linux" {
		n = strings.ToLower(n)
	}
	if len(n) > 1 && strings.HasSuffix(n, "/") {
		n = strings.TrimSuffix(n, "/")
	}
	if goos == "windows" && len(n) >= 2 && n[1] == ':' && n[0] >= 'a' && n[0] <= 'z' {
		n = "<vol>" + n[2:]
	}
	return n
}

// matchCleanupComponentGlob matches ONE path component. `*` matches any
// (possibly empty) run of characters within that component; it never spans '/'.
func matchCleanupComponentGlob(pattern, name string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == name
	}
	parts := strings.Split(pattern, "*")
	if !strings.HasPrefix(name, parts[0]) {
		return false
	}
	rest := name[len(parts[0]):]
	for i := 1; i < len(parts)-1; i++ {
		idx := strings.Index(rest, parts[i])
		if idx < 0 {
			return false
		}
		rest = rest[idx+len(parts[i]):]
	}
	return strings.HasSuffix(rest, parts[len(parts)-1])
}

// matchCleanupComponents walks a component pattern against a component path.
// `**` matches ONE OR MORE components. Recursion is bounded by the path depth
// (the scanner caps depth at maxFSMaxDepth = 64) and patterns carry at most one
// `**`, so the search never blows up.
func matchCleanupComponents(pattern, path []string) bool {
	if len(pattern) == 0 {
		return len(path) == 0
	}
	if pattern[0] == "**" {
		for consume := 1; consume <= len(path); consume++ {
			if matchCleanupComponents(pattern[1:], path[consume:]) {
				return true
			}
		}
		return false
	}
	if len(path) == 0 {
		return false
	}
	if !matchCleanupComponentGlob(pattern[0], path[0]) {
		return false
	}
	return matchCleanupComponents(pattern[1:], path[1:])
}

// matchCleanupRuleFor returns the first rule whose pattern matches and whose
// exclude list does not. An excluded match CONTINUES to the next rule rather
// than terminating: that is how /home/*/.cache/pip/** leaves browser_cache and
// is claimed by package_cache.
func matchCleanupRuleFor(goos, path string) *cleanupRuleMatch {
	table, err := loadCleanupRules()
	if err != nil || table == nil {
		return nil
	}
	components := splitCleanupComponents(normalizeCleanupPathFor(goos, path))
	for _, rule := range table.byOS[goos] {
		var matchedPattern []string
		for _, pattern := range rule.patterns {
			if matchCleanupComponents(pattern, components) {
				matchedPattern = pattern
				break
			}
		}
		if matchedPattern == nil {
			continue
		}
		excluded := false
		for _, pattern := range rule.exclude {
			if matchCleanupComponents(pattern, components) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		return &cleanupRuleMatch{
			Category:      rule.category,
			Granularity:   rule.granularity,
			MinAge:        rule.minAge,
			LiteralPrefix: literalPrefixLen(matchedPattern),
		}
	}
	return nil
}

// literalPrefixLen counts the leading pattern components that contain no
// wildcard. Those components are fixed by the RULE AUTHOR, so the directory
// they name is a trustworthy place to anchor a confined traversal.
func literalPrefixLen(pattern []string) int {
	n := 0
	for _, component := range pattern {
		if component == "**" || strings.Contains(component, "*") {
			break
		}
		n++
	}
	return n
}

// cleanupRuleAnchorFor maps a matched rule's literal prefix back onto the
// CONCRETE path, producing the directory the agent opens with os.OpenRoot
// before it touches anything (`/home/*/.cache/**` → `/home`;
// `<vol>/users/*/appdata/local/temp/**` → `C:\Users`).
//
// Everything below the anchor is then resolved by the runtime through that
// handle, so an ancestor swapped for a symlink or a junction between preview
// and execute is refused rather than followed (spec §13 row 1).
func cleanupRuleAnchorFor(goos, path string) (string, bool) {
	match := matchCleanupRuleFor(goos, path)
	if match == nil || match.LiteralPrefix == 0 {
		return "", false
	}
	return concreteAnchor(goos, path, match.LiteralPrefix)
}

// concreteAnchor rebuilds the first n normalised components of path as a real,
// platform-shaped path. On Windows the first component is the `<vol>` token,
// which maps to the volume specifier rather than to a directory.
func concreteAnchor(goos, path string, n int) (string, bool) {
	if n <= 0 {
		return "", false
	}
	// Use the requested OS grammar, not the host's filepath implementation:
	// the shared contract exercises Windows paths on POSIX hosts too.
	separator := "/"
	prefix := "/"
	if goos == "windows" {
		path = strings.ReplaceAll(path, "\\", "/")
		if len(path) < 3 || path[1] != ':' || path[2] != '/' ||
			!((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')) {
			return "", false
		}
		separator = "\\"
		prefix = path[:2] + separator
		path = path[2:]
		n-- // The volume token is the first pattern component.
	} else if !strings.HasPrefix(path, "/") {
		return "", false
	}
	parts := splitCleanupComponents(path)
	if n > len(parts) {
		return "", false
	}
	for _, part := range parts {
		if part == "." || part == ".." {
			return "", false
		}
	}
	return prefix + strings.Join(parts[:n], separator), true
}

func matchCleanupRule(path string) *cleanupRuleMatch {
	return matchCleanupRuleFor(runtime.GOOS, path)
}

// isCleanupDeniedRootFor reports whether path IS a cleanup-denied root or lives
// under one. Roots are stored bare (no `/**`) precisely so the root node itself
// is denied: /private/var/db sits at depth 3, below isRecursiveDeleteBoundary's
// reach.
func isCleanupDeniedRootFor(goos, path string) bool {
	table, err := loadCleanupRules()
	if err != nil || table == nil {
		// Fail closed: with no table we cannot prove a path is safe.
		return true
	}
	normalized := normalizeCleanupPathFor(goos, path)
	for _, root := range table.denied[goos] {
		if normalized == root || strings.HasPrefix(normalized, root+"/") {
			return true
		}
	}
	return false
}

func isCleanupDeniedRoot(path string) bool {
	return isCleanupDeniedRootFor(runtime.GOOS, path)
}

// classifyCleanupPathFor is the single place `Safe` is decided (spec §6.1:
// "Safe is true only when a rule matched, no Exclude matched, and the min-age
// check passed"). It replaces the hardcoded `Safe: true` at
// filesystem_analysis.go:425 and :591.
func classifyCleanupPathFor(goos, path string, modTime, now time.Time) (string, string, bool) {
	if isCleanupDeniedRootFor(goos, path) {
		return "", "", false
	}
	match := matchCleanupRuleFor(goos, path)
	if match == nil {
		return "", "", false
	}
	if match.MinAge > 0 && now.Sub(modTime) < match.MinAge {
		return "", "", false
	}
	return match.Category, match.Granularity, true
}

func classifyCleanupPath(path string, modTime, now time.Time) (string, string, bool) {
	return classifyCleanupPathFor(runtime.GOOS, path, modTime, now)
}
