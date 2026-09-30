//go:build darwin

package userhelper

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via osascript, the same
// no-cgo technique notify_darwin.go uses. "giving up after N" implements the
// countdown. A gave-up result is an expired countdown; any osascript failure
// other than the user's Deny (-128) means no dialog was shown
// (classifyOsascriptResult) — never an expiry, which an older helper turned
// into a policy verdict.
func showConsentDialogOS(ctx context.Context, req ipc.ConsentRequest, presented func()) dialogOutcome {
	title, body := buildConsentDialogText(req)
	script := fmt.Sprintf(
		`display dialog "%s" with title "%s" buttons {"Deny", "Allow"} default button "Allow" cancel button "Deny" with icon caution`,
		escapeAppleScript(body), escapeAppleScript(title),
	)
	if req.TimeoutMs > 0 {
		script += fmt.Sprintf(" giving up after %d", (req.TimeoutMs+999)/1000)
	}
	// Capture stdout and stderr together: on success osascript writes its
	// "button returned:..."/"gave up:..." record to stdout; on failure the
	// error number (e.g. -128 for the user's cancel) is on stderr.
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		log.Warn("osascript consent dialog could not start", "error", err.Error())
		return dialogUnavailable
	}
	presented()
	err := cmd.Wait()
	outcome := classifyOsascriptResult(out.String(), err != nil)
	if err != nil && outcome == dialogUnavailable {
		log.Warn("osascript consent dialog failed", "error", err.Error())
	}
	return outcome
}
