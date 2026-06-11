# Security Best Practices Report: R-179 through R-180

### R-179: Session broker command waits now validate payload-level correlation for helper command and desktop-start responses
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go)

Summary:
- After matching a pending helper response by envelope ID and type, the session broker now also validates payload-level identifiers for `command_result` and `desktop_start` responses before delivering them to callers.
- This closes a remaining trust gap where a compromised helper could reuse the right envelope ID and type but smuggle a different command or desktop session identity inside the response payload.

### R-180: Agent command-result ingestion now only accepts in-flight device commands
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- Agent command results now resolve and update `device_commands` rows only when the command is still in an in-flight state (`pending` or `sent`), rather than accepting any historical command row for the device.
- This closes a replay/overwrite path where a connected agent could previously resubmit a result against an old command ID and mutate already-completed command state or its downstream post-processing records.
