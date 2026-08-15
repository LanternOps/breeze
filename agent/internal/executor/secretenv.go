package executor

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// #3409 PR4b — agent-side secret variable delivery.
//
// A `script` command may carry a `secretEnv` map: tenant variables the operator
// marked secret, delivered to the agent encrypted in transit (the server seals
// them into one AAD-bound envelope and opens it only at delivery — see
// apps/api/src/services/scriptSecretEnvelope.ts) and injected here as process
// environment.
//
// Environment, deliberately, and NOT parameter substitution: the substituted
// script is written to a temp file on the customer's disk (shell.go
// WriteScriptFile), so a substituted secret becomes a file on their filesystem.
// SecretEnv values must therefore never reach SubstituteParameters or
// validateScript.
const (
	// SecretEnvPayloadKey is the wire field name on a `script` command payload.
	SecretEnvPayloadKey = "secretEnv"

	// MinSecretValueLength mirrors MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH in
	// packages/shared/src/validators/tenantVariables.ts. A secret shorter than
	// this cannot be exact-value-redacted from script output without shredding
	// the output itself (imagine redacting every "ab"), so rather than choose
	// between destroying the operator's output and leaking the credential, the
	// command is refused. The server rejects such a value at save time and at
	// seal time; this is the fail-closed backstop.
	MinSecretValueLength = 4

	// MaxSecretEnvEntries mirrors MAX_SECRET_ENV_ENTRIES in
	// apps/api/src/services/scriptSecretEnvelope.ts. Bounds the redactor's work
	// and the environment block.
	MaxSecretEnvEntries = 32

	// SecretEnvPrefix is the environment-variable namespace. A script reads a
	// secret as $BREEZE_VAR_API_TOKEN / $env:BREEZE_VAR_API_TOKEN.
	SecretEnvPrefix = "BREEZE_VAR_"
)

// secretKeyPattern is EXACTLY TENANT_VARIABLE_KEY_PATTERN from the server
// (packages/shared/src/validators/tenantVariables.ts), which the
// tenant_variables_key_chk DB constraint also enforces. Re-enforced agent-side
// so a malformed key cannot inject a second environment entry (a key containing
// "=" or a newline would otherwise split the env block), and deliberately not
// one character laxer than its only producer: anything outside this grammar is
// something the server should never have sent, so refusing it is fail-closed.
//
// The lowercase-only grammar is also what makes EnvKey's ToUpper folding
// injective: two distinct keys cannot collide on one BREEZE_VAR_* name. If this
// pattern is ever widened to admit uppercase, that stops being true and
// ParseSecretEnv must grow a collision check — otherwise which secret wins would
// depend on Go's randomized map iteration order.
var secretKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// SecretEnv holds the secret variable values for a single script execution.
//
// It is a distinct type rather than a bare map so that every representation Go
// can produce for it redacts: a stray log line, a %+v on the enclosing
// ScriptExecution, or an accidental json.Marshal can never emit a credential.
// Same defense secmem.SecureString provides for the enrollment token
// (agent/internal/secmem/secmem.go). Use Values() to reach the plaintext, which
// only the environment builder and the output redactor do.
type SecretEnv map[string]string

// String redacts. This is what fmt uses for %v, %s and %+v.
func (SecretEnv) String() string { return "[REDACTED]" }

// GoString redacts %#v, which does not consult Stringer.
func (SecretEnv) GoString() string { return "executor.SecretEnv{[REDACTED]}" }

// Format catches every remaining verb (%q, %x, ...) so no format string can
// coax the plaintext out.
func (s SecretEnv) Format(f fmt.State, verb rune) {
	switch verb {
	case 'v':
		if f.Flag('#') {
			_, _ = fmt.Fprint(f, s.GoString())
			return
		}
	}
	_, _ = fmt.Fprint(f, s.String())
}

// MarshalJSON redacts, so a SecretEnv can never be serialized back onto a wire
// or into a result frame.
func (SecretEnv) MarshalJSON() ([]byte, error) { return json.Marshal("[REDACTED]") }

// UnmarshalJSON always fails: the only supported way to build a SecretEnv is
// ParseSecretEnv, which validates. A silent json.Unmarshal would bypass every
// check in this file.
func (*SecretEnv) UnmarshalJSON([]byte) error {
	return fmt.Errorf("executor: SecretEnv must be built with ParseSecretEnv")
}

// Values returns each secret value once, for the output redactor.
func (s SecretEnv) Values() []string {
	out := make([]string, 0, len(s))
	for _, v := range s {
		out = append(out, v)
	}
	return out
}

// EnvKey maps a variable key to its environment variable name.
func (SecretEnv) EnvKey(key string) string {
	return SecretEnvPrefix + strings.ToUpper(key)
}

// ParseSecretEnv validates a raw `secretEnv` payload value.
//
// Fail-closed by design: EVERY malformed entry is an error, and the caller must
// refuse to run the script. Running with a credential env var unset is not a
// degraded success — it can mean anonymous access, an auth fallback, an account
// lockout, or a destructive operation against the wrong target.
//
// Errors name the offending KEY and never the value: these strings travel back
// to the server as result.Error and land in logs.
func ParseSecretEnv(raw any) (SecretEnv, error) {
	if raw == nil {
		return SecretEnv{}, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("secretEnv must be an object")
	}
	if len(m) > MaxSecretEnvEntries {
		return nil, fmt.Errorf("secretEnv has %d entries, maximum is %d", len(m), MaxSecretEnvEntries)
	}

	out := make(SecretEnv, len(m))
	// Sorted so the error reported for a multi-fault map is deterministic —
	// Go randomizes map iteration, and a test that asserts on error text would
	// otherwise flake.
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		if !secretKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("secretEnv key %q is not a valid variable key", key)
		}
		value, ok := m[key].(string)
		if !ok {
			return nil, fmt.Errorf("secretEnv value for %q is not a string", key)
		}
		if len(value) < MinSecretValueLength {
			return nil, fmt.Errorf(
				"secretEnv value for %q is shorter than %d characters and cannot be redacted from output",
				key, MinSecretValueLength,
			)
		}
		out[key] = value
	}
	return out, nil
}
