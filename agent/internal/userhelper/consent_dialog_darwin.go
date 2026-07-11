//go:build darwin

package userhelper

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via osascript, the same
// no-cgo technique notify_darwin.go uses. "giving up after N" implements the
// countdown; a gave-up result maps to answered=false so consentDecision
// applies the onTimeout policy.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	title, body := buildConsentDialogText(req)
	script := fmt.Sprintf(
		`display dialog "%s" with title "%s" buttons {"Deny", "Allow"} default button "Allow" cancel button "Deny" with icon caution`,
		escapeAppleScript(body), escapeAppleScript(title),
	)
	if req.TimeoutMs > 0 {
		script += fmt.Sprintf(" giving up after %d", (req.TimeoutMs+999)/1000)
	}
	// CombinedOutput (not Output) so stderr is available to distinguish an
	// explicit user cancel from an infra failure below. On success osascript
	// writes its "button returned:..."/"gave up:..." record to stdout and
	// exits 0, so the err==nil parsing below is unaffected by also capturing
	// stderr.
	out, err := exec.Command("osascript", "-e", script).CombinedOutput()
	if err != nil {
		result := string(out)
		if strings.Contains(result, "-128") {
			// User clicked Deny/cancel: osascript reports "User canceled. (-128)".
			// This is a real decision, not an infra failure.
			return false, true
		}
		// Any other failure (osascript missing, no window server, execution
		// error) is not a user decision — log it for diagnosability and report
		// answered=false so decideConsent applies the onTimeout/unavailable
		// policy instead of recording a fake user deny, matching Linux's intent.
		log.Warn("osascript consent dialog failed", "error", err.Error())
		return false, false
	}
	result := string(out)
	if strings.Contains(result, "gave up:true") {
		return false, false
	}
	return strings.Contains(result, "button returned:Allow"), true
}
