# Instance Diagnostics Task 4 Report

Base: `692864c5483bed0845ff57fc955a04d366968bee`

## Result

Implemented structured process-role diagnostics for the main agent and helper processes, plus retained parent-side spawn provenance. The implementation does not change helper process handles, Job Object ownership, lifecycle convergence, or RDS role policy.

## TDD evidence

### RED

1. Native focused test command:

   `go test -race ./internal/agentapp ./internal/sessionbroker -run 'TestProcessStartup|TestLogProcessStartup|TestSpawnedHelperDiagnostics|TestClassifyProcess|TestResolveUserHelperPath|TestBuildUserHelperCmdLine' -count=1`

   Exit 1. Expected missing-feature failures:

   - `undefined: logProcessStartup`
   - `unknown field CommandMode in struct literal of type SpawnedHelper`
   - `unknown field Role in struct literal of type SpawnedHelper`
   - `unknown field WindowsSessionID in struct literal of type SpawnedHelper`

2. Windows amd64 sessionbroker test cross-compile:

   `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ./internal/sessionbroker -o /tmp/breeze-task4-red/sessionbroker.test.exe`

   Exit 1. The Windows `SpawnedHelper` lacked `CommandMode`, `Role`, and `WindowsSessionID`.

3. Cached main-startup regression test with the cache implementation removed:

   `go test ./internal/agentapp -run TestCachedMainProcessStartupUsesGuardRecord -count=1`

   Exit 1. The cache and cache accessors were absent, proving the test requires the Task 3 guard-time record rather than a later recomputation.

### GREEN

- Focused cache/startup tests: pass under `-race`.
- Brief-required focused command:

  `go test -race ./internal/agentapp ./internal/sessionbroker -run 'TestProcessStartup|TestClassifyProcess|TestResolveUserHelperPath|TestBuildUserHelperCmdLine' -count=1`

  Pass.

- Affected package suites:

  `go test -race ./internal/agentapp ./internal/sessionbroker -count=1`

  Pass.

- Full native agent suite:

  `go test -race ./...`

  Pass with no race report.

- Windows cross-compilation for both `amd64` and `arm64`: `agentapp`, `sessionbroker`, and `heartbeat` test binaries plus `cmd/breeze-agent` all compile successfully.

## One-event evidence

- There is one log implementation for the event: `log.Info("process startup", args...)` in `process_role.go`.
- Main startup has one call site, after full logging and log shipping initialization: `logProcessStartup(cachedMainProcessStartup())` in `startAgent`.
- Helper startup has one call site, after helper logging and optional shipping initialization: `logProcessStartup(currentProcessStartup("user-helper", role, false))` in `runHelperProcess`.
- The previous `starting agent` and `starting helper` messages have been removed; repository string search over the touched startup paths returns zero occurrences.
- `TestLogProcessStartupEmitsOneStructuredEvent` captures JSON logs and asserts exactly one `process startup` record.
- Parent-side spawn diagnostics remain a distinct `spawned user helper in session` record and are asserted once in the Windows spawner test. They are not a second `process startup` record.

## Field and security checklist

The process-startup whitelist contains only:

- `binary`
- `executablePath`
- `pid`
- `parentPid`
- `windowsSessionId`
- `launchMode`
- `helperRole`
- `lifecycleKey`
- `companionHelper`
- `mainBinaryFallback`
- `version`
- `createdAt`

The parent spawn diagnostic contains only process provenance needed for support: PID, actual binary path, `user-helper` command mode, explicit authenticated helper role, kernel-target Windows session ID, and typed resolver fallback status. It does not log token-source metadata.

Tests reject `authToken`, `helperAuthToken`, and `mtlsKey`; the Windows spawn-log test also rejects token-source, certificate, tenant, and organization fields. No secret value, token value, certificate material, tenant ID, organization ID, server URL, or agent ID was added to either diagnostic.

Helper self-diagnostics use `os.Executable()` and kernel process metadata. `WindowsSessionID` and `LifecycleKey` therefore come from the current process session, not a claimed session argument. Parent diagnostics copy `BinaryPath` and `MainBinaryFallback` from `ResolvedHelperExecutable` into `SpawnedHelper`, so provenance survives an immediate child exit.

## Guard and lifecycle checklist

- The Task 3 main startup record is cached before the instance guard and reused after logging becomes available.
- Only `start` and legacy `run` route through `runAgent` and acquire the main guard.
- `user-helper`, `desktop-helper`, `status`, `enroll`, and `bootstrap` do not call `runAgent` and do not acquire the main guard.
- Existing duplicate-main exit behavior and exit code 17 remain unchanged.
- No helper lifecycle, process-handle, Job Object, spawn ordering, or RDS desired-role policy code was changed.
- Windows and non-Windows `SpawnedHelper` definitions have parity for `CommandMode`, `Role`, `WindowsSessionID`, `BinaryPath`, and `MainBinaryFallback`.

## Manual limitation

Windows CIM/manual endpoint verification was not executed because no Windows test endpoint is available in this environment. In particular, this report does not claim live verification of SCM/console classification, the elevated duplicate exit, or CIM `SessionId`/`CommandLine` correlation. The Windows-only tests were cross-compiled, not executed locally.
