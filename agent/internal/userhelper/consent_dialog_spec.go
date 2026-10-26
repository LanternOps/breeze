// Untagged on purpose, like notify_prompt.go: the native consent dialogs behind
// showConsentDialogFn are windows/darwin/linux-tagged, and the userhelper
// package's Windows tests do not run in CI. Everything that decides WHAT each
// native dialog is asked to render (its buttons, which one is the default, the
// countdown copy) lives on this side of the build tag, so every OS's test run
// checks every platform's dialog.
//
// Safe default (#10187): Deny is the default button on every native consent
// dialog, as it is on the Breeze Assist card (apps/helper ConsentDialog.tsx).
// A user who presses Enter to get rid of "something that popped up" must not
// grant remote control. A countdown expiry is reported as presented_expired,
// never as a grant; the agent's policy decides it (decideConsent).
package userhelper

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// MessageBoxTimeoutW uType bits used by the native dialogs (winuser.h).
const (
	consentMBYesNo         = 0x00000004
	consentMBIconQuestion  = 0x00000020
	consentMBDefButton2    = 0x00000100
	consentMBSystemModal   = 0x00001000
	consentMBSetForeground = 0x00010000
	consentMBTopMost       = 0x00040000
)

// consentMessageBoxFlags is the Windows consent box's uType: Yes (Allow) /
// No (Deny), with MB_DEFBUTTON2 making No the default button. An MB_YESNO box
// has no Cancel button, so Esc and the close box are disabled.
const consentMessageBoxFlags = consentMBYesNo | consentMBDefButton2 | consentMBIconQuestion | consentMBTopMost | consentMBSystemModal | consentMBSetForeground

// consentMessageBoxText is the Windows consent box's title and body. A message
// box cannot relabel its buttons, so the body says what Yes and No mean.
func consentMessageBoxText(req ipc.ConsentRequest) (title, body string) {
	title, body = buildConsentDialogText(req)
	body += "\r\n\r\nSelect Yes to allow, or No to decline."
	if notice := consentCountdownNotice(req); notice != "" {
		body += "\r\n" + notice
	}
	return title, body
}

// consentOsascriptScript is the macOS consent dialog. Deny is both the default
// and the cancel button, so Return, Esc and a click on Deny all end osascript
// with error -128 (classifyOsascriptResult: denied).
func consentOsascriptScript(req ipc.ConsentRequest) string {
	title, body := buildConsentDialogText(req)
	if notice := consentCountdownNotice(req); notice != "" {
		body += "\n\n" + notice
	}
	script := fmt.Sprintf(
		`display dialog "%s" with title "%s" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution`,
		escapeAppleScript(body), escapeAppleScript(title),
	)
	if req.TimeoutMs > 0 {
		script += fmt.Sprintf(" giving up after %d", consentTimeoutSeconds(req))
	}
	return script
}

// consentZenityArgs is the Linux consent dialog: OK is Allow (exit 0) and
// Cancel is Deny (exit 1); --default-cancel gives Deny the focus.
func consentZenityArgs(req ipc.ConsentRequest) []string {
	title, body := buildConsentDialogText(req)
	if notice := consentCountdownNotice(req); notice != "" {
		body += "\n\n" + notice
	}
	args := []string{
		"--question",
		"--title", title,
		"--text", body,
		"--ok-label", "Allow",
		"--cancel-label", "Deny",
		"--default-cancel",
	}
	if req.TimeoutMs > 0 {
		args = append(args, fmt.Sprintf("--timeout=%d", consentTimeoutSeconds(req)))
	}
	return args
}

// consentTimeoutSeconds is the countdown in whole seconds, rounded up, as the
// osascript and zenity timeouts take it.
func consentTimeoutSeconds(req ipc.ConsentRequest) int {
	return (req.TimeoutMs + 999) / 1000
}

// consentCountdownNotice states what happens if the user does nothing: the
// Assist card's "Declining automatically" line, said once because a native
// dialog cannot tick down. It says "allowed" only when the policy proceeds on
// expiry, the same rule decideConsent and legacyConsentDecision apply. ""
// for a prompt without a countdown. req must be sanitized (OnTimeout
// lower-cased).
func consentCountdownNotice(req ipc.ConsentRequest) string {
	if req.TimeoutMs <= 0 {
		return ""
	}
	secs := consentTimeoutSeconds(req)
	unit := "seconds"
	if secs == 1 {
		unit = "second"
	}
	if req.OnTimeout == "proceed" {
		return fmt.Sprintf("If you do nothing, remote access will be allowed automatically in %d %s.", secs, unit)
	}
	return fmt.Sprintf("If you do nothing, this request will be declined automatically in %d %s.", secs, unit)
}
