//go:build linux

package userhelper

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

// showNativePromptOS draws a native prompt with zenity. What it shows and
// how its exit code maps back is decided in prompt_native.go.
func showNativePromptOS(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "zenity", nativePromptZenityArgs(m, time.Now())...)
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nativeOutcome{Err: err}
	}
	presented()
	err := cmd.Wait()
	if ctx.Err() != nil {
		return nativeOutcome{Hidden: true}
	}
	if err == nil {
		return classifyNativeZenity(m, 0)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		out := classifyNativeZenityRun(m, exitErr.ExitCode(), stderr.String())
		if out.Err != nil {
			log.Warn("zenity prompt failed", "exitCode", exitErr.ExitCode(), "stderr", truncateForLog(stderr.String()))
		}
		return out
	}
	return nativeOutcome{Err: err}
}
