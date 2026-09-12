package bmr

import (
	"context"
	"os/exec"
)

// runCommand executes an external command and returns its combined output.
// It is a package-level var (rather than calling exec.Command directly)
// purely so tests can substitute a fake instead of shelling out to real
// apt-get/dnf/systemctl/crontab/iptables-restore/chroot. Deliberately
// untagged (not restore_linux.go, its only real caller today): the rebuild
// engine's cross-platform unit tests (engine_test.go, built on darwin and
// windows too via `go test`/`go vet`) call SetRunCommandForTest below to
// observe RestoreSystemStateOffline's `systemctl --root=…` calls, so this
// seam and its test hook must compile everywhere even though every actual
// production caller is Linux-only.
var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// SetRunCommandForTest swaps runCommand for the duration of a test, in this
// package or another — see runCommand's doc comment for why a cross-package
// caller needs this. Test-only: exported so it is callable from outside this
// package, but every real caller is a _test.go file.
func SetRunCommandForTest(fn func(ctx context.Context, name string, args ...string) ([]byte, error)) (restore func()) {
	orig := runCommand
	runCommand = fn
	return func() { runCommand = orig }
}
