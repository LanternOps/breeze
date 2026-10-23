package heartbeat

import (
	"errors"
	"strings"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

func init() {
	handlerRegistry[tools.CmdSoftwareInstall] = handleSoftwareInstall
}

// Seams (vars, not direct calls) solely so tests can prove handleSoftwareInstall
// wires this command's id through to the WebSocket and the script executor
// without running a real install or completing a real capability handshake.
var (
	installSoftwareWithOptions = tools.InstallSoftwareWithOptions
	sendCommandProgress        = func(c *websocket.Client, commandID, stage string) error {
		return c.SendCommandProgress(commandID, stage)
	}
)

func handleSoftwareInstall(h *Heartbeat, cmd Command) tools.CommandResult {
	var ex *executor.Executor
	if h != nil {
		ex = h.executor
	}
	return installSoftwareWithOptions(cmd.Payload, h.commandProgressReporter(cmd.ID), tools.InstallOptions{
		CommandID: cmd.ID,
		RunScript: installScriptRunner(ex),
	})
}

// executorTimeoutPrefix is how executor.Execute reports a run it killed at its
// deadline (ExitCode -1, nil error). Pinned against the real executor in
// TestInstallScriptRunner_RealExecutorTimeout.
const executorTimeoutPrefix = "execution timed out after "

// installScriptRunner adapts the script executor to tools.InstallScriptRunner
// (tools cannot import executor: executor → privilege → tools). A nil
// executor yields a nil runner, which fails a scripted install with
// install_script_runner_unavailable rather than skipping its script.
//
// The execution runs with no RunAs (the agent service principal), and with
// the executor's own parameter rendering, content validation, output caps and
// process-tree kill on timeout, all unchanged.
func installScriptRunner(ex *executor.Executor) tools.InstallScriptRunner {
	if ex == nil {
		return nil
	}
	return func(req tools.InstallScriptRequest) (*tools.InstallScriptResult, error) {
		res, err := ex.Execute(executor.ScriptExecution{
			ID:         req.ID,
			ScriptID:   req.ID,
			ScriptType: req.ScriptType,
			Script:     req.Script,
			Parameters: req.Parameters,
			Timeout:    req.TimeoutSeconds,
		})
		if res == nil {
			return nil, err
		}
		return &tools.InstallScriptResult{
			ExitCode:  res.ExitCode,
			Stdout:    res.Stdout,
			Stderr:    res.Stderr,
			Error:     res.Error,
			TimedOut:  err == nil && strings.HasPrefix(res.Error, executorTimeoutPrefix),
			Truncated: len(res.TruncatedFields) > 0,
		}, err
	}
}

// commandProgressReporter returns a reporter that forwards in-flight stages for
// commandID to the server over the WebSocket (#3578), or nil when there is no
// WebSocket client (a nil reporter reports nothing). Whether the connected
// server understands the frame is decided per send by the client's capability
// check, so a reconnect to a different server version is handled.
func (h *Heartbeat) commandProgressReporter(commandID string) tools.ProgressReporter {
	if h == nil || h.wsClient == nil || commandID == "" {
		return nil
	}
	client := h.wsClient
	return newCommandProgressReporter(commandID, func(id, stage string) error {
		return sendCommandProgress(client, id, stage)
	})
}

func newCommandProgressReporter(commandID string, send func(commandID, stage string) error) tools.ProgressReporter {
	return func(stage string) {
		// Advisory: a lost stage costs the UI a label, never the install.
		if err := send(commandID, stage); err != nil && !errors.Is(err, websocket.ErrServerLacksCapability) {
			log.Debug("command progress not sent",
				logging.KeyCommandID, commandID,
				"stage", stage,
				"error", err.Error())
		}
	}
}
