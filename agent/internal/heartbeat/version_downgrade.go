package heartbeat

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/versionpolicy"
)

// mainAgentUpgradeDecision decides whether the agent should install target,
// given its own currently-running version. This is the only update path
// granted the versionpolicy "dev" build development-compatibility exception
// — see versionpolicy.MainAgentCurrent.
//
// SECURITY: never auto-downgrade. A compromised/MITM'd control plane could
// otherwise force a fleet-wide rollback to an older, still-validly-signed,
// known-vulnerable build, or slip a malformed/prerelease target past a
// naive comparison. Deliberate rollback is an operator action via the
// (default-off) dev_update path, not this one.
func mainAgentUpgradeDecision(target, current string) versionpolicy.Decision {
	return versionpolicy.Decide(target, current, versionpolicy.MainAgentCurrent)
}

// helperUpgradeAllowed reports whether a server-directed Helper upgrade to
// target should proceed given the currently installed helper version. On
// refusal it returns a short reason suitable for structured logging.
//
// SECURITY: this mirrors the agent self-update downgrade guard above — the
// signed release manifest only binds manifest.Release == requested version,
// so a compromised/MITM'd control plane could replay an older, validly
// signed, known-vulnerable helper release. Unlike the main-agent decision,
// the helper is never granted the "dev" exception: the target always
// originates from the control plane and must be a real release semver, and a
// non-empty but unparseable installed version means we cannot prove the
// directive isn't a downgrade replay.
//
// An empty installed version is only treated as a fresh install (allowed)
// when it is ALSO genuinely absent from disk (installedOnDisk false) — both
// signals must agree. installedOnDisk and installed come from independent
// sources (helper.Manager.IsInstalled() stats the binary path; InstalledVersion()
// reads separate per-session status files), and a partial uninstall can
// desync them: e.g. package removal succeeds but clearing the sessions
// directory fails (locked file, permission error) and only logs a warning,
// leaving IsInstalled() == false while InstalledVersion() still returns the
// last real installed version. If installedOnDisk alone selected the
// fresh-install policy, that stale non-empty "installed" would be discarded
// entirely and any signed-but-older target would sail through as a "fresh
// install" — reintroducing exactly the downgrade-replay this function
// exists to block. So the fresh-install policy requires installed to be
// itself empty/whitespace; a non-empty installed version — on disk or not —
// is always compared for real via InstalledComponentCurrent.
//
// If the binary IS on disk but its version is unreadable — e.g. no user
// session has written a status file yet, or a status read failed — we must
// also FAIL CLOSED: an attacker-replayed older signed release could
// otherwise be installed during that window. Distinguishing "absent" from
// "present but version unknown" is the caller's job (helper.Manager.IsInstalled()).
func helperUpgradeAllowed(target, installed string, installedOnDisk bool) (allowed bool, reason string) {
	policy := versionpolicy.InstalledComponentCurrent
	if !installedOnDisk && strings.TrimSpace(installed) == "" {
		policy = versionpolicy.AbsentComponentCurrent
	}
	d := versionpolicy.Decide(target, installed, policy)
	if d.Allowed {
		return true, ""
	}
	return false, d.Reason
}

// watchdogUpgradeDecision decides whether the watchdog should be swapped to
// target, given the running agent's own version as the comparison floor —
// the watchdog ships in lockstep with the agent, so the agent's version is a
// safe stand-in for "the watchdog's current version" even though it isn't
// literally the on-disk watchdog binary's version.
//
// SECURITY: mirrors the helper-upgrade guard's posture, including NOT
// granting the main-agent "dev" exception (InstalledComponentCurrent, not
// MainAgentCurrent) — an agent dev build must not waive the downgrade guard
// for a server-directed, privileged watchdog binary swap.
func watchdogUpgradeDecision(target, agentVersion string) versionpolicy.Decision {
	return versionpolicy.Decide(target, agentVersion, versionpolicy.InstalledComponentCurrent)
}
