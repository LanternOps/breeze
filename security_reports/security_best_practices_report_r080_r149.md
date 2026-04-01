### R-080: macOS delayed agent restart no longer depends on a shell wrapper
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_darwin.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/agent_restart_darwin.go)
- [/Users/toddhebebrand/breeze/agent/cmd/breeze-agent/internal_restart_cmd.go](/Users/toddhebebrand/breeze/agent/cmd/breeze-agent/internal_restart_cmd.go)

Summary:
- The macOS delayed restart path now spawns a detached hidden helper subcommand from the current binary instead of using `bash -c "sleep ... && launchctl ..."`.
- This removes the last shell wrapper from the agent-restart path while preserving the delayed restart behavior needed to flush the command response before the service restarts.

### R-081: helper notifications now bound title, body, and icon sizes before invoking OS-specific notifiers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_linux.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go)

Summary:
- Notification requests are now normalized through a shared sanitizer that trims and caps the title, body, and icon fields before they are passed to `notify-send`, `osascript`, or PowerShell.
- This reduces argv and script-injection pressure from oversized caller-controlled notification payloads.

### R-082: helper notifications now cap action counts and normalize urgency values
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_common.go)

Summary:
- Notification actions are now capped to a small fixed count, and urgency is normalized to an allowlist of `low`, `normal`, or `critical`.
- This prevents unsupported or attacker-influenced notification metadata from becoming another loosely validated execution surface inside helper-side OS integrations.

### R-083: Windows toast notifications now run PowerShell in non-interactive mode
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/notify_windows.go)

Summary:
- The Windows notification helper now invokes PowerShell with `-NonInteractive` in addition to `-NoProfile`.
- This keeps the toast path more constrained and avoids depending on interactive shell behavior for a background helper operation.

### R-084: service-control commands now reject malformed service identifiers before invoking native service managers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/services.go)

Summary:
- `get/start/stop/restart service` now reject identifiers with traversal markers, path separators, whitespace-padding, or control characters instead of truncating and forwarding them into `systemctl` or `launchctl`.
- This tightens the service-control surface and prevents malformed names from steering service-manager lookups in surprising ways.

### R-085: scheduled-task operations now validate task folders and task paths before use
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/tasks.go)

Summary:
- Scheduled-task commands now require canonical `\\...` task paths/folders and reject traversal markers and control characters before they reach the Windows task wrappers.
- This narrows the task-control input boundary instead of trusting raw caller-provided identifiers throughout the task toolchain.

### R-086: trash listings now cap the number of returned items and expose truncation explicitly
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/types.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/types.go)

Summary:
- `file_trash_list` now caps the number of returned items and marks the response as `truncated` when the trash contains more entries than the transport budget should return.
- This prevents a large trash directory from turning the file-ops response into another unbounded JSON amplification surface.

### R-087: trash metadata reads now enforce a size budget before list, restore, or lazy-purge parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- Trash metadata files are now size-checked before `json.Unmarshal` in list, restore, and lazy-purge flows.
- This closes a remaining local DoS path where a corrupted or oversized metadata file could force unnecessary memory allocation during routine trash operations.

### R-088: trash purge now caps the number of returned per-item error strings
Location:
- [/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go](/Users/toddhebebrand/breeze/agent/internal/remote/tools/fileops.go)

Summary:
- `file_trash_purge` now limits how many per-item error strings are accumulated into the response payload.
- This keeps purge failures from reflecting unbounded error arrays back through the remote tool channel when the trash contains many failing entries.

### R-089: broker self-hash computation now streams the agent binary instead of reading it fully into memory
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- The session broker now hashes its own executable through a streaming SHA-256 helper after verifying that the path is a regular file.
- This removes an avoidable whole-file memory read from the helper-integrity path and makes the broker more resilient to unexpectedly large binaries.

