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

**What it protects:** Encrypts sensitive data at rest in the database (SSO client secrets, integration tokens, etc.). Uses AES-256-GCM with versioned prefixes (`enc:v1:` legacy ciphertexts and `enc:v2:<keyId>:` key-id ciphertexts).

**Current implementation:** `apps/api/src/services/secretCrypto.ts` derives 256-bit AES keys via SHA-256 from configured secret strings. Legacy `enc:v1:` values use `APP_ENCRYPTION_KEY` (or `SSO_ENCRYPTION_KEY` / `SECRET_ENCRYPTION_KEY` aliases). When `APP_ENCRYPTION_KEY_ID` or `SECRET_ENCRYPTION_KEY_ID` is configured, new writes use `enc:v2:<keyId>:` and decrypt by key ID from the active key or keyring.

> **WARNING:** Rotating this key without re-encrypting existing data will make all previously encrypted values unreadable -- unless those rows are still decryptable via the legacy fallback chain (see below). Always run the re-encrypt script before retiring any old key material.

### Rotation Status

Breeze can read both legacy `enc:v1:` values and key-id based
`enc:v2:<keyId>:` values. New encryption remains `enc:v1:` unless an active key
ID is configured, which preserves compatibility for deployments that have not
started a key-id migration.

### Read-Side Legacy Fallback Chain (v0.65.0+)

When the primary `APP_ENCRYPTION_KEY` (or `SSO_ENCRYPTION_KEY` /
`SECRET_ENCRYPTION_KEY` alias) fails to decrypt an `enc:v1:` row,
`decryptSecret()` retries with a fixed legacy chain:

1. `JWT_SECRET`
2. `SESSION_SECRET`

This lets operators upgrade to a dedicated `APP_ENCRYPTION_KEY` without first
re-encrypting every row -- rows written by older builds (when the encryption
key was derived from `JWT_SECRET` / `SESSION_SECRET`) still decrypt
transparently. New writes always use the active key. The fallback only applies
to `enc:v1:`; unknown `enc:v2:` key IDs fail closed.

When a fallback decrypt succeeds, the API logs the following warning **once
per process per row** (suppressed in tests):

```
[secretCrypto] Decrypted enc:v1: row with legacy fallback key. Run scripts/re-encrypt-secrets.ts to re-encrypt under APP_ENCRYPTION_KEY.
```

This warning is your migration indicator. Tail the API logs after deploying a
new `APP_ENCRYPTION_KEY` -- if no warnings appear over a representative
window, the legacy fallback path is no longer reachable and you can safely
rotate `JWT_SECRET` / `SESSION_SECRET` independently.

Supported key-id environment variables:

```bash
APP_ENCRYPTION_KEY_ID=app-2026-05
APP_ENCRYPTION_KEYRING='{"app-2026-05":"current-secret","app-2025-11":"previous-secret"}'
```

`SECRET_ENCRYPTION_KEY_ID` and `SECRET_ENCRYPTION_KEYRING` are supported aliases.
If both `APP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEYRING` are present, the
keyring entry for the active key ID is used for new `enc:v2` writes. This lets
operators keep the legacy `APP_ENCRYPTION_KEY` available to decrypt old
`enc:v1` ciphertext while writing new ciphertext with the active keyring key.
Unknown `enc:v2` key IDs fail closed.

Routine in-place rotation is supported through the encrypted-column registry in
`apps/api/src/services/encryptedColumnRegistry.ts` and the dry-run-capable
script at `scripts/re-encrypt-secrets.ts`. Do not perform manual SQL rewrites;
the registry covers text, text-array, and JSON secret locations used by
`encryptSecret()`.

### Rotation Procedure (v0.65.0+)

This procedure assumes you are rotating the dedicated `APP_ENCRYPTION_KEY`
itself. For keyring-driven `enc:v2` key-ID rotations, see the next subsection.

1. **Generate the new key:** `openssl rand -hex 32`.
2. **Set the new `APP_ENCRYPTION_KEY` in your environment.** Leave
   `JWT_SECRET` and `SESSION_SECRET` in place -- the read-side legacy
   fallback chain uses them to decrypt any `enc:v1:` rows that were written
   by older builds. **Do not** rotate `JWT_SECRET` or `SESSION_SECRET` in the
   same change; their unchanged values are what keep legacy ciphertext
   readable while the re-encrypt script runs.
