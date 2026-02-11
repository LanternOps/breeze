# Breeze RMM - Disaster Recovery Runbook

This runbook provides step-by-step procedures for recovering the Breeze RMM platform from various failure scenarios. Keep a printed or offline copy accessible -- you may need it when your infrastructure is down.

---

## Table of Contents

1. [Recovery Objectives](#1-recovery-objectives)
2. [Infrastructure Overview](#2-infrastructure-overview)
3. [Backup Requirements](#3-backup-requirements)
4. [Scenario 1: Single Service Crash](#4-scenario-1-single-service-crash)
5. [Scenario 2: Database Failure](#5-scenario-2-database-failure)
6. [Scenario 3: Complete Infrastructure Loss](#6-scenario-3-complete-infrastructure-loss)
7. [Scenario 4: Data Corruption](#7-scenario-4-data-corruption)
8. [Scenario 5: Security Incident](#8-scenario-5-security-incident)
9. [External Dependency Failover](#9-external-dependency-failover)
10. [Communication Plan](#10-communication-plan)
11. [Post-Incident Review](#11-post-incident-review)

---

## 1. Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | < 1 hour | Full service restoration from the start of recovery |
| **RPO** (Recovery Point Objective) | < 15 minutes | With continuous WAL archiving enabled |
| **RPO (fallback)** | Last backup interval | If using only periodic `pg_dump` (e.g., daily) |

These targets assume backups are current, tested, and accessible. Adjust based on your deployment and backup frequency.

---

## 2. Infrastructure Overview

Breeze RMM consists of the following services. Understand the dependency chain before attempting recovery.

```
┌─────────────────────────────────────────────────────────┐
│                    Breeze Platform                       │
│                                                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │  Astro     │  │  Hono API  │  │  BullMQ Workers    │ │
│  │  Frontend  │──│  Server    │──│  (Job Processing)  │ │
│  └────────────┘  └─────┬──────┘  └────────┬───────────┘ │
│                        │                   │             │
│              ┌─────────┼───────────────────┤             │
│              ▼         ▼                   ▼             │
│       ┌────────────┐ ┌──────┐ ┌────────────────────┐    │
│       │ PostgreSQL │ │Redis │ │ S3/R2/MinIO        │    │
│       │ (primary)  │ │      │ │ (object storage)   │    │
│       └────────────┘ └──────┘ └────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
External    Go Agents
Services    (10,000+)
```

### Service Dependencies

| Service | Depends On | Impact If Down |
|---------|-----------|----------------|
| **Astro Frontend** | API Server | UI unavailable; agents unaffected |
| **Hono API Server** | PostgreSQL, Redis | All API calls fail; agents queue locally |
| **BullMQ Workers** | Redis, PostgreSQL | Jobs queue but do not execute |
| **PostgreSQL** | Disk, Network | All reads/writes fail; complete outage |
| **Redis** | Memory, Disk | Job queuing, rate limiting, caching fail |
| **S3/MinIO** | Network, Disk | Script downloads, file transfers fail |
| **Go Agents** | API Server (heartbeat) | Agents operate independently; buffer data locally |

### External Services (Optional)

| Service | Used For | Failover Behavior |
|---------|----------|-------------------|
| **Cloudflare** | mTLS cert management, DNS, WAF | Existing certs remain valid; new enrollments fail |
| **Resend / Mailgun / SMTP** | Email notifications | Alerts queue; no email delivery until restored |
| **Twilio** | SMS MFA, SMS alerts | MFA falls back to TOTP app; SMS alerts queue |
| **Anthropic** | AI assistant | AI features unavailable; core platform unaffected |
| **Sentry** | Error tracking | Errors not reported; platform unaffected |

---

## 3. Backup Requirements

### What to Back Up

| Component | Method | Frequency | Retention |
|-----------|--------|-----------|-----------|
| **PostgreSQL data** | `pg_dump` + continuous WAL archiving | Daily full dump + continuous WAL | 30 days full, 7 days WAL |
| **Object storage** | S3 cross-region replication or daily `rclone sync` | Daily | 30 days |
| **Configuration** | Encrypted backup of `.env`, certs, and secrets | On every change | 90 days |
| **TLS/mTLS certificates** | Backup private keys and cert files | On every change | Until expiry + 30 days |
| **Go agents** | No backup needed | N/A | Agents auto-reconnect and re-sync |

### PostgreSQL Backup Commands

**Daily full dump:**

```bash
pg_dump -Fc -Z9 \
  --file="/backups/breeze-$(date +%Y%m%d-%H%M%S).dump" \
  "$DATABASE_URL"
```

**Continuous WAL archiving (in `postgresql.conf`):**

```
wal_level = replica
archive_mode = on
archive_command = 'cp %p /wal-archive/%f'
```

**Configuration backup:**

```bash
# Encrypt and store .env and certs
tar czf - .env certs/ | \
  gpg --symmetric --cipher-algo AES256 \
  > "/backups/config-$(date +%Y%m%d).tar.gz.gpg"
```

### Backup Verification

Test your backups at least monthly:

1. Restore a `pg_dump` to a test database and run integrity checks.
2. Verify WAL replay by performing point-in-time recovery to a test instance.
3. Decrypt and inspect your configuration backup.
4. Confirm object storage sync by comparing file counts and checksums.

---

## 4. Scenario 1: Single Service Crash

Covers: API server crash, Redis crash, BullMQ worker crash, or frontend crash.

### Detection

- Health check endpoint returns non-200: `GET /health`
- Prometheus alerts fire (e.g., `BreezeApiDown`, `RedisDown`)
- Grafana dashboard shows service as unreachable
- Agents report connection failures in their local logs

### Immediate Actions (First 5 Minutes)

1. **Identify which service crashed** by checking process status and logs:

   ```bash
   # Check API server
   systemctl status breeze-api
   journalctl -u breeze-api --since "5 minutes ago" --no-pager

   # Check Redis
   systemctl status redis
   redis-cli ping

   # Check BullMQ workers
   systemctl status breeze-worker
   journalctl -u breeze-worker --since "5 minutes ago" --no-pager

   # Check frontend
   systemctl status breeze-web
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4321
   ```

2. **Check for obvious causes:** disk full, OOM kill, network partition, misconfiguration.

   ```bash
   df -h                    # Disk space
   free -m                  # Memory
   dmesg | tail -20         # Kernel messages (OOM kills)
   ```

### Recovery Steps

**API Server:**

```bash
systemctl restart breeze-api
# If the service fails to start, check logs:
journalctl -u breeze-api -n 100 --no-pager
# Verify database connectivity:
psql "$DATABASE_URL" -c "SELECT 1;"
# Verify Redis connectivity:
redis-cli -u "$REDIS_URL" ping
```

**Redis:**

```bash
systemctl restart redis
# Verify data persistence:
redis-cli info persistence | grep rdb_last_bgsave_status
# Check memory:
redis-cli info memory | grep used_memory_human
```

**BullMQ Workers:**

```bash
systemctl restart breeze-worker
# Check for stuck jobs:
# Jobs are durable in Redis -- they will resume processing after restart
```

**Frontend:**

```bash
systemctl restart breeze-web
curl -s http://localhost:4321 | head -5
```

### Verification

1. Health check passes: `curl http://localhost:3001/health`
2. Agents reconnect (check WebSocket connection count in Prometheus/Grafana).
3. Submit a test action through the UI (e.g., run a script on a test device).
4. Check BullMQ dashboard or Redis for job queue backlog clearing.

---

## 5. Scenario 2: Database Failure

Covers: PostgreSQL crash, corruption, disk failure, or accidental data deletion.

### Detection

- API returns 500 errors on all database-dependent routes
- `psql "$DATABASE_URL" -c "SELECT 1;"` fails
- PostgreSQL logs show `FATAL` or `PANIC` entries
- Prometheus `pg_up` metric drops to 0

### Immediate Actions (First 5 Minutes)

1. **Assess the failure type:**

   ```bash
   # Is PostgreSQL running?
   systemctl status postgresql
   pg_isready -h localhost -p 5432

   # Check PostgreSQL logs
   tail -100 /var/log/postgresql/postgresql-*.log

   # Check disk health
   df -h /var/lib/postgresql
   smartctl -a /dev/sda  # If applicable
   ```

2. **Do not attempt writes.** If the database is partially running but corrupt, stop it to prevent further damage:

   ```bash
   systemctl stop postgresql
   ```

3. **Notify the team** (see [Communication Plan](#10-communication-plan)).

### Recovery Steps

#### Option A: Restart (Simple Crash, No Corruption)

```bash
systemctl start postgresql
pg_isready -h localhost -p 5432
# Run a quick integrity check:
psql "$DATABASE_URL" -c "SELECT count(*) FROM devices;"
```

#### Option B: Restore from pg_dump (Data Loss Up to Last Backup)

```bash
# 1. Stop all Breeze services
systemctl stop breeze-api breeze-worker breeze-web

# 2. Drop and recreate the database
psql -U postgres -c "DROP DATABASE IF EXISTS breeze;"
psql -U postgres -c "CREATE DATABASE breeze OWNER breeze;"

# 3. Restore from the latest dump
pg_restore -d breeze -U breeze --no-owner \
  /backups/breeze-YYYYMMDD-HHMMSS.dump

# 4. Run Drizzle migrations to ensure schema is current
cd /path/to/breeze && pnpm db:push

# 5. Restart services
systemctl start breeze-api breeze-worker breeze-web
```

#### Option C: Point-in-Time Recovery (WAL Replay, Minimal Data Loss)

```bash
# 1. Stop PostgreSQL
systemctl stop postgresql

# 2. Move the corrupted data directory
mv /var/lib/postgresql/16/main /var/lib/postgresql/16/main.corrupt

# 3. Restore the base backup
pg_basebackup_restore /backups/base/ /var/lib/postgresql/16/main

# 4. Create recovery.conf (or recovery.signal for PG 12+)
cat > /var/lib/postgresql/16/main/recovery.signal <<EOF
EOF

# Add to postgresql.conf:
# restore_command = 'cp /wal-archive/%f %p'
# recovery_target_time = '2026-02-11 14:30:00 UTC'  # Set to just before the failure

# 5. Start PostgreSQL -- it will replay WAL files
systemctl start postgresql

# 6. Verify recovery
psql "$DATABASE_URL" -c "SELECT max(created_at) FROM audit_logs;"

# 7. Restart Breeze services
systemctl start breeze-api breeze-worker breeze-web
```

### Verification

1. `psql "$DATABASE_URL" -c "SELECT count(*) FROM devices;"` returns expected count.
2. API health check passes.
3. Log in to the UI and verify recent data is present.
4. Check audit logs for the expected most-recent entry.
5. Run `pnpm db:push` with `--dry-run` (if supported) to confirm schema matches.

---

## 6. Scenario 3: Complete Infrastructure Loss

Covers: data center failure, cloud region outage, catastrophic hardware failure, or accidental infrastructure deletion.

### Detection

- All services unreachable
- Cloud provider status page confirms regional outage
- Monitoring systems (if hosted externally) show all targets down

### Immediate Actions (First 5 Minutes)

1. **Confirm the scope.** Is it your infrastructure or a provider-wide outage? Check cloud provider status pages.
2. **Activate the communication plan** (see [Communication Plan](#10-communication-plan)).
3. **Locate your backups.** Confirm access to:
   - Database backups (stored off-site / cross-region)
   - Configuration backups (`.env`, certs)
   - Object storage backups

### Recovery Steps

**Step 1 -- Provision new infrastructure:**

```bash
# Using your IaC tool (Terraform, Pulumi, etc.) or manual provisioning:
# - 1x application server (API + frontend + workers)
# - 1x PostgreSQL instance
# - 1x Redis instance
# - 1x S3-compatible object storage bucket
```

**Step 2 -- Restore configuration:**

```bash
# Decrypt the configuration backup
gpg --decrypt /offsite-backups/config-YYYYMMDD.tar.gz.gpg | tar xzf -
# Review .env and update hostnames/IPs for the new infrastructure
```

**Step 3 -- Restore the database:**

```bash
# Create the database
psql -U postgres -c "CREATE DATABASE breeze OWNER breeze;"

# Restore from the latest off-site backup
pg_restore -d breeze -U breeze --no-owner \
  /offsite-backups/breeze-YYYYMMDD-HHMMSS.dump
```

**Step 4 -- Restore object storage:**

```bash
# Sync from backup location
rclone sync offsite-backup:breeze-backup s3:breeze
```

**Step 5 -- Deploy the application:**

```bash
# Clone the repo, install dependencies, start services
git clone <repo-url> /opt/breeze
cd /opt/breeze && pnpm install
pnpm db:push  # Ensure schema is current

# Start all services
systemctl start breeze-api breeze-worker breeze-web
```

**Step 6 -- Update DNS and networking:**

- Point DNS records to the new infrastructure.
- Update Cloudflare WAF rules if applicable.
- Update any firewall rules or security groups.

**Step 7 -- Wait for agents to reconnect.** Agents will automatically retry connections to the API server. If the DNS/IP changed, agents that use a hostname will reconnect after DNS propagation. Agents using a hardcoded IP will need manual reconfiguration.

### Verification

1. All health checks pass.
2. UI is accessible and data is present.
3. Agent count in the dashboard approaches the expected number (give it 30-60 minutes for all agents to reconnect).
4. Run a test script on a device to verify end-to-end functionality.
5. Confirm BullMQ workers are processing jobs.
6. Verify monitoring (Prometheus/Grafana) is collecting metrics from the new infrastructure.

---

## 7. Scenario 4: Data Corruption

Covers: corrupt database records, application bugs that wrote bad data, ransomware encryption of database files.

### Detection

- Application errors referencing malformed data (decryption failures, JSON parse errors, constraint violations)
- Unexpected values in the UI or API responses
- Database integrity check failures
- Files in object storage that cannot be read or have unexpected sizes

### Immediate Actions (First 5 Minutes)

1. **Stop the bleeding.** If the corruption is being caused by an active process (runaway script, bad migration, compromised account):

   ```bash
   # Identify and stop the offending process
   # If unsure, put the API in maintenance mode or stop it:
   systemctl stop breeze-api breeze-worker
   ```

2. **Take a snapshot.** Before making any changes, capture the current state:

   ```bash
   pg_dump -Fc "$DATABASE_URL" > /backups/pre-recovery-snapshot.dump
   ```

3. **Identify the scope.** Which tables/records are affected?

   ```sql
   -- Example: find records with corrupted encrypted values
   SELECT id, created_at FROM sso_providers
   WHERE client_secret NOT LIKE 'enc:v1:%' AND client_secret IS NOT NULL;

   -- Example: find devices with invalid status
   SELECT id, status, updated_at FROM devices
   WHERE status NOT IN ('online', 'offline', 'pending', 'quarantined');
   ```

### Recovery Steps

#### Option A: Targeted Fix (Few Records Affected)

1. Identify all corrupted records.
2. Restore correct values from backup:

   ```bash
   # Restore the backup to a temporary database
   createdb breeze_recovery
   pg_restore -d breeze_recovery /backups/breeze-YYYYMMDD.dump

   # Query the correct values from the recovery database
   psql breeze_recovery -c "SELECT id, column FROM table WHERE id IN (...);"

   # Update the production database with correct values
   psql "$DATABASE_URL" -c "UPDATE table SET column = 'correct_value' WHERE id = '...';"

   # Clean up
   dropdb breeze_recovery
   ```

3. Restart services and verify.

#### Option B: Point-in-Time Recovery (Widespread Corruption)

Use the WAL-based PITR procedure from [Scenario 2, Option C](#option-c-point-in-time-recovery-wal-replay-minimal-data-loss). Set `recovery_target_time` to just before the corruption event.

#### Option C: Full Restore (Ransomware or Catastrophic Corruption)

1. Wipe the affected systems.
2. Follow the [Complete Infrastructure Loss](#6-scenario-3-complete-infrastructure-loss) procedure.
3. Restore from the last known-good backup.

### Verification

1. Run integrity queries to confirm corrupted records are fixed.
2. Spot-check data in the UI.
3. Verify encrypted fields can be decrypted: test SSO login, API key validation, etc.
4. Review audit logs to understand what caused the corruption and prevent recurrence.

---

## 8. Scenario 5: Security Incident

Covers: unauthorized access, credential compromise, data exfiltration, compromised agent, or supply chain attack.

### Detection

- Unexpected entries in audit logs (unfamiliar IPs, actions, or user agents)
- Alerts from monitoring (anomalous API request patterns, failed auth spikes)
- External notification (security researcher, customer report, threat intelligence)
- Unexpected changes to configuration, users, or permissions

### Immediate Actions (First 5 Minutes)

1. **Contain the threat.** Do not shut down systems unless actively being attacked -- you need the logs.

   ```bash
   # Block suspicious IPs at the firewall/WAF level
   # If using Cloudflare:
   # Add the IP to a Cloudflare WAF block rule

   # If a specific user account is compromised:
   # Disable the account via the admin API
   curl -X PATCH https://your-server/api/v1/users/<user-id> \
     -H "Authorization: Bearer <admin-token>" \
     -d '{"isActive": false}'

   # If an agent is compromised:
   # Revoke its token by clearing agentTokenHash
   psql "$DATABASE_URL" -c \
     "UPDATE devices SET agent_token_hash = NULL, status = 'quarantined' WHERE id = '<device-id>';"
   ```

2. **Preserve evidence.** Capture logs and state before they rotate:

   ```bash
   # Database audit logs
   psql "$DATABASE_URL" -c \
     "COPY (SELECT * FROM audit_logs WHERE created_at > now() - interval '24 hours') TO '/tmp/audit-export.csv' CSV HEADER;"

   # Application logs
   journalctl -u breeze-api --since "24 hours ago" > /tmp/api-logs.txt

   # Redis data (rate limit keys can show attack patterns)
   redis-cli -u "$REDIS_URL" --scan --pattern "rl:*" > /tmp/redis-rate-limit-keys.txt
   ```

3. **Notify the incident response team** (see [Communication Plan](#10-communication-plan)).

### Recovery Steps

**Step 1 -- Rotate all compromised credentials:**

Follow the [Secret Rotation Guide](SECRET_ROTATION.md). At minimum:

- Rotate `JWT_SECRET` (invalidates all sessions)
- Rotate `SESSION_SECRET`
- Revoke all API keys
- Rotate database and Redis credentials if the attacker had infrastructure access

**Step 2 -- Audit access:**

```sql
-- Recent admin actions
SELECT * FROM audit_logs
WHERE created_at > now() - interval '7 days'
ORDER BY created_at DESC
LIMIT 500;

-- Recently modified users
SELECT id, email, updated_at, is_active FROM users
WHERE updated_at > now() - interval '7 days'
ORDER BY updated_at DESC;

-- Recently enrolled devices (attacker may have enrolled rogue agents)
SELECT id, hostname, org_id, created_at FROM devices
WHERE created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```

**Step 3 -- Restore from known-good state (if necessary):**

If the attacker modified data, perform a targeted or full restore from a backup predating the compromise. See [Scenario 4](#7-scenario-4-data-corruption).

**Step 4 -- Harden:**

- Enable MFA for all admin accounts if not already required.
- Review and tighten CORS, rate limits, and IP allowlists.
- Update the `AGENT_ENROLLMENT_SECRET` to prevent rogue agent enrollment.
- Review Cloudflare WAF rules.

**Step 5 -- Monitor for re-entry:**

- Watch audit logs closely for 30 days.
- Set up additional alerts for the attacker's known patterns (IPs, user agents, API call patterns).

### Verification

1. All compromised credentials have been rotated.
2. Unauthorized accounts/agents have been removed or disabled.
3. Audit logs show no further suspicious activity.
4. All legitimate users can access the system (they may need to log in again after credential rotation).
5. Agent enrollment is working with the new enrollment secret.

---

## 9. External Dependency Failover

### PostgreSQL

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| Primary crash | Full outage | Automatic failover to replica (if configured), or manual restore from backup |
| Replication lag | Stale reads | Monitor `pg_stat_replication`; alert on lag > 30s |
| Disk full | Write failures | Monitor disk usage; alert at 80%; auto-expand if cloud-hosted |

### Redis

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| Crash | Job queuing and rate limiting fail | Restart; data persists via RDB/AOF |
| Memory exhaustion | Eviction of keys | Set `maxmemory-policy` to `noeviction` for BullMQ; monitor memory |
| Network partition | Connection errors | Reconnection is automatic (ioredis retry) |

### S3 / MinIO / Object Storage

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| Provider outage | Script downloads and file transfers fail | Cross-region replication; cache frequently used scripts locally |
| Bucket deletion | Data loss | Versioning enabled; cross-region backup |
| Credential expiry | Access denied | Monitor credential expiry; see Secret Rotation Guide |

### Cloudflare (Optional)

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| API outage | Cannot issue or renew mTLS certs | Existing certs remain valid; enrollment queues until restored |
| WAF misconfiguration | Legitimate traffic blocked | Maintain a bypass rule for critical paths (`/renew-cert`, health checks) |
| DNS outage | Platform unreachable | Maintain fallback DNS records with a secondary provider |

### Email / SMS Providers

| Failure Mode | Impact | Mitigation |
|-------------|--------|------------|
| Resend/Mailgun outage | Email notifications and password resets fail | Fall back to SMTP provider (set `EMAIL_PROVIDER=smtp` or use `auto` mode) |
| Twilio outage | SMS MFA and SMS alerts fail | Users fall back to TOTP app-based MFA; alerts queue for retry |

---

## 10. Communication Plan

### Internal Notification Chain

| Priority | Who to Notify | Method | Timeframe |
|----------|--------------|--------|-----------|
| **P1** (full outage) | On-call engineer, Engineering lead, CTO | PagerDuty / phone call | Immediately |
| **P2** (degraded service) | On-call engineer, Engineering lead | Slack #incidents | Within 5 minutes |
| **P3** (minor issue) | On-call engineer | Slack #ops | Within 15 minutes |
| **Security incident** | On-call engineer, Security lead, CTO, Legal | Phone call + encrypted channel | Immediately |

### External Communication

**Status page updates** (post to your status page or notify customers via email):

| Timing | Update |
|--------|--------|
| As soon as detected | "We are investigating reports of [service degradation / outage]. We will provide updates every 30 minutes." |
| During recovery | "We have identified the issue and are actively working on restoration. Current ETA: [time]." |
| After resolution | "The issue has been resolved. [Brief description of what happened and what was affected]. We will publish a full incident report within 48 hours." |

### Customer Notification Templates

**Service outage:**

> Subject: [Breeze RMM] Service Disruption - [Date]
>
> We are currently experiencing a service disruption affecting [specific functionality]. Our team is actively working on restoration.
>
> **Impact:** [What customers cannot do]
> **Workaround:** [If any -- e.g., "Agents continue to operate locally and will sync when connectivity is restored"]
> **ETA:** [Estimated restoration time]
>
> We will send another update in 30 minutes or when the issue is resolved.

**Security incident:**

> Subject: [Breeze RMM] Security Notice - [Date]
>
> We have identified and contained a security incident affecting [scope]. We are conducting a thorough investigation.
>
> **What happened:** [Brief, factual description]
> **What data was affected:** [Be specific]
> **What we have done:** [Actions taken]
> **What you should do:** [Recommended actions -- e.g., "rotate your API keys", "review audit logs"]
>
> We take the security of your data seriously and will provide a full incident report within [timeframe].

---

## 11. Post-Incident Review

Every P1 and P2 incident, and every security incident, must have a post-incident review within 48 hours.

### Review Template

```markdown
## Incident Report: [Title]

**Date:** [Date and time range]
**Duration:** [Total time from detection to resolution]
**Severity:** [P1/P2/P3]
**Author:** [Name]

### Timeline
- HH:MM - [Event: what happened]
- HH:MM - [Detection: how we found out]
- HH:MM - [Response: what we did]
- HH:MM - [Resolution: when service was restored]

### Root Cause
[What actually caused the incident]

### Impact
- [Number of affected users/agents]
- [Duration of outage/degradation]
- [Data loss, if any]

### What Went Well
- [Things that worked as expected]

### What Went Wrong
- [Things that failed or were slower than expected]

### Action Items
| Action | Owner | Due Date |
|--------|-------|----------|
| [Specific action] | [Name] | [Date] |

### Lessons Learned
[Key takeaways for preventing recurrence]
```

### Review Principles

- **Blameless.** Focus on systems and processes, not individuals.
- **Specific.** Every action item must have an owner and a deadline.
- **Shared.** Publish the report internally so the entire team learns from it.
- **Follow through.** Track action items to completion. Review open items weekly.
