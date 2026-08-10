package hostpolicy

// TEST ONLY. SetAllowedHostsForTest and SetStrictModeForTest let tests in
// this and other packages (config, agentapp, heartbeat, updater) exercise
// hosted/strict-mode behavior without rebuilding the binary with ldflags.
//
// Importing "testing" from a non-test file is deliberate here, and scoped to
// exactly this guard: testing.Testing() reports whether the current binary
// was built by `go test`, so both seams panic when called from a production
// binary. That keeps the override capability out of shipped builds while
// leaving it usable from any package's test files, since all of them run
// inside a `go test` binary in the same process.

import "testing"

// SetAllowedHostsForTest overrides the compiled allowlist at runtime for TESTS
// ONLY and returns a restore func. Panics if called outside `go test`.
func SetAllowedHostsForTest(csv string) (restore func()) {
	if !testing.Testing() {
		panic("hostpolicy test seams are test-only")
	}
	prev := current.Load()
	current.Store(&snapshot{hosts: parseHosts(csv), strict: prev.strict})
	return func() { current.Store(prev) }
}

// SetStrictModeForTest overrides strict mode at runtime for TESTS ONLY and
// returns a restore func. Panics if called outside `go test`.
func SetStrictModeForTest(on bool) (restore func()) {
	if !testing.Testing() {
		panic("hostpolicy test seams are test-only")
	}
	prev := current.Load()
	current.Store(&snapshot{hosts: prev.hosts, strict: on})
	return func() { current.Store(prev) }
}
