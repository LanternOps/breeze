//go:build !darwin && !windows

package helper

import (
	"bytes"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()
	_ = os.Remove(desktopEntryPath)
}

func stopHelperLegacy() {
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
}

func migrationTargets() ([]string, error) {
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err == nil {
		seen := make(map[string]struct{})
		var targets []string
		for _, line := range bytes.Split(out, []byte{'\n'}) {
			fields := strings.Fields(string(line))
			if len(fields) < 2 {
				continue
			}
			uid := fields[1]
			if uid == "" || uid == "0" {
				continue
			}
			if _, ok := seen[uid]; ok {
				continue
			}
			seen[uid] = struct{}{}
			targets = append(targets, uid)
		}
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
