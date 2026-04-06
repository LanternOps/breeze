# Security Best Practices Report: R-181

### R-181: Agent command-result post-processing now aborts when the in-flight status transition was lost and rebinds script execution updates to the resolved device
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- After conditionally updating a `device_commands` row from `pending`/`sent` to its terminal state, the agent WebSocket handler now aborts all downstream post-processing if that update affected no rows, rather than continuing on stale or concurrently-processed results.
- The script-result path now also updates `script_executions` only when the execution belongs to the resolved device and is still active, and only increments a batch counter when the batch matches the execution's script.
- This closes a race where a replayed or duplicated result could lose the command status update but still mutate discovery, backup, script, or other downstream records.
