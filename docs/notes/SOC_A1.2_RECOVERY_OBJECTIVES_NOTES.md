# SOC 2 A1.2 Recovery Objectives Notes (Breeze, DigitalOcean Plan)

Last updated: 2026-02-27

## Control Metadata

- Control ID: `A1.2`
- Severity: `MEDIUM`
- Control statement (summary): The entity establishes, documents, maintains, and tests recovery objectives to restore availability and data after disruptions.

## Objective of This Note

Define a practical A1.2 approach for Breeze using **DigitalOcean built-in services/features** so recovery targets are explicit, achievable, and auditable.

## Recovery Objectives (Draft Targets)

Apply these targets to production workloads:

- Platform service restoration (API/web/worker): `RTO <= 60 minutes`
- PostgreSQL data restoration point: `RPO <= 15 minutes` (target state using managed database PITR/WAL-based restore)
- Object storage restoration point: `RPO <= 24 hours` (or tighter if replication/versioning policy supports it)
- Configuration/secrets restoration point: `RPO <= 24 hours` (or on-change backup trigger)

Fallback objective when PITR is unavailable:

- Database RPO falls back to last successful backup interval.

## Scope and System Components

In scope for A1.2 recovery objectives:

- Breeze API and web services
- Breeze worker services
- PostgreSQL
- Redis
- Object storage for scripts/reports/artifacts
- TLS/cert and runtime configuration

Out of scope:

- Managed endpoint state on customer devices (agents reconnect and resync post-recovery)

## DigitalOcean-First Recovery Design (Planned State)

1. Compute / app host recovery

- Use DigitalOcean Droplets for application runtime.
- Enable **Droplet Backups** and on-demand **Snapshots** before high-risk changes.
- Keep startup/deploy automation (`scripts/prod/deploy.sh`) ready for rebuild from clean host.

2. Database recovery

- Use **DigitalOcean Managed PostgreSQL** with automated backups and point-in-time restore capability.
- Define restore runbook for:
  - cluster/node failure (service-level recovery)
  - logical corruption (restore to pre-incident timestamp)
- Document the specific restore workflow and responsible owner.

3. Cache/queue recovery

- Use **DigitalOcean Managed Redis** (or documented Redis rebuild procedure if self-managed).
- Treat Redis as recoverable runtime state where possible; ensure queue durability/retry behavior is documented.

4. Object storage recovery

- Use **DigitalOcean Spaces** for object data (or equivalent S3-compatible target).
- Enable bucket versioning/lifecycle policies and optional cross-region copy as required by retention policy.

5. Network failover / service endpoint continuity

- Use **DigitalOcean Load Balancer** health checks for service routing where applicable.
- Use **Reserved IP** failover pattern for rapid traffic cutover when running active/standby app droplets.

6. Detection and response trigger

- Use DigitalOcean Monitoring/Alerts plus Prometheus+Grafana alerts to trigger incident response rapidly.

## Recovery Procedure Expectations (A1.2)

For each critical component, procedures should define:

- owner/on-call role
- trigger conditions
- restore steps
- validation checks
- decision points (rollback vs continue)
- communication checkpoints
- expected completion time vs RTO

Primary references:

- `docs/DISASTER_RECOVERY.md`
- `docs/BACKUP_RESTORE.md`

## Evidence Model (What Auditors Will Ask For)

Keep these artifacts for each audit period:

- documented RTO/RPO targets approved by management
- DigitalOcean backup/PITR configuration evidence (screenshots/config export/change tickets)
- backup job success evidence and retention checks
- incident tickets showing restore timeline (start time, restore complete time, validation time)
- post-incident or post-test reports with measured RTO/RPO vs target
- runbook revision history (who changed, when, why)

## Implementation Plan (Recommended)

1. Baseline and ownership

- Confirm system-of-record runbook and assign A1.2 control owner + backup owner.
- Approve final production RTO/RPO values.

2. Enable/confirm DO built-ins

- Confirm Droplet backups/snapshot policy.
- Confirm Managed PostgreSQL automated backup + PITR settings.
- Confirm Spaces versioning/replication/retention policy.
- Confirm alerting and escalation paths.

3. Run tabletop + technical restore test

- Simulate database corruption and execute PITR to target time.
- Simulate app host loss and rebuild from automation.
- Record measured RTO/RPO outcomes.

4. Close gaps

- If measured outcomes exceed targets, update architecture/runbooks and retest.

## Known Risks and Assumptions

- If Managed PostgreSQL PITR is not enabled, RPO likely degrades to backup schedule.
- If app runtime is single-droplet without failover, RTO may exceed 60 minutes during host loss.
- If Spaces versioning/replication is not enabled, recovery options for deleted/corrupted objects are reduced.

## Example A1.2 Narrative (Draft)

Breeze defines and maintains recovery objectives for critical production services, including platform RTO and data RPO targets. The organization plans to meet these objectives using DigitalOcean native recovery capabilities (Droplet backups/snapshots, Managed PostgreSQL backup and point-in-time restore, Spaces data protection, and monitored service failover patterns), supported by documented recovery runbooks, assigned ownership, and periodic recovery testing with retained evidence.
