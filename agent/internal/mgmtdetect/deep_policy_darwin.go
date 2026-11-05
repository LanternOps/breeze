//go:build darwin

package mgmtdetect

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

func collectPolicyDetections() []Detection {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	output, err := procspawn.CommandContext(ctx, "profiles", "list").CombinedOutput()
	if err != nil {
		log.Warn("profiles list command failed", "error", err)
		return nil
	}
	return parseMacProfilesOutput(string(output))
}
