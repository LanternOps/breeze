//go:build !windows

package rollback

import (
	"os"
	"path/filepath"
)

func replaceStateFile(source, target string) error { return os.Rename(source, target) }

func syncStateDir(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
