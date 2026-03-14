package helper

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const desktopEntryDir = "/etc/xdg/autostart"
const desktopEntryPath = "/etc/xdg/autostart/breeze-helper.desktop"

func packageExtension() string { return ".AppImage" }

// installPackage copies the AppImage to the target path and makes it executable.
// AppImages are self-contained and directly runnable.
func installPackage(appImagePath, binaryPath string) error {
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0755); err != nil {
		return fmt.Errorf("create binary dir: %w", err)
	}

	src, err := os.Open(appImagePath)
	if err != nil {
		return fmt.Errorf("open appimage: %w", err)
	}
	defer src.Close()

	dst, err := os.OpenFile(binaryPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("create binary: %w", err)
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("copy appimage: %w", err)
	}

	log.Info("AppImage installed", "path", binaryPath)
	return nil
}

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
