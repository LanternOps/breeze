# Go Agent Hardening — Future Work

Items identified during the Phase 1-3 hardening PR review (Feb 2026) that were deferred as non-critical. Organized by category, roughly prioritized within each section.

---

## Heartbeat Refactoring

### Extract `executeCommand` switch into handler functions
`heartbeat.go:executeCommand` is a 670-line monolithic switch with ~40 command cases. Many cases contain 20-50 lines of inline payload parsing. Extracting each into a dedicated handler method would dramatically improve readability and testability.

### Centralize timing boilerplate
Nearly every switch case starts with `start := time.Now()` and ends with `time.Since(start).Milliseconds()`. Capture start time once before the switch and compute duration after.

### Add `requirePayloadString` helper
The "check for required field, build error result" pattern appears ~10 times. A helper like `requirePayloadString(payload, key) (string, *CommandResult)` would eliminate this boilerplate.

### Unify `map[string]interface{}` to `map[string]any`
Mixed usage throughout inventory/patch methods. Since Go 1.18+, `any` is idiomatic.

### Collapse duplicate patch-to-map conversion
`collectPatchInventory` and `collectPatchInventoryFromCollectors` have nearly identical struct-to-map conversion and error combination logic.

### Track inventory goroutines in shutdown
`sendInventory()` launches 7 fire-and-forget goroutines with no WaitGroup. During graceful shutdown, these may be mid-flight when `Stop()` is called. Add a WaitGroup and include them in drain logic.

---

## Audit Log Improvements

### Add rotation sentinel entry
When the audit log rotates, `prevHash` continues from the old file. The new file has no genesis marker, so per-file chain verification is impossible. Write a `log_rotated` entry as the first record in each new file, referencing the previous file's last hash.

### Add `fsync` for critical entries
`Log()` calls `file.Write()` but not `Sync()`. In a crash, buffered entries are lost. Consider periodic or per-entry fsync for tamper-evident integrity.

### Make `Log()` nil-receiver safe
Every call site in heartbeat.go must nil-check `h.auditLog`. Adding `if l == nil { return }` at the top of `Log()` and `Close()` would eliminate this burden.

### Track dropped entry count
When audit entries are dropped (marshal failure, write failure, rotation failure), increment a counter and expose it in the health summary so operators can detect audit degradation.

### Fail startup when audit is enabled but init fails
Currently the agent continues without audit logging when `AuditEnabled: true` but `NewLogger()` fails. Consider making this a fatal error, or at minimum marking health as Degraded.

---

## Security & SecureString

### Wire `SecureString` into actual usage or remove it
`secureToken` in main.go wraps `cfg.AuthToken` but the original string is still used everywhere via `cfg.AuthToken`. The `SecureString` copy is zeroed on shutdown but the original persists. Either:
- Clear `cfg.AuthToken` after wrapping and thread `SecureString` through to all callers
- Remove `secureToken` to avoid false security assurance

### Fix `fmt.Stringer` leak
`SecureString.String()` implements `fmt.Stringer`, so `fmt.Println(token)` prints plaintext. Rename to `Reveal()` or `PlainText()` and add `fmt.Formatter` / `MarshalJSON` / `MarshalText` implementations that return `[REDACTED]`.

### Add thread safety to SecureString
`Zero()` called concurrently with `String()` is a data race on the `data` slice. Add a mutex or document single-goroutine usage requirement.

---

## Health Monitor

### Treat unknown status as unhealthy (fail-safe)
`statusRank` returns 0 (Healthy) for unrecognized `Status` values. In a health monitoring system, unknown should be the worst case, not the best. Change default rank to 2+ (Unhealthy).

### Return "unknown" when no checks registered
`Overall()` returns Healthy when the checks map is empty (e.g., at startup before any component reports). Consider a distinct "unknown" or "starting" state.

### Make `Summary()` atomic
`Summary()` calls `Overall()` then `All()` sequentially, releasing and re-acquiring the lock between them. A status change in that window produces an inconsistent snapshot. Hold the lock across both operations.

### Add `Status.IsValid()` method
`health.Status("invalid")` compiles without error. An `IsValid() bool` method checking membership in the known set would allow `Update()` to reject bad values.

---

## Worker Pool

### Document `StopAccepting` → `Drain` ordering requirement
`Drain` can be called without `StopAccepting`, allowing new tasks during drain. Consider combining into `Shutdown(ctx)` that enforces correct ordering, or add a runtime check.

### Consider task-level context cancellation
On drain timeout, in-flight tasks continue running with no cancellation signal. Threading `context.Context` through task functions would allow cooperative cancellation.

---

## Config & Validation

### Use `slog` package logger consistently
`validate.go` uses `slog.Warn` directly while every other file uses a package-level `log = logging.L("component")` variable. Switch to the consistent pattern.

### Add fatal vs warning validation tiers
Some validation errors are cosmetic (unknown collector name) while others would cause runtime panics if not clamped (zero intervals). Make the distinction explicit in the code.

---

## Observability

### Send metrics unavailability indicator
When metrics collection fails, zero-value metrics are sent (CPU 0%, RAM 0%, Disk 0%). This looks like a healthy idle device. Either skip the heartbeat, set metrics to null, or add a `metricsUnavailable: true` flag.

### Add output truncation indicator
`executor.limitedWriter` silently truncates script output at 1MB with no indication. Add a note to `ScriptResult.Stderr` or a dedicated field: "output truncated at 1MB".

### Log file fallback visibility
When `LogFile` open fails, the warning goes to stderr which is lost when running as a service. Write the warning to the structured logger (now on stdout) so it appears in journalctl/Event Viewer.

### Update health monitor on logging/audit init failure
Neither logging nor audit initialization failures update the health monitor. These should set initial health check status.

---

## Code Consistency

### Migrate `math/rand` to `math/rand/v2`
`websocket/client.go` uses `math/rand` (v1) while `httputil/retry.go` and `heartbeat.go` use `math/rand/v2`. Standardize on v2 across the codebase.

### Make `ElevatedCommandTypes()` a package-level var
Currently allocates a new map on every call. Since the data is immutable, use a package-level variable. Also consider unexporting it since `RequiresElevation()` is the intended public API.

### Link command type constants across privilege and dispatch
Command type strings in `privilege/check.go` are string literals. If the same strings are defined as constants in `remote/tools/`, a typo in either location would create a silent security gap. Use shared constants.
