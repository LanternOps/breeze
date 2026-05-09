# Security Report Slice: R-189 through R-190

### R-189: Discovery job creation now acquires a transaction-scoped per-profile lock and reuses active jobs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/discoveryJobCreation.ts](/Users/toddhebebrand/breeze/apps/api/src/services/discoveryJobCreation.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/discovery.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/discovery.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/discoveryWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/discoveryWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/networkBaselineWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/networkBaselineWorker.ts)

Summary:
- Discovery job creation now runs under a transaction-scoped advisory lock keyed by organization and profile, checks for existing `scheduled` or `running` discovery jobs inside that lock, and reuses the active row instead of blindly inserting another one.
- Manual `/discovery/scan` now returns `409` when a profile already has an active job, scheduled profile runs skip duplicate creation, and baseline-triggered discovery scans reuse the existing discovery job ID.
- This closes a race where concurrent manual, scheduled, or baseline-triggered scans for the same profile could previously create duplicate active discovery jobs.

### R-190: Discovery and network-baseline queue submissions now use stable logical BullMQ job IDs
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/discoveryWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/discoveryWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/networkBaselineWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/networkBaselineWorker.ts)

Summary:
- Discovery dispatch and result-processing queue submissions now use stable BullMQ job IDs derived from the discovery job ID, and network-baseline execute/compare queue submissions now use stable IDs derived from the baseline and discovery job IDs.
- This closes duplicate-enqueue paths where repeated submissions for the same discovery or baseline workflow could otherwise stack multiple identical queue jobs before the row-level state guards executed.
