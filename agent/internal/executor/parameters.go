package executor

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
		return nil
	}
	decoded := make(map[string]string, len(params))
	for key, value := range params {
		if s, ok := value.(string); ok {
			decoded[key] = s
		}
	}
	return decoded
}
