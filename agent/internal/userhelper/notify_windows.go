//go:build windows

package userhelper

import (
	"encoding/xml"
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

// showNotificationOS uses PowerShell toast notifications on Windows.
// A production implementation would use WinRT Toast API directly.
func showNotificationOS(req ipc.NotifyRequest) bool {
	notifyAumidOnce.Do(registerToastAUMID)
	req = sanitizeNotifyRequest(req)
	// XML-escape title and body to prevent injection
	title := xmlEscape(req.Title)
	body := xmlEscape(req.Body)

	toastXML := `<toast><visual><binding template="ToastText02">` +
		`<text id="1">` + title + `</text>` +
		`<text id="2">` + body + `</text>` +
		`</binding></visual></toast>`

	// The XML travels via an environment variable: `-Command <script> <args>`
	// does NOT bind script params — PowerShell appends the extra argv tokens to
	// the command TEXT, which made the previous `param($xml) ... -xml <toast>`
	// shape a parse error on every call (the toast never showed once). The env
	// var also avoids all quoting/interpolation, so the escaped XML can't
	// inject into the script.
	script := `try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml($env:BREEZE_TOAST_XML)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + notifyAUMID + `').Show($toast)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "BREEZE_TOAST_XML="+toastXML)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Warn("notification failed", "error", err, "output", strings.TrimSpace(string(out)))
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
