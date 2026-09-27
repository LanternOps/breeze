//go:build windows

package tools

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// createPrivateInstallDir creates the per-download software-install staging
// directory with an EXPLICIT, protected DACL instead of relying on whatever
// the base temp directory happens to inherit. os.MkdirTemp inherits the
// parent's ACEs — on a Windows build without GetTempPath2W (Go's temp
// directory falls back to C:\Windows\Temp) that is enough for a standard
// local user to create files in the same directory the agent stages an
// installer into. Mirrors internal/executor's createPrivateScriptDir.
func createPrivateInstallDir() (string, error) {
	sa, err := securefs.PrivateDirSecurityAttributes()
	if err != nil {
		return "", err
	}
	base := os.TempDir()
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		var suffix [12]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return "", fmt.Errorf("generate install directory name: %w", err)
		}
		dir := filepath.Join(base, "breeze-sw-install-"+hex.EncodeToString(suffix[:]))
		wide, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return "", err
		}
		if err := windows.CreateDirectory(wide, sa); err != nil {
			if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
				lastErr = err
				continue
			}
			return "", fmt.Errorf("create private install directory: %w", err)
		}
		if err := securefs.VerifyPrivateDir(dir); err != nil {
			_ = os.Remove(dir)
			return "", err
		}
		return dir, nil
	}
	return "", fmt.Errorf("create private install directory: name repeatedly taken: %w", lastErr)
}
