//go:build !darwin && !windows

package helper

import (
	"os"
	"os/user"
	"strconv"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()
	_ = os.Remove(desktopEntryPath)
}

func stopHelperLegacy() {
	_ = runHelperCommand("pkill", "-f", "breeze-helper")
}

func migrationTargets() ([]string, error) {
	out, err := outputHelperCommand("loginctl", "list-sessions", "--no-legend", "--no-pager")
	if err == nil {
		targets := parseMigrationTargetsOutput(out)
		if len(targets) > 0 {
			return targets, nil
		}
	}

	current, err := user.Current()
	if err != nil || current.Uid == "" || current.Uid == "0" {
		return nil, err
	}
	return []string{current.Uid}, nil
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
