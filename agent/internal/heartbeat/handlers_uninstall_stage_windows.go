//go:build windows

package heartbeat

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/securefs"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
)

// stageWindowsUninstallHelper copies the agent binary into a new
// SYSTEM/Administrators-only directory under the system temp folder (the
// original is locked while the agent runs and is removed by the teardown) and
// returns the copy's path. The copy is named so no kill list in the teardown
// matches it.
func stageWindowsUninstallHelper(agentExe string) (string, func(), error) {
	dir, err := securefs.CreatePrivateTempDir(os.TempDir(), selfuninstall.HelperDirPrefix)
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	dst := filepath.Join(dir, selfuninstall.HelperExeName)
	if err := copyExecutable(agentExe, dst); err != nil {
		cleanup()
		return "", nil, err
	}
	return dst, cleanup, nil
}

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy %s: %w", src, err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
