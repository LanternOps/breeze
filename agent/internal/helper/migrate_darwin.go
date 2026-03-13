package helper

import (
	"os"
	"os/exec"
	"strings"
)

func migrateLegacyPlatform() {
	out, err := exec.Command("id", "-u").Output()
	uid := ""
	if err == nil {
		uid = strings.TrimSpace(string(out))
	}
	if uid != "" {
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, "/Library/LaunchAgents/com.breeze.helper.plist").Run()
	}
	os.Remove("/Library/LaunchAgents/com.breeze.helper.plist")
}