### R-090: Linux session detection now runs `loginctl` enumeration under explicit command timeouts
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Linux detector now executes both `loginctl list-sessions` and per-session `loginctl show-session` calls through bounded `CommandContext` timeouts.
- This prevents a hung session-enumeration subprocess from stalling the detector loop indefinitely.

### R-091: Linux session detection now uses bounded scanners and reports parser failures instead of silently truncating state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Linux detector now parses `loginctl` output with an explicit scanner buffer budget and returns errors on scanner failure instead of silently accepting partial output.
- This removes another oversized-output blind spot from a trust boundary that feeds helper-spawning and session-targeting logic.

### R-092: detected-session snapshots now validate field contents and cap total session fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_linux.go)

Summary:
- Detected session usernames, session IDs, display names, seat names, and state/type fields now pass through a shared validator, and the detector caps the number of returned sessions.
- This prevents malformed or oversized session metadata from flowing unchecked into the broker’s session-selection logic.

### R-093: macOS no-CGO session detection now uses timed subprocesses for console user and UID lookup
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The macOS fallback detector now runs `stat` and `id -u` with explicit timeouts instead of untimed child processes.
- This keeps the no-CGO detector from hanging indefinitely when the local command path misbehaves.

### R-094: macOS no-CGO session detection now validates the console username and normalizes the returned session shape
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin_nocgo.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The fallback detector now validates the console username, parses the UID with `strconv`, and returns a sanitized `DetectedSession` with an explicit `console` type.
- This tightens the contract on the darwin no-CGO path instead of trusting raw command output as already well-formed.

### R-095: the broker now drops unmatched response-only helper messages instead of forwarding them into higher layers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- Unmatched `command_result`, `notify_result`, and `clipboard_data` envelopes are now explicitly dropped rather than forwarded to the heartbeat as unsolicited helper messages.
- This narrows the broker’s message surface and removes a class of stray or spoofed response packets that had no legitimate unsolicited consumer.

### R-096: the broker now enforces scope checks on unsolicited tray, desktop, and backup helper messages
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- The broker now requires the relevant helper scope before forwarding unsolicited `tray_action`, `sas_request`, `desktop_peer_disconnected`, and backup progress/result messages.
- This makes the unsolicited IPC path fail closed if a helper tries to emit message families outside the role it authenticated for.

### R-097: the macOS TCC dialog path now uses escaped AppleScript strings and bounded command execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go)

Summary:
- The TCC dialog path now feeds its message text through the existing AppleScript string escaper and runs `osascript` under an explicit timeout.
- This keeps the consent prompt path tighter and avoids indefinite blocking on a GUI scripting subprocess.

### R-098: the macOS TCC System Settings opener now uses an allowlisted permission-to-URL mapper and bounded `open` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_common.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_common.go)
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/tcc_darwin.go)

Summary:
- Opening System Settings now goes through a small allowlisted permission-to-URL mapper and invokes `open` under a bounded timeout.
- This removes any chance of the TCC helper path turning arbitrary permission labels into unchecked URL launches.

### R-099: the user-helper self-integrity hash now streams executable bytes instead of reading the whole binary into memory
Location:
- [/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go)

Summary:
- The user helper now computes its self-hash through a streaming SHA-256 helper instead of reading the full executable into memory before hashing.
- This aligns the helper-side integrity check with the broker-side hardening and removes another avoidable whole-file read from the auth path.

### R-100: the CGO macOS session detector now sanitizes the console snapshot before returning it
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The CGO-backed macOS detector now runs the console user snapshot through the same shared detected-session validator used by the hardened Linux and no-CGO darwin paths.
- This brings the last darwin detector variant up to the same field-validation standard before session metadata reaches helper lifecycle decisions.

### R-101: the CGO macOS session watch loop now normalizes console-user transitions instead of trusting raw C strings
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_darwin.go)

Summary:
- The watch loop now sanitizes both initial and current console-user snapshots before emitting login/logout events.
- This keeps malformed or unexpected console-user values from bypassing the detected-session validation path during live transition handling.

