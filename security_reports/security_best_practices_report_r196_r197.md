### R-196: Deployment-level queue jobs now use stable logical BullMQ identities
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/deploymentWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/deploymentWorker.ts)

Summary:
- Deployment start and staggered next-batch scheduling now use stable BullMQ `jobId` values derived from the logical deployment and batch, and they reuse still-active queue entries instead of blindly adding another copy.
- This closes duplicate-enqueue paths where repeated deployment starts or repeated batch scheduling for the same rollout phase could otherwise stack multiple identical deployment queue jobs.

### R-197: Deployment device dispatch and deferred requeues now deduplicate per deployment/device pair
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/deploymentWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/deploymentWorker.ts)

Summary:
- Deployment device dispatch now assigns stable queue identities per deployment/device pair, skips devices that already have an active or delayed queue entry, and uses a separate stable deferred identity for maintenance-window waits and retry backoff.
- This prevents repeated batch processing, retry scheduling, or maintenance-window deferrals from stacking duplicate device-execution jobs while still preserving the one future delayed run that the active worker intends to schedule.
