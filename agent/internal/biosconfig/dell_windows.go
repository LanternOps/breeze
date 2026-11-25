//go:build windows

package biosconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	dellReadTimeout  = 60 * time.Second
	dellWriteTimeout = 60 * time.Second
	// maxDellWriteOutput bounds what is read back from the write script, which
	// prints one short JSON object.
	maxDellWriteOutput = 4 << 10
)

func newDellAdapter() Adapter {
	return &dellAdapter{run: runPowerShell, write: runDellWrite}
}

// runPowerShell runs a read-only script and returns its stdout.
func runPowerShell(ctx context.Context, script string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, dellReadTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 300 {
				msg = msg[:300]
			}
			return nil, fmt.Errorf("powershell exit %d: %s", exit.ExitCode(), msg)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

// runDellWrite runs dellApplyScript with the request on stdin. Windows
// PowerShell is run from System32 by absolute path (this runs as SYSTEM, so a
// PATH lookup is not good enough), with fixed arguments and a timeout. Neither
// stdout nor stderr reaches an error or a log: the script prints only its own
// status JSON, which the caller parses. A timed-out run may still have landed
// in firmware; the caller re-reads.
func runDellWrite(ctx context.Context, script string, stdin []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, dellWriteTimeout)
	defer cancel()
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, fmt.Errorf("locate powershell: %w", err)
	}
	exe := filepath.Join(dir, "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := procspawn.CommandContext(ctx, exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	stdout := &boundedWriter{limit: maxDellWriteOutput}
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stdout = stdout
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("dell write did not finish and may still take effect: %w", ctx.Err())
		}
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return nil, fmt.Errorf("powershell exit %d", exit.ExitCode())
		}
		return nil, errors.New("powershell did not run")
	}
	if stdout.overflow {
		return nil, errors.New("dell write output is larger than expected")
	}
	return stdout.data, nil
}

// boundedWriter keeps at most limit bytes and says when it overflowed. A Write
// never fails, so a chatty process is not killed by its own pipe.
type boundedWriter struct {
	data     []byte
	limit    int
	overflow bool
}

func (b *boundedWriter) Write(p []byte) (int, error) {
	keep := p
	if room := b.limit - len(b.data); len(p) > room {
		b.overflow = true
		keep = p[:max(room, 0)]
	}
	b.data = append(b.data, keep...)
	return len(p), nil
}
