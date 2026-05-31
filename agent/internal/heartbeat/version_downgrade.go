package heartbeat

import (
	"strconv"
	"strings"
)

// parseSemver extracts major/minor/patch from a version string like "0.68.2"
// or "v0.68.2". A pre-release/build suffix (after '-' or '+') is ignored.
// Returns ok=false for anything that isn't three dotted non-negative integers
// (e.g. "dev", "") so callers can fail open.
func parseSemver(v string) (maj, min, patch int, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return 0, 0, 0, false
		}
		out[i] = n
	}
	return out[0], out[1], out[2], true
}

// isDowngrade reports whether target is a strictly lower semver than current.
// Fail-open: returns false when either version is unparseable, so updates we
// cannot reason about (e.g. "dev" builds) are never blocked — the security
// goal is to stop a control plane forcing a real older release onto agents
// running a real newer one, not to police non-semver builds.
func isDowngrade(target, current string) bool {
	tMaj, tMin, tPatch, tOk := parseSemver(target)
	cMaj, cMin, cPatch, cOk := parseSemver(current)
	if !tOk || !cOk {
		return false
	}
	if tMaj != cMaj {
		return tMaj < cMaj
	}
	if tMin != cMin {
		return tMin < cMin
	}
	return tPatch < cPatch
}
