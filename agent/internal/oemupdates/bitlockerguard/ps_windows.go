//go:build windows

package bitlockerguard

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	commandTimeout   = 60 * time.Second
	commandWaitDelay = 10 * time.Second
	// maxManageBdeOutput bounds what is read. A TPM listing is well under this.
	maxManageBdeOutput = 64 << 10
)

// system32 is where every tool here is run from, by full path: this runs as
// SYSTEM, so a PATH lookup is not good enough.
func system32() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32")
}

func runPowerShell(ctx context.Context, script string) error {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx,
		filepath.Join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"),
		"-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, io.Discard, io.Discard
	cmd.WaitDelay = commandWaitDelay
	return cmd.Run()
}

func systemSuspend(ctx context.Context, count int) error {
	drive, err := mountPoint(os.Getenv("SystemDrive"))
	if err != nil {
		return err
	}
	script, err := suspendScript(drive, count)
	if err != nil {
		return err
	}
	return runPowerShell(ctx, script)
}

func systemResume(ctx context.Context) error {
	drive, err := mountPoint(os.Getenv("SystemDrive"))
	if err != nil {
		return err
	}
	script, err := resumeScript(drive)
	if err != nil {
		return err
	}
	return runPowerShell(ctx, script)
}

// boundedBuffer keeps at most limit bytes and says when it overflowed.
type boundedBuffer struct {
	data     []byte
	limit    int
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	room := b.limit - len(b.data)
	if len(p) > room {
		b.overflow = true
		p2 := p[:max(room, 0)]
		b.data = append(b.data, p2...)
		return len(p), nil
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

// systemProtectors never puts the output in an error or a log.
func systemProtectors(ctx context.Context) (string, error) {
	drive, err := mountPoint(os.Getenv("SystemDrive"))
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	out := &boundedBuffer{limit: maxManageBdeOutput}
	cmd := procspawn.CommandContext(ctx, filepath.Join(system32(), "manage-bde.exe"), manageBdeArgs(drive)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, out, io.Discard
	cmd.WaitDelay = commandWaitDelay
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("manage-bde: %w", err)
	}
	if out.overflow {
		return "", errors.New("manage-bde output is larger than expected")
	}
	return string(out.data), nil
}
