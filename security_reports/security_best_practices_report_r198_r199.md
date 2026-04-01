### R-198: Patch job orchestration now uses stable logical BullMQ identities
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/patchJobExecutor.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/patchJobExecutor.ts)

Summary:
- Patch job enqueue, per-device execution fanout, and completion-check scheduling now use stable BullMQ `jobId` values derived from the logical patch job and device identities, and they reuse still-active queue entries instead of blindly adding another copy.
- This closes duplicate-enqueue paths where repeated scheduler or route submissions for the same patch job could otherwise stack duplicate orchestration, completion, or per-device execution jobs.

### R-199: Patch job execution now fail-closes on the `scheduled -> running` claim boundary
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/patchJobExecutor.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/patchJobExecutor.ts)

Summary:
- Patch job orchestration now transitions a job from `scheduled` to `running` with a conditional update that only succeeds while the row is still unclaimed, and the worker aborts fanout if that claim affected no rows.
- This closes the race where duplicate `execute-patch-job` queue entries could both observe a `scheduled` job and both fan out duplicate per-device patch installs before one of them noticed the state change.