### R-102: Windows session detection now caps the number of enumerated sessions returned to the broker
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- The Windows detector now stops after a bounded number of sanitized session entries instead of reflecting arbitrarily large WTS enumerations.
- This keeps the Windows session snapshot surface aligned with the same result-budget policy used on other detector implementations.

### R-103: Windows detected-session fields now pass through shared normalization before entering broker state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_common.go)

Summary:
- Windows session IDs, display names, states, types, and usernames are now validated and size-bounded before they are appended to the detected-session list.
- This closes the last cross-platform gap where detector output was still treated as implicitly trustworthy on one platform.

### R-104: Windows session IDs now use a strict shared parser instead of loose `%d` parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- Windows session identifiers now have a dedicated parser that rejects whitespace, non-digits, negative values, and oversized inputs.
- This avoids the lenient `%d` parsing behavior that could previously accept malformed session strings in downstream Windows-session control paths.

### R-105: disconnect-state checks now fail closed on malformed Windows session IDs
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/detector_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- `IsSessionDisconnected` now uses the strict Windows session-ID parser before issuing the WTS query.
- This removes another loose parsing path from a helper-targeting decision that determines whether a session is safe to reuse for capture.

### R-106: `list_sessions` now skips malformed session identifiers instead of silently coercing them to session `0`
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The heartbeat-side `list_sessions` response builder now parses session IDs strictly and drops malformed entries rather than letting `fmt.Sscanf` default them to zero.
- This prevents corrupted detector output from being misreported as the privileged services session in API-facing session listings.

### R-107: helper spawning now validates explicit target Windows session IDs before invoking the spawner
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The desktop-helper spawn path now validates `targetSession` with the strict session-ID parser before converting it to the numeric session handle used by the Windows spawner.
- This narrows a remaining trust boundary where caller-influenced session strings still flowed into session-targeted helper creation.

### R-108: helper-originated desktop-disconnect notices now require a valid session ID format before they affect API state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)

Summary:
- Desktop peer-disconnect notices are now checked against a bounded session-ID pattern before the heartbeat forwards them toward the API.
- This prevents malformed helper-originated session identifiers from mutating remote-session state or log streams.

### R-109: helper-originated desktop-disconnect notices are now bound to the recorded owning helper session
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)

Summary:
- The heartbeat now verifies that a desktop peer-disconnect notice came from the helper session recorded as that desktop session’s owner before forwarding it.
- This closes a cross-session tampering path where one connected desktop-capable helper could previously try to mark another session’s viewer as disconnected.

### R-110: desktop-disconnect notifications sent upstream now refuse invalid session IDs, even if called internally
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/heartbeat.go)

Summary:
- The outbound `sendDesktopDisconnectNotification` helper now independently validates the session ID before constructing the WebSocket result.
- This adds a second fail-closed guard on the API-facing path rather than relying only on the caller to have validated the identifier already.

### R-111: macOS GUI-user discovery now uses bounded scanning and validates discovered UIDs before LaunchAgent restart attempts
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop_helper.go)
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/windows_session_id.go)

Summary:
- The macOS `ps` output parser used for GUI-user discovery now uses a bounded scanner, de-duplicates results, caps the number of discovered UIDs, and rejects malformed numeric IDs.
- This hardens the LaunchAgent kickstart/bootstrap helper path against oversized process listings and malformed UID tokens.

### R-112: `start_desktop` now rejects malformed desktop session identifiers before opening a new session
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- The heartbeat-side `start_desktop` handler now validates the caller-supplied session identifier against the same bounded desktop-session pattern already used on disconnect notifications.
- This prevents malformed or path-like session IDs from entering desktop session creation and downstream owner-tracking state.

