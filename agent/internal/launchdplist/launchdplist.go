// Package launchdplist is the single source of truth for the macOS
// desktop-helper LaunchAgent plist XML. Before #4379 this XML was hand-synced
// across three places (agent/service/launchd/*.plist, service_cmd_darwin.go,
// heartbeat/handlers_desktop_helper.go); editing one silently diverged the
// others, and since agent auto-update ships binaries, not plists, a fleet
// only ever picks up a plist edit on reinstall.
package launchdplist

import "fmt"

// DesktopHelperParams describes one desktop-helper LaunchAgent variant.
type DesktopHelperParams struct {
	Label            string // launchd Label, e.g. "com.breeze.desktop-helper-user"
	Context          string // --context flag value passed to breeze-desktop-helper
	SessionType      string // LimitLoadToSessionType, e.g. "Aqua" or "LoginWindow"
	ThrottleInterval int
}

const desktopHelperTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>%s</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>ThrottleInterval</key>
    <integer>%d</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`

// RenderDesktopHelper renders the LaunchAgent plist XML for one desktop
// helper variant (user session or login window).
func RenderDesktopHelper(p DesktopHelperParams) string {
	return fmt.Sprintf(desktopHelperTemplate, p.Label, p.Context, p.SessionType, p.ThrottleInterval)
}

// DesktopHelperUser and DesktopHelperLoginWindow are the two desktop-helper
// LaunchAgent plists Breeze ships today. Values are unchanged from the
// pre-consolidation copies (verified byte-identical across all three — see
// #4379); this consolidation does not change any plist value.
var (
	DesktopHelperUser = RenderDesktopHelper(DesktopHelperParams{
		Label:            "com.breeze.desktop-helper-user",
		Context:          "user_session",
		SessionType:      "Aqua",
		ThrottleInterval: 10,
	})

	DesktopHelperLoginWindow = RenderDesktopHelper(DesktopHelperParams{
		Label:            "com.breeze.desktop-helper-loginwindow",
		Context:          "login_window",
		SessionType:      "LoginWindow",
		ThrottleInterval: 10,
	})
)
