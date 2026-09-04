//go:build !linux

package linuxsession

import (
	"context"
	"os/exec"
)

// List reports no sessions off Linux. The caller turns that into shown=false,
// which is the same answer a headless Linux box gives and is already the
// documented path.
func List(context.Context) ([]GraphicalSession, error) {
	return nil, ErrUnsupportedPlatform
}

// Command is never reachable off Linux; it exists so callers compile
// everywhere and so a misrouted call fails loudly instead of silently.
func (s GraphicalSession) Command(context.Context, string, ...string) (*exec.Cmd, error) {
	return nil, ErrUnsupportedPlatform
}