### R-113: stop, stream, input, and config desktop commands now share the same fail-closed session-ID validation
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- `stop_desktop`, `desktop_stream_start`, `desktop_stream_stop`, `desktop_input`, and `desktop_config` now all go through a shared validated-session-ID helper instead of accepting arbitrary caller strings.
- This closes the remaining heartbeat-side command paths that still trusted raw desktop session identifiers after the earlier disconnect/owner hardening.

### R-114: desktop start requests now bound `displayIndex` to a small integer range
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- The desktop start path now requires `displayIndex` to be an integer between `0` and `16`.
- This prevents malformed floating-point or extreme display indices from flowing into session creation and monitor-selection logic.

### R-115: WebSocket desktop stream start now enforces the same bounded monitor index policy
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- `desktop_stream_start` now applies the same integer-and-range validation to `displayIndex` before it reaches the WS desktop manager.
- This keeps the stream-start path aligned with the direct desktop-start path rather than leaving one monitor-selection surface looser than the other.

### R-116: desktop input events now use an explicit allowlist of supported event types
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- Heartbeat-side desktop input parsing now rejects unknown `type` values instead of passing arbitrary strings into the platform-specific input handlers.
- This removes another trust boundary where malformed or unexpected viewer event types still reached desktop control code.

### R-117: mouse-button desktop input is now canonicalized to a strict left/right/middle allowlist
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- Desktop input normalization now only accepts `left`, `right`, or `middle` mouse-button identifiers and defaults blank click/down/up events to `left`.
- This prevents unexpected button tokens from flowing into platform-specific click injection code.

### R-118: keyboard desktop input now normalizes and size-bounds key and modifier fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- Keyboard events now require a bounded `key`, de-duplicate modifiers, cap modifier count, and canonicalize aliases like `control`, `cmd`, `super`, and `win`.
- This reduces injection ambiguity and avoids unbounded or adversarial modifier payloads in the input path.

### R-119: desktop input coordinates and scroll deltas now reject malformed or extreme numeric values
Location:
- [/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go](/Users/toddhebebrand/breeze/agent/internal/heartbeat/handlers_desktop.go)

Summary:
- Input normalization now requires integer coordinates, rejects `NaN`/`Inf`, and caps coordinate magnitude and scroll delta before the desktop manager sees the event.
- This removes a simple agent-side denial-of-service path where oversized scroll counts or malformed numeric payloads could reach input-injection loops.

### R-120: helper install and migration shell-outs now run under a shared timeout wrapper instead of unconstrained local process execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/helper/command_util.go](/Users/toddhebebrand/breeze/agent/internal/helper/command_util.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/install_linux.go](/Users/toddhebebrand/breeze/agent/internal/helper/install_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/install_darwin.go](/Users/toddhebebrand/breeze/agent/internal/helper/install_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/install_windows.go](/Users/toddhebebrand/breeze/agent/internal/helper/install_windows.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/migrate_linux.go](/Users/toddhebebrand/breeze/agent/internal/helper/migrate_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/migrate_darwin.go](/Users/toddhebebrand/breeze/agent/internal/helper/migrate_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/migrate_windows.go](/Users/toddhebebrand/breeze/agent/internal/helper/migrate_windows.go)

Summary:
- Helper lifecycle commands such as `pgrep`, `pkill`, `tasklist`, `taskkill`, `launchctl bootout`, `stat`, and `loginctl` now execute through a shared `CommandContext` timeout wrapper.
- This hardens a remaining cluster of local helper-management shell-outs that could otherwise hang indefinitely and stall install, removal, or migration flows.

### R-121: helper-side UID, process-path, and migration-target parsing now validates and bounds local command output before use
Location:
- [/Users/toddhebebrand/breeze/agent/internal/helper/command_util.go](/Users/toddhebebrand/breeze/agent/internal/helper/command_util.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/install_darwin.go](/Users/toddhebebrand/breeze/agent/internal/helper/install_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/process_check_darwin.go](/Users/toddhebebrand/breeze/agent/internal/helper/process_check_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/helper/migrate_linux.go](/Users/toddhebebrand/breeze/agent/internal/helper/migrate_linux.go)

