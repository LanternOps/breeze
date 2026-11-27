//go:build linux

package userhelper

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// showNativePromptOS draws a native prompt with zenity. What it shows and
// how its exit code maps back is decided in prompt_native.go.
func showNativePromptOS(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	var stderr bytes.Buffer
	cmd := procspawn.CommandContext(ctx, "zenity", nativePromptZenityArgs(m, time.Now())...)
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nativeOutcome{Err: err}
	}
	// Reported on screen only once zenity outlives its startup window: one
	// that cannot open the display is never reported visible (#12794 review).
	reported, err := runNativeProcess(cmd.Wait, nativeStartupWindow, presented)
	if ctx.Err() != nil {
		return nativeOutcome{Hidden: true}
	}
	out := classifyNativeZenityExit(m, err, stderr.String())
	if !reported && out.Err == nil {
		presented() // answered within the window: it was on screen
	}
	return out
}

// classifyNativeZenityExit maps zenity's cmd.Wait result.
func classifyNativeZenityExit(m nativePromptModel, err error, stderr string) nativeOutcome {
	if err == nil {
		return classifyNativeZenity(m, 0)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		out := classifyNativeZenityRun(m, exitErr.ExitCode(), stderr)
		if out.Err != nil {
			log.Warn("zenity prompt failed", "exitCode", exitErr.ExitCode(), "stderr", truncateForLog(stderr))
		}
		return out
	}
	return nativeOutcome{Err: err}
}
