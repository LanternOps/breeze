//go:build windows

package agentapp

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/serviceinstall"
)

func protectedPackagedSibling(agentPath, siblingPath string) bool {
	expectedAgent, err := serviceinstall.ProtectedBinaryPath(filepath.Base(agentPath))
	if err != nil {
		return false
	}
	expectedSibling, err := serviceinstall.ProtectedBinaryPath(filepath.Base(siblingPath))
	if err != nil || !strings.EqualFold(filepath.Clean(agentPath), filepath.Clean(expectedAgent)) ||
		!strings.EqualFold(filepath.Clean(siblingPath), filepath.Clean(expectedSibling)) {
		return false
	}
	for _, path := range []string{agentPath, siblingPath} {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	return true
}