3. **Deploy the API.** New writes use the new `APP_ENCRYPTION_KEY`. Existing
   rows decrypt either under the new key (no-op for rows already on the new
   key) or under the legacy fallback (`JWT_SECRET` / `SESSION_SECRET`).
4. **Dry-run the re-encrypt script:**

   ```bash
   pnpm --filter @breeze/api secrets:reencrypt
   ```

   Review the JSON summary. `errors` must be empty. `changed` is the number of
   rows that would be re-encrypted under the new key.
5. **Apply the migration:**

   ```bash
   pnpm --filter @breeze/api secrets:reencrypt -- --apply
   ```

6. **Re-run the dry run.** `changed` should now be `0`.
7. **Confirm the legacy fallback is no longer reached.** Tail the API logs
   for at least one full request cycle through every encrypted-column code
   path (SSO logins, integration syncs, webhook deliveries, MFA reads). You
   should see **zero** occurrences of:

   ```
   [secretCrypto] Decrypted enc:v1: row with legacy fallback key
   ```

   If the warning still fires, identify the table/column from the call site
   and re-run the script. Common causes: a row added to the registry after
   the previous rotation, or a column type (`json` / `text-array`) whose
   transform missed an entry.
8. **Optional -- rotate `JWT_SECRET` / `SESSION_SECRET`.** Once the warning
   has stayed silent over a representative window (typically 24-48h covering
   all background jobs and weekly schedules), the legacy fallback is dead
   code. You can now rotate `JWT_SECRET` and `SESSION_SECRET` independently
   following their own procedures (sections 2 and 7) without risk of
   stranding ciphertext.

### Keyring-Driven `enc:v2` Rotation (advanced)

For deployments already using `APP_ENCRYPTION_KEY_ID` + `APP_ENCRYPTION_KEYRING`:

1. Keep the old keyring entry available so prior `enc:v2:<oldId>:` values remain readable.
2. Generate the new key: `openssl rand -hex 32`.
3. Configure a new active key ID and keyring entry:

```bash
APP_ENCRYPTION_KEY=<old-key-that-can-read-enc-v1>
APP_ENCRYPTION_KEY_ID=app-2026-05
APP_ENCRYPTION_KEYRING='{"app-2026-05":"<new-key>","app-2025-11":"<previous-key>"}'
```

4. Run the dry run, apply, re-verify with `changed=0` (steps 4-6 above).
5. After backups and application checks pass, remove the old key material from
   the keyring/vault when no `enc:v1` or old-key `enc:v2` values remain.

Emergency compromise response should prefer restoring from a known-good backup
and reissuing affected integration credentials over ad hoc database rewrites.

### Registry Coverage

The registry currently covers:

- SSO provider client secrets and SSO identity tokens.
- C2C OAuth client secrets and tokens.
- Webhook secrets and encrypted webhook headers.
- Notification channel secret config.
- SNMP community strings and credential JSON.
- Automation webhook trigger secrets.
- PSA, Huntress, SentinelOne, DNS filter, backup private-key, and organization
  log-forwarding secrets.

### Validation

Focused tests cover mixed-key reads, explicit re-encryption, registry JSON
transforms, and dry-run stats. Run:

```bash
cd apps/api
./node_modules/.bin/vitest run src/services/secretCrypto.test.ts src/services/encryptedColumnRegistry.test.ts
```

---

## 4. MFA_ENCRYPTION_KEY

**What it protects:** Encrypts MFA TOTP secrets stored on the `users` table. Without a working key, users cannot complete MFA verification.

**Current implementation (v0.65.0+):** `apps/api/src/services/mfaSecretCrypto.ts` writes new TOTP secrets as `mfa:v1:` rows under `MFA_ENCRYPTION_KEY` (AES-256-GCM, SHA-256-derived 256-bit key). Reads accept both formats:

- `mfa:v1:` rows are decrypted with `MFA_ENCRYPTION_KEY`.
- Legacy `enc:v1:` rows fall through to `decryptSecret()`, which uses the standard `APP_ENCRYPTION_KEY` chain and its legacy fallback (see §3).

