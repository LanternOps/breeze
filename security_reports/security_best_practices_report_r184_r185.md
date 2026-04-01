# Security Report Slice: R-184 through R-185

### R-184: Backup result persistence now only finalizes in-flight backup jobs before writing snapshots or chain metadata
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/services/backupResultPersistence.ts](/Users/toddhebebrand/breeze/apps/api/src/services/backupResultPersistence.ts)

Summary:
- Backup result application now conditionally updates `backup_jobs` only while the job is still `pending` or `running`, and it aborts snapshot-file, MSSQL-chain, and GFS-retention persistence when that conditional state transition does not succeed.
- This closes a stale-result replay path where a duplicated or late backup result could previously overwrite an already-terminal job and still mutate secondary backup state such as snapshots and chains.

### R-185: All backup result consumers now use the same in-flight finalization guard for malformed, queued, and inline agent results
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/agentWs.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/backupWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/backupWorker.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/backup/mssql.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/backup/mssql.ts)
- [/Users/toddhebebrand/breeze/apps/api/src/routes/backup/hyperv.ts](/Users/toddhebebrand/breeze/apps/api/src/routes/backup/hyperv.ts)

Summary:
- The Redis-inline backup result path, the queued backup worker result path, and the manual Hyper-V and MSSQL execution paths now all finalize or fail jobs through the shared conditional helper instead of issuing unconditional `backup_jobs` updates.
- This removes several inconsistent terminal-state writes and ensures malformed or replayed backup results fail closed once the job has already left its in-flight states.
