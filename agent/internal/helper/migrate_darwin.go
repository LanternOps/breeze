package helper

import (
	"os"
	"os/exec"
	"strconv"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()
	_ = os.Remove(plistPath)
}

func stopHelperLegacy() {
	uid := consoleUID()
	if uid != "" && uid != "0" {
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
	}
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
}

func migrationTargets() ([]string, error) {
	uid := consoleUID()
	if uid == "" || uid == "0" {
		return nil, nil
	}
	return []string{uid}, nil
}

func prepareSessionDir(path, sessionKey string) error {
	if sessionKey == "" {
		return nil
	}
	uid, err := strconv.Atoi(sessionKey)
	if err != nil {
		return err
	}
	return os.Chown(path, uid, -1)
}
