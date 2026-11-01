package heartbeat

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/wire"
)

func init() { handlerRegistry[tools.CmdReleaseContainment] = handleReleaseContainment }

func handleReleaseContainment(h *Heartbeat, cmd Command) tools.CommandResult {
	if h == nil || h.containment == nil {
		return invalidContainmentResult()
	}
	return containmentCommandResult(h.containment.manager.HandleRelease(context.Background(), cmd.Payload))
}

func invalidContainmentResult() tools.CommandResult {
	r := tools.NewErrorResult(errContainmentSpec, 0)
	r.ErrorCode = wire.ErrCodeIsolationInvalidSpec
	return r
}

func containmentCommandResult(out isolation.CommandOutcome) tools.CommandResult {
	r := tools.CommandResult{Status: out.Status, Error: out.Error, ErrorCode: out.ErrorCode}
	if out.Failed() {
		r.ExitCode = 1
	}
	if out.Result != nil {
		data, err := json.Marshal(out.Result)
		if err != nil || len(data) > 8000 {
			r = tools.NewErrorResult(errors.New("isolation result could not be encoded within the command limit"), 0)
			r.ErrorCode = wire.ErrCodeIsolationApplyError
			return r
		}
		r.Stdout = string(data)
	}
	return r
}
