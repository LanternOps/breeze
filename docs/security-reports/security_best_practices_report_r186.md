# Security Report Slice: R-186

### R-186: Backup BullMQ enqueue helpers now use stable logical job IDs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/backupEnqueue.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/backupEnqueue.ts)

Summary:
- Backup dispatch, backup result processing, and restore dispatch queue submissions now set stable BullMQ `jobId` values derived from the logical backup or restore job ID.
- This closes a duplicate-enqueue path where repeated enqueue attempts for the same backup workflow could otherwise stack multiple identical queue jobs in Redis before the database-layer stale-result guards ran.
