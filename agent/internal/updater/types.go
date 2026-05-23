package updater

// BinaryPair is a freshly-downloaded binary in a temp location plus its final
// install path. Used to pipe optional companion binaries (e.g. breeze-user-helper.exe)
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
}
