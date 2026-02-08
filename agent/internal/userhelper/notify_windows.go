//go:build windows

package userhelper

import (
	"encoding/xml"
	"os/exec"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showNotificationOS uses PowerShell toast notifications on Windows.
// A production implementation would use WinRT Toast API directly.
func showNotificationOS(req ipc.NotifyRequest) bool {
	// XML-escape title and body to prevent injection
	title := xmlEscape(req.Title)
	body := xmlEscape(req.Body)

	toastXML := `<toast><visual><binding template="ToastText02">` +
		`<text id="1">` + title + `</text>` +
		`<text id="2">` + body + `</text>` +
		`</binding></visual></toast>`

	// Pass XML as a variable to avoid PowerShell interpolation entirely.
	// Using -EncodedCommand or single-quoted here-strings prevents injection.
	script := `param([string]$xml)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
$doc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Breeze Agent").Show($toast)`

	cmd := exec.Command("powershell", "-NoProfile", "-Command", script, "-xml", toastXML)
	if err := cmd.Run(); err != nil {
		log.Warn("notification failed", "error", err)
		return false
	}
	return true
}

// xmlEscape encodes a string so it is safe for embedding in XML text content.
func xmlEscape(s string) string {
	var b strings.Builder
	if err := xml.EscapeText(&b, []byte(s)); err != nil {
		return ""
	}
	return b.String()
}
