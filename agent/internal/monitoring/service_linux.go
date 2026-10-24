//go:build linux

package monitoring

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func checkService(name string) CheckResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	output, err := exec.CommandContext(ctx, "systemctl", "is-active", "--", name).Output()
	execDetail := ""
	if err != nil {
		execDetail = err.Error()
	}
	// `-p LoadState` without --value: --value needs systemd >= 230.
	return systemctlCheckResult(name, strings.TrimSpace(string(output)), classifyExec(ctx.Err(), err), exitCodeOf(err), execDetail,
		func() (string, execOutcome) {
			out, showErr := exec.CommandContext(ctx, "systemctl", "show", "-p", "LoadState", "--", name).Output()
			return string(out), classifyExec(ctx.Err(), showErr)
		})
}

func restartService(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "systemctl", "restart", name)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", name, err)
	}
	return nil
}
