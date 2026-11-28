// Package wingetenv puts the VC++ runtime framework on winget's DLL search
// path when the agent runs winget.exe by its full WindowsApps path (#12835).
//
// winget.exe imports VCRUNTIME140.dll and WindowsPackageManager.dll imports
// MSVCP140.dll, VCRUNTIME140_1.dll and CONCRT140.dll. Those ship in the
// Microsoft.VCLibs.140.00.UWPDesktop framework package that App Installer
// depends on. Run through its execution alias, winget has package identity and
// the framework is on its search path. Run as SYSTEM from
// %ProgramFiles%\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe, it has
// no identity, so on a machine without the VC++ redistributable in System32 it
// dies with 0xC0000135 (STATUS_DLL_NOT_FOUND) before printing anything.
// Prepending the matching framework directory to the CHILD's PATH fixes it.
//
// procspawn.Prepare calls Apply for every child the agent starts, so no winget
// call site can skip it. The package has no dependencies beyond the standard
// library and only acts on a winget.exe inside an App Installer package
// directory, so on other platforms (and for every other command) it is a no-op.
package wingetenv

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

var (
	appInstallerDirRe = regexp.MustCompile(`^Microsoft\.DesktopAppInstaller_([0-9]+(?:\.[0-9]+)*)_(x64|arm64)__8wekyb3d8bbwe$`)
	vclibsDirRe       = regexp.MustCompile(`^Microsoft\.VCLibs\.140\.00\.UWPDesktop_([0-9]+(?:\.[0-9]+)*)_(x64|arm64|x86)__8wekyb3d8bbwe$`)
)

const vclibsGlob = `Microsoft.VCLibs.140.00.UWPDesktop_*__8wekyb3d8bbwe`

// ParseAppInstallerDir extracts the version and architecture from a
// Microsoft.DesktopAppInstaller_<ver>_<x64|arm64>__8wekyb3d8bbwe directory
// name. Neutral/split resource packages and other architectures do not match.
func ParseAppInstallerDir(dir string) (version, arch string, ok bool) {
	m := appInstallerDirRe.FindStringSubmatch(dir)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// CompareVersions compares two dotted-numeric version strings component by
// component as integers, returning -1, 0, or 1.
func CompareVersions(a, b string) int {
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

// lastSep returns the index of the last path separator in p. Both '\' and '/'
// count: the paths are Windows paths even when this is tested on another OS.
func lastSep(p string) int { return strings.LastIndexAny(p, `\/`) }

// VCLibsDir returns the highest-version Microsoft.VCLibs.140.00.UWPDesktop
// directory whose architecture matches the App Installer package wingetPath
// lives in, searching that package's own WindowsApps root. It reports false
// (and never calls glob) when wingetPath is not winget.exe inside an App
// Installer package directory, and false when no matching framework exists.
func VCLibsDir(wingetPath string, glob func(string) ([]string, error)) (string, bool) {
	i := lastSep(wingetPath)
	if i < 0 || !strings.EqualFold(wingetPath[i+1:], "winget.exe") {
		return "", false
	}
	pkgDir := wingetPath[:i]
	j := lastSep(pkgDir)
	if j < 0 {
		return "", false
	}
	_, arch, ok := ParseAppInstallerDir(pkgDir[j+1:])
	if !ok {
		return "", false
	}
	root, sep := pkgDir[:j], pkgDir[j:j+1]

	matches, err := glob(root + sep + vclibsGlob)
	if err != nil {
		return "", false
	}
	best, bestVer := "", ""
	for _, m := range matches {
		k := lastSep(m)
		mm := vclibsDirRe.FindStringSubmatch(m[k+1:])
		if mm == nil || mm[2] != arch {
			continue
		}
		if bestVer == "" || CompareVersions(mm[1], bestVer) > 0 {
			best, bestVer = m, mm[1]
		}
	}
	return best, best != ""
}

// ChildEnv returns a copy of env with dir prepended to PATH. caseInsensitive
// matches the variable name the way Windows does ("Path" is PATH) and keeps the
// existing spelling; when duplicates exist the last one is edited, because that
// is the one os/exec keeps. A missing or empty PATH becomes just dir, and a PATH
// that already starts with dir is returned unchanged. env is never modified.
func ChildEnv(env []string, dir string, caseInsensitive bool, listSep string) []string {
	out := append([]string(nil), env...)
	sameName := func(k string) bool {
		if caseInsensitive {
			return strings.EqualFold(k, "PATH")
		}
		return k == "PATH"
	}
	for i, kv := range slices.Backward(out) {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || !sameName(k) {
			continue
		}
		if v == "" {
			out[i] = k + "=" + dir
			return out
		}
		first, _, _ := strings.Cut(v, listSep)
		if first == dir || (caseInsensitive && strings.EqualFold(first, dir)) {
			return out
		}
		out[i] = k + "=" + dir + listSep + v
		return out
	}
	return append(out, "PATH="+dir)
}

// Apply prepends the matching VC++ framework directory to cmd's child PATH when
// cmd runs App Installer's winget.exe by full path. The agent's own environment
// is never touched: the result goes in cmd.Env, starting from cmd.Env when the
// caller set one and from os.Environ() otherwise. It is idempotent and returns
// cmd; any other command, or no framework on disk, leaves cmd unchanged.
func Apply(cmd *exec.Cmd) *exec.Cmd {
	if cmd == nil {
		return nil
	}
	dir, ok := VCLibsDir(cmd.Path, filepath.Glob)
	if !ok {
		return cmd
	}
	env := cmd.Env
	if env == nil {
		env = os.Environ()
	}
	cmd.Env = ChildEnv(env, dir, runtime.GOOS == "windows", string(os.PathListSeparator))
	return cmd
}
