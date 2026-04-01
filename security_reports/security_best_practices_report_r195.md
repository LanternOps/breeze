### R-195: Sensitive-data throttling requeues now preserve stable scan queue identity
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/sensitiveDataJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/sensitiveDataJobs.ts)

Summary:
- Sensitive-data scan dispatch now goes through a shared helper that reuses the stable BullMQ `jobId` derived from the logical scan ID and reuses an already active or delayed queue entry instead of blindly adding another dispatch job.
- The throttle/backpressure requeue path now uses that same helper, so repeated org-cap or device-cap throttling for the same scan cannot silently stack duplicate delayed dispatch jobs in Redis.
