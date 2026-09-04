package executor

import (
	"fmt"
	"sort"
	"strings"
)

// ParametersFromPayload decodes a script command payload's "parameters" field
// into the string-only map ScriptExecution.Parameters expects.
//
// ONE decoder, deliberately, for the two places that build a ScriptExecution
// from a server-supplied payload:
//
//   - heartbeat.handleScriptInner — the SYSTEM-context local executor, and
//   - userhelper.Client.executeScript — the runAs=user hop, where the daemon
//     re-marshals the raw payload over IPC and the helper process rebuilds the
//     ScriptExecution on the other side.
//
// Those two drifted once already (#4882): only the daemon decoded parameters,
// so every user-context script reached the shell with no BREEZE_PARAM_* and
// with its {{name}} placeholders unexpanded, while the byte-identical script
// in SYSTEM context ran fine. A parameterised script therefore failed with the
// script's own "parameter is required" error and nothing in the agent logs
// pointed at the cause. Sharing the decode is what makes that divergence
// impossible to reintroduce by editing one site.
//
// Non-string values are dropped rather than coerced: the server only ever
// sends strings (script_executions.parameters is a string map), and
// stringifying a JSON number here would make the helper produce a value the
// SYSTEM path never would — reintroducing drift in the opposite direction.
//
// Returns nil when the payload has no "parameters" object at all. nil and an
// empty map behave identically downstream (SubstituteParameters returns the
// content untouched; buildEnvironment appends nothing), so callers may assign
// the result unconditionally.
//
// SecretEnv is deliberately NOT handled here. Secrets are parsed and validated
// by ParseSecretEnv on the daemon only, and runAsSupportsSecrets refuses a
// secret-bearing runAs=user run outright (#3409) — the helper must never gain a
// second delivery route for BREEZE_VAR_*.
func ParametersFromPayload(raw any) map[string]string {
	params, ok := raw.(map[string]any)
	if !ok {
		// Absent is the ordinary case for an unparameterised script and says
		// nothing. Present-but-not-an-object means a producer broke the wire
		// contract, and the script is about to run with its placeholders
		// intact and no BREEZE_PARAM_* — exactly the invisible failure #4882
		// was. Log the type (never the content) so it is diagnosable from
		// agent logs instead of only from the script's own error message.
		if raw != nil {
			log.Warn("script command carried a non-object `parameters` field; running with no parameters",
				"payloadType", fmt.Sprintf("%T", raw))
		}
		return nil
	}
	decoded := make(map[string]string, len(params))
	var dropped []string
	for key, value := range params {
		if s, ok := value.(string); ok {
			decoded[key] = s
			continue
		}
		dropped = append(dropped, key)
	}
	if len(dropped) > 0 {
		// The server canonicalises every value to a string before dispatch
		// (canonicalizeScriptParameters), so reaching here means that
		// chokepoint was bypassed. Keys only — a value is operator-supplied
		// content that has no business in the agent log.
		sort.Strings(dropped)
		log.Warn("dropping non-string script parameter values",
			"keys", strings.Join(dropped, ","))
	}
	return decoded
}
