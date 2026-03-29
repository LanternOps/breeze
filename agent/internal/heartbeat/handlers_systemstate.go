package heartbeat

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSystemStateCollect] = handleSystemStateCollect
	handlerRegistry[tools.CmdHardwareProfile] = handleHardwareProfile
}

func handleSystemStateCollect(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	manifest, stagingDir, err := systemstate.CollectSystemState()
	if err != nil {
		slog.Error("system state collection failed", "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	result := map[string]any{
		"manifest":   manifest,
		"stagingDir": stagingDir,
		"artifacts":  len(manifest.Artifacts),
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleHardwareProfile(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	profile, err := systemstate.CollectHardwareOnly()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(profile)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}
