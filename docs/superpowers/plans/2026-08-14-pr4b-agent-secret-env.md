# Tenant Variables #3409 — PR4b Implementation Plan (agent-side secret env delivery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Go agent to accept an encrypted-in-transit `secretEnv` map on a `script` command, inject it as `BREEZE_VAR_*` process environment (never into the script text on disk), refuse every execution path that cannot carry it, redact the exact secret values out of stdout/stderr/**error** on every exit path, and advertise the `scriptSecretEnvVersion: 1` capability so the server can gate on it.

**Nothing activates in this PR.** The server still never populates `secretEnv` (PR4c does that), so every new agent path is unreachable in production until PR4c ships and an operator saves a secret variable. This PR is the fleet-side half of the handshake and must be deployed and rolled out *before* PR4c.

**Prior context:** `docs/superpowers/plans/2026-08-14-pr4-secret-delivery-handoff.md` §3 (settled design) and §4.3 (agent seams). PR4a (server machinery, inert) is PR #3557.

**Tech Stack:** Go 1.25 (agent module), stdlib `testing` only — **no testify anywhere in `agent/`**.

---

## Global Constraints

- **Branch:** `ToddHebebrand/tenant-variables-pr4b`, based on `origin/main` (NOT on the PR4a branch — this PR touches no TypeScript, so it must get full CI rather than the stacked-branch no-CI trap).
- **Worktree:** `/Users/toddhebebrand/orca/workspaces/breeze/tenant-variables-pr4b`.
- **Redaction marker is exactly `[REDACTED]`** — never a marker naming the variable key. Naming the key confirms *which* credential leaked to an audience (`scripts:read`) wider than the script's author.
- **Fail loudly, never silently.** Any malformed, oversized, short, non-string, or duplicate-after-uppercasing secret entry **fails the command without running the script**. An agent that runs a script with the credential env var unset can mean anonymous access, auth fallback, lockouts, or destructive operations against the wrong target.
- **A secret value must never appear in an error message, a log line, or a script file on disk.** Error text names the *key*, never the value.
- **Secrets never reach `SubstituteParameters` or `validateScript`.** The substituted script is written to a temp file (`agent/internal/executor/shell.go:118-127`, 0700 on Unix / 0600 on Windows) — putting a secret through substitution lands it on the customer's filesystem, which is the entire reason env delivery exists.
- **Constants must match the server.** `MinSecretValueLength = 4` mirrors `MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH` (`packages/shared/src/validators/tenantVariables.ts`); `MaxSecretEnvEntries = 32` mirrors `MAX_SECRET_ENV_ENTRIES` (`apps/api/src/services/scriptSecretEnvelope.ts`). No cross-language drift guard is possible — carry the cross-reference in a comment at each constant.
- **Key grammar is `^[A-Za-z_][A-Za-z0-9_]*$`**, matching `TENANT_VARIABLE_KEY_PATTERN`. Anything else is rejected so a malformed key cannot inject a second env entry.
- **Test commands:** `cd agent && go test ./internal/executor/... ./internal/heartbeat/...` for a slice; before opening the PR, `cd agent && go build ./... && go vet ./... && gofmt -l . && CGO_ENABLED=0 go test ./... && go test -race ./internal/executor ./internal/heartbeat`.
- **Mutation-verify every guard.** For each new guard: force it off (invert the condition / return a constant), confirm the new tests fail *and nothing else does*, restore.
- **Do not touch the user-helper binary.** Secrets are blocked from the helper path in v1; fixing the helper needs a separately-versioned binary rollout (`HelperVersion`, `agent/internal/heartbeat/heartbeat.go:99`) and is explicitly out of scope.

---

## Verified seams (do not re-derive — these were checked against this branch)

