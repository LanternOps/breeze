//go:build !windows

package agentapp

import (
	"os"
	"path/filepath"
	"syscall"
)

func protectedPackagedSibling(agentPath, siblingPath string) bool {
	agentAbs, err := filepath.Abs(agentPath)
	if err != nil {
		return false
	}
	siblingAbs, err := filepath.Abs(siblingPath)
	if err != nil || filepath.Dir(agentAbs) != "/usr/local/bin" || filepath.Dir(siblingAbs) != "/usr/local/bin" {
		return false
	}
	for _, path := range []string{"/usr/local/bin", agentAbs, siblingAbs} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
			return false
		}
		if path != "/usr/local/bin" && !info.Mode().IsRegular() {
			return false
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 {
			return false
		}
	}
	return true
}
