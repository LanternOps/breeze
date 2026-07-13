package backup

import (
	"log"
	"path"
	"runtime"
	"strings"
)

// excludeMatcher applies user-configured exclusion patterns to paths visited
// during a file-mode backup walk. Patterns come from the config-policy Backup
// tab (see apps/web/.../backupTabPresets.ts) and use forward-slash glob
// syntax with doublestar support:
//
//   - "*.tmp", "Thumbs.db"                — no slash: matched against the base
//     name of every file AND directory visited.
//   - "node_modules/**", "$RECYCLE.BIN/**" — slash: matched against the
//     root-relative path, where "**" spans zero or more path segments.
//     Patterns match at any depth (gitignore-style implicit leading "**/"),
//     so "node_modules/**" excludes every node_modules directory, not just
//     one at the backup root. A pattern that matches a directory excludes
//     the whole subtree (the walker returns fs.SkipDir).
//
// Matching is case-insensitive on Windows (case-insensitive filesystems) and
// case-sensitive elsewhere. Invalid glob patterns are logged and skipped
// rather than failing the backup.
type excludeMatcher struct {
	baseName        []string   // patterns without "/" — base-name globs
	relPath         [][]string // patterns with "/" — pre-split path segments
	caseInsensitive bool
}

// newExcludeMatcher compiles exclusion patterns. Returns nil when no usable
// patterns remain (callers treat a nil matcher as "exclude nothing").
func newExcludeMatcher(patterns []string) *excludeMatcher {
	return newExcludeMatcherForOS(patterns, runtime.GOOS == "windows")
}

func newExcludeMatcherForOS(patterns []string, caseInsensitive bool) *excludeMatcher {
	m := &excludeMatcher{caseInsensitive: caseInsensitive}
	for _, raw := range patterns {
		// Normalize Windows-style separators so "AppData\Local" works; after
		// this, backslash escape sequences no longer exist in patterns.
		p := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
		p = strings.Trim(p, "/")
		if p == "" {
			continue
		}
		if caseInsensitive {
			p = strings.ToLower(p)
		}
		// Validate glob syntax up front so a bad pattern is reported once per
		// run instead of silently never matching. Validation must mirror the
		// runtime exactly: slash patterns are matched per segment, so they
		// are validated per segment too (e.g. "a[x/y]b" is a valid glob as a
		// full string but splits into malformed segments).
		if strings.Contains(p, "/") {
			segs := strings.Split(p, "/")
			if !validGlobSegments(segs) {
				log.Printf("[backup] ignoring invalid exclusion pattern %q", raw)
				continue
			}
			// Implicit leading "**/" so patterns match at any depth
			// (consecutive "**" segments are collapsed by matchSegments).
			m.relPath = append(m.relPath, append([]string{"**"}, segs...))
		} else {
			if _, err := path.Match(p, "probe"); err != nil {
				log.Printf("[backup] ignoring invalid exclusion pattern %q: %v", raw, err)
				continue
			}
			m.baseName = append(m.baseName, p)
		}
	}
	if len(m.baseName) == 0 && len(m.relPath) == 0 {
		return nil
	}
	return m
}

// matches reports whether the entry at relPath (root-relative, slash-separated)
// is excluded. Works for files and directories alike; the walker decides
// whether a hit means "skip file" or "skip subtree".
func (m *excludeMatcher) matches(relPath string) bool {
	if m == nil || relPath == "" || relPath == "." {
		return false
	}
	rel := strings.ReplaceAll(relPath, "\\", "/")
	if m.caseInsensitive {
		rel = strings.ToLower(rel)
	}

	base := path.Base(rel)
	for _, p := range m.baseName {
		if ok, _ := path.Match(p, base); ok {
			return true
		}
	}

	if len(m.relPath) == 0 {
		return false
	}
	segs := strings.Split(rel, "/")
	for _, patSegs := range m.relPath {
		if matchSegments(patSegs, segs) {
			return true
		}
	}
	return false
}

// validGlobSegments reports whether every non-doublestar segment is a valid
// single-segment glob. path.Match's ErrBadPattern is independent of the name
// being matched (Go 1.16+), so probing with a fixed name is exhaustive.
// Empty segments (from "a//b") are rejected: they could never match a real
// path segment and indicate a malformed pattern.
func validGlobSegments(segs []string) bool {
	for _, s := range segs {
		if s == "**" {
			continue
		}
		if s == "" {
			return false
		}
		if _, err := path.Match(s, "probe"); err != nil {
			return false
		}
	}
	return true
}

// matchSegments matches glob pattern segments against path segments, where a
// "**" pattern segment spans zero or more path segments. Non-doublestar
// segments use path.Match single-segment glob semantics (errors from a
// malformed segment are treated as non-match; construction-time validation
// makes that branch defensively unreachable).
func matchSegments(pattern, segs []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			// Collapse consecutive "**" and try every possible span.
			for len(pattern) > 0 && pattern[0] == "**" {
				pattern = pattern[1:]
			}
			if len(pattern) == 0 {
				return true // trailing ** matches everything (including nothing)
			}
			for i := 0; i <= len(segs); i++ {
				if matchSegments(pattern, segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, err := path.Match(pattern[0], segs[0]); err != nil || !ok {
			return false
		}
		pattern = pattern[1:]
		segs = segs[1:]
	}
	return len(segs) == 0
}