The decryption path returns a `migratedSecret` value alongside the plaintext so callers can persist the rewrap on the next successful MFA verification (transparent online migration). New enrollments always write `mfa:v1:`.

### Rotation Procedure

The dual-format read path means rotation does NOT instantly lock users out, but you must run the re-encrypt step before retiring the old key.

1. **Generate the new key:** `openssl rand -hex 32`.
2. **Update `MFA_ENCRYPTION_KEY` in your environment.** Keep the old `APP_ENCRYPTION_KEY` / `JWT_SECRET` / `SESSION_SECRET` in place so any remaining `enc:v1:` MFA rows still decrypt via the legacy fallback.
3. **Deploy the API.** New MFA enrollments write `mfa:v1:` under the new key.
4. **Dry-run the re-encrypt script** (`scripts/re-encrypt-secrets.ts` covers MFA columns through the encrypted-column registry):

   ```bash
   pnpm --filter @breeze/api secrets:reencrypt
   pnpm --filter @breeze/api secrets:reencrypt -- --apply
   ```

5. **Verify** by tailing the API logs while users sign in -- you should not see legacy-fallback warnings (§3) attributable to MFA reads. The transparent migration path also rewrites old rows on first successful login, so steady-state attrition is expected.

> **WARNING:** Do **not** rotate `MFA_ENCRYPTION_KEY` simultaneously with `APP_ENCRYPTION_KEY` and the legacy `JWT_SECRET` / `SESSION_SECRET` fallbacks. Doing so removes every read path for both `mfa:v1:` and `enc:v1:` MFA rows, locking out every MFA-enabled user. Rotate one, run the re-encrypt script, verify, then move to the next.

---

## 5. ENROLLMENT_KEY_PEPPER / MFA_RECOVERY_CODE_PEPPER

**What they protect:** These peppers are mixed into SHA-256 hashes for enrollment keys and MFA recovery codes, respectively. Used for one-way hashing, not encryption. See `apps/api/src/services/enrollmentKeySecurity.ts` and `apps/api/src/routes/auth/helpers.ts`.

### ENROLLMENT_KEY_PEPPER (rotation-safe via fallback chain, v0.65.0+)

`enrollmentKeySecurity.ts` exposes two functions:

- `hashEnrollmentKey(rawKey)` -- always uses the **primary** `ENROLLMENT_KEY_PEPPER`. All new writes hash here.
- `hashEnrollmentKeyCandidates(rawKey)` -- returns every hash a stored row could match: primary first, then one hash per legacy pepper. Lookup paths (e.g. `inArray(enrollmentKeys.key, candidates)`) accept any match.

The legacy fallback list is, in order, every non-empty value of:

1. `APP_ENCRYPTION_KEY`
2. `SSO_ENCRYPTION_KEY`
3. `SECRET_ENCRYPTION_KEY`
4. `JWT_SECRET`
5. `SESSION_SECRET`

(De-duped, and the primary `ENROLLMENT_KEY_PEPPER` value itself is excluded if any of the above happens to share its value.) This list matches the historical "pre-dedicated-pepper" hash sources used before `ENROLLMENT_KEY_PEPPER` was a required env var.

**Rotation Procedure:**

1. Generate the new pepper: `openssl rand -hex 32`.
2. Set `ENROLLMENT_KEY_PEPPER` to the new value. **Leave** `APP_ENCRYPTION_KEY`, `JWT_SECRET`, and `SESSION_SECRET` in place -- existing enrollment-key hashes match through the legacy fallback list.
3. Deploy. New enrollment keys are hashed under the new pepper; existing keys remain matchable via the candidate lookup.
4. **Drain the legacy list.** Existing enrollment keys are short-lived (24h TTL by default) and self-rotate as devices enroll, so the fallback list naturally goes idle within a TTL cycle. Audit the `enrollment_keys` table: once no rows remain whose hash is reachable only through legacy peppers (typically after one TTL window plus margin), drop the legacy values from the env in a follow-up rotation.

