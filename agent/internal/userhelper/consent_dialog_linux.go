//go:build linux

package userhelper

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via zenity. consentUISupported
// only verifies zenity + a display are present at auth time; if zenity is
// later missing, crashes, or cannot open the display (the display went away
// between auth and this call), the result is unavailable — never a user
// denial or an expiry (classifyZenityExit).
// zenity exit codes: 0=OK(Allow), 1=Cancel(Deny), 5=timeout.
func showConsentDialogOS(req ipc.ConsentRequest, presented func()) dialogOutcome {
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
	var stderr bytes.Buffer
	cmd := exec.Command("zenity", args...)
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		log.Warn("zenity consent dialog could not start", "error", err.Error())
		return classifyZenityExit(-1, false, "")
	}
	presented()
	err := cmd.Wait()
	if err == nil {
		return classifyZenityExit(0, true, stderr.String())
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		outcome := classifyZenityExit(exitErr.ExitCode(), true, stderr.String())
		if outcome == dialogUnavailable {
			log.Warn("zenity consent dialog failed", "exitCode", exitErr.ExitCode(), "stderr", truncateForLog(stderr.String()))
		}
		return outcome
	}
	log.Warn("zenity consent dialog failed", "error", err.Error())
	return dialogUnavailable
}

func truncateForLog(s string) string {
	const max = 256
	if len(s) > max {
		return s[:max]
	}
	return s
}
