package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/networkdiagnostic"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/google/uuid"
)

type activeTopologyDiagnostic struct {
	runID, attemptID string
	cancel           context.CancelFunc
}

func init() {
	handlerRegistry[tools.CmdNetworkDiagnostic] = handleTopologyDiagnostic
	handlerRegistry[tools.CmdNetworkDiagnosticCancel] = handleTopologyDiagnosticCancel
}
func (h *Heartbeat) topologyJournal() (*networkdiagnostic.Journal, error) {
	// Caller holds topologyDiagnosticMu, so both transport handlers share exactly
	// one journal and one in-flight registry rather than reopening live intents.
	if h.topologyDiagnosticJournal == nil {
		journal, e := networkdiagnostic.OpenJournal(filepath.Join(config.GetDataDir(), "topology-diagnostic-journal.json"))
		if e != nil {
			return nil, e
		}
		h.topologyDiagnosticJournal = journal
	}
	if h.topologyDiagnosticActive == nil {
		h.topologyDiagnosticActive = map[string]activeTopologyDiagnostic{}
	}
	return h.topologyDiagnosticJournal, nil
}
func handleTopologyDiagnostic(h *Heartbeat, cmd Command) tools.CommandResult {
	started := time.Now()
	raw, e := json.Marshal(cmd.Payload)
	if e != nil {
		return tools.NewErrorResult(e, 0)
	}
	command, e := networkdiagnostic.DecodeCommand(raw)
	if e != nil {
		return tools.NewErrorResult(e, 0)
	}
	if command.CommandID != cmd.ID || command.Type != cmd.Type {
		return tools.NewErrorResult(errors.New("diagnostic command identity mismatch"), 0)
	}
	h.networkContextMu.Lock()
	manager := h.networkContext
	h.networkContextMu.Unlock()
	if manager == nil {
		return tools.NewErrorResult(errors.New("topology capability unavailable"), 0)
	}
	manager.mu.Lock()
	enabled := manager.enabled
	epoch := manager.config.ProducerEpoch
	reader := manager.reader
	manager.mu.Unlock()
	h.mu.Lock()
	agentID := ""
	if h.config != nil {
		agentID = h.config.AgentID
	}
	h.mu.Unlock()
	if !enabled || reader == nil || command.Plan.Origin.AgentID != agentID || command.Plan.Origin.ProducerEpoch != epoch {
		return tools.NewErrorResult(errors.New("topology origin no longer eligible"), 0)
	}
	h.topologyDiagnosticMu.Lock()
	journal, e := h.topologyJournal()
	if e != nil {
		h.topologyDiagnosticMu.Unlock()
		return tools.NewErrorResult(e, 0)
	}
	if _, exists := h.topologyDiagnosticActive[command.CommandID]; exists {
		h.topologyDiagnosticMu.Unlock()
		return tools.NewErrorResult(errors.New("diagnostic already running"), 0)
	}
	if len(h.topologyDiagnosticActive) >= 2 {
		h.topologyDiagnosticMu.Unlock()
		return tools.NewErrorResult(errors.New("diagnostic concurrency limit reached"), 0)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.topologyDiagnosticActive[command.CommandID] = activeTopologyDiagnostic{command.RunID, command.AttemptID, cancel}
	h.topologyDiagnosticMu.Unlock()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-h.stopChan:
			cancel()
		case <-done:
		}
	}()
	defer func() {
		cancel()
		h.topologyDiagnosticMu.Lock()
		delete(h.topologyDiagnosticActive, command.CommandID)
		h.topologyDiagnosticMu.Unlock()
	}()
	result := networkdiagnostic.Run(ctx, command, journal, &networkdiagnostic.NativeIO{Reader: reader, Origin: command.Plan.Origin})
	return tools.NewSuccessResult(result, time.Since(started).Milliseconds())
}
func handleTopologyDiagnosticCancel(h *Heartbeat, cmd Command) tools.CommandResult {
	started := time.Now()
	type cancelPayload struct {
		Version   int    `json:"version"`
		RunID     string `json:"runId"`
		AttemptID string `json:"attemptId"`
		CommandID string `json:"commandId"`
	}
	raw, e := json.Marshal(cmd.Payload)
	if e != nil {
		return tools.NewErrorResult(e, 0)
	}
	var payload cancelPayload
	if len(cmd.Payload) != 4 || json.Unmarshal(raw, &payload) != nil || payload.Version != 1 {
		return tools.NewErrorResult(errors.New("invalid diagnostic cancellation"), 0)
	}
	for _, id := range []string{payload.RunID, payload.AttemptID, payload.CommandID} {
		if _, e = uuid.Parse(id); e != nil {
			return tools.NewErrorResult(errors.New("invalid diagnostic cancellation identity"), 0)
		}
	}
	h.topologyDiagnosticMu.Lock()
	defer h.topologyDiagnosticMu.Unlock()
	journal, e := h.topologyJournal()
	if e != nil {
		return tools.NewErrorResult(e, 0)
	}
	if e = journal.Cancel(payload.CommandID, payload.RunID, payload.AttemptID); e != nil {
		return tools.NewErrorResult(e, 0)
	}
	if active, ok := h.topologyDiagnosticActive[payload.CommandID]; ok && active.runID == payload.RunID && active.attemptID == payload.AttemptID {
		active.cancel()
	}
	return tools.NewSuccessResult(map[string]any{"runId": payload.RunID, "attemptId": payload.AttemptID, "commandId": payload.CommandID, "stopRequested": true}, time.Since(started).Milliseconds())
}
