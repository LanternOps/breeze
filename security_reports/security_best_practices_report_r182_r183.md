# Security Best Practices Report: R-182 through R-183

### R-182: Shared command delivery now claims `pending -> sent` before dispatch and releases failed claims
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/commandDispatch.ts](/Users/toddhebebrand/breeze/apps/api/src/services/commandDispatch.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/services/commandQueue.ts](/Users/toddhebebrand/breeze/apps/api/src/services/commandQueue.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agents/heartbeat.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agents/heartbeat.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/scripts.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/scripts.ts)

Summary:
- Row-backed commands are now conditionally claimed from `pending` to `sent` before WebSocket delivery or heartbeat handoff, and failed immediate deliveries release the claim back to `pending`.
- The agent WebSocket and heartbeat fetch paths now return only successfully claimed commands, and the immediate script dispatch path uses the same claim/release flow.
- This closes a duplicate-delivery race where concurrent WebSocket and heartbeat dispatch paths could otherwise hand the same pending command to an agent more than once.

### R-183: Generic queue timeout and result-submission helpers now only transition in-flight commands
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/commandQueue.ts](/Users/toddhebebrand/breeze/apps/api/src/services/commandQueue.ts)

Summary:
- `waitForCommandResult`, `markCommandsSent`, and `submitCommandResult` now condition their updates on the command still being in the expected in-flight state, instead of unconditionally overwriting any row with the matching ID.
- This closes the remaining stale-transition path in the generic command queue helpers and keeps replayed or late updates from mutating already-completed command rows.
