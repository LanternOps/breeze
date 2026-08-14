package patching

import (
	"fmt"
	"strings"
	"time"
)

// userWingetScanTimeout bounds the user-context pass. It is deliberately the
// same budget as the SYSTEM pass: the two run sequentially inside one provider
// Scan(), so the worst case a patch cycle can block is the sum of the two, and
// the user pass is additionally bounded by the helper's own kill timer.
const userWingetScanTimeout = 120 * time.Second

// UserExecFunc runs a command in the interactive user's context and returns
// stdout, stderr and the process exit code. It is implemented by the heartbeat
// against the user-helper IPC transport (session broker -> helper
// executeProcess). err is reserved for "the command could not be run at all"
// (no helper session, IPC failure, helper-side timeout); a non-zero exit from
// the command itself is reported via exitCode.
type UserExecFunc func(name string, args []string, timeout time.Duration) (stdout, stderr string, exitCode int, err error)

// UserScanStatus reports the outcome of the best-effort user-context winget
// pass for the most recent scan. It exists so the platform can say "per-user
// apps were not scanned" rather than silently under-reporting a device to zero
// third-party updates (#2727) — a skipped user pass and a genuinely clean user
// scope are indistinguishable from the patch list alone.
type UserScanStatus struct {
	// Attempted is true when the provider was configured with a user-context
	// executor and tried the pass this scan.
	Attempted bool
	// Scanned is true only when the pass ran and produced output we could
	// parse, i.e. the per-user results in this scan are trustworthy.
	Scanned bool
	// Reason explains why Scanned is false. Empty when Scanned is true.
	Reason string
}

// UserScopeScanner is implemented by providers that additionally attempt a
// user-context pass, so callers can report what the last scan actually covered.
type UserScopeScanner interface {
	LastUserScan() UserScanStatus
}

// userScanArgs builds the user-context `winget upgrade` arguments.
//
// `--scope user` (rather than an unscoped run filtered afterwards) is
// deliberate. The helper runs on the user's FILTERED token, which can read
// HKLM, so an unscoped run in that context returns machine-wide packages too —
// and `winget upgrade` has no scope column, so nothing in the output would let
// us label which rows came from which scope. Asking winget for user scope makes
// the Scope label truthful by construction and makes the merge with the SYSTEM
// pass a straight union rather than a guess.
//
// The known cost is symmetric with the SYSTEM pass: `--scope` also drops
// packages whose installed scope winget cannot classify. That is a pre-existing
// winget under-reporting bug affecting both passes and is tracked separately —
// it is not made worse here.
func userScanArgs() []string {
	return []string{"upgrade", "--include-unknown", "--scope", "user",
		"--source", "winget", "--accept-source-agreements", "--disable-interactivity"}
}

// userWingetScan runs the user-context winget pass and returns the per-user
// upgradable packages. Every failure mode returns an error — the caller treats
// any error as "user scope not scanned" and still reports machine-scope
// results, so a missing helper never degrades the SYSTEM scan.
//
// "winget" is invoked by name, not by the SYSTEM-resolved path: winget ships as
// an App Execution Alias that resolves per-user, and the path the service
// process resolved for itself is not necessarily launchable in the user's
// session.
func userWingetScan(exec UserExecFunc) ([]AvailablePatch, error) {
	if exec == nil {
		return nil, fmt.Errorf("no user-context executor configured")
	}

	stdout, stderr, code, err := exec("winget", userScanArgs(), userWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("user-context winget upgrade failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("user-context winget upgrade failed (exit %d): %s",
			code, truncatePatchField(stderr))
	}

	patches, parseErr := parseWingetUpgradeOutput(stdout)
	if parseErr != nil {
		// Same reasoning as the SYSTEM pass (#2726): output we could not parse
		// is not evidence of an empty user scope. Report it as unscanned so the
		// absence of per-user rows is explained rather than presented as a
		// clean result.
		return nil, fmt.Errorf("%v (exit %d, stdout: %q, stderr: %q)",
			parseErr, code, truncatePatchField(stdout), truncatePatchField(stderr))
	}
	return patches, nil
}

// mergeWingetScopes labels and merges the two winget passes.
//
// Machine-scope entries win a package-ID collision. A package can legitimately
// be installed at both scopes, but the platform stores at most one pending row
// per (device, package), and the machine-scope entry is the one this agent can
// actually remediate from SYSTEM today — so keeping it is both the honest and
// the actionable choice. The user-scope duplicate is dropped, not merged, so no
// package is ever reported twice.
//
// Comparison is case-insensitive because winget package IDs are.
func mergeWingetScopes(machine, user []AvailablePatch) []AvailablePatch {
	merged := make([]AvailablePatch, 0, len(machine)+len(user))
	seen := make(map[string]struct{}, len(machine)+len(user))

	for _, p := range machine {
		p.Scope = PatchScopeMachine
		merged = append(merged, p)
		seen[strings.ToLower(p.ID)] = struct{}{}
	}
	for _, p := range user {
		key := strings.ToLower(p.ID)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		p.Scope = PatchScopeUser
		merged = append(merged, p)
	}
	return merged
}

// userScopeIDSet returns the lowercased package IDs in patches that were
// discovered only at user scope. The provider keeps this from the last scan so
// an install request for one of them can be refused explicitly instead of
// silently running a machine-scope install that would fail or double-install
// (#2727 ships detection only).
func userScopeIDSet(patches []AvailablePatch) map[string]struct{} {
	ids := make(map[string]struct{})
	for _, p := range patches {
		if p.Scope == PatchScopeUser {
			ids[strings.ToLower(p.ID)] = struct{}{}
		}
	}
	return ids
}
