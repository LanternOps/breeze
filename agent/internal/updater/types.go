package updater

// BinaryPair is a freshly-downloaded binary in a temp location plus its final
// install path. Used to pipe optional companion binaries (e.g. nu-user-helper.exe)
// through the Windows in-place upgrade swap.
type BinaryPair struct {
	Temp   string
	Target string
}

// IsZero reports whether both fields are the empty string. Useful for treating
// an accidentally zero-valued BinaryPair as "no companion to swap" instead of
// generating a broken script — though the preferred API is to pass a *BinaryPair
// and use nil to express absence (see restartScriptOptions.UserHelper).
func (p BinaryPair) IsZero() bool { return p.Temp == "" && p.Target == "" }

// UpdateOptions carries optional companion behavior for an update operation.
// Passed by value into UpdateToWithOptions / UpdateFromURL so the call site is
// self-describing: there is no Updater-level state for callers to mutate, and
// the helper-swap path is visible from a single function body. Issue #816 /
// #845 follow-up (PR B): replaces the prior u.extras action-at-a-distance.
type UpdateOptions struct {
	// UserHelper, when non-nil, is also swapped alongside the main binary
	// on Windows. Ignored on other platforms (the agent-only path is the
	// only path on non-Windows).
	UserHelper *BinaryPair

	// Backup, when non-nil, is also swapped alongside the main binary during
	// this upgrade: on Windows via the restart-helper script (like UserHelper),
	// on Linux and the macOS raw-binary fallback via an atomic same-directory
	// rename before the agent restarts (see swapCompanionBinary). Unlike
	// UserHelper this applies on EVERY platform — nu-backup ships
	// everywhere (agent/Makefile), not just Windows — with one exception: the
	// macOS .pkg install path already bundles its own nu-backup, so
	// updateTo discards (rather than swaps) a staged Backup pair when the pkg
	// path is taken. nu-backup's version is slaved to the agent's; there
	// is no independent backup update directive.
	Backup *BinaryPair
}
