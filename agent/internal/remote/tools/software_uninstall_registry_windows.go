//go:build windows

package tools

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// machineUninstallKeyPaths are the machine-wide Uninstall keys, the same HKLM
// roots the software inventory collector reads. Per-user hives are deliberately
// absent: see the trust-boundary note in software_uninstall_registry.go.
var machineUninstallKeyPaths = []string{
	`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
	`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

func listWindowsUninstallEntriesOS() ([]windowsUninstallEntry, error) {
	var entries []windowsUninstallEntry
	opened := 0
	for _, base := range machineUninstallKeyPaths {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, base, registry.READ)
		if err != nil {
			if registryKeyMissing(err) {
				continue
			}
			return nil, fmt.Errorf(`open HKLM\%s: %w`, base, err)
		}
		opened++
		names, err := key.ReadSubKeyNames(-1)
		key.Close()
		if err != nil {
			return nil, fmt.Errorf(`enumerate HKLM\%s: %w`, base, err)
		}
		for _, name := range names {
			path := base + `\` + name
			sub, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
			if err != nil {
				if registryKeyMissing(err) {
					continue // removed between enumeration and open
				}
				entries = append(entries, windowsUninstallEntry{KeyPath: path, KeyName: name, ReadErr: err})
				continue
			}
			entries = append(entries, readWindowsUninstallEntry(sub, name, path))
			sub.Close()
		}
	}
	if opened == 0 {
		return nil, fmt.Errorf("no machine-wide Uninstall registry key could be opened")
	}
	return entries, nil
}

func readWindowsUninstallEntry(key registry.Key, name, path string) windowsUninstallEntry {
	str := func(value string) string {
		v, _, err := key.GetStringValue(value)
		if err != nil {
			return ""
		}
		return v
	}
	flag := func(value string) bool {
		v, _, err := key.GetIntegerValue(value)
		return err == nil && v == 1
	}
	return windowsUninstallEntry{
		KeyPath:              path,
		KeyName:              name,
		DisplayName:          str("DisplayName"),
		DisplayVersion:       str("DisplayVersion"),
		UninstallString:      str("UninstallString"),
		QuietUninstallString: str("QuietUninstallString"),
		WindowsInstaller:     flag("WindowsInstaller"),
		SystemComponent:      flag("SystemComponent"),
	}
}

func uninstallEntryPresentOS(entry windowsUninstallEntry) (bool, error) {
	if entry.KeyPath == "" {
		return false, fmt.Errorf("uninstall entry has no registry path")
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, entry.KeyPath, registry.QUERY_VALUE)
	if err != nil {
		if registryKeyMissing(err) {
			return false, nil
		}
		return false, err
	}
	key.Close()
	return true, nil
}

// startRegistryUninstallerOS launches the planned uninstaller directly via
// CreateProcess: lpApplicationName is the absolute executable path and the
// command line is passed verbatim, so no shell is involved and no search path
// is consulted.
//
// A QuietUninstallString executable is first opened and checked where it
// really lives (openResolvedUninstaller). That handle stays open, sharing
// read access only, until the process has started, so the checked file
// cannot be replaced, renamed or written in between, and the resolved path is
// the one launched.
func startRegistryUninstallerOS(plan registryUninstallPlan) (uninstallerProcess, error) {
	sysDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, fmt.Errorf("resolve system directory: %w", err)
	}
	if plan.Kind == registryUninstallKindQuiet {
		held, resolved, err := openResolvedUninstaller(plan.Exe)
		if err != nil {
			return nil, err
		}
		defer held.Close()
		plan.Exe = resolved
	}
	exePath, cmdLine := registryUninstallCmdLine(plan, filepath.Join(sysDir, "msiexec.exe"))

	info, err := os.Stat(exePath)
	if err != nil {
		return nil, fmt.Errorf("uninstaller %q: %w", exePath, err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("uninstaller " + exePath + " is not a regular file")
	}

	cmd := procspawn.Prepare(&exec.Cmd{
		Path: exePath,
		SysProcAttr: &syscall.SysProcAttr{
			CmdLine:    cmdLine,
			HideWindow: true,
		},
	})
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmdProcess{cmd}, nil
}

// openResolvedUninstaller opens exePath for reading, sharing read access
// only, and applies the uninstaller location checks to the path Windows
// resolves the open file to. A short (8.3) name, a junction or a link can
// name the same file differently from the registered string; the checks then
// decide on the file's real location. On success the caller owns the open
// file and receives the resolved path.
func openResolvedUninstaller(exePath string) (*os.File, string, error) {
	name, err := windows.UTF16PtrFromString(exePath)
	if err != nil {
		return nil, "", fmt.Errorf("uninstaller %q: %w", exePath, err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, "", fmt.Errorf("uninstaller %q: %w", exePath, err)
	}
	f := os.NewFile(uintptr(h), exePath)
	resolved, err := finalPathOfFile(f)
	if err != nil {
		f.Close()
		return nil, "", fmt.Errorf("resolve uninstaller %q: %w", exePath, err)
	}
	resolved = collapsePathSeparators(resolved)
	if err := validateUninstallerPath(resolved); err != nil {
		f.Close()
		return nil, "", fmt.Errorf("uninstaller %q resolves to %q: %w", exePath, resolved, err)
	}
	return f, resolved, nil
}

type cmdProcess struct{ cmd *exec.Cmd }

func (p cmdProcess) Wait() error { return p.cmd.Wait() }
func (p cmdProcess) Kill() error { return p.cmd.Process.Kill() }
