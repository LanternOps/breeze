//go:build !darwin && !windows

package helper

import (
	"os"
	"os/exec"
)

func migrateLegacyPlatform() {
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
	os.Remove("/etc/xdg/autostart/breeze-helper.desktop")
}
