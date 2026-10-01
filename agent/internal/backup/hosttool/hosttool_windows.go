//go:build windows

package hosttool

import "golang.org/x/sys/windows"

func init() {
	windowsDir = func() string {
		dir, err := windows.GetSystemWindowsDirectory()
		if err != nil {
			return ""
		}
		return dir
	}
}
