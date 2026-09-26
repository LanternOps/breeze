//go:build windows

package userhelper

import (
	"strings"
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// MB_ICONWARNING. The consent dialog uses MB_ICONQUESTION because it asks a
// question about someone else's request; a pending restart of the machine the
// user is working on is a warning about their own session.
const notifyPromptMBIconWarning = 0x00000030

// showNotifyPromptOS renders the interactive notification as a native Yes/No
// message box, reusing the MessageBoxTimeoutW proc consent_dialog_windows.go
// already declares — it is the only Win32 message box with a real countdown.
//
// Buttons come from MB_YESNO: Yes is Actions[0] (the affirmative, "Restart now")
// and No is Actions[1] (the postponement). A message box cannot render arbitrary
// button labels, so the legend is appended to the body text; the daemon only ever
// sends two actions for a reboot prompt.
//
// Return mapping, and why every ambiguous case is "":
//   - IDYES / IDNO are real clicks and map to their action.
//   - 32000 is MessageBoxTimeoutW's countdown expiry: the user did nothing.
//   - 0 means the call itself failed (no window station, a bad UTF-16 buffer).
//     That one is reported shown=false so the caller falls back to a toast — the
//     user has to be warned even when no dialog could open (#3197).
//
// Anything that is not an unambiguous click yields no action, so the reboot
// proceeds exactly as scheduled. Silence is never a postponement, and it is never
// an acceleration either.
func showNotifyPromptOS(req ipc.NotifyRequest) (clicked string, shown bool) {
	titleStr := req.Title
	if titleStr == "" {
		titleStr = "Restart Scheduled"
	}
	bodyStr := req.Body
	if legend := notifyPromptLegend(req.Actions); legend != "" {
		bodyStr = strings.TrimSpace(bodyStr) + "\r\n\r\n" + legend
	}

	title, err := syscall.UTF16PtrFromString(titleStr)
	if err != nil {
		log.Warn("reboot prompt title could not be encoded", "error", err.Error())
		return "", false
	}
	body, err := syscall.UTF16PtrFromString(bodyStr)
	if err != nil {
		log.Warn("reboot prompt body could not be encoded", "error", err.Error())
		return "", false
	}

	flags := uintptr(consentMBYesNo | notifyPromptMBIconWarning | consentMBTopMost | consentMBSystemModal | consentMBSetForeground)
	ret, _, _ := procMessageBoxTimeoutW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		flags,
		0, // language id
		uintptr(notifyPromptTimeoutMs(req)),
	)
	switch ret {
	case consentIDYes:
		return notifyPromptAction(req.Actions, 0), true
	case consentIDNo:
		return notifyPromptAction(req.Actions, 1), true
	case consentIDTimeout:
		return "", true // shown, and deliberately unanswered
	case 0:
		log.Warn("MessageBoxTimeoutW could not display the reboot prompt")
		return "", false
	default:
		// Dismissed some other way (Alt+F4 is disabled on a MB_YESNO box, but be
		// defensive): treat it as no decision rather than guessing a button.
		return "", true
	}
}

// MB_OK is 0, spelled out for readability; MB_ICONINFORMATION marks the dialog
// as an announcement rather than a question or a warning.
const (
	noticeDialogMBOK              = 0x00000000
	noticeDialogMBIconInformation = 0x00000040
)

// noticeDialogTimeoutMs bounds how long the fallback dialog stays up. It is an
// announcement, so it goes away on its own rather than waiting for a click.
const noticeDialogTimeoutMs = 60_000

// showNoticeDialogOS is the #6864 fallback for a notice whose toast failed: an
// OK-only information box that closes itself after noticeDialogTimeoutMs. It is
// topmost so it is not hidden behind the user's windows, but not system-modal:
// it tells the user something and does not block their work. MessageBoxTimeoutW
// returns 0 only when the call itself failed, which is reported as not shown.
func showNoticeDialogOS(req ipc.NotifyRequest) bool {
	titleStr := req.Title
	if titleStr == "" {
		titleStr = "Breeze Agent"
	}
	title, err := syscall.UTF16PtrFromString(titleStr)
	if err != nil {
		log.Warn("notice dialog title could not be encoded", "error", err.Error())
		return false
	}
	body, err := syscall.UTF16PtrFromString(req.Body)
	if err != nil {
		log.Warn("notice dialog body could not be encoded", "error", err.Error())
		return false
	}
	flags := uintptr(noticeDialogMBOK | noticeDialogMBIconInformation | consentMBTopMost | consentMBSetForeground)
	ret, _, _ := procMessageBoxTimeoutW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		flags,
		0, // language id
		uintptr(noticeDialogTimeoutMs),
	)
	if ret == 0 {
		log.Warn("MessageBoxTimeoutW could not display the notice dialog")
		return false
	}
	return true
}
