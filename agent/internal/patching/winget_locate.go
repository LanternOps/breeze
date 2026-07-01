package patching

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var errWingetNotFound = errors.New("winget.exe not found under WindowsApps")

var appInstallerDirRe = regexp.MustCompile(`^Microsoft\.DesktopAppInstaller_([0-9]+(?:\.[0-9]+)*)_x64__8wekyb3d8bbwe$`)

// wingetLocator finds the SYSTEM-usable winget.exe under the versioned
// WindowsApps folder, since the per-user PATH shim isn't reachable from the
// SYSTEM account.
type wingetLocator struct {
	root string
	glob func(string) ([]string, error)
}

func newWingetLocator() *wingetLocator {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return &wingetLocator{root: filepath.Join(pf, "WindowsApps"), glob: filepath.Glob}
}

// Locate returns the path and version of the highest-version winget.exe
// found under root, or errWingetNotFound if none match.
func (l *wingetLocator) Locate() (string, string, error) {
	matches, err := l.glob(filepath.Join(l.root, "Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe", "winget.exe"))
	if err != nil {
		return "", "", err
	}
	bestPath, bestVer := "", ""
	for _, m := range matches {
		// Split on both '\' and '/' rather than using filepath.Dir/Base:
		// those are separator-aware based on the *host* GOOS, but these
		// paths are always Windows-style (backslash) even when this code
		// is compiled/tested on a non-Windows host.
		parts := strings.FieldsFunc(m, func(r rune) bool { return r == '\\' || r == '/' })
		if len(parts) < 2 {
			continue
		}
		dir := parts[len(parts)-2]
		ver, ok := parseAppInstallerVersion(dir)
		if !ok {
			continue
		}
		if bestVer == "" || compareVersions(ver, bestVer) > 0 {
			bestPath, bestVer = m, ver
		}
	}
	if bestPath == "" {
		return "", "", errWingetNotFound
	}
	return bestPath, bestVer, nil
}

// parseAppInstallerVersion extracts the version string from a
// Microsoft.DesktopAppInstaller_<ver>_x64__8wekyb3d8bbwe directory name.
func parseAppInstallerVersion(dir string) (string, bool) {
	m := appInstallerDirRe.FindStringSubmatch(dir)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// compareVersions compares two dotted-numeric version strings, returning
// -1, 0, or 1 as a is less than, equal to, or greater than b.
func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
