//go:build !windows

package sessionbroker

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// helperBinaryInstallTrusted requires the helper binary and its directory to
// be owned by root and not group- or world-writable, so only root could have
// placed or replaced it.
func helperBinaryInstallTrusted(path string) error {
	for _, p := range []string{path, filepath.Dir(path)} {
		info, err := os.Stat(p)
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("%s: owner unavailable", p)
		}
		if st.Uid != 0 {
			return fmt.Errorf("%s: owned by uid %d, not root", p, st.Uid)
		}
		if info.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s: group- or world-writable (mode %v)", p, info.Mode().Perm())
		}
	}
	return nil
}
