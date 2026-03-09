package helper

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const desktopEntryDir = "/etc/xdg/autostart"
const desktopEntryPath = "/etc/xdg/autostart/breeze-helper.desktop"

func installAutoStart(binaryPath string) error {
	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Breeze Helper
Exec=%s
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`, binaryPath)

	if err := os.MkdirAll(desktopEntryDir, 0755); err != nil {
		return fmt.Errorf("create autostart dir: %w", err)
	}

	if err := os.WriteFile(desktopEntryPath, []byte(entry), 0644); err != nil {
		return fmt.Errorf("write desktop entry: %w", err)
	}

	log.Info("installed XDG autostart entry", "path", desktopEntryPath)
	return nil
}

func isHelperRunning() bool {
	out, err := exec.Command("pgrep", "-f", "breeze-helper").Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}

func stopHelper() error {
	return exec.Command("pkill", "-f", "breeze-helper").Run()
}