| What | Where |
|---|---|
| `executor.ScriptExecution` struct | `agent/internal/executor/executor.go:34-42` |
| `buildEnvironment` (incl. `BREEZE_PARAM_` loop) | `agent/internal/executor/executor.go:328-345`; applied at `:182` via `procoutput.ApplyEnv` |
| `SubstituteParameters` call | `agent/internal/executor/executor.go:120` |
| `validateScript` call | `agent/internal/executor/executor.go:123` |
| Script written to temp file | `agent/internal/executor/shell.go:102-130`, called from `executor.go:132` |
| `SanitizeOutput` (pattern-based, cannot see values) | `agent/internal/executor/security.go:199-242` |
| `handleScript` — the ONLY entry point | `agent/internal/heartbeat/handlers_script.go:26` |
| Payload decode (map-based; wire keys `scriptId`/`language`/`content`/`timeoutSeconds`/`runAs`/`parameters`) | `handlers_script.go:26-44` |
| runAs branching (5 branches, first match wins) | `handlers_script.go:75-115` |
| Local result build — `Error` copied RAW at `:132` | `handlers_script.go:127-134` |
| Helper result build — `Error` copied RAW at `:276` | `handlers_script.go:273-296` |
| `executeViaUserHelper` / `executeScriptInSession` — called ONLY from within `handleScript` | `handlers_script.go:252`, `:361`, `:408`, `:427` |
| `tools.CommandResult` | `agent/internal/remote/tools/types.go:241-253`; `NewErrorResult` at `:280` |
| `SecurityCapabilities` struct | `agent/internal/heartbeat/heartbeat.go:177-179`; populated at `:3828`; JSON pinned by `heartbeat_test.go:239` |
| `secmem.SecureString` redaction precedent | `agent/internal/secmem/secmem.go:64-84` |
| No `DisallowUnknownFields` anywhere in `agent/` | old agents ignore `secretEnv` silently — which is exactly why the capability gate (PR4c) is mandatory |
| Nothing logs `cmd.Payload` in `internal/heartbeat` or `internal/websocket` | verified by grep; keep it that way |

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `agent/internal/executor/secretenv.go` | `SecretEnv` type with redacting `String`/`GoString`/`Format`/`MarshalJSON`; constants; `ParseSecretEnv` (validate + fail-closed). |
| `agent/internal/executor/secretenv_test.go` | Parse/validation/redacting-representation tests. |
| `agent/internal/executor/secretredact.go` | `SecretRedactionMarker`, `BuildSecretRedactor(values) func(string) string`. |
| `agent/internal/executor/secretredact_test.go` | Overlap merge, dedupe, idempotence, literal-not-pattern, large-input tests. |
| `agent/internal/heartbeat/handlers_script_secret_test.go` | Decode failure modes, runAs blocking, env injection, every-exit-path redaction. |

**Modify**

| File | Change |
|---|---|
| `agent/internal/executor/executor.go` | `ScriptExecution.SecretEnv SecretEnv \`json:"-"\``; `buildEnvironment` emits `BREEZE_VAR_*`. |
| `agent/internal/heartbeat/handlers_script.go` | Decode + validate `secretEnv`; block non-local execution paths; redaction wrapper over every exit path; sanitize `Error`. |
| `agent/internal/heartbeat/heartbeat.go` | `SecurityCapabilities.ScriptSecretEnvVersion`, declared `1`. |
| `agent/internal/heartbeat/heartbeat_test.go` | Extend the pinned capability JSON assertion. |

---

### Task 1: `SecretEnv` type, constants, and fail-closed parsing

A dedicated type — not a bare `map[string]string` — so that a stray `%v`, `%+v`, `%#v`, or `json.Marshal` of a `ScriptExecution` can never emit a credential. This mirrors `secmem.SecureString` (`agent/internal/secmem/secmem.go:64-84`), which is the repo's established precedent.

**Files:**
- Create: `agent/internal/executor/secretenv.go`
- Create: `agent/internal/executor/secretenv_test.go`

