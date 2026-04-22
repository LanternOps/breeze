package helper

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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

// xmlEscapeString returns s with XML special characters escaped so it is safe
// to embed between <string>...</string> tags in a plist document.
func xmlEscapeString(s string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(s))
	return buf.String()
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
`, xmlEscapeString(plistLabel), xmlEscapeString(binaryPath))

	if err := os.WriteFile(plistPath, []byte(plist), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	log.Info("installed LaunchAgent plist", "path", plistPath)
	return nil
}

func removeAutoStart() error {
	uid := consoleUID()
	if uid != "" {
		if err := runHelperCommand("launchctl", "bootout", "gui/"+uid, plistPath); err != nil {
			log.Debug("launchctl bootout failed during autostart removal", "uid", uid, "error", err.Error())
		}
	}
	if err := os.Remove(plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove plist: %w", err)
	}
	return nil
}

func stopByPID(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("kill pid %d: %w", pid, err)
	}
	return nil
}

func spawnWithConfig(binaryPath, sessionKey, configPath string) (int, error) {
	uid, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid uid %q: %w", sessionKey, err)
	}

	u, err := user.LookupId(sessionKey)
	if err != nil {
		return 0, fmt.Errorf("lookup uid %s: %w", sessionKey, err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parse gid %q: %w", u.Gid, err)
	}

	cmd := exec.Command(binaryPath, "--config", configPath)
	cmd.Dir = filepath.Dir(binaryPath)
	if os.Geteuid() == 0 && uint32(uid) != uint32(os.Geteuid()) {
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{
				Uid: uint32(uid),
				Gid: uint32(gid),
			},
		}
	}
	cmd.Env = append(os.Environ(),
		"HOME="+u.HomeDir,
		"USER="+u.Username,
		"LOGNAME="+u.Username,
	)

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start helper for uid %s: %w", sessionKey, err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}

func isHelperRunning() bool {
	// Check for running process directly — the agent starts the helper via
	// exec.Command, not launchctl bootstrap, so launchctl list won't show it.
	return runHelperCommand("pgrep", "-f", "breeze-helper") == nil
}

func stopHelper() error {
	uid := consoleUID()
	if uid == "" {
		return fmt.Errorf("could not determine console user ID")
	}
	return runHelperCommand("launchctl", "bootout", "gui/"+uid, plistPath)
}

// consoleUID returns the UID of the user who owns the macOS console session.
// When the agent runs as a root daemon, os.Getuid()/id -u returns 0, which
// is wrong for launchctl bootout gui/<uid>. Use /dev/console ownership instead.
func consoleUID() string {
	out, err := outputHelperCommand("stat", "-f", "%u", "/dev/console")
	if err != nil {
		log.Warn("failed to get console user uid", "error", err.Error())
		return ""
	}
	uid, err := parseConsoleUIDOutput(out)
	if err != nil {
		log.Warn("failed to parse console user uid", "error", err.Error())
		return ""
	}
	if uid == "0" {
		log.Warn("console owned by root — no user session logged in")
		return ""
	}
	return uid
}
