package helper

import (
	"fmt"
	"os"
	"path/filepath"
)

const helperConfigTempPattern = "helper_config.*.yaml.tmp"

// writeHelperConfigFile replaces path with data for a per-session config, whose
// directory belongs to the session's user. It uses an exclusive temp so a
// pre-existing path is never opened for writing, and mode is set on the open
// descriptor. The rename swaps the directory entry at path itself, never what
// that entry points to. The file keeps the Agent's ownership.
func writeHelperConfigFile(path string, data []byte, mode os.FileMode) (err error) {
	f, err := os.CreateTemp(filepath.Dir(path), helperConfigTempPattern)
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close() // already closed if the rename failed; harmless
			_ = os.Remove(tmp)
		}
	}()

	if err = f.Chmod(mode); err != nil {
		return fmt.Errorf("set temp config mode: %w", err)
	}
	if _, err = f.Write(data); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err = f.Sync(); err != nil {
		return fmt.Errorf("sync temp config: %w", err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("close temp config: %w", err)
	}
	if err = os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename config: %w", err)
	}
	return nil
}
