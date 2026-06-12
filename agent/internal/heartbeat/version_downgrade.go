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

// helperUpgradeAllowed reports whether a server-directed Helper upgrade to
// target should proceed given the currently installed helper version. On
// refusal it returns a short reason suitable for structured logging.
//
// SECURITY: this mirrors the agent self-update downgrade guard above —
// the signed release manifest only binds manifest.Release == requested
// version, so a compromised/MITM control plane could replay an older,
// validly-signed, known-vulnerable helper release. Unlike isDowngrade
// (fail-open, because agent "dev" builds must stay updatable), this check
// fails CLOSED on unparseable versions: the target always originates from
// the control plane and must be a real release semver, and a non-empty but
// unparseable installed version means we cannot prove the directive isn't
// a downgrade replay.
//
// An empty installed version is only treated as a fresh install (allowed)
// when the helper binary is genuinely absent from disk (installedOnDisk
// false). If the binary IS on disk but its version is unreadable — e.g. no
// user session has written a status file yet, or a status read failed — we
// must FAIL CLOSED: an attacker-replayed older signed release could otherwise
// be installed during that window. Distinguishing "absent" from "present but
// version unknown" is the caller's job (helper.Manager.IsInstalled()).
func helperUpgradeAllowed(target, installed string, installedOnDisk bool) (allowed bool, reason string) {
	if _, _, _, ok := parseSemver(target); !ok {
		return false, "target version is not a parseable semver"
	}
	if strings.TrimSpace(installed) == "" {
		if installedOnDisk {
			return false, "helper present on disk but installed version is unreadable; cannot rule out downgrade replay"
		}
		// Helper not installed yet — fresh install, not a downgrade.
		return true, ""
	}
	if _, _, _, ok := parseSemver(installed); !ok {
		return false, "installed helper version is not a parseable semver"
	}
	if isDowngrade(target, installed) {
		return false, "target version is older than installed helper"
	}
	return true, ""
}
