package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// userExecIPCGrace is added to the caller's timeout when waiting on the helper
// so the HELPER's own kill timer fires first and we get a real error message
// back instead of a bare IPC timeout.
const userExecIPCGrace = 15 * time.Second

// userSessionProvider is the slice of the session broker this bridge needs.
// Narrowing it keeps the transport unit-testable without standing up a broker.
type userSessionProvider interface {
	PreferredRunAsUserSession() *sessionbroker.Session
}

// commandSender is the slice of sessionbroker.Session the bridge uses.
type commandSender interface {
	SendCommand(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error)
}

// makeUserExecFunc returns a patching.UserExecFunc that runs a command inside
// the interactive user's session via the user-helper IPC transport
// (broker -> Session.SendCommand -> helper executeProcess, "exec" type,
// run_as_user scope). It is how the winget user-scope pass sees per-user
// installs that SYSTEM cannot (#2727).
//
// Every failure path returns an error: no broker, no connected helper, IPC
// failure, undecodable result, or a helper-reported failure. Callers treat any
// error as "the user-context pass did not run" and fall back to machine scope.
func (h *Heartbeat) makeUserExecFunc() patching.UserExecFunc {
	if h.sessionBroker == nil {
		return nil
	}
	return newUserExecFunc(h.sessionBroker)
}

func newUserExecFunc(broker userSessionProvider) patching.UserExecFunc {
	return func(name string, args []string, timeout time.Duration) (string, string, int, error) {
		if broker == nil {
			return "", "", -1, fmt.Errorf("no session broker available")
		}
		session := broker.PreferredRunAsUserSession()
		if session == nil {
			// The common, expected case: nobody is logged in, or the console
			// user's helper hasn't connected. Not an agent fault.
			return "", "", -1, fmt.Errorf("no user helper session connected")
		}
		return sendUserExec(session, name, args, timeout)
	}
}

func sendUserExec(session commandSender, name string, args []string, timeout time.Duration) (string, string, int, error) {
	// timeoutSeconds makes the HELPER enforce the deadline too: without it the
	// helper defaults to 300s, so a hung winget would outlive our own wait and
	// leave an orphan process running in the user's session.
	payloadBytes, err := json.Marshal(map[string]any{
		"type":           "exec",
		"command":        name,
		"args":           args,
		"timeoutSeconds": int(timeout.Seconds()),
	})
	if err != nil {
		return "", "", -1, fmt.Errorf("marshal exec payload: %w", err)
	}

	cmdID := fmt.Sprintf("userexec-%d", time.Now().UnixNano())
	resp, err := session.SendCommand(cmdID, ipc.TypeCommand, ipc.IPCCommand{
		CommandID: cmdID,
		Type:      "exec",
		Payload:   payloadBytes,
	}, timeout+userExecIPCGrace)
	if err != nil {
		return "", "", -1, fmt.Errorf("user helper exec: %w", err)
	}
	if resp == nil {
		return "", "", -1, fmt.Errorf("user helper session closed during exec")
	}

	var result ipc.IPCCommandResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return "", "", -1, fmt.Errorf("unmarshal exec result: %w", err)
	}

	stdout, stderr, exitCode := decodeUserExecResult(result.Result)
	if result.Status == "failed" && result.Error != "" {
		// The helper reports a non-zero exit as status "failed" WITH a decoded
		// result, and a genuine transport/spawn failure as "failed" with an
		// Error and no result. Only the latter is an error here: a non-zero
		// winget exit is data the caller interprets (winget exits non-zero for
		// several benign outcomes).
		return stdout, stderr, exitCode, fmt.Errorf("user helper exec failed: %s", result.Error)
	}
	return stdout, stderr, exitCode, nil
}

// decodeUserExecResult pulls stdout/stderr/exitCode out of the helper's
// executeProcess result object. A missing or malformed field yields the zero
// value rather than an error — the caller's own exit-code/parse checks decide
// whether the run was usable.
func decodeUserExecResult(raw json.RawMessage) (string, string, int) {
	if len(raw) == 0 {
		return "", "", 0
	}
	var nested map[string]any
	if err := json.Unmarshal(raw, &nested); err != nil {
		return "", "", 0
	}

	var stdout, stderr string
	var exitCode int
	if s, ok := nested["stdout"].(string); ok {
		stdout = executor.SanitizeOutput(s)
	}
	if s, ok := nested["stderr"].(string); ok {
		stderr = executor.SanitizeOutput(s)
	}
	if c, ok := nested["exitCode"].(float64); ok {
		exitCode = int(c)
	}
	return stdout, stderr, exitCode
}
