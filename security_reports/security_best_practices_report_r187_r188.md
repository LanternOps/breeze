# Security Report Slice: R-187 through R-188

### R-187: Manual backup job creation now acquires a transaction-scoped per-device lock and refuses duplicate active jobs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/backupJobCreation.ts](/Users/toddhebebrand/breeze/apps/api/src/services/backupJobCreation.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/backup/jobs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/backup/jobs.ts)

Summary:
- Manual backup job creation now runs under a transaction-scoped advisory lock keyed by organization and device, checks for existing `pending` or `running` jobs inside that locked transaction, and returns `409` instead of inserting a second active job.
- This closes a race where concurrent manual backup requests could both pass the old check-then-insert flow and create duplicate active jobs for the same device.

### R-188: Scheduled backup creation now uses occurrence-scoped locking before inserting minute-window jobs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/backupJobCreation.ts](/Users/toddhebebrand/breeze/apps/api/src/services/backupJobCreation.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/backupWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/backupWorker.ts)

Summary:
- Scheduled backup creation now acquires an advisory lock scoped to device, config/feature, and due occurrence key before checking the minute window and inserting the scheduled backup row.
- This closes the parallel scheduler race where concurrent schedule processors could previously both miss the minute-window row and create duplicate scheduled backup jobs for the same occurrence.
