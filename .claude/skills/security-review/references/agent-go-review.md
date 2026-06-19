# Go Agent — Security Review Reference

The SKILL.md checklist is API/web-centric (the upstream prompts it derives from are Python/web).
The Go agent is our **highest-value attack surface** (RMM compromise → code exec as SYSTEM across
the fleet), so it gets a dedicated class block. Run this as a Pass-1 specialist agent
(see [methodology.md](methodology.md)).

## Specialist prompt

> You are the AGENT/GO specialist. Audit the Go agent (`agent/internal/...`, `agent/main.go`) for
> the classes below. Use Grep/Glob/Read; trace data flow end-to-end. Report file:line + source →
> sink → exact path + concrete exploit scenario + confidence (>=7 only).

## Class checklist

### Update / signed-manifest channel (PRIORITY — fleet-wide RCE as SYSTEM)
- [ ] Manifest signature verified against the **embedded** trust root before *any* artifact is used
      (`internal/updater/`, manifest pubkey). No path skips verification.
- [ ] Downgrade/replay: a previously-valid signed manifest can't be replayed to install an older,
      vulnerable build (version monotonicity / nonce / timestamp checked).
- [ ] Download URL is constrained to the expected server origin — `downloadFromURL` rejects
      github.com / arbitrary URLs (this was the #646 bug class). Attacker-influenced `download_url`
      must not cause a fetch from an arbitrary host.
- [ ] TOFU pin can't be silently reset/rotated by an attacker who reaches the API host.
- [ ] Staged binary integrity (checksum) verified before swap; fsync before rename.

### IPC / Helper privilege boundary (SYSTEM vs user role)
- [ ] Named-pipe broker enforces identity gating: SYSTEM-role scope grants require the SYSTEM SID
      (S-1-5-18) over the pipe (`broker.go` roleIdentityRejection). A user-token caller cannot obtain
      `desktop`/capture/`system` scope.
- [ ] `userHelperScopes` vs `systemHelperScopes` separation holds — user helper has no capture/SYSTEM
      capability.
- [ ] Pipe ACL restricts who can connect; no world-writable pipe.
- [ ] Keepalive / role messages can't be used to cross-grant scope (cf. #462 watchdog keepalive
      eviction class).

### Command execution / injection
- [ ] Agent commands validated (schema) before execution; no arbitrary code exec via unsanitized
      payload.
- [ ] Shell-outs use array args, never shell-string interpolation of user/server-influenced data.
- [ ] Path inputs (file browser, patching, scripts) checked for traversal / null bytes; no write
      outside intended roots.
- [ ] PowerShell/cmd invocations encode args safely (UTF-8 / no injection via crafted strings).

### Secrets & config at rest
- [ ] `agent.yaml` stays Users-readable (Helper runs as the logged-in user) but `secrets.yaml` is the
      locked file (0600); chmod-enforce failure on secrets.yaml is fatal. **Do not flag agent.yaml
      readability as a vuln — that's by design (#988).**
- [ ] Tokens (`brz_`) SHA-256 hashed; raw tokens never written to disk or logs.
- [ ] In-memory secret handling (`secmem.SecureString`) — no plaintext token lingering in logs/errors.
- [ ] `backup_s3_*` and other secret-suffixed keys are stripped from non-secret config and read back
      from secrets.yaml (the drift-proof denylist, #6/#997).

### TLS / transport
- [ ] No `InsecureSkipVerify`; cert validation enabled on WS + HTTP clients.
- [ ] mTLS cert rotation before expiry (2/3 lifetime threshold); renewal path authenticated.

### Go-language-specific footguns
- [ ] Goroutine data races on shared connection/session maps (`go test -race` clean).
- [ ] `slog`/`log` error serialization: `"error", err` serializes interface as `{}` — must use
      `err.Error()`; verify no security-relevant context lost AND no secret leaked via verbose error.
- [ ] Missing `context` cancellation → leaked goroutines / hung sessions (DoS-adjacent; report only if
      it crosses into a security boundary, e.g. unbounded session accumulation).
- [ ] Unchecked syscall returns: `void`-returning COM/D3D calls (`CopyResource`) whose RAX garbage was
      misread as HRESULT — pattern that masked real failures; check security-relevant syscalls aren't
      similarly mis-evaluated.
- [ ] Integer/array bounds on parsed network/IPC payloads.

## Key files

| Area | Files |
|---|---|
| Update channel | `agent/internal/updater/`, manifest trust root |
| IPC / broker | `agent/internal/sessionbroker/`, `broker.go`, `agent/internal/ipc/` |
| Helper roles | `agent/internal/userhelper/` |
| Config / secrets | `agent/internal/config/config.go`, `permissions_*.go` |
| Transport | `agent/internal/websocket/client.go`, `agent/internal/mtls/mtls.go` |
| Enrollment | `apps/api/src/routes/agents/enrollment.ts` (server side) |
