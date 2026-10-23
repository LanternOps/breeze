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

	output, err := exec.CommandContext(ctx, "systemctl", "is-active", name).Output()
	execDetail := ""
	if err != nil {
		execDetail = err.Error()
	}
	return systemctlCheckResult(name, strings.TrimSpace(string(output)), classifyExec(ctx.Err(), err), execDetail,
		func() execOutcome {
			catErr := exec.CommandContext(ctx, "systemctl", "cat", name).Run()
			return classifyExec(ctx.Err(), catErr)
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
