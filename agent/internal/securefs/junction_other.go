//go:build !windows

package securefs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func installJunction(string, string, string, uint32) ([]error, error) {
	return nil, ErrJunctionUnsupported
}

// ensureNoReparsePointsAlong is the lstat-only counterpart of the Windows
// walk: it refuses a symlink at any existing component of relative beneath
// base and stops at the first one that does not exist.
func ensureNoReparsePointsAlong(base, relative string) error {
	current := base
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path component %q is a symlink", component)
		}
		if !info.IsDir() {
			return nil
		}
	}
	return nil
}