Summary:
- The helper package now parses console UIDs, process paths, and Linux migration targets through explicit numeric/path validators with bounded scanner limits and deduped target caps.
- This closes another local trust boundary where raw command output still flowed directly into helper-session selection or process-identity checks.

### R-122: package-manager providers now share bounded command-execution helpers instead of issuing unconstrained local shell-outs directly
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The patching module now has shared timeout wrappers for output and combined-output command execution, plus a reusable bounded scanner configuration.
- This removes a broad class of hung local package-manager invocations from the patch scan/install/remove paths.

### R-123: package-manager install and uninstall output is now truncated before entering logs, errors, and result payloads
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go](/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go](/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/apt.go](/Users/toddhebebrand/breeze/agent/internal/patching/apt.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/yum.go](/Users/toddhebebrand/breeze/agent/internal/patching/yum.go)

Summary:
- Install/uninstall output returned from `brew`, `apt-get`, `dnf`/`yum`, and `choco` is now truncated to a bounded size before it is copied into errors or `InstallResult.Message`.
- This reduces a remaining agent-side memory and log-amplification path on package-manager failures.

### R-124: APT install and uninstall now validate package IDs before invoking `apt-get`
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/apt.go](/Users/toddhebebrand/breeze/agent/internal/patching/apt.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The APT provider now enforces an explicit allowlist for package names and rejects option-like or malformed identifiers before calling `apt-get`.
- This closes a shell-wrapper input boundary where caller-controlled package IDs were still treated as implicitly safe.

### R-125: YUM/DNF install and uninstall now enforce the same package-name validation before mutation
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/yum.go](/Users/toddhebebrand/breeze/agent/internal/patching/yum.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The YUM/DNF provider now validates patch identifiers before it calls `update` or `remove`.
- This removes the remaining unchecked package-name input on the Linux RPM patching path.

### R-126: Homebrew package IDs are now validated before formula or cask upgrade/removal commands are constructed
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go](/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- Homebrew install and uninstall now reject malformed names, option-like identifiers, path-like values, and traversal-style tokens before command construction.
- This narrows the package-ID trust boundary on the macOS third-party patch path.

### R-127: Chocolatey scan, install, uninstall, and installed-package enumeration now run under explicit timeouts
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go](/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The Chocolatey provider no longer calls `choco` through unconstrained `Output`/`CombinedOutput` paths.
- This hardens the Windows package-manager wrapper against indefinitely hung local command execution during scan or mutation.

### R-128: APT scan and installed-package enumeration now use bounded scanning and timeout-wrapped command execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/apt.go](/Users/toddhebebrand/breeze/agent/internal/patching/apt.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The APT provider now parses `apt list --upgradable` and `dpkg-query` output through the shared bounded scanner and timeout wrapper.
- This reduces oversized local package-list output and hung command risk in the Debian/Ubuntu scan path.

### R-129: YUM/DNF scan and installed-package enumeration now use the same bounded scanner and timeout policy
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/yum.go](/Users/toddhebebrand/breeze/agent/internal/patching/yum.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- The YUM/DNF provider now wraps `check-update` and `rpm -qa` with explicit timeouts and parses their output through a bounded scanner.
- This closes the equivalent result-budget and local DoS gap on the RPM-based patching path.

### R-130: Homebrew scan/list and console-user discovery now use validated, timeout-bounded execution helpers
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go](/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- Homebrew scan/list execution now runs through bounded wrappers, and console-user discovery validates the short username returned by `stat` before it is used for `sudo -u`.
- This hardens both the brew command path and the user-targeting decision that underpins root-to-console-user execution.

### R-131: package-manager scan/list results now skip malformed package names, truncate large fields, and cap result fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go](/Users/toddhebebrand/breeze/agent/internal/patching/chocolatey.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go](/Users/toddhebebrand/breeze/agent/internal/patching/homebrew.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/apt.go](/Users/toddhebebrand/breeze/agent/internal/patching/apt.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/yum.go](/Users/toddhebebrand/breeze/agent/internal/patching/yum.go)
- [/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/patching/command_limits.go)

Summary:
- All four local package-manager providers now drop malformed names parsed from command output, truncate large titles/versions/descriptions, and stop after a bounded number of results.
- This removes another large structured-output trust boundary from the patch inventory and patch availability surfaces.

### R-132: collector command execution now has shared timeout and output-budget helpers instead of ad hoc direct process reads
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The collectors package now has shared helpers for timeout-bounded command execution, bounded scanner creation, and field truncation.
- This establishes a common defensive baseline for the local command-heavy collectors that previously mixed direct `Output()` calls with unbounded parsing.

### R-133: macOS boot-time discovery now runs under explicit command timeouts and bounded log scanning
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `sysctl kern.boottime` and the `log show` desktop-ready probe now run through shared timeout helpers, and the unified-log parsing path now uses a bounded scanner.
- This closes a local hang and oversized-log parsing gap in the macOS boot-metrics path.

### R-134: macOS launchd plist and login-item enumeration now use bounded command output and truncated item names
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `plutil` and `osascript` calls in startup-item enumeration now run under bounded execution helpers, and login-item names are truncated before they enter collector results.
- This reduces the risk of oversized or hostile local startup metadata dominating the startup inventory path.

### R-135: early-boot process enumeration now uses bounded scanning and caps the number of matched processes
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The macOS `ps -eo etime,cputime,comm` reader now runs under a timeout helper, uses a bounded scanner, truncates command names, and stops after a capped number of process records.
- This removes another result-size and local DoS edge from the boot-performance impact-scoring path.

### R-136: launchctl and AppleScript startup-item mutation paths now fail closed on hung commands and oversized output
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The macOS startup-item enable/disable helpers now run `launchctl`, `id`, and `osascript` through timeout-bounded wrappers and truncate fallback error output before surfacing it.
- This hardens a small remaining mutation surface in the collectors module that still used unconstrained local command execution.

### R-137: macOS bandwidth queries now reject malformed interface names before they reach `ifconfig`
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_darwin.go)

