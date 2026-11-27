//go:build darwin

package userhelper

import (
	"bytes"
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// showNativePromptOS draws a native prompt with osascript (no cgo, as the
// consent dialog does). What it shows and how its result maps back is decided
// in prompt_native.go.
func showNativePromptOS(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	var out bytes.Buffer
	cmd := procspawn.CommandContext(ctx, "osascript", "-e", nativePromptOsascript(m, time.Now()))
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return nativeOutcome{Err: err}
	}
	// Reported on screen only once osascript outlives its startup window: a
	// script that fails at once is never reported visible (#12794 review).
	reported, err := runNativeProcess(cmd.Wait, nativeStartupWindow, presented)
	if ctx.Err() != nil {
		return nativeOutcome{Hidden: true}
	}
	o := classifyNativeOsascript(m, out.String(), err != nil)
	if !reported && o.Err == nil {
		presented() // answered within the window: it was on screen
	}
	return o
}
