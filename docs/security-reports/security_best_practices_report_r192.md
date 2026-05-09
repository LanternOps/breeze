# Security Report Slice: R-192

### R-192: SNMP poll dispatch and result processing now use stable logical BullMQ job IDs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/snmpWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/snmpWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- SNMP per-device poll jobs now use a stable queue `jobId` derived from the SNMP device ID, and queued SNMP result processing now uses the originating `snmp-...` command ID as a stable `jobId`.
- This closes duplicate dispatch and duplicate post-processing paths where repeated scheduler ticks or repeated agent deliveries for the same SNMP poll could otherwise queue the same logical work more than once.