Summary:
- The darwin bandwidth collector now validates interface names against a short allowlist before using them in `ifconfig`.
- This narrows the interface-name trust boundary on the local network-speed probe path.

### R-138: macOS network-speed probes now run under bounded command wrappers instead of direct `Output()` calls
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/bandwidth_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `networksetup`, `ifconfig`, and the private `airport` binary now run through shared timeout/output-budget helpers.
- This removes another macOS collector path that could previously hang indefinitely or return oversized local command output unbounded.

### R-139: macOS unified-log event collection now caps processed result fan-out and truncates event identity fields
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin unified-log reader now runs through bounded command helpers, caps the number of accepted entries, and truncates `Source`, `EventID`, `Subsystem`, and crash-report metadata fields before they enter result payloads.
- This reduces large caller-influenced log messages and process metadata from spilling into unbounded collector output.

### R-140: macOS crash-report parsing now rejects oversized `.ips` and `.crash` files before reading them into memory
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/eventlogs_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Crash-report ingestion now checks the file size before `os.ReadFile` and rejects oversized crash artifacts.
- This closes a straightforward memory-amplification path in the application-crash event collector.

### R-141: Linux systemd service and timer enumeration now uses bounded execution, unit-name validation, and capped result sets
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/services_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/services_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Linux `systemctl` readers in both the change tracker and service collector now use timeout-bounded helpers, bounded scanners, validated unit names, truncated fields, and explicit result caps.
- This hardens the main Linux service/task inventory surfaces against oversized or malformed local command output.

