//go:build windows

package userhelper

import (
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotificationOS uses PowerShell toast notifications on Windows.
// A production implementation would use WinRT Toast API directly.
func showNotificationOS(req ipc.NotifyRequest) bool {
	script := `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast>
  <visual>
    <binding template="ToastText02">
      <text id="1">` + req.Title + `</text>
      <text id="2">` + req.Body + `</text>
    </binding>
  </visual>
</toast>
"@
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Breeze Agent").Show($toast)
`
	cmd := exec.Command("powershell", "-NoProfile", "-Command", script)
	if err := cmd.Run(); err != nil {
		log.Warn("notification failed", "error", err)
		return false
	}
	return true
}
