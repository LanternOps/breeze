# Security Report Slice: R-191

### R-191: Monitor result processing now deduplicates per monitor check command ID
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/monitorWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/monitorWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)

Summary:
- Monitor result ingestion now carries the originating `mon-...` command ID into the queued monitor result payload, and the monitor worker uses that command ID as a stable BullMQ `jobId` for `process-check-result`.
- This closes a duplicate post-processing path where repeated deliveries of the same monitor check result could otherwise enqueue and record the same logical check more than once.
