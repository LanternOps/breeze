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
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		// Cancel button (Deny) makes osascript exit non-zero (user canceled -128).
		return false, true
	}
	result := string(out)
	if strings.Contains(result, "gave up:true") {
		return false, false
	}
	return strings.Contains(result, "button returned:Allow"), true
}
