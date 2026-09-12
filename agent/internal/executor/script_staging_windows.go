//go:build windows

package executor

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

// createPrivateScriptDir creates the per-execution script staging directory
// with an EXPLICIT, protected DACL instead of relying on whatever %TEMP%
// happens to inherit. os.MkdirTemp would leave the directory with the parent's
// inherited ACEs — on C:\Windows\Temp that is enough for an interactive user to
// reach a script the agent writes as SYSTEM.
//
// CreateDirectory with SECURITY_ATTRIBUTES is the atomic exclusive create: a
// squatted name returns ERROR_ALREADY_EXISTS and is retried under a new random
// name, so the agent never adopts a directory somebody else made. The result is
// then verified from its own handle — a real directory, not a reparse point,
// owned by SYSTEM/Administrators/the agent account, with an inheritance-
// protected DACL — before any script content is written into it.
func createPrivateScriptDir() (string, error) {
	sa, err := securefs.PrivateDirSecurityAttributes()
	if err != nil {
		return "", err
	}
	base := os.TempDir()
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		var suffix [12]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return "", fmt.Errorf("generate script directory name: %w", err)
		}
		dir := filepath.Join(base, "breeze-scripts-"+hex.EncodeToString(suffix[:]))
		wide, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return "", err
		}
		if err := windows.CreateDirectory(wide, sa); err != nil {
			if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
				lastErr = err
				continue
			}
			return "", fmt.Errorf("create private script directory: %w", err)
		}
		if err := securefs.VerifyPrivateDir(dir); err != nil {
			_ = os.Remove(dir)
			return "", err
		}
		return dir, nil
	}
	return "", fmt.Errorf("create private script directory: name repeatedly taken: %w", lastErr)
}
