package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	rollbackstate "github.com/breeze-rmm/agent/internal/rollback"
)

func decodeRollbackDirective(payload map[string]any) (rollbackstate.Directive, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return rollbackstate.Directive{}, fmt.Errorf("encode rollback directive: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var directive rollbackstate.Directive
	if err := decoder.Decode(&directive); err != nil {
		return rollbackstate.Directive{}, fmt.Errorf("invalid rollback directive: %w", err)
	}
	return directive, nil
}

func handleAgentRollback(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h == nil || h.rollbackController == nil {
		return tools.NewErrorResult(fmt.Errorf("rollback executor unavailable"), time.Since(start).Milliseconds())
	}
	directive, err := decodeRollbackDirective(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := h.rollbackController.Execute(context.Background(), directive); err != nil {
		// Directive artifact URLs may contain bearer capabilities. The durable
		// engine records a bounded failure code; command results stay generic so
		// a wrapped net/http error cannot echo the URL into API logs.
		return tools.NewErrorResult(fmt.Errorf("rollback execution rejected or failed"), time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{"rollbackId": directive.RollbackID, "accepted": true}, time.Since(start).Milliseconds())
}