**Interfaces produced:**
- `const MinSecretValueLength = 4`
- `const MaxSecretEnvEntries = 32`
- `const SecretEnvPayloadKey = "secretEnv"`
- `type SecretEnv map[string]string`
- `func (SecretEnv) String() string` / `GoString() string` / `Format(fmt.State, rune)` / `MarshalJSON() ([]byte, error)` — all redacting
- `func (SecretEnv) Values() []string`
- `func (SecretEnv) EnvKey(key string) string` → `"BREEZE_VAR_" + strings.ToUpper(key)`
- `func ParseSecretEnv(raw any) (SecretEnv, error)`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/executor/secretenv_test.go`. Pure stdlib `testing`, table-driven where the cases are homogeneous. Required cases:

*`ParseSecretEnv` accepts:*
- `nil` → empty `SecretEnv`, no error (the field is absent on every command today).
- `map[string]any{}` → empty `SecretEnv`, no error.
- `map[string]any{"api_token": "super-secret-value"}` → `SecretEnv{"api_token": "super-secret-value"}`.
- A key with a leading underscore (`_token`) and a key with digits after the first char (`token2`).

*`ParseSecretEnv` rejects (error, and the error message must NOT contain the value):*
- Not an object: `"nope"`, `[]any{"a"}`, `42`.
- Non-string value: `map[string]any{"api_token": 42}`.
- Value shorter than `MinSecretValueLength`: `map[string]any{"api_token": "ab"}` — error text must contain `api_token` and must not contain `ab` as a standalone leak (assert `!strings.Contains(err.Error(), "\"ab\"")` and that the message mentions the length floor).
- Empty value: `map[string]any{"api_token": ""}`.
- Key outside the grammar: `"BAD KEY"`, `"9lives"`, `"a-b"`, `""`.
- More than `MaxSecretEnvEntries` entries.
- **Two distinct keys that collide after uppercasing** — `map[string]any{"api_token": "value-one", "API_TOKEN": "value-two"}` — because both would produce `BREEZE_VAR_API_TOKEN` and the winner would depend on Go's randomized map iteration order. Error must name both keys.

*Redacting representation:* for `SecretEnv{"api_token": "super-secret-value"}`, assert that none of `fmt.Sprintf("%v", se)`, `%+v`, `%#v`, `%s`, `se.String()`, or `json.Marshal(se)` contains `super-secret-value`, and that each yields the `[REDACTED]` marker. Also assert the same holds for a `ScriptExecution` value carrying it once Task 2 lands — leave that assertion for Task 2's test file, not here.

*`Values()`:* returns each value exactly once; length matches the map.

*`EnvKey`:* `EnvKey("api_token") == "BREEZE_VAR_API_TOKEN"`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test ./internal/executor -run Secret
```
Expected: FAIL — `secretenv.go` does not exist.

- [ ] **Step 3: Implement `agent/internal/executor/secretenv.go`**

```go
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

// secretKeyPattern mirrors TENANT_VARIABLE_KEY_PATTERN on the server. Enforced
// agent-side too so a malformed key cannot inject a second environment entry
// (a key containing "=" or a newline would otherwise split the env block).
var secretKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

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

	seenEnvKeys := make(map[string]string, len(m))
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
		envKey := out.EnvKey(key)
		if prior, dup := seenEnvKeys[envKey]; dup {
			// Two keys differing only in case would both become the same
			// BREEZE_VAR_* entry, and which one won would depend on map
			// iteration order. Refuse rather than run a coin flip.
			return nil, fmt.Errorf(
				"secretEnv keys %q and %q both map to %s", prior, key, envKey,
			)
		}
		seenEnvKeys[envKey] = key
		out[key] = value
	}
	return out, nil
}
```

Note: `MaxScriptSize` already caps total payload size (`shell.go:15`), so no separate per-value length ceiling is needed agent-side — the server enforces `MAX_TENANT_VARIABLE_VALUE_LENGTH` at seal time.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd agent && go test ./internal/executor -run Secret -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/secretenv.go agent/internal/executor/secretenv_test.go
git commit -m "feat(agent): fail-closed SecretEnv type for script secret delivery (#3409 PR4b)"
```

---

### Task 2: Exact-value output redactor

`executor.SanitizeOutput` (`security.go:199-242`) is **pattern-based**: it fires only when a credential sits next to a recognized key name or matches a known shape. A script that echoes a bare secret on its own line survives it entirely. This task adds the value-based layer. It is a pure function with no I/O and mirrors the server's `apps/api/src/services/exactSecretRedaction.ts` (PR4a) so both ends produce identical text.

