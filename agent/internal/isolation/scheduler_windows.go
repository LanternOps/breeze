//go:build windows

package isolation

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/authenticode"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/procspawn"
	"golang.org/x/sys/windows"
)

// NewPlatformScheduler supplies Windows' independent recovery tasks. Paths are
// loaded afresh from the journal so an artifact rotation also rotates actions.
func NewPlatformScheduler(dataDir string) RecoveryScheduler {
	return &windowsScheduler{
		dataDir: dataDir,
		tempDir: dataDir,
		recoveryPath: func() (string, error) {
			j, err := journal.Load(journal.Path(dataDir))
			if err != nil {
				return "", err
			}
			return j.RecoveryPath, nil
		},
		run: func(args ...string) ([]byte, error) {
			systemDir, err := windows.GetSystemDirectory()
			if err != nil {
				return nil, fmt.Errorf("resolve schtasks directory: %w", err)
			}
			return runRecoveryCommand(30*time.Second, filepath.Join(systemDir, "schtasks.exe"), args...)
		},
		exists:          func(path string) bool { info, err := os.Stat(path); return err == nil && info.Mode().IsRegular() },
		verifySignature: verifyRecoveryAuthenticode,
		selfTest:        func(path string) error { _, err := runRecoveryCommand(15*time.Second, path, "self-test"); return err },
		now:             time.Now,
	}
}

func runRecoveryCommand(timeout time.Duration, path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := procspawn.CommandContext(ctx, path, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("execute %s: %w (%s)", path, err, output)
	}
	return output, nil
}

func verifyRecoveryAuthenticode(path string) error { return authenticode.VerifyChain(path) }
