package heartbeat

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdTimeResync] = handleTimeResync
	handlerRegistry[tools.CmdTimeSetTimezone] = handleTimeSetTimezone
	handlerRegistry[tools.CmdTimeApplyPolicy] = handleTimeApplyPolicy
}

func handleTimeResync(h *Heartbeat, cmd Command) tools.CommandResult {
	return handleTimeCommand(h, cmd, tools.CmdTimeResync)
}

func handleTimeSetTimezone(h *Heartbeat, cmd Command) tools.CommandResult {
	return handleTimeCommand(h, cmd, tools.CmdTimeSetTimezone)
}

func handleTimeApplyPolicy(h *Heartbeat, cmd Command) tools.CommandResult {
	return handleTimeCommand(h, cmd, tools.CmdTimeApplyPolicy)
}

// handleTimeCommand runs one manual time command through timesync.Manager under a
// 60-second child of the time lifecycle context. The F.4 structured result is
// always set on CommandResult.Result, so it survives both the HTTP and the
// WebSocket leg even when Error is non-empty (which suppresses stdout reparsing).
func handleTimeCommand(h *Heartbeat, cmd Command, kind string) tools.CommandResult {
	start := time.Now()
	var data any
	var err error
	h.mu.Lock()
	r := h.timeSync
	stopped := r == nil || r.stopping
	h.mu.Unlock()
	if stopped {
		err = fmt.Errorf("time management unavailable on this agent")
	} else {
		ctx, cancel := context.WithTimeout(r.ctx, 60*time.Second)
		defer cancel()
		data, err = r.manager.Command(ctx, kind, cmd.Payload)
		if ctx.Err() != nil {
			// A timed-out command may have left the snapshot stale; let the worker refresh it.
			h.mu.Lock()
			h.wakeTimeSyncLocked()
			h.mu.Unlock()
		}
	}
	if data == nil {
		var message *string
		if err != nil {
			s := err.Error()
			message = &s
		}
		switch kind {
		case tools.CmdTimeResync:
			data = timesync.ResyncResult{ExitCode: 1, Error: message}
		case tools.CmdTimeSetTimezone:
			data = timesync.SetTimezoneResult{Error: message}
		case tools.CmdTimeApplyPolicy:
			data = timesync.ManagementReport{}
		}
	}
	result := tools.NewSuccessResult(data, time.Since(start).Milliseconds())
	result.Result = data // Preserve F.4 on BOTH HTTP and WebSocket error paths.
	if err != nil {
		result.Status = "failed"
		result.ExitCode = 1
		result.Error = err.Error()
	}
	if resync, ok := data.(timesync.ResyncResult); ok {
		result.ExitCode = resync.ExitCode
		if err != nil && result.ExitCode == 0 {
			result.ExitCode = 1
		}
	}
	return result
}
