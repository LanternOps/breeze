//go:build !windows

package networkcontext

import (
	"os"
	"path/filepath"
)

func replaceStateFile(from, to string) error {
	if e := os.Rename(from, to); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(to))
	if e != nil {
		return e
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
