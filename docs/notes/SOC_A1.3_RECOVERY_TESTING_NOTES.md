# SOC 2 A1.3 Recovery Testing Notes (Breeze, DigitalOcean Plan)

Last updated: 2026-02-28

## Control Metadata

- Control ID: `A1.3`
- Severity: `MEDIUM`
- Control statement (summary): The entity tests recovery capabilities periodically, evaluates results against recovery objectives, and updates procedures based on findings.

## Objective of This Note

Define a repeatable, auditable recovery testing program for Breeze that validates A1.2 recovery objectives using DigitalOcean-native capabilities and existing Breeze runbooks.

## Testing Scope

In scope:

- Application service recovery (API/web/worker)
- PostgreSQL recovery (backup restore and/or point-in-time restore)
- Redis recovery/rebuild behavior
- Object storage recovery for critical artifacts
- Configuration/secrets restoration

Out of scope:

- Managed endpoint local state on customer devices (agents reconnect/resync after platform restoration)

## Test Cadence (Draft)

- Monthly: one focused technical restore test (rotating scenario)
- Quarterly: one broader resilience exercise (multi-component)
- Annually: full disaster recovery simulation against declared RTO/RPO objectives

## Recovery Test Types

1. Tabletop exercises

- Walk through incident detection, decision-making, communications, and runbook steps.
- Validate ownership clarity, escalation, and external communication templates.

2. Technical restore tests

- Execute actual restore/failover actions in a controlled environment.
- Record measured:
  - detection-to-response time
  - restoration completion time (RTO)
  - restore point achieved (RPO)

3. Post-incident validation

- For real incidents that trigger recovery workflows, treat incident review as A1.3 evidence when timings and outcomes are documented.

## Planned Test Scenarios (DigitalOcean-Focused)

1. Managed PostgreSQL logical corruption drill

- Perform PITR restore to a timestamp before injected corruption.
- Validate application integrity after reconnect.

2. App host loss drill

- Simulate primary Droplet loss and rebuild/cutover using deployment automation.
- Validate health checks, login flow, command queue processing.

3. Redis service recovery drill

- Simulate Redis service interruption and validate queue processing recovery behavior.

4. Spaces object recovery drill

- Simulate accidental object deletion and recover via versioning/replication/backup workflow.

5. Config and secret restoration drill

- Restore encrypted configuration backup and verify secure runtime startup.

## Pass/Fail Criteria (Draft)

For each test:

- documented runbook was followed (or deviations captured)
- target RTO met (or exception documented with root cause)
- target RPO met (or exception documented)
- service validation checks passed (health endpoints, key workflows)
- corrective actions assigned with owner and due date

## Evidence to Retain

Per test execution, retain:

- test plan (date, scenario, participants, preconditions)
- execution log/timeline with UTC timestamps
- screenshots/logs from DigitalOcean and monitoring stack
- measured RTO/RPO calculation sheet
- validation checklist results
- post-test report (findings, decisions, action items)
- proof of remediation completion for prior findings

Suggested retention period: align with SOC audit evidence retention policy (typically at least 12 months).

Recommended report template:

- `docs/notes/SOC_A1.3_RECOVERY_TEST_REPORT_TEMPLATE.md`

## Roles and Responsibilities (Draft)

- Control owner: Operations/SRE lead
- Test coordinator: Incident manager or designated backup
- Approver: Engineering leadership
- Review participants: Platform engineer, database owner, security/compliance representative

## Integration with Existing Breeze Docs

Primary runbooks/procedures:

- `docs/DISASTER_RECOVERY.md`
- `docs/BACKUP_RESTORE.md`
- `scripts/prod/deploy.sh` (rebuild/deploy automation)

## Continuous Improvement Loop

After each test:

1. Publish post-test report within 5 business days.
2. Track remediation items in ticketing system.
3. Update runbooks and thresholds as needed.
4. Schedule retest for any failed objective.

## Example A1.3 Narrative (Draft)

Breeze performs recurring recovery testing through tabletop and technical restore exercises that validate documented recovery objectives for critical systems. Test results are measured against RTO/RPO targets, exceptions are recorded with corrective actions, and recovery procedures are updated based on lessons learned. Evidence of tests, outcomes, and remediation is retained for audit support.
