package agentapp

// installIPCPrereqsThenHelpers runs the macOS install steps in the one order
// that works, and exists purely so that order is enforced by a test instead of
// by a comment.
//
// The ordering is the whole bug in #3133/#3134/#3137. A desktop helper inherits
// its group list when its process starts, so:
//
//  1. the breeze group must exist,
//  2. the console users must be members of it,
//  3. only then may the helper LaunchAgents be bootstrapped.
//
// `service install` previously bootstrapped the helpers first, so every helper
// it started was outside the group that owns the IPC socket and was denied.
//
// ensureGroup is fatal — without the group there is nothing for the socket to
// belong to, and a silent partial install is worse than a loud failure.
// ensureMembers is not: one unresolvable console user must not fail an install
// that works for everyone else, and the daemon re-attempts membership on every
// helper start anyway.
//
// Lives in an untagged file on purpose. Its darwin caller cannot be tested by
// the blocking CI jobs (`test-agent` is ubuntu, `test-agent-windows` is windows,
// and the macOS `test-agent-race` job is not in ci-success's needs), so keeping
// the ordering contract platform-independent is what puts it under a required
// check.
func installIPCPrereqsThenHelpers(
	ensureGroup func() error,
	ensureMembers func(),
	bootstrapHelpers func(),
) error {
	if err := ensureGroup(); err != nil {
		return err
	}
	ensureMembers()
	bootstrapHelpers()
	return nil
}
