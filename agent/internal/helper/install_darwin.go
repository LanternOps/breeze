package helper

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const plistLabel = "com.breeze.helper"
const plistPath = "/Library/LaunchAgents/com.breeze.helper.plist"
const appBundleName = "Breeze Helper.app"

func packageExtension() string { return ".dmg" }

// destAppPath is the fixed install location — avoids fragile filepath.Dir chains.
const destAppPath = "/Applications/Breeze Helper.app"

// installPackage mounts the DMG, copies the .app bundle, and unmounts.
func installPackage(dmgPath, _ string) error {
	// Mount the DMG to a temp mount point
	mountPoint, err := os.MkdirTemp("", "breeze-helper-mount-")
	if err != nil {
		return fmt.Errorf("create mount point: %w", err)
	}
	defer os.RemoveAll(mountPoint)

	if out, err := exec.Command("hdiutil", "attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-noautoopen", "-quiet").CombinedOutput(); err != nil {
		return fmt.Errorf("mount dmg: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	defer func() {
		if out, err := exec.Command("hdiutil", "detach", mountPoint, "-quiet").CombinedOutput(); err != nil {
			log.Warn("failed to detach dmg", "mountpoint", mountPoint, "error", err.Error(), "output", strings.TrimSpace(string(out)))
		}
	}()

	// Find the .app in the mounted DMG
	srcApp := filepath.Join(mountPoint, appBundleName)
	if _, err := os.Stat(srcApp); err != nil {
		return fmt.Errorf("app bundle not found in dmg at %s: %w", srcApp, err)
	}

	// Copy .app to /Applications/
	if err := os.RemoveAll(destAppPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove old app: %w", err)
	}

	if out, err := exec.Command("cp", "-R", srcApp, destAppPath).CombinedOutput(); err != nil {
		return fmt.Errorf("copy app: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}

	log.Info("app bundle installed", "path", destAppPath)
	return nil
}

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
	uid := currentUID()
	if uid == "" {
		return fmt.Errorf("could not determine current user ID")
	}
	return exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
}

func currentUID() string {
	out, err := exec.Command("id", "-u").Output()
	if err != nil {
		log.Warn("failed to get current uid", "error", err.Error())
		return ""
	}
	return strings.TrimSpace(string(out))
}