**Files:**
- Create: `agent/internal/executor/secretredact.go`
- Create: `agent/internal/executor/secretredact_test.go`

**Interfaces produced:**
- `const SecretRedactionMarker = "[REDACTED]"`
- `func BuildSecretRedactor(values []string) func(string) string`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/executor/secretredact_test.go` with these cases:

- Replaces every occurrence: `BuildSecretRedactor([]string{"hunter2000"})("token=hunter2000 and again hunter2000")` → `"token=[REDACTED] and again [REDACTED]"`.
- Never names the variable: redacting the whole string yields exactly `[REDACTED]`.
- **Literals, not patterns:** `BuildSecretRedactor([]string{"a.c*d"})("abcd a.c*d")` → `"abcd [REDACTED]"` (proves no regex compilation of the value).
- **Merges overlapping matches into ONE marker:** `BuildSecretRedactor([]string{"abcabc", "bcab"})("xxabcabcxx")` → `"xx[REDACTED]xx"`. A naive longest-first pass would rescan its own marker and emit nested markers.
- Does not rescan its own marker: `BuildSecretRedactor([]string{"secret", "REDACTED"})("secret")` → exactly `"[REDACTED]"`.
- Idempotent: redacting the output again is a no-op.
- Dedupes identical values.
- Ignores empty and sub-`MinSecretValueLength` values rather than shredding output: `BuildSecretRedactor([]string{"", "ab"})("ab and an empty  gap")` returns the input unchanged.
- Passthrough when there is nothing to redact (`nil` and `[]string{}`), and the returned function must be non-nil in both cases.
- Handles a large output without quadratic blowup: 1 MB of filler around one match completes well under a second and contains the marker. Use `testing.Short()`-independent plain assertions; do **not** assert on wall-clock time (CI machines are contended) — assert only correctness, and keep the input at 1 MB so a quadratic implementation would visibly hang the suite.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test ./internal/executor -run Redact
```
Expected: FAIL — `secretredact.go` does not exist.

- [ ] **Step 3: Implement `agent/internal/executor/secretredact.go`**

Algorithm — **collect all match ranges of all values against the ORIGINAL text, merge overlapping/adjacent ranges, then rebuild the string in one pass.** Do not use `strings.ReplaceAll` per value: sequential replacement rescans text that already contains the marker, producing nested markers and non-idempotent output.

```go
package executor

import (
	"sort"
	"strings"
)

// SecretRedactionMarker is deliberately generic. A marker naming the variable
// key would CONFIRM which credential the script emitted, to an audience
// (`scripts:read` on the server) wider than the script's author — the leak this
// exists to prevent, minus the characters.
const SecretRedactionMarker = "[REDACTED]"

// BuildSecretRedactor returns a function that removes every literal occurrence
// of the supplied secret values from a text.
//
// Honest scope: this is ACCIDENTAL-LEAK protection, not DLP. It removes a
// credential a script echoed, logged, or included in an error message. It
// cannot catch a value the script transformed, base64-encoded, hashed,
// reversed, or printed one character per line. Treat it as a safety net over
// careless output, never as a control against a hostile script author — who
// holds the credential by definition.
//
// Mirrors apps/api/src/services/exactSecretRedaction.ts so the agent and the
// server produce identical redacted text for the same input.
func BuildSecretRedactor(values []string) func(string) string { ... }
```

Implementation requirements:
- Filter out values shorter than `MinSecretValueLength` (this includes the empty string) and dedupe with a `map[string]struct{}`.
- If nothing survives filtering, return `func(s string) string { return s }` (never `nil`).
- For each surviving value, walk the original text with `strings.Index` on successive slices, recording `[start, end)` ranges; advance by the match length so a value never matches inside itself.
- Sort ranges by start, then merge any range whose start is `<= ` the current end (overlapping **or** adjacent).
- Rebuild with a `strings.Builder` sized `len(text)`, emitting the marker once per merged range.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd agent && go test ./internal/executor -run Redact -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/secretredact.go agent/internal/executor/secretredact_test.go
git commit -m "feat(agent): exact-value output redactor with overlap merging (#3409 PR4b)"
```

---

### Task 3: Carry `SecretEnv` on `ScriptExecution` and inject `BREEZE_VAR_*`

**Files:**
- Modify: `agent/internal/executor/executor.go`
- Test: `agent/internal/executor/executor_test.go` (append; do not restructure the file)

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/executor/executor_test.go`:

