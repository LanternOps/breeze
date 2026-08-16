//go:build !darwin

package patching

import (
	"errors"
	"fmt"
)

// ErrBrewUnavailable mirrors the darwin build's sentinel (homebrew.go) so
// callers outside this package (agent/internal/remote/tools) can
// errors.Is(err, patching.ErrBrewUnavailable) regardless of the agent's
// build target.
var ErrBrewUnavailable = errors.New("homebrew not installed")

// EnsureBrewInstalled is the non-darwin stub: the package-manager software
// library's Homebrew support targets macOS only, so any invocation off
// darwin is unconditionally unavailable rather than attempting to shell out
// to a `brew` that cannot exist on this platform.
func EnsureBrewInstalled(kind, name string) (output string, alreadyInstalled bool, err error) {
	return "", false, fmt.Errorf("%w: homebrew ensure-present is darwin-only", ErrBrewUnavailable)
}
