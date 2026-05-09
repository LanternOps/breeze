### R-200: DR execution reconciliation now uses stable logical BullMQ identities
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/drExecutionWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/drExecutionWorker.ts)

Summary:
- DR execution reconciliation now uses a stable BullMQ `jobId` derived from the logical execution ID and reuses still-active or delayed queue entries instead of blindly adding another reconcile job.
- This closes duplicate-enqueue paths where repeated DR execution updates for the same failover, failback, or rehearsal record could otherwise stack redundant reconcile jobs in Redis.