- `buildEnvironment` with `SecretEnv{"api_token": "super-secret-value"}` produces an entry `BREEZE_VAR_API_TOKEN=super-secret-value`, and still produces the existing `BREEZE_EXECUTION_ID` / `BREEZE_SCRIPT_ID` / `BREEZE_PARAM_*` entries.
- A `ScriptExecution` with both a parameter and a secret produces both `BREEZE_PARAM_*` and `BREEZE_VAR_*` entries, and the two namespaces do not collide.
- **The secret env entry is appended AFTER `os.Environ()`**: seed `t.Setenv("BREEZE_VAR_API_TOKEN", "inherited-value")`, then assert the *last* matching entry in the returned slice carries the delivered value. (`os/exec` dedupes `Cmd.Env` keeping the last occurrence, so a hostile pre-existing environment cannot shadow a delivered secret.)
- Empty/nil `SecretEnv` adds no `BREEZE_VAR_` entries at all.
- **A `ScriptExecution` carrying a secret redacts under every fmt verb and under `json.Marshal`** — `%v`, `%+v`, `%#v`, and `json.Marshal` of the struct must not contain `super-secret-value`. This is the test that proves the `json:"-"` tag plus the redacting methods actually hold at the enclosing-struct level.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test ./internal/executor -run 'Environment|ScriptExecution'
```
Expected: FAIL — field does not exist.

- [ ] **Step 3: Implement**

In `agent/internal/executor/executor.go`, add to `ScriptExecution` (after `RunAs`, `:41`):

```go
	// #3409 PR4b — secret tenant variables, delivered as process environment
	// rather than substituted into the script text. `json:"-"` because this
	// struct must never carry a credential onto any wire or into any file;
	// SecretEnv's own String/Format/MarshalJSON redact as a second layer.
	// Populated only by heartbeat.handleScript, which validates it first.
	SecretEnv SecretEnv `json:"-"`
```

In `buildEnvironment` (`:328-345`), after the `BREEZE_PARAM_` loop and before `return env`:

```go
	// #3409 PR4b: secrets ride the environment, never the script text — the
	// substituted script is written to a temp file on the customer's disk.
	// Appended after os.Environ() on purpose: os/exec dedupes Cmd.Env keeping
	// the LAST occurrence, so a pre-existing BREEZE_VAR_* in the machine
	// environment cannot shadow a delivered secret.
	//
	// Keys were validated against the tenant-variable grammar by
	// ParseSecretEnv, so no character mapping is needed here (unlike the
	// parameter loop above, which has to fold "-" to "_").
	for key, value := range script.SecretEnv {
		env = append(env, script.SecretEnv.EnvKey(key)+"="+value)
	}
```

**Do not** touch `executor.go:120` (`SubstituteParameters`) or `:123` (`validateScript`) — secrets must not reach either.

- [ ] **Step 4: Run tests**

```bash
cd agent && go test ./internal/executor/...
```
Expected: PASS, existing tests unchanged.

**Mutation-verify:** temporarily move the `BREEZE_VAR_` loop *before* `os.Environ()` is appended — confirm only the shadowing test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/executor.go agent/internal/executor/executor_test.go
git commit -m "feat(agent): inject validated secrets as BREEZE_VAR_* environment (#3409 PR4b)"
```

---

### Task 4: Decode, gate, and redact in `handlers_script.go`

The single highest-risk task. Three separate invariants land here, and each must hold on **every** exit path of `handleScript`:

