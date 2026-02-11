# Breeze RMM - Secret Rotation Guide

This guide covers the procedures for rotating every secret and credential used by the Breeze RMM platform. Rotating secrets regularly is a fundamental security practice -- follow these procedures to avoid downtime and data loss.

---

## Table of Contents

1. [General Principles](#1-general-principles)
2. [JWT_SECRET](#2-jwt_secret)
3. [APP_ENCRYPTION_KEY](#3-app_encryption_key)
4. [MFA_ENCRYPTION_KEY](#4-mfa_encryption_key)
5. [ENROLLMENT_KEY_PEPPER / MFA_RECOVERY_CODE_PEPPER](#5-enrollment_key_pepper--mfa_recovery_code_pepper)
6. [AGENT_ENROLLMENT_SECRET](#6-agent_enrollment_secret)
7. [SESSION_SECRET](#7-session_secret)
8. [API Keys (User-Facing)](#8-api-keys-user-facing)
9. [Cloudflare API Token](#9-cloudflare-api-token)
10. [Database Credentials](#10-database-credentials)
11. [Redis Credentials](#11-redis-credentials)
12. [S3 / Object Storage Credentials](#12-s3--object-storage-credentials)
13. [TURN_SECRET (WebRTC)](#13-turn_secret-webrtc)
14. [METRICS_SCRAPE_TOKEN](#14-metrics_scrape_token)
15. [Email & SMS Provider Credentials](#15-email--sms-provider-credentials)
16. [ANTHROPIC_API_KEY](#16-anthropic_api_key)
17. [Rotation Schedule](#17-rotation-schedule)

---

## 1. General Principles

Before rotating any secret, review these rules:

- **Never rotate all secrets simultaneously.** Rotate one secret at a time and verify the system is healthy before moving on.
- **Always test in staging first.** Run the exact rotation procedure against a staging environment before touching production.
- **Keep a rollback plan.** Before changing any secret, record the current value in a secure vault (not in plaintext files or chat logs). You need it if the rotation fails.
- **Log all rotations.** Record who rotated what, when, and why in your audit trail. Breeze logs admin actions to the `audit_logs` table -- supplement this with manual entries for infrastructure-level changes.
- **Use a secrets manager.** Store all production secrets in a vault (HashiCorp Vault, AWS Secrets Manager, 1Password, etc.), not in `.env` files on disk.
- **Coordinate with your team.** Announce rotations ahead of time. Some rotations (encryption keys, database credentials) can cause brief service interruptions.

---

## 2. JWT_SECRET

**What it protects:** Signs and verifies all JWT access tokens and refresh tokens. Compromise of this secret allows forging admin tokens.

**Current implementation:** `apps/api/src/services/jwt.ts` uses `HS256` with `jose`. Access tokens expire in 15 minutes; refresh tokens in 7 days.

### Rotation Procedure (Zero-Downtime with Dual-Secret)

The dual-secret approach allows old tokens to remain valid during a transition window.

> **Note:** Breeze does not yet implement dual-secret verification out of the box. Until that feature is added, use the "hard rotation" approach below, or implement dual-secret support by modifying `verifyToken()` to try `JWT_SECRET` first, then fall back to `JWT_SECRET_PREVIOUS`.

**Step 1 -- Generate a new secret:**

```bash
openssl rand -base64 64
```

**Step 2 -- Set the previous secret (if using dual-secret):**

```bash
# In your .env or secrets manager
JWT_SECRET_PREVIOUS=<current-jwt-secret-value>
```

**Step 3 -- Update JWT_SECRET:**

```bash
JWT_SECRET=<newly-generated-secret>
```

**Step 4 -- Deploy the API.** New tokens are signed with the new secret. Old tokens are verified against `JWT_SECRET_PREVIOUS` as a fallback.

**Step 5 -- Wait for old tokens to expire.** Access tokens expire in 15 minutes. Refresh tokens expire in 7 days. Wait at least 7 days before removing the previous secret.

**Step 6 -- Remove JWT_SECRET_PREVIOUS and deploy again.**

### Hard Rotation (Simpler, Brief Disruption)

If you cannot implement dual-secret verification:

1. Generate a new secret: `openssl rand -base64 64`
2. Update `JWT_SECRET` in your environment.
3. Deploy the API.
4. **All active sessions are immediately invalidated.** Every user must log in again.

Schedule hard rotations during a maintenance window and notify users in advance.

---

## 3. APP_ENCRYPTION_KEY

**What it protects:** Encrypts sensitive data at rest in the database (SSO client secrets, integration tokens, etc.). Uses AES-256-GCM with a versioned prefix (`enc:v1:`).

**Current implementation:** `apps/api/src/services/secretCrypto.ts` derives a 256-bit key via SHA-256 from this env var.

> **WARNING:** Rotating this key without re-encrypting existing data will make all previously encrypted values unreadable. This causes permanent data loss if you do not follow the re-encryption procedure.

### Rotation Procedure

**Step 1 -- Generate a new key:**

```bash
openssl rand -hex 32
```

**Step 2 -- Record the old key.** Store it securely -- you need it for the re-encryption migration.

**Step 3 -- Run the re-encryption migration.** This script must:

1. Read each encrypted value from the database using the old key.
2. Decrypt it with the old key.
3. Re-encrypt it with the new key.
4. Write it back to the database.

```bash
# Example migration (to be created in scripts/re-encrypt-secrets.ts)
OLD_ENCRYPTION_KEY=<old-key> \
APP_ENCRYPTION_KEY=<new-key> \
npx tsx scripts/re-encrypt-secrets.ts
```

Tables and columns that contain encrypted values (prefixed with `enc:v1:`):
- SSO provider `clientSecret` fields
- Any integration credentials stored via `encryptSecret()`

**Step 4 -- Verify the migration.** Spot-check decryption of several records with the new key.

**Step 5 -- Update `APP_ENCRYPTION_KEY` in your environment to the new key.

**Step 6 -- Deploy the API.**

**Step 7 -- Delete the old key from your vault after confirming everything works.

### Rollback

If the migration fails partway through, the database may contain a mix of old-key and new-key encrypted values. To recover:

1. Keep both keys available.
2. Identify which records were migrated (check timestamps or run decryption attempts with both keys).
3. Re-run the migration for any remaining records.

---

## 4. MFA_ENCRYPTION_KEY

**What it protects:** Encrypts MFA TOTP secrets stored in the `users` table. Without the correct key, users cannot complete MFA verification.

### Rotation Procedure

The same re-encryption approach as `APP_ENCRYPTION_KEY` applies:

1. Generate new key: `openssl rand -hex 32`
2. Run a re-encryption migration targeting MFA secret columns.
3. Update `MFA_ENCRYPTION_KEY` in your environment.
4. Deploy.

> **WARNING:** If you rotate this key without re-encryption, all users with MFA enabled will be locked out of their accounts. They would need to disable and re-enable MFA, which requires admin intervention.

---

## 5. ENROLLMENT_KEY_PEPPER / MFA_RECOVERY_CODE_PEPPER

**What they protect:** These peppers are mixed into SHA-256 hashes for enrollment keys and MFA recovery codes, respectively. See `apps/api/src/services/enrollmentKeySecurity.ts`.

### Rotation Procedure

These peppers are used for one-way hashing, not encryption. Rotating them means **all existing hashes become invalid:**

- **ENROLLMENT_KEY_PEPPER:** All unexpired enrollment keys become unusable. You must regenerate enrollment keys after rotation.
- **MFA_RECOVERY_CODE_PEPPER:** All existing MFA recovery codes become invalid. Users must generate new recovery codes.

**Steps:**

1. Generate new pepper: `openssl rand -hex 32`
2. Update the env var.
3. Deploy.
4. For enrollment keys: regenerate and redistribute to anyone who needs to enroll new devices.
5. For recovery codes: notify users to regenerate their MFA recovery codes via the UI. Alternatively, an admin can trigger bulk regeneration.

Schedule this during a maintenance window and communicate the impact.

---

## 6. AGENT_ENROLLMENT_SECRET

**What it protects:** Shared secret that new agents must present during enrollment to prove they are authorized.

### Rotation Procedure

1. Generate a new secret: `openssl rand -hex 32`
2. Update `AGENT_ENROLLMENT_SECRET` in the API environment.
3. Deploy the API.

**Impact:**

- Already-enrolled agents are **not affected.** They authenticate using their individual bearer tokens (`agentTokenHash`), not the enrollment secret.
- Any pending enrollments using the old secret will fail. Redistribute the new secret to anyone deploying new agents.

```bash
# New agent enrollment with the updated secret
breeze-agent enroll <enrollment-key> \
  --server https://your-server \
  --enrollment-secret <new-enrollment-secret>
```

---

## 7. SESSION_SECRET

**What it protects:** Signs session cookies.

### Rotation Procedure

1. Generate a new secret: `openssl rand -base64 64`
2. Update `SESSION_SECRET` in your environment.
3. Deploy.
4. All active sessions are invalidated. Users must log in again.

This is low-risk and can be done during off-peak hours.

---

## 8. API Keys (User-Facing)

**What they protect:** Programmatic access to the Breeze API. Keys are stored as SHA-256 hashes.

### Rotation Procedure

API keys are managed by individual users or admins through the application:

- **Individual rotation:** Users regenerate their API key via the UI (Settings > API Keys > Regenerate) or via `POST /api/v1/api-keys`.
- **Admin revocation:** Admins can revoke any API key via the admin panel or `DELETE /api/v1/api-keys/:id`.
- **Bulk revocation:** In a security incident, an admin can revoke all API keys. Users must generate new ones.

No environment variable changes are required. The old key is immediately invalidated upon regeneration.

---

## 9. Cloudflare API Token

**What it protects:** Allows the API to manage mTLS client certificates via Cloudflare's API. Only relevant if `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are set.

### Rotation Procedure

1. Go to the Cloudflare dashboard > My Profile > API Tokens.
2. Create a new token with the same permissions as the old one (Client Certificates: Edit for the relevant zone).
3. Update `CLOUDFLARE_API_TOKEN` in your environment.
4. Deploy the API.
5. Verify by checking agent enrollment or certificate renewal.
6. Delete the old token in the Cloudflare dashboard.

**Impact:** Existing mTLS certificates already issued to agents remain valid. Only new certificate operations (enrollment, renewal) require a valid API token.

---

## 10. Database Credentials

**What they protect:** `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL` -- access to the PostgreSQL database containing all application data.

### Rotation Procedure

1. Create a new PostgreSQL user or update the existing user's password:

   ```sql
   ALTER USER breeze WITH PASSWORD 'new-secure-password';
   ```

2. Update `POSTGRES_PASSWORD` and `DATABASE_URL` in your environment:

   ```
   DATABASE_URL=postgresql://breeze:new-secure-password@localhost:5432/breeze
   ```

3. Deploy the API with a **rolling restart.** Drizzle uses connection pooling; existing connections will be dropped and re-established with the new credentials.

**Considerations:**

- If you run multiple API instances, update them all before the old password is removed.
- Test the new connection string before deploying: `psql "$DATABASE_URL" -c "SELECT 1;"`
- For zero-downtime rotation, create a second user with identical permissions, switch the app to the new user, then drop the old user.

---

## 11. Redis Credentials

**What they protect:** `REDIS_URL` -- access to the Redis instance used for BullMQ job queues, rate limiting, caching, and portal state.

### Rotation Procedure

1. Set or update the Redis password:

   ```bash
   redis-cli CONFIG SET requirepass "new-redis-password"
   # Make it persistent
   redis-cli -a "new-redis-password" CONFIG REWRITE
   ```

2. Update `REDIS_URL` in your environment:

   ```
   REDIS_URL=redis://:new-redis-password@localhost:6379
   ```

3. Restart the API and worker processes. BullMQ will reconnect automatically.

**Considerations:**

- Existing jobs in the queue are not lost -- they are persisted in Redis and will be processed after reconnection.
- If using Redis Sentinel or Cluster, update credentials on all nodes first.

---

## 12. S3 / Object Storage Credentials

**What they protect:** `S3_ACCESS_KEY`, `S3_SECRET_KEY` -- access to the object storage bucket containing scripts, logs, patch reports, and file transfers.

### Rotation Procedure

1. Create a new access key pair in your S3/R2/MinIO console.
2. Update `S3_ACCESS_KEY` and `S3_SECRET_KEY` in your environment.
3. Deploy the API.
4. Verify by uploading and downloading a test file.
5. Delete the old access key in your storage provider's console.

**Impact:** No data is lost. Objects in the bucket are unaffected by credential rotation.

---

## 13. TURN_SECRET (WebRTC)

**What it protects:** Shared secret used to generate time-limited TURN server credentials for WebRTC remote access sessions.

### Rotation Procedure

1. Generate a new secret: `openssl rand -hex 32`
2. Update `TURN_SECRET` in both the TURN server configuration and the Breeze API environment.
3. Restart the TURN server and deploy the API.

**Impact:** Active remote desktop/terminal sessions using old TURN credentials will eventually fail when credentials expire (typically after a few minutes). Users can reconnect.

---

## 14. METRICS_SCRAPE_TOKEN

**What it protects:** Bearer token required to access the `/metrics/scrape` Prometheus endpoint.

### Rotation Procedure

1. Generate a new token: `openssl rand -hex 32`
2. Update `METRICS_SCRAPE_TOKEN` in the API environment.
3. Update the corresponding `bearer_token` in your Prometheus `scrape_configs`.
4. Deploy the API and reload Prometheus configuration.

**Impact:** Prometheus will get `401` responses until its config is updated. No data loss; there will be a brief gap in metrics collection.

---

## 15. Email & SMS Provider Credentials

Covers `RESEND_API_KEY`, `SMTP_USER`/`SMTP_PASS`, `MAILGUN_API_KEY`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, and related credentials.

### Rotation Procedure

1. Rotate the credential in the provider's dashboard (Resend, Mailgun, Twilio, or your SMTP provider).
2. Update the corresponding env var(s).
3. Deploy the API.
4. Verify by triggering a test notification (e.g., password reset email, test SMS alert).

**Impact:** Notifications and MFA SMS messages will fail between the time the old credential is revoked and the new one is deployed. Keep the old credential active until the new one is deployed.

---

## 16. ANTHROPIC_API_KEY

**What it protects:** Access to the Anthropic API for the AI assistant feature.

### Rotation Procedure

1. Generate a new API key in the Anthropic console.
2. Update `ANTHROPIC_API_KEY` in your environment.
3. Deploy the API.
4. Revoke the old key in the Anthropic console.

**Impact:** AI assistant queries will fail between revocation of the old key and deployment of the new one. The rest of the platform is unaffected.

---

## 17. Rotation Schedule

Recommended rotation intervals for production deployments:

| Secret | Rotation Interval | Disruption Level |
|--------|-------------------|------------------|
| `JWT_SECRET` | Every 90 days | None (dual-secret) or sessions invalidated |
| `APP_ENCRYPTION_KEY` | Annually or on suspected compromise | Requires re-encryption migration |
| `MFA_ENCRYPTION_KEY` | Annually or on suspected compromise | Requires re-encryption migration |
| `ENROLLMENT_KEY_PEPPER` | Annually or on suspected compromise | Enrollment keys invalidated |
| `MFA_RECOVERY_CODE_PEPPER` | Annually or on suspected compromise | Recovery codes invalidated |
| `AGENT_ENROLLMENT_SECRET` | Every 90 days | New enrollments need updated secret |
| `SESSION_SECRET` | Every 90 days | Sessions invalidated |
| `DATABASE_URL` credentials | Every 90 days | Brief reconnection |
| `REDIS_URL` credentials | Every 90 days | Brief reconnection |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Every 90 days | None |
| `CLOUDFLARE_API_TOKEN` | Every 90 days | None |
| `TURN_SECRET` | Every 90 days | Active sessions may drop |
| `METRICS_SCRAPE_TOKEN` | Every 180 days | Brief metrics gap |
| Email/SMS provider keys | Per provider policy | Brief notification gap |
| `ANTHROPIC_API_KEY` | Per provider policy | AI assistant unavailable |
| User API keys | User responsibility | Immediate |

### Emergency Rotation (Security Incident)

If you suspect any secret has been compromised:

1. **Rotate the compromised secret immediately** using the procedures above.
2. **Check audit logs** for unauthorized access during the exposure window.
3. **Rotate related secrets.** If `JWT_SECRET` was compromised, also rotate `SESSION_SECRET`. If database credentials leaked, also rotate `APP_ENCRYPTION_KEY` in case encrypted data was exfiltrated.
4. **Notify affected users** if their data may have been accessed.
5. **File a post-incident report** documenting the timeline, impact, and remediation.
