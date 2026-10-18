//go:build windows

package userhelper

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// notifyAUMID is the AppUserModelID toasts are raised under. It MUST be
// registered (HKCU is enough) or Windows accepts the toast and silently
// never displays it — Server SKUs and recent Win11 builds drop toasts from
// unregistered AUMIDs even though the WinRT Show() call reports success.
const notifyAUMID = "Breeze.Agent"

var notifyAumidOnce sync.Once

// registerToastAUMID registers the per-user AUMID with a friendly display
// name so toasts render branded as "Breeze". Idempotent; best-effort — a
// registry failure is logged and the toast is still attempted.
func registerToastAUMID() {
	key, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		`Software\Classes\AppUserModelId\`+notifyAUMID,
		registry.SET_VALUE,
	)
	if err != nil {
		log.Warn("toast AUMID registration failed", "error", err.Error())
		return
	}
	defer key.Close()
	if err := key.SetStringValue("DisplayName", "Breeze"); err != nil {
		log.Warn("toast AUMID DisplayName write failed", "error", err.Error())
	}
}

// toastWinRTFn and toastPowerShellFn are the two toast backends behind
// showNotificationOS. WinRT is primary: it raises the toast in-process, so no
// child gets a console and nothing flashes on the user's desktop. PowerShell is
// the fallback for hosts where WinRT activation fails; it is spawned hidden.
// Tests swap both.
var (
	toastWinRTFn      = showToastWinRT
	toastPowerShellFn = showToastPowerShell
)

// showNotificationOS raises a Windows toast for a plain notice.
func showNotificationOS(req ipc.NotifyRequest) bool {
	notifyAumidOnce.Do(registerToastAUMID)
	req = sanitizeNotifyRequest(req)
	toastXML := buildToastXML(req.Title, req.Body)

	if err := toastWinRTFn(notifyAUMID, toastXML); err != nil {
		if errors.Is(err, errToastsDisabled) {
			// The PowerShell path raises the same toast through the same
			// notifier, so it cannot succeed either; don't spawn it. Report
			// undelivered so FallbackDialog can fire.
			log.Warn("toast notifications are disabled; not retrying via PowerShell", "error", err.Error())
			return false
		}
		log.Warn("WinRT toast failed; falling back to PowerShell", "error", err.Error())
		return toastPowerShellFn(toastXML)
	}
	return true
}

// newToastPowerShellCmd builds the hidden powershell.exe invocation that raises
// toastXML through the WinRT projection. The XML travels via an environment
// variable: `-Command <script> <args>` does NOT bind script params — PowerShell
// appends the extra argv tokens to the command TEXT, which made the previous
// `param($xml) ... -xml <toast>` shape a parse error on every call (the toast
// never showed once). The env var also avoids all quoting/interpolation, so the
// escaped XML can't inject into the script.
func newToastPowerShellCmd(toastXML string) *exec.Cmd {
	script := `try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml($env:BREEZE_TOAST_XML)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + notifyAUMID + `')
  $setting = $null
  try { $setting = $notifier.Setting } catch { }
  if ($null -ne $setting -and $setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) {
    [Console]::Error.WriteLine("toast notifications are disabled (Setting=$setting)")
    exit 3
  }
  $notifier.Show($toast)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "BREEZE_TOAST_XML="+toastXML)
	// The user-helper is a GUI-subsystem binary; without this the kernel gives
	// powershell.exe a fresh console that flashes on the interactive desktop.
	hideWindow(cmd)
	return cmd
}

// showToastPowerShell is the fallback toast backend.
func showToastPowerShell(toastXML string) bool {
	if out, err := newToastPowerShellCmd(toastXML).CombinedOutput(); err != nil {
		log.Warn("notification failed", "error", err, "output", strings.TrimSpace(string(out)))
		return false
	}
	return true
}
