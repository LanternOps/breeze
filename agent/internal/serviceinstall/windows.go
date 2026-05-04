//go:build windows

package serviceinstall

import (
	"fmt"

	"golang.org/x/sys/windows"
)

func ProtectedBinaryPath(binaryName string) (string, error) {
	programFiles, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return "", fmt.Errorf("resolve protected Program Files path: %w", err)
	}
	return ProtectedBinaryPathIn(programFiles, binaryName)
}

func InstallProtectedBinary(currentExe, binaryName string) (string, bool, error) {
	targetPath, err := ProtectedBinaryPath(binaryName)
	if err != nil {
		return "", false, err
	}
	return StageProtectedBinary(currentExe, targetPath)
}
