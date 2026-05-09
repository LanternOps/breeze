# Security Best Practices Report: R-178

### R-178: Desktop session state transitions in agent WebSocket handling now bind to the exact start or disconnect command ID
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- Desktop answer, disconnect, and start-failure handling now derive the session ID from the exact `desk-start-...` or `desk-disconnect-...` command ID and only accept a payload session ID when it matches that expected value.
- This closes a cross-session trust gap where a crafted non-start desktop result or mismatched payload session ID could previously drive the state of another remote desktop session on the same device.
