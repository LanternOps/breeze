//go:build !darwin

package patching

import (
	"errors"
	"fmt"
	"os/user"
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

// BrewBinaryPath is the non-darwin stub: Homebrew is macOS-only, so there is
// never a brew binary to find here.
func BrewBinaryPath() (string, error) {
	return "", fmt.Errorf("%w: brew is darwin-only", ErrBrewUnavailable)
}

// ActiveConsoleUser is the non-darwin stub. The console-user resolution is
// implemented with macOS's /dev/console ownership convention and has no
// meaning on other platforms.
func ActiveConsoleUser() (*user.User, error) {
	return nil, fmt.Errorf("console user resolution is darwin-only")
}
