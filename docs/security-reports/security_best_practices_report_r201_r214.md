# Security Best Practices Remediation Log

## R-201 through R-214

### R-201: Browser policy evaluation requests now deduplicate by org and policy within a short queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/browserSecurityJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/browserSecurityJobs.ts)

Summary:
- On-demand browser policy evaluation now assigns a stable BullMQ `jobId` derived from the organization, policy, and current short dedupe slot, and it reuses an already active or delayed queue entry instead of blindly adding another evaluation job.
- This closes a queue-amplification path where repeated route retries or policy edits for the same org/policy pair could otherwise stack duplicate full-extension evaluation work in Redis.

### R-202: Manual log correlation requests now deduplicate by logical detection parameters
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/logCorrelation.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/logCorrelation.ts)

Summary:
- Manual rules-based and ad hoc pattern-based log correlation requests now derive stable BullMQ `jobId` values from the normalized request parameters plus a short dedupe slot, and they reuse active queue entries instead of scheduling another copy.
- This closes a resource-amplification path where repeated correlation requests with the same parameters could otherwise stack duplicate expensive log-search jobs before the prior copy completed.

### R-203: User-risk recompute requests now deduplicate per organization within a short queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/userRiskJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/userRiskJobs.ts)

Summary:
- On-demand user-risk recompute now assigns a stable BullMQ `jobId` derived from the target organization and the current short dedupe slot, and it reuses an already active queue entry instead of enqueueing another org-wide recomputation.
- This closes a queue-amplification path where repeated retries of the same recompute request could otherwise stack duplicate full-org risk scoring jobs.

### R-204: Manual alert evaluation requests now deduplicate by target and queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/alertWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/alertWorker.ts)

Summary:
- On-demand device evaluation and full alert evaluation now assign stable BullMQ `jobId` values derived from the logical target plus a short dedupe slot, and they reuse already active queue entries instead of blindly enqueueing another scan.
- This closes a route-retry amplification path where repeated alert evaluation requests could otherwise stack duplicate alert-rule scans for the same device set.

### R-205: Security-posture recompute requests now deduplicate per organization within a short queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/securityPostureWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/securityPostureWorker.ts)

Summary:
- On-demand security posture recompute now assigns a stable BullMQ `jobId` per organization and short dedupe slot, and it reuses an already active queue entry instead of scheduling another org-wide posture run.
- This closes a queue-amplification path where repeated retries could otherwise stack duplicate security posture recomputations for the same organization.

### R-206: Device reliability recompute requests now deduplicate per device within a short queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/reliabilityWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/reliabilityWorker.ts)

Summary:
- On-demand device reliability recompute now assigns a stable BullMQ `jobId` derived from the device and short dedupe slot, and it reuses an already active queue entry instead of scheduling another copy.
- This closes a duplicate-enqueue path where repeated device reliability refreshes for the same device could otherwise stack redundant scoring work.

### R-207: Audit-baseline collection and drift-evaluation requests now deduplicate per organization within a short queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/auditBaselineJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/auditBaselineJobs.ts)

Summary:
- Manual audit policy collection and drift evaluation now assign stable BullMQ `jobId` values derived from the target organization and short dedupe slot, and they reuse already active queue entries instead of blindly adding another scan.
- This closes duplicate-enqueue paths where repeated audit-baseline requests could otherwise stack redundant collection and evaluation jobs for the same org.

### R-208: Manual CIS scans now deduplicate by baseline, normalized device set, and queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/cisJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/cisJobs.ts)

Summary:
- Manual CIS scan requests now normalize and sort the requested device set, derive a stable BullMQ `jobId` from the baseline, normalized target set, and short dedupe slot, and reuse already active queue entries instead of enqueueing another copy.
- This closes a route-retry amplification path where repeated CIS scan submissions for the same baseline and device set could otherwise stack duplicate benchmark runs.

### R-209: Manual offline detection requests now deduplicate by threshold and queue window
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/offlineDetector.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/offlineDetector.ts)

Summary:
- On-demand offline detection now assigns a stable BullMQ `jobId` derived from the threshold parameter and a short dedupe slot, and it reuses already active queue entries instead of scheduling another identical detection pass.
- This closes a duplicate-enqueue path where repeated test or retry calls could otherwise stack redundant full-device offline scans.

### R-210: Automation run execution now claims queue identity from the logical run ID
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/automationWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/automationWorker.ts)

Summary:
- `enqueueAutomationRun(runId)` now uses a stable BullMQ `jobId` derived from the logical automation run ID and reuses an already active queue entry instead of blindly adding another execution job for the same run row.
- This closes a duplicate-execution path where route retries, schedule retries, or concurrent callers could otherwise execute the same automation run more than once.

### R-211: Session-broker backup IPC responses now validate payload `commandId`
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/session.go)

Summary:
- Pending backup helper responses now validate the payload-level `commandId` from `backup_result` messages against the original `backup_command` request before delivering the envelope to the waiting caller.
- This closes the same payload-correlation gap previously fixed for generic command results and desktop-start replies, where a helper could reuse the right envelope ID but smuggle a different logical backup command identity in the payload.

### R-212: Only desktop-authorized helpers may update broker TCC permission state
Location:
- [/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go](/Users/toddhebebrand/breeze/agent/internal/sessionbroker/broker.go)

Summary:
- The broker now rejects unsolicited `tcc_status` messages from helpers that do not hold desktop scope, instead of accepting and storing that permission state on the session.
- This closes a trust-boundary gap where a non-desktop helper, including non-capture roles, could previously poison the broker’s macOS permission view and influence later desktop/TCC decisions.

### R-213: Log-forwarding jobs now cap queued event count and drop oversized raw payloads
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/logForwardingWorker.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/logForwardingWorker.ts)

Summary:
- Log-forwarding enqueue now trims hostname and per-event string fields, caps each queued batch to a bounded number of events, and drops `rawData` blobs whose serialized size exceeds a fixed budget.
- This closes a queue-memory amplification path where a caller could previously submit arbitrarily large event arrays or oversized raw payloads and push that unbounded body directly into Redis.

### R-214: User-risk signal-event jobs now cap string fields and reject oversized detail payloads
Location:
- [/Users/toddhebebrand/breeze/apps/api/src/jobs/userRiskJobs.ts](/Users/toddhebebrand/breeze/apps/api/src/jobs/userRiskJobs.ts)

Summary:
- User-risk signal-event enqueue now truncates oversized `eventType` and `description` fields and drops `details` objects whose serialized size exceeds a fixed budget before queueing the job.
- This closes a queue-memory amplification path where an attacker who could reach that enqueue path could otherwise stuff oversized free-form metadata into BullMQ and downstream persistence.
