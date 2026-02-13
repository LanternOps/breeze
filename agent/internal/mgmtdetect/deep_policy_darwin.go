//go:build darwin

package mgmtdetect

import (
	"context"
	"os/exec"
	"time"
)

func collectPolicyDetections() []Detection {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	output, err := exec.CommandContext(ctx, "profiles", "list").CombinedOutput()
	if err != nil {
		log.Warn("profiles list command failed", "error", err)
		return nil
	}
	return parseMacProfilesOutput(string(output))
}
