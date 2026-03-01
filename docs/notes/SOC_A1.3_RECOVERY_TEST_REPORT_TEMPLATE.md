# SOC A1.3 Recovery Test Report Template (Breeze)

Use this template for each recovery test execution (monthly/quarterly/annual).  
Store completed reports in your compliance evidence repository with immutable timestamps.

## 1) Test Metadata

- Report ID:
- Test date (UTC):
- Prepared by:
- Reviewed by:
- Approved by:
- Environment: (`production` / `staging` / `isolated DR test`)
- Control mapping: `A1.3` (supports `A1.2`)

## 2) Scenario Definition

- Scenario name:
- Scenario type: (`tabletop` / `technical restore` / `post-incident validation`)
- Trigger simulated:
- Components in scope:
- Preconditions verified:
- Success criteria:

## 3) Recovery Objectives for This Test

- Target RTO:
- Target RPO:
- Objective source document/version:

## 4) Timeline (UTC)

| Time (UTC) | Event |
|---|---|
|  | Detection time |
|  | Incident declared |
|  | Recovery started |
|  | Service restored |
|  | Data validation complete |
|  | Incident/test closed |

## 5) Execution Summary

- Actions taken:
- DigitalOcean features used (check all that apply):
  - [ ] Droplet Backup
  - [ ] Droplet Snapshot
  - [ ] Managed PostgreSQL restore
  - [ ] Managed PostgreSQL PITR
  - [ ] Managed Redis recovery/rebuild
  - [ ] Spaces version restore
  - [ ] Spaces replication recovery
  - [ ] Load Balancer failover
  - [ ] Reserved IP cutover
  - [ ] Monitoring/alerting triggered
- Deviations from runbook:

## 6) Measured Results

- Measured RTO:
- Measured RPO:
- RTO objective met: (`yes` / `no`)
- RPO objective met: (`yes` / `no`)

If objective not met:

- Root cause:
- Impact:
- Immediate mitigation:

## 7) Validation Checks

- [ ] API health endpoint passes
- [ ] Web login flow functional
- [ ] Worker queue processing resumed
- [ ] Database integrity checks pass
- [ ] Critical object storage artifacts accessible
- [ ] Monitoring dashboards/alerts normal
- [ ] Security controls remain intact after restore

Validation notes:

## 8) Evidence Attached

- [ ] DO screenshots/restore logs
- [ ] Prometheus/Grafana timeline export
- [ ] Command logs / deployment logs
- [ ] Ticket/incident transcript
- [ ] Runbook copy used in test
- [ ] Any SQL/data integrity verification output

Evidence links/paths:

## 9) Findings and Corrective Actions

| Finding ID | Severity | Description | Owner | Due Date | Status |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## 10) Final Outcome

- Overall test status: (`pass` / `pass with exceptions` / `fail`)
- Residual risk accepted by:
- Retest required: (`yes` / `no`)
- Retest date (if required):

## 11) Sign-Off

- Control owner sign-off:
- Engineering approver sign-off:
- Compliance/security sign-off:
