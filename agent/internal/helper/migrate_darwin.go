package helper

import (
	"os"
	"strconv"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()
	_ = os.Remove(plistPath)
}

func stopHelperLegacy() {
	uid := consoleUID()
	if uid != "" && uid != "0" {
		_ = runHelperCommand("launchctl", "bootout", "gui/"+uid, plistPath)
	}
	_ = runHelperCommand("pkill", "-f", "breeze-helper")
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
