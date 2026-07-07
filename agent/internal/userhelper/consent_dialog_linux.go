//go:build linux

package userhelper

import (
	"fmt"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via zenity. consentUISupported
// only verifies zenity + a display are present at auth time; if zenity is
// later missing or crashes (TOCTOU: uninstalled or the display went away
// between auth and this call), the exec.ExitError branch below still handles
// it explicitly by denying rather than silently pretending a timeout.
// zenity exit codes: 0=OK(Allow), 1=Cancel(Deny), 5=timeout.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	title, body := buildConsentDialogText(req)
	args := []string{
		"--question",
		"--title", title,
		"--text", body,
		"--ok-label", "Allow",
		"--cancel-label", "Deny",
	}
	if req.TimeoutMs > 0 {
		args = append(args, fmt.Sprintf("--timeout=%d", (req.TimeoutMs+999)/1000))
	}
	err := exec.Command("zenity", args...).Run()
	if err == nil {
		return true, true
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		switch exitErr.ExitCode() {
		case 1:
			return false, true // Deny
		case 5:
			return false, false // timeout
		}
	}
	// zenity missing/crashed: deny explicitly rather than pretend a timeout.
	return false, true
}
