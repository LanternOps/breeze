//go:build linux

package tools

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

const systemctlTimeout = 5 * time.Second

// platformServiceStatus asks systemd directly. svcquery has no Linux
// implementation, and giving it one would change mgmtdetect's booleans, so the
// install-time check keeps its own helper. `--` ends option parsing; the name
// has also been refused by validServiceName if it starts with '-'.
func platformServiceStatus(name string) (running bool, supported bool) {
	ctx, cancel := context.WithTimeout(context.Background(), systemctlTimeout)
	defer cancel()

	err := exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", "--", name).Run()
	if err == nil {
		return classifySystemctl(nil, nil)
	}
	// A deadline kill surfaces as an *exec.ExitError ("signal: killed"); it is
	// a failure to ask, not an answer.
	if ctx.Err() != nil {
		return classifySystemctl(nil, ctx.Err())
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return classifySystemctl(exitErr, nil)
	}
	return classifySystemctl(nil, err)
}
