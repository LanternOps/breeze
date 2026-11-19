package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates/observe"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// oem_observe (#11065, observe-first amendment §1.2): the read-only canary
// instrument. It is its own command and its own package, so nothing here can
// reach oem_update_run's deps, store, runner, marker, lock, takeover, flash
// guard or reboot code. It is journalled like any command (journalable is
// generic) and has no interrupted body: it keeps no durable record.

func init() {
	handlerRegistry[tools.CmdOemObserve] = handleOemObserve
}

// oemObserveTimeout bounds the whole observation. The Windows Update search
// checks its context only between results, so a search already inside COM
// runs to its own end; everything after it stops.
const oemObserveTimeout = 5 * time.Minute

// Seams, so the handler tests on any OS. oemGOOS and oemElevated are shared
// with handlers_oem.go.
var (
	oemObserveCollect = observe.Collect
	oemObserveHost    = observe.SystemHost
)

// handleOemObserve parses strictly, refuses off Windows or unelevated, and puts
// the observation on stdout as JSON. A refusal is a failed result whose Error
// is a bare code (invalid_payload, os_not_supported, not_elevated,
// result_invalid) with no stdout: the result schema has no refusal shape.
func handleOemObserve(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	refuse := func(code string) tools.CommandResult {
		return tools.NewErrorResult(errors.New(code), time.Since(start).Milliseconds())
	}
	raw, err := json.Marshal(cmd.Payload)
	if err != nil {
		return refuse("invalid_payload")
	}
	req, err := observe.ParseRequest(raw)
	if err != nil {
		log.Debug("oem_observe payload refused", "commandId", cmd.ID)
		return refuse("invalid_payload")
	}
	if oemGOOS != "windows" {
		log.Debug("oem_observe on a non-Windows agent", "goos", oemGOOS)
		return refuse("os_not_supported")
	}
	if !oemElevated() {
		log.Warn("oem_observe refused: agent is not elevated", "commandId", cmd.ID)
		return refuse("not_elevated")
	}

	parent, cancel := h.oemRunContext()
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(parent, oemObserveTimeout)
	defer cancelTimeout()

	version := ""
	if h != nil {
		version = h.agentVersion
	}
	result := oemObserveCollect(ctx, oemObserveHost(), req, version)
	if err := result.Validate(); err != nil {
		log.Warn("oem_observe result failed the contract; not sent", "commandId", cmd.ID)
		return refuse("result_invalid")
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}
