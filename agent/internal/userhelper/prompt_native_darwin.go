//go:build darwin

package userhelper

import (
	"bytes"
	"context"
	"os/exec"
	"time"
)

// showNativePromptOS draws a native prompt with osascript (no cgo, as the
// consent dialog does). What it shows and how its result maps back is decided
// in prompt_native.go.
func showNativePromptOS(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "osascript", "-e", nativePromptOsascript(m, time.Now()))
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return nativeOutcome{Err: err}
	}
	presented()
	err := cmd.Wait()
	if ctx.Err() != nil {
		return nativeOutcome{Hidden: true}
	}
	return classifyNativeOsascript(m, out.String(), err != nil)
}