There is no re-hash migration script for enrollment keys -- the fallback path plus natural TTL turnover is the expected migration mechanism. Forced rotation of all peppers without waiting for TTL drain will invalidate every unexpired enrollment key (devices in flight will need a fresh key).

### MFA_RECOVERY_CODE_PEPPER (no fallback chain)

`MFA_RECOVERY_CODE_PEPPER` is read directly by `getRecoveryCodePepper()` in `apps/api/src/routes/auth/helpers.ts` with **no** legacy fallback -- this is intentional, because recovery codes are a high-value last-resort credential and the operational risk of rotating them is bounded (users regenerate via the UI). Rotation invalidates every existing recovery code.

**Rotation Procedure:**

1. Generate the new pepper: `openssl rand -hex 32`.
2. Update `MFA_RECOVERY_CODE_PEPPER`.
3. Deploy.
4. Notify all MFA-enabled users to regenerate their recovery codes via the UI. Admins can trigger bulk regeneration if available, or force-revoke unused codes.

Schedule during a maintenance window and communicate the impact.

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

### Emergency Rotation Quick Reference (v0.65.0+ fallback chains)

The read-side fallback chains added in v0.65.0 change the emergency-rotation
ordering in two important ways:

- **Rotating `APP_ENCRYPTION_KEY` alone no longer locks out existing rows.**
  `enc:v1:` ciphertext written under older builds (or under a previous
  `APP_ENCRYPTION_KEY`) will continue to decrypt via the `JWT_SECRET` /
  `SESSION_SECRET` legacy fallback. This is *good* for routine rotation but
  *bad* in a confirmed-compromise scenario: if the attacker had access to
  any of `JWT_SECRET`, `SESSION_SECRET`, or the old `APP_ENCRYPTION_KEY`,
  they can still decrypt exfiltrated `enc:v1:` ciphertext until those
  legacy values are also rotated and every row has been re-encrypted.
- **`ENROLLMENT_KEY_PEPPER` rotation is similarly soft.** The pepper
  fallback list keeps existing enrollment-key hashes matchable across all
  candidate peppers, so an attacker who lifted any one of the historical
  pepper sources can still match stored hashes until those values are
  rotated.

Recommended order for a **confirmed compromise of secrets at rest** (assume
the database and the full env both leaked):

1. **Rotate `JWT_SECRET` and `SESSION_SECRET` first** (sections 2 and 7).
   This invalidates active sessions and removes the legacy decrypt fallback
   for both `secretCrypto` and `enrollmentKeySecurity`.
2. **Rotate `APP_ENCRYPTION_KEY`** (section 3) to a fresh value the attacker
   has never seen. Run `pnpm --filter @breeze/api secrets:reencrypt --
   --apply` immediately so new ciphertext is written under the new key. Tail
   logs for the `legacy fallback key` warning -- with `JWT_SECRET` /
   `SESSION_SECRET` already rotated, any warning indicates a row that the
   re-encrypt registry missed and must be investigated before proceeding.
3. **Rotate `MFA_ENCRYPTION_KEY`** (section 4) and re-run the script. The
   `mfa:v1:` -> new-key transition relies on the same registry path.
4. **Rotate `ENROLLMENT_KEY_PEPPER`** (section 5). Because step 1 already
   rotated `JWT_SECRET` / `SESSION_SECRET`, the fallback pepper list is now
   constrained to (rotated) `APP_ENCRYPTION_KEY` only. If you also want to
   cut the `APP_ENCRYPTION_KEY`-derived pepper, stage a follow-up rotation
   after the enrollment-key TTL window has fully drained (default 24h).
5. **Rotate `MFA_RECOVERY_CODE_PEPPER`** (section 5) -- this has no
   fallback, so recovery codes are immediately invalidated. Notify users
   to regenerate.
6. **Revoke all user-facing API keys** and force a global session reset.
7. **Reissue integration credentials** that were stored encrypted at rest
   (SSO client secrets, PSA tokens, Huntress / S1 / DNS-filter API keys,
   webhook secrets, SNMP credentials, etc.) -- attacker-decrypted
   ciphertext means the upstream credential itself is compromised.
8. Restore from a known-good backup if integrity of any encrypted column is
   in doubt; do not rely on ad-hoc database rewrites.
