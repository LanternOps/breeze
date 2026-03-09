package helper

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const plistLabel = "com.breeze.helper"
const plistPath = "/Library/LaunchAgents/com.breeze.helper.plist"

func installAutoStart(binaryPath string) error {
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
`, plistLabel, binaryPath)

	if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	log.Info("installed LaunchAgent plist", "path", plistPath)
	return nil
}

func isHelperRunning() bool {
	out, err := exec.Command("launchctl", "list").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), plistLabel)
}

func stopHelper() error {
	_ = exec.Command("launchctl", "bootout", "gui/"+currentUID(), plistPath).Run()
	return nil
}

func currentUID() string {
	out, err := exec.Command("id", "-u").Output()
	if err != nil {
		return "0"
	}
	return strings.TrimSpace(string(out))
}
