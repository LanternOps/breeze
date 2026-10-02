//go:build !linux && !darwin && !windows

package securefs

import (
	"fmt"
	"os"
	"path/filepath"
)

func openFileRead(base, relative string) (*os.File, error) {
	if _, err := statFile(base, relative); err != nil {
		return nil, err
	}
	f, err := os.Open(filepath.Join(base, relative))
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, fmt.Errorf("target is not a regular file: %q", relative)
	}
	return f, nil
}
