package mgmtdetect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// checkDispatcher evaluates Check probes using existing agent primitives.
type checkDispatcher struct {
	processSnap *processSnapshot
}

func newCheckDispatcher(snap *processSnapshot) *checkDispatcher {
	return &checkDispatcher{processSnap: snap}
}

// evaluate runs a single check and returns true if the probe matched.
func (d *checkDispatcher) evaluate(c Check) bool {
	// Per-check OS filter
	if c.OS != "" && c.OS != runtime.GOOS {
		return false
	}

	switch c.Type {
	case CheckFileExists:
		_, err := os.Stat(c.Value)
		return err == nil
	case CheckServiceRunning:
		return d.checkServiceRunning(c.Value)
	case CheckProcessRunning:
		return d.processSnap.isRunning(c.Value)
	case CheckRegistryValue:
		return d.checkRegistryValue(c.Value)
	case CheckLaunchDaemon:
		return d.checkLaunchDaemon(c.Value)
	case CheckCommand:
		return d.checkCommand(c.Value, c.Parse)
	default:
		log.Warn("unknown check type", "type", c.Type)
		return false
	}
}

func (d *checkDispatcher) checkServiceRunning(name string) bool {
	running, err := svcquery.IsRunning(name)
	if err != nil {
		log.Debug("service check failed", "service", name, "error", err)
		return false
	}
	return running
}

func (d *checkDispatcher) checkCommand(command, parse string) bool {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			log.Warn("command timed out", "command", parts[0])
		} else if !errors.Is(err, exec.ErrNotFound) {
			log.Debug("command failed", "command", parts[0], "error", err)
		}
		return false
	}
	if parse == "" {
		return true
	}
	return strings.Contains(string(output), parse)
}
