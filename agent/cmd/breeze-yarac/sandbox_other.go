//go:build !(linux && (amd64 || arm64))

package main

import (
	"fmt"
	"io"
	"runtime"
)

const sandboxedSubcommand = "__sandboxed"

// enterSandbox: the Landlock + seccomp sandbox exists only on Linux
// amd64/arm64 (the API image). Everywhere else `match` fails closed (exit 3)
// unless BREEZE_YARA_TEST_UNSANDBOXED=1, which the API passes only under
// NODE_ENV development/test (macOS dev boxes).
func enterSandbox(string, []string) error {
	return fmt.Errorf("%w: needs Linux (amd64/arm64) with Landlock, this is %s/%s",
		errSandboxUnavailable, runtime.GOOS, runtime.GOARCH)
}

func cmdSandboxed(_ []string, _ io.Reader, stdout, stderr io.Writer) int {
	return sandboxUnavailable(enterSandbox("", nil), stdout, stderr)
}

func runProbes(bool) []probeResult { return nil }
