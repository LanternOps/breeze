//go:build !darwin

package syscleanup

import (
	"context"
	"errors"
)

// brewCleanupRun is darwin-only; the stub exists so darwin.go stays untagged
// and its argv builders and parsers run under `go test ./...` on the Linux CI
// runner. internal/patching/homebrew.go is //go:build darwin, so importing it
// from an untagged file would not compile anywhere else.
func brewCleanupRun(context.Context, bool) (string, error) {
	return "", errors.New("homebrew cleanup is only available on macOS")
}