### R-142: Linux boot-phase timing now uses bounded `systemd-analyze` execution instead of unconstrained local process reads
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux boot-performance collector now runs `systemd-analyze` through the shared timeout/output-budget helper.
- This removes another collector path that could previously hang indefinitely or return oversized local output.

### R-143: Linux startup-unit and blame parsing now uses bounded scanners, validated unit names, and capped fan-out
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- `systemctl list-unit-files` and `systemd-analyze blame` now parse through bounded scanners, skip malformed unit names, truncate item names/paths, and stop after a capped number of results.
- This hardens the Linux startup-item and blame-based impact-scoring paths against oversized or malformed local command output.

### R-144: Linux cron startup parsing now rejects oversized crontab files before reading them
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux boot-performance cron parser now checks file size before `os.ReadFile` and skips oversized crontab files.
- This closes another simple local memory-amplification edge in the collector path.

### R-145: Linux startup-item mutation paths now truncate command output and bound `systemctl` and `update-rc.d` execution
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go](/Users/toddhebebrand/breeze/agent/internal/collectors/boot_performance_linux.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The Linux startup-item mutators now execute `systemctl` and `update-rc.d` through bounded wrappers and truncate surfaced command output in fallback/error paths.
- This reduces the blast radius of hung or noisy local service-management commands in the boot collector’s mutation surface.

### R-146: macOS change-tracker `crontab` and `dscl` readers now run under bounded execution and result caps
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin change tracker now wraps `crontab -l` and `dscl` with the shared timeout helper, caps parsed user/task results, and truncates stored fields.
- This hardens the remaining macOS change-tracker command readers against large or hung local output.

### R-147: macOS change-tracker startup and crontab metadata is now truncated before entering snapshot state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/change_tracker_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- Startup-item names/paths and parsed darwin crontab schedule/command fields now get truncated and capped before being added to change-tracker snapshots.
- This closes another structured-output amplification path in the macOS drift-detection layer.

### R-148: macOS service enumeration now uses bounded `launchctl` execution and capped parsing
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/services_darwin.go](/Users/toddhebebrand/breeze/agent/internal/collectors/services_darwin.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The darwin service collector now runs `launchctl list` through a shared timeout helper, parses with a bounded scanner, truncates labels, and caps result fan-out.
- This hardens the remaining service inventory path on macOS against oversized local command output.

### R-149: macOS LocalHostName lookup now uses the shared collector timeout helper and truncates oversized hostnames
Location:
- [/Users/toddhebebrand/breeze/agent/internal/collectors/hardware.go](/Users/toddhebebrand/breeze/agent/internal/collectors/hardware.go)
- [/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go](/Users/toddhebebrand/breeze/agent/internal/collectors/command_limits.go)

Summary:
- The macOS `scutil --get LocalHostName` override now runs through the shared collector timeout helper and truncates the resulting hostname before use.
- This closes one more small but still-unbounded local command reader in the hardware/system-info path.

## Suggested Next Audit Targets

1. Continue into the remaining collector readers that still use direct local command execution, especially [`/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go`](/Users/toddhebebrand/breeze/agent/internal/collectors/warranty_darwin.go), [`/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_darwin.go`](/Users/toddhebebrand/breeze/agent/internal/collectors/hardware_darwin.go), [`/Users/toddhebebrand/breeze/agent/internal/collectors/metrics_fallback_darwin_nocgo.go`](/Users/toddhebebrand/breeze/agent/internal/collectors/metrics_fallback_darwin_nocgo.go), and the remaining Linux boot/change readers.
2. Revisit the remaining desktop/session mirror logic in [`/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go`](/Users/toddhebebrand/breeze/agent/internal/userhelper/client.go) to decide whether more helper-side validation should mirror the service-side desktop guards.
3. If the audit should move back up-stack again, the next natural API target remains another pass over [`/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts`](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts).
