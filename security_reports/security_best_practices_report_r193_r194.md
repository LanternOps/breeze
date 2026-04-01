### R-193: C2C sync job creation now acquires a transaction-scoped per-config lock and reuses active jobs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/c2cJobCreation.ts](/Users/toddhebebrand/breeze/apps/api/src/services/c2cJobCreation.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cBackupWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cBackupWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/c2c/jobs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/c2c/jobs.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/services/aiToolsC2C.ts](/Users/toddhebebrand/breeze/apps/api/src/services/aiToolsC2C.ts)

Summary:
- C2C sync creation now runs under a transaction-scoped advisory lock keyed by organization and backup configuration, checks for existing `pending` or `running` sync jobs inside that locked transaction, and reuses the active row instead of blindly inserting another one.
- Scheduled sync generation, manual `/c2c/configs/:id/run`, and the AI-triggered sync path now all share that helper, and the manual/API entrypoints now refuse duplicate active syncs instead of stacking them.
- This closes the same check-then-insert race that previously existed in backup and discovery, where concurrent schedule ticks or manual sync triggers for the same C2C configuration could create duplicate active jobs.

### R-194: C2C sync and restore queue submissions now use stable logical BullMQ job IDs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cEnqueue.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cEnqueue.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cBackupWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/c2cBackupWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/c2c/items.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/c2c/items.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/services/aiToolsC2C.ts](/Users/toddhebebrand/breeze/apps/api/src/services/aiToolsC2C.ts)

Summary:
- C2C sync dispatch and restore processing now flow through shared enqueue helpers that assign stable BullMQ `jobId` values derived from the logical C2C job ID and reuse still-active queue entries instead of submitting another copy.
- This closes duplicate-enqueue paths where repeated sync or restore submissions for the same C2C job could otherwise stack multiple identical BullMQ jobs and re-run the same logical work.