1. A malformed `secretEnv` fails the command **before** the script runs.
2. A command carrying secrets never reaches an execution path that would drop them (user-helper / session-targeted), because such a run would execute with the credential unset.
3. Every returned `Stdout`, `Stderr` **and `Error`** has the exact secret values removed — `Error` is currently copied raw at both `:132` (local) and `:276` (helper).

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go`
- Create: `agent/internal/heartbeat/handlers_script_secret_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/heartbeat/handlers_script_secret_test.go`. Reuse the existing fakes in `agent/internal/heartbeat/test_helpers_test.go` and the patterns in `handlers_script_test.go` / `heartbeat_userhelper_test.go` — **do not invent a new harness.** Required cases:

*Decode / fail-closed (script must NOT run):*
- Payload with `secretEnv` that is not an object → `Status: "failed"`, non-zero `ExitCode`, `Error` mentions `secretEnv`, and the executor was never invoked.
- Payload with a 2-character secret value → failed, `Error` names the key and the length floor, never the value.
- Payload with a non-string secret value → failed.
- Payload with an invalid key (`"BAD KEY"`) → failed.
- Payload with two case-colliding keys → failed.
- Payload with **no** `secretEnv` key → behaves exactly as today (this is the regression guard proving the PR is inert for existing traffic).

*runAs gating:*
- `secretEnv` present + `runAs: "user"` → failed, `Error` states that secret variables require system-context execution and that the agent will not run the script; the user-helper was never called.
- `secretEnv` present + `runAs: "<username>"` → failed the same way.
- `secretEnv` present + `targetSessionId >= 0` → failed the same way.
- `secretEnv` present + `runAs: ""` / `"system"` / `"elevated"` → runs locally, and the executor receives a populated `SecretEnv`.
- **No** `secretEnv` + `runAs: "user"` → unchanged behavior (helper path still used).

*Redaction on every exit path:*
- Executor returns stdout/stderr/error each containing the secret value → all three come back with `[REDACTED]` and none contains the value.
- Executor returns `(nil, err)` where the error text contains the secret (the `NewErrorResult` path at `:117`) → the returned `Error` is redacted.
- The helper path result (`executeViaUserHelper`) is redacted too.
- `Error` is additionally run through `SanitizeOutput`: an error carrying `AKIA` + 16 uppercase alphanumerics comes back with `[AWS_KEY_REDACTED]`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test ./internal/heartbeat -run Secret
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Read `handlers_script.go:26-135` and `:250-300` before editing.

**(a) Wrap every exit path.** Rename the existing `handleScript` body to `handleScriptInner(h *Heartbeat, cmd Command, secretEnv executor.SecretEnv) tools.CommandResult`, and introduce a new `handleScript` that owns the invariant:

```go
// handleScript is a thin wrapper that owns two invariants for EVERY exit path
// of script execution — including early failures, the user-helper path, and
// panicking-free error returns:
//
//  1. a malformed `secretEnv` fails the command before any script runs, and
//  2. the delivered secret values are stripped from stdout, stderr AND error.
//
// `Error` in particular was copied raw out of the executor and out of the
// helper IPC result, so a credential echoed into an error message reached the
// server unredacted. Keeping the redaction here — rather than at the eight
// executor sites that assign result.Error — means a new failure path cannot
// silently opt out. Mirrors the server's own chokepoint invariant
// (redactAgentResultErrorFields as the first statement of processCommandResult,
// apps/api/src/routes/agentWs.ts).
func handleScript(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	secretEnv, err := executor.ParseSecretEnv(cmd.Payload[executor.SecretEnvPayloadKey])
	if err != nil {
		// Fail closed: never run a script whose secret map we could not
		// validate. ParseSecretEnv error text names keys, never values.
		return tools.CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Error:      fmt.Sprintf("refusing to execute script: %v", err),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	res := handleScriptInner(h, cmd, secretEnv)
	if len(secretEnv) == 0 {
		return res
	}
	redact := executor.BuildSecretRedactor(secretEnv.Values())
	res.Stdout = redact(res.Stdout)
	res.Stderr = redact(res.Stderr)
	res.Error = redact(res.Error)
	return res
}
```

Confirm while editing that `executeViaUserHelper` and `executeScriptInSession` are reachable **only** from `handleScriptInner` — they are today (`:76`, `:82`, `:408`, `:427`, all inside that call tree). If a new caller appears, the wrapper invariant breaks; state this in the report.

**(b) Populate the struct.** In `handleScriptInner`, after the `parameters` block (`:37-44`), set `script.SecretEnv = secretEnv`.

**(c) Gate the non-local paths.** Immediately before the branch at `:75` (the `targetSessionID` branch), add:

```go
	// #3409 PR4b: secrets are delivered as process environment to the LOCAL
	// executor only. The user-helper path forwards the raw payload over IPC and
	// the helper never reads parameters or env (userhelper/client.go
	// executeScript), so a user-context run would execute with the credential
	// UNSET — anonymous access, an auth fallback, a lockout, or a destructive
	// operation against the wrong target. Refuse instead. Lifting this needs a
	// separately-versioned user-helper binary rollout (HelperVersion), which is
	// deliberately out of scope for v1.
	if len(script.SecretEnv) > 0 && !runAsSupportsSecrets(script.RunAs, targetSessionID) {
		return tools.CommandResult{
			Status:   "failed",
			ExitCode: 1,
			Error: "script uses secret variables, which require system-context execution; " +
				"this script is configured to run as a user and was not executed",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
```

with

```go
// runAsSupportsSecrets reports whether an execution with this runAs setting
// will reach the LOCAL executor, which is the only path that carries
// BREEZE_VAR_* environment. Mirrors resolveRunAsSession's contract: "", system
// and elevated never resolve a helper session. An explicit username is refused
// even though it currently falls through to local execution on an unresolved
// lookup — that fall-through is a best-effort downgrade, and downgrading a
// secret-bearing run is exactly what must not happen silently.
func runAsSupportsSecrets(runAs string, targetSessionID int) bool {
	if targetSessionID >= 0 {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(runAs)) {
	case "", "system", "elevated":
		return true
	default:
		return false
	}
}
```

Place the guard so it runs after `targetSessionID` is computed. Read the surrounding code to confirm where that value is derived and adjust placement accordingly; the guard must precede **both** helper branches.

**(d) Sanitize `Error`.** At the local result build (`:127-134`), change `Error: scriptResult.Error` to `Error: executor.SanitizeOutput(scriptResult.Error)`. At the helper result build (`:274-278`), change `Error: result.Error` to `Error: executor.SanitizeOutput(result.Error)`. Add a short comment at each noting that `Error` was previously the only unsanitized field.

Ordering note: exact-value redaction (the wrapper) runs **after** `SanitizeOutput`, which is fine — the marker `[REDACTED]` contains no characters the exact redactor matches, and the exact redactor works against whatever text survived. Keep the pattern-based layer; it catches credential shapes that were never delivered as tenant variables.

- [ ] **Step 4: Run tests**

```bash
cd agent && go test ./internal/heartbeat/... ./internal/executor/...
```
Expected: PASS, including every pre-existing script handler test unchanged.

**Mutation-verify, one at a time, restoring after each:**
1. Make `ParseSecretEnv` return `(SecretEnv{}, nil)` unconditionally → the decode-failure tests must fail and nothing else.
2. Make `runAsSupportsSecrets` return `true` unconditionally → the runAs-gating tests must fail and nothing else.
3. Drop the `res.Error = redact(res.Error)` line → the error-redaction tests must fail and nothing else.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_script.go agent/internal/heartbeat/handlers_script_secret_test.go
git commit -m "feat(agent): validate, gate and redact script secret variables (#3409 PR4b)

Decodes secretEnv fail-closed before any script runs, refuses user-context
execution paths that would drop the credential, and strips the exact secret
values from stdout, stderr AND error on every exit path. Error was previously
the only result field that reached the server unsanitized."
```

---

### Task 5: Advertise the `scriptSecretEnvVersion` capability

The server (PR4a) already stores `devices.script_secret_env_version` from `securityCapabilities.scriptSecretEnvVersion`, non-sticky so a downgrade is detected. PR4c gates dispatch on it at **enqueue and at claim**. This task makes the agent declare it.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

- [ ] **Step 1: Write the failing test**

Extend `TestHeartbeatPayloadSecurityCapabilitiesJSON` (`heartbeat_test.go:239`) — do not add a parallel test — so it asserts the marshalled payload contains `"scriptSecretEnvVersion":1` alongside the existing `outboundNetworkPolicyVersion`, and that the field is emitted **unconditionally** (no `omitempty`), so the server can distinguish "old agent, object absent" from "capable agent declaring 0".

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test ./internal/heartbeat -run SecurityCapabilities
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`heartbeat.go:177-179`:

```go
type SecurityCapabilities struct {
	OutboundNetworkPolicyVersion int `json:"outboundNetworkPolicyVersion"`
	// #3409 PR4b — this build decodes `secretEnv`, injects BREEZE_VAR_*, blocks
	// user-context runs that would drop the credential, and redacts the values
	// out of stdout/stderr/error. Declared unconditionally: the behavior is
	// compiled in, not a runtime toggle. The server writes this non-sticky on
	// every beat, so a DOWNGRADE to an older agent reports back down to 0 and
	// the PR4c dispatch gate stops trusting a stale claim.
	ScriptSecretEnvVersion int `json:"scriptSecretEnvVersion"`
}
```

`heartbeat.go:3828`:

```go
		SecurityCapabilities: SecurityCapabilities{
			OutboundNetworkPolicyVersion: 1,
			ScriptSecretEnvVersion:       1,
		},
```

- [ ] **Step 4: Run tests and commit**

```bash
cd agent && go test ./internal/heartbeat/...
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go
git commit -m "feat(agent): advertise scriptSecretEnvVersion 1 capability (#3409 PR4b)"
```

---

### Task 6: Whole-agent verification and PR

- [ ] **Step 1: Confirm no new leak surface**

Run and report the output of each:

```bash
cd agent
grep -rn "SecretEnv" internal/ --include='*.go' | grep -v '_test.go'
grep -rn "BREEZE_VAR_" internal/ --include='*.go' | grep -v '_test.go'
grep -rn "DisallowUnknownFields" .
```

Assert by inspection that: no `log.` call takes a `SecretEnv` or a secret value; `SecretEnv` appears on no struct that is marshalled to the wire, written to disk, or sent over IPC; and `SubstituteParameters` / `validateScript` / `WriteScriptFile` are not reachable with a secret value.

- [ ] **Step 2: Full agent build, vet, format and suite**

```bash
cd agent
go build ./...
go vet ./...
gofmt -l .            # must print nothing
CGO_ENABLED=0 go test ./...        # matches the CI `test-agent` job
go test -race ./internal/executor ./internal/heartbeat
```

Do not pipe these through `tail` — you lose progress and cannot tell slow from wedged.

- [ ] **Step 3: Rebase onto current main BEFORE opening the PR**

```bash
git fetch origin main && git rebase origin/main
cd agent && CGO_ENABLED=0 go test ./internal/executor ./internal/heartbeat
```

- [ ] **Step 4: Open the PR**

Title: `feat(agent): decode, gate and redact script secret variables (#3409 PR4b)`

Body must state: the feature is **inert** (the server never populates `secretEnv` until PR4c); this build must be **rolled out to the fleet before PR4c merges**; the `runAs: user` limitation and why lifting it needs a separate helper-binary rollout; and that exact-value redaction is accidental-leak protection, not DLP.

---

## Explicitly out of scope

| Item | Where it belongs |
|---|---|
| Unblocking secrets at script save/import and at dispatch | PR4c |
| Capability gate at enqueue and at claim | PR4c |
| Digest pinning of variable references + canonicalized parameter definitions | PR4c |
| User-helper support for secrets (needs a versioned helper-binary rollout) | Later, tracked separately |
| `TruncatedFields` not propagated from the executor into `tools.CommandResult` (`handlers_script.go:127-134`) — pre-existing, unrelated | Own issue |
| Docs / release notes for the feature | PR4c, when it becomes reachable |
