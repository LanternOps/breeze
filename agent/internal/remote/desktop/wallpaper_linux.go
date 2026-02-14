//go:build linux

package desktop

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type linuxWallpaperBackend struct{}

func newWallpaperBackend() wallpaperBackend {
	return &linuxWallpaperBackend{}
}

func (b *linuxWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	de := detectDesktopEnv()
	state := &WallpaperState{DesktopEnv: de}

	switch de {
	case "gnome", "cinnamon":
		out, err := exec.Command("gsettings", "get", "org.gnome.desktop.background", "picture-uri").Output()
		if err != nil {
			return state, nil
		}
		state.WallpaperPath = unquoteGSettings(string(out))
	case "xfce":
		out, err := exec.Command("xfconf-query", "-c", "xfce4-desktop",
			"-p", "/backdrop/screen0/monitor0/workspace0/last-image").Output()
		if err != nil {
			return state, nil
		}
		state.WallpaperPath = strings.TrimSpace(string(out))
	}
	return state, nil
}

func (b *linuxWallpaperBackend) SetSolidBlack() error {
	de := detectDesktopEnv()
	switch de {
	case "gnome", "cinnamon":
		// Remove wallpaper image, set solid color to black
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "picture-uri", "''").Run()
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "picture-uri-dark", "''").Run()
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "primary-color", "#000000").Run()
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "color-shading-type", "solid").Run()
		return nil
	case "xfce":
		_ = exec.Command("xfconf-query", "-c", "xfce4-desktop",
			"-p", "/backdrop/screen0/monitor0/workspace0/last-image", "-s", "").Run()
		_ = exec.Command("xfconf-query", "-c", "xfce4-desktop",
			"-p", "/backdrop/screen0/monitor0/workspace0/color1",
			"-t", "uint", "-s", "0",
			"-t", "uint", "-s", "0",
			"-t", "uint", "-s", "0",
			"-t", "uint", "-s", "65535").Run()
		return nil
	default:
		return fmt.Errorf("unsupported desktop environment: %s", de)
	}
}

func (b *linuxWallpaperBackend) Restore(state *WallpaperState) error {
	if state.WallpaperPath == "" {
		return nil
	}

	de := state.DesktopEnv
	if de == "" {
		de = detectDesktopEnv()
	}

	switch de {
	case "gnome", "cinnamon":
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "picture-uri", state.WallpaperPath).Run()
		_ = exec.Command("gsettings", "set", "org.gnome.desktop.background", "picture-uri-dark", state.WallpaperPath).Run()
		return nil
	case "xfce":
		return exec.Command("xfconf-query", "-c", "xfce4-desktop",
			"-p", "/backdrop/screen0/monitor0/workspace0/last-image",
			"-s", state.WallpaperPath).Run()
	default:
		return fmt.Errorf("unsupported desktop environment: %s", de)
	}
}

func detectDesktopEnv() string {
	de := strings.ToLower(os.Getenv("XDG_CURRENT_DESKTOP"))
	if de == "" {
		de = strings.ToLower(os.Getenv("DESKTOP_SESSION"))
	}
	switch {
	case strings.Contains(de, "gnome"):
		return "gnome"
	case strings.Contains(de, "cinnamon"):
		return "cinnamon"
	case strings.Contains(de, "xfce"):
		return "xfce"
	default:
		return de
	}
}

// unquoteGSettings strips the quotes that gsettings wraps around string values.
func unquoteGSettings(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "'\"")
	return s
}
