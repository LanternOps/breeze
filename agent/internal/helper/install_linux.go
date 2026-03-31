package helper

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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

func removeAutoStart() error {
	if err := os.Remove(desktopEntryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove desktop entry: %w", err)
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

func spawnWithConfig(binaryPath, sessionKey, configPath string) error {
	uid, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return fmt.Errorf("invalid uid %q: %w", sessionKey, err)
	}

	u, err := user.LookupId(sessionKey)
	if err != nil {
		return fmt.Errorf("lookup uid %s: %w", sessionKey, err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return fmt.Errorf("parse gid %q: %w", u.Gid, err)
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
		return fmt.Errorf("start helper for uid %s: %w", sessionKey, err)
	}
	return cmd.Process.Release()
}

func isHelperRunning() bool {
	out, err := outputHelperCommand("pgrep", "-f", "breeze-helper")
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}

func stopHelper() error {
	return runHelperCommand("pkill", "-f", "breeze-helper")
}
