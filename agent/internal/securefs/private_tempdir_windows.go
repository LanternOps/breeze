//go:build windows

package securefs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// CreatePrivateTempDir creates a new directory named prefix+<random hex>
// directly under base, with an EXPLICIT, protected SYSTEM + Administrators
// (+ the agent's own account) DACL instead of whatever base would let it
// inherit, and returns its path. The caller removes it.
//
// CreateDirectory with SECURITY_ATTRIBUTES is the atomic exclusive create: a
// squatted name returns ERROR_ALREADY_EXISTS and is retried under a new random
// name, so the agent never adopts a directory somebody else made. The result
// is then verified from its own handle (a real directory, not a reparse point,
// owned by SYSTEM/Administrators/the agent account, inheritance-protected DACL)
// before the caller writes or has a privileged tool write anything into it.
// Same construction as the executor's script staging directory.
func CreatePrivateTempDir(base, prefix string) (string, error) {
	sa, err := PrivateDirSecurityAttributes()
	if err != nil {
		return "", err
	}
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		var suffix [12]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return "", fmt.Errorf("generate private directory name: %w", err)
		}
		dir := filepath.Join(base, prefix+hex.EncodeToString(suffix[:]))
		wide, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return "", err
		}
		if err := windows.CreateDirectory(wide, sa); err != nil {
			if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
				lastErr = err
				continue
			}
			return "", fmt.Errorf("create private directory: %w", err)
		}
		if err := VerifyPrivateDir(dir); err != nil {
			_ = os.Remove(dir)
			return "", err
		}
		return dir, nil
	}
	return "", fmt.Errorf("create private directory: name repeatedly taken: %w", lastErr)
}
