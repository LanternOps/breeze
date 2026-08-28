# Upgrading Breeze

## No action required: nightly job schedules were staggered

Every BullMQ job registered with `repeat: { every: N }` fires on a wall-clock
boundary derived from the Unix epoch, so all `every: 24h` jobs used to fire at
exactly 00:00:00.000 UTC together — 18 of the 97 repeat entries on hosted
production shared a single millisecond, and eleven of those were batched
retention `DELETE`s competing for the same Postgres pool as live agent traffic.

Those registrations are now explicit, staggered cron slots allocated in
`apps/api/src/jobs/scheduleRegistry.ts`. No two scheduled jobs that run hourly
or less often share a firing minute any more — including the daily vulnerability
feed syncs, which used to co-fire with the hourly risk-score refresh on minute 0
(the 13:00 pair was holding database connections for ~128 s a day).

Daily job times have therefore moved. If you monitor for a specific job's run
time, the registry lists every slot; nothing runs on a schedule you can no longer
see.

**No Redis cleanup is needed.** Each job's initializer removes its queue's
existing repeat entries before re-registering, so the first boot of the new API
image replaces the old schedule rather than adding a second one. To confirm
after deploying, the total repeat count should stay flat rather than roughly
double:

```bash
docker exec -i breeze-redis redis-cli --scan --pattern 'bull:*:repeat' \
  | while read -r k; do printf '%s %s\n' "$(docker exec -i breeze-redis redis-cli ZCARD "$k")" "$k"; done \
  | sort -rn
```

Two renamed environment variables (both optional, both previously undocumented
apart from one example line in the admin guide):

| Removed | Replacement | Notes |
|---|---|---|
| `USER_RISK_SCAN_INTERVAL_MS` | `USER_RISK_SCAN_CRON` | Value is now a cron pattern, e.g. `57 4,10,16,22 * * *`. |
| `USER_RISK_RETENTION_INTERVAL_MS` | `USER_RISK_RETENTION_CRON` | Value is now a cron pattern, e.g. `45 8 * * *`. |
| `ML_OUTPUT_RETENTION_INTERVAL_MS` | `ML_OUTPUT_RETENTION_CRON` | Value is now a cron pattern, e.g. `25 8 * * *`. |

Setting a removed variable now logs a startup warning naming its replacement,
and the job runs on its allocated default slot. Pick a minute no other job owns
— the registry lists every allocated slot in one place.

Cron overrides are validated at boot. Breeze requires the full five-field form:
`cron-parser` does not reject a short expression, it pads the missing fields, so
`*/5` means "day-of-month step 5, every minute" (first run four days later)
rather than "every five minutes". An override that fails validation is ignored
in favour of the built-in slot, with an error on stdout and in Sentry — a bad
cadence value never prevents the API from becoming ready.

### What this does not change

The ~43 sub-hourly repeatable jobs (5s/30s/60s/2m/5m/10m/15m/30m sweeps) are
deliberately still registered with `every:` — a 60-second tick has to fire every
60 seconds. They remain epoch-aligned, so the 5-, 10-, 15- and 30-minute jobs do
still converge on 00:00:00.000 alongside each other. The production `ZRANGE`
above was taken mid-day and structurally could not show them. Midnight is
quieter, not empty: what changed is that the heavy batched-`DELETE` retention
jobs are no longer part of that convergence.

## Action required: reconnect Microsoft 365 ticket mailboxes

This release strengthens Microsoft 365 ticket mailbox consent by verifying the Microsoft tenant and consenting administrator identity and binding the tenant to its Breeze partner. During the upgrade, every non-disabled Microsoft 365 ticket mailbox connection becomes `reauth_required`. Disabled rows that still hold a legacy tenant or delta cursor also become `reauth_required` and have that state cleared. Already-disabled rows with neither value remain disabled and are not reactivated.

### Deploy order

1. Deploy the database migration and API together. Do not run the new API against a database that has not completed its migration.
2. Deploy the web UI after the API and migration are healthy.

Inbound Microsoft polling and outbound Microsoft Graph replies remain disabled for each affected connection until consent is completed again. When no verified Graph mailbox resolves, SMTP fallback for outbound customer mail remains active.

### Administrator action

For each Microsoft 365 ticket mailbox connection:

1. Sign in to Breeze as a full-partner mailbox administrator with MFA completed.
2. Open **Settings → Partner → Ticketing**.
3. Select **Reconnect Microsoft 365** and complete the Microsoft consent flow with an eligible Microsoft 365 administrator.
4. Confirm that the connection returns to `connected`.

### Post-deploy verification

Run this query as a database administrator. It must return zero rows; any result is a connection marked `connected` without a matching verified `(tenant_id, partner_id)` ownership row.

```sql
SELECT c.id, c.partner_id, c.tenant_id, c.mailbox_address
FROM ticket_mailbox_connections AS c
LEFT JOIN ticket_mailbox_tenant_ownerships AS o
  ON o.tenant_id = c.tenant_id
 AND o.partner_id = c.partner_id
WHERE c.status = 'connected'
  AND o.tenant_id IS NULL;
```

Also confirm that expected active or legacy-state connections are `reauth_required` until their administrators finish consent again, while clean rows that were already disabled remain `disabled`.

### Rollback warning

If the application deployment must be rolled back, keep the ownership tables, the composite tenant/partner foreign key, and the connected-row ownership check. Keep legacy connections disabled until they complete verified consent again. Do not restore unsigned callback behavior. These database protections are forward-compatible and must remain in place while application services are rolled back.

> ## TL;DR — Upgrading to the SR-001..SR-024 security-hardening release
>
> 1. **Run the FORCE-RLS ownership pre-check** (one SQL query — section below) before deploying.
> 2. **Add to `.env`** — each must be a **dedicated** random hex string (`openssl rand -hex 32`); the production validator rejects boot if any two of these reuse the same value:
>    - `APP_ENCRYPTION_KEY`
>    - `MFA_ENCRYPTION_KEY`
>    - `ENROLLMENT_KEY_PEPPER`
>    - `MFA_RECOVERY_CODE_PEPPER`
>
>    Existing `enc:v1:` rows keep decrypting via the legacy `JWT_SECRET` fallback (you'll see one-time warnings — see [Post-deploy](#post-deploy)).
> 3. **If behind a reverse proxy** with `TRUST_PROXY_HEADERS=true`: set `TRUSTED_PROXY_CIDRS` to your proxy IPs.
> 4. **Deploy API**, watch logs for the warnings in the [Post-deploy](#post-deploy) table — each is a backlog item, not an outage.
> 5. **Plan the next release.** Several flag defaults are temporary (see [Backward-compatibility windows](#backward-compatibility-windows-will-tighten-in-the-next-release)).

---

## About this file

Describes upgrade steps that are not safe to handle automatically — env-var changes, one-time data migrations, breaking-config changes, and pre-deploy checks. Routine schema migrations run on container start (`autoMigrate`); only steps listed here need operator action.

When upgrading across multiple versions, apply each section in order — later sections assume earlier ones are done.

---

## Upgrading to the SR-001..SR-024 security-hardening release

Cross-cutting security review fixing 24 audit areas. If you are upgrading to this from an earlier release, **read the entire section** — there are pre-deploy steps.

### Pre-deploy

**1. Database ownership pre-check (FORCE RLS).** This release adds `FORCE ROW LEVEL SECURITY` to org-scoped tables. If `breeze_app` ever became the *owner* of any of these tables (instead of just having grants), queries silently return zero rows after the migration. Run this as a DB superuser before upgrading:

```sql
SELECT t.tablename, c.relowner::regrole
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
WHERE c.relowner = 'breeze_app'::regrole
  AND t.schemaname = 'public';
```

If any rows return, transfer ownership to the admin role before deploying:

```sql
ALTER TABLE <tablename> OWNER TO breeze;
```

**2. Required env vars** (add to `.env`).

> **Each value must be unique.** In production the API config validator (`apps/api/src/config/validate.ts`) refuses to boot if any two of `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `ENROLLMENT_KEY_PEPPER`, or `MFA_RECOVERY_CODE_PEPPER` share the same string. Generate every value below with a fresh `openssl rand -hex 32`.

| Variable | What to set | Why |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Fresh random hex (`openssl rand -hex 32`) — must differ from `JWT_SECRET` | New writes use this key. Existing `enc:v1:` rows decrypt via the legacy `JWT_SECRET`/`SESSION_SECRET` fallback (one-time warning per row); migrate them with `pnpm tsx scripts/re-encrypt-secrets.ts` when convenient. |
| `MFA_ENCRYPTION_KEY` | Fresh random hex (`openssl rand -hex 32`) | Required by docker-compose. Existing rows decrypt via legacy fallback. |
| `ENROLLMENT_KEY_PEPPER` | Fresh random hex | New writes use this; lookups also try `APP_ENCRYPTION_KEY` and `JWT_SECRET` for backward compatibility. |
| `MFA_RECOVERY_CODE_PEPPER` | Fresh random hex | Recovery codes are write-only currently — set to anything (random). |

**Optional but recommended:**

| Variable | When to set |
|---|---|
| `AGENT_ENROLLMENT_SECRET` | If you don't want to set per-key secrets. Otherwise set `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn` to defer. |
| `TRUSTED_PROXY_CIDRS` | If you have `TRUST_PROXY_HEADERS=true`. Defaults to loopback if missing — real-IP detection degrades but the API does not crash. |

### Deploy

Deploy the API first; agents update on their own schedule and remain compatible with N-2 versions.

### Post-deploy

<a id="post-deploy"></a>
Watch the API container logs for these one-time warnings. Each is a backlog item, not an outage:

| Log line | Action |
|---|---|
| `[secretCrypto] Decrypted enc:v1: row with legacy fallback key` | Run `pnpm tsx scripts/re-encrypt-secrets.ts --dry-run`, then `--apply`. Migrates rows from JWT_SECRET-derived to APP_ENCRYPTION_KEY-derived encryption. |
| `[automations] Webhook ... accepted via legacy header secret` | Update the webhook sender to use HMAC (`x-breeze-signature` + `x-breeze-timestamp`). Header-secret support flips off in the next release. |
| `[enrollment] WARNING: Production enrollment proceeding WITHOUT enrollment secret` | Set `AGENT_ENROLLMENT_SECRET` and remove `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn`. |
| `[config] TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS is empty` | Set `TRUSTED_PROXY_CIDRS` to your reverse-proxy IPs. |
| `[agentWs] Device ... has no token hash — predates hash migration` | Re-enroll the affected device. |

<a id="backward-compatibility-windows-will-tighten-in-the-next-release"></a>
### Backward-compatibility windows (will tighten in the **next** release)

The following defaults are temporary to avoid stranding existing deployments:

W07 removed the expired SSO exchange compatibility response. `/sso/exchange`
now returns only the access token metadata and installs the refresh token through
the HttpOnly cookie; external clients must use that cookie-based handoff.

- `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` — **default flipped to `false` this release.** Inbound automation webhooks now require HMAC signing (`x-breeze-signature` + `x-breeze-timestamp`). If you still have senders using the legacy `x-automation-secret` / `x-webhook-secret` header, set this to `true` as a short-term emergency rollback while you migrate them; the flag will be removed in a future release. The `?secret=` query-string path has been removed entirely — there is no flag to re-enable it (it leaks into every access log on the path).
- `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn` — accepted in this release only. Next release will require either `AGENT_ENROLLMENT_SECRET` or per-key secrets.
- Legacy enrollment-key pepper fallback (`APP_ENCRYPTION_KEY`/`JWT_SECRET`) — will be removed once existing keys are re-hashed under `ENROLLMENT_KEY_PEPPER`.
- Legacy `enc:v1:` decrypt fallback to `JWT_SECRET`/`SESSION_SECRET` — will be removed once `re-encrypt-secrets.ts` has been run on all deployments.

### Optional cleanups

- Run `pnpm tsx scripts/re-encrypt-secrets.ts` to migrate `enc:v1:` rows under `APP_ENCRYPTION_KEY`. After this, the `JWT_SECRET` decrypt fallback becomes dead code (cleaned up in the next release).
- Pause the OAuth stale-client cleanup cron for 24h after deploy if you have active MCP/DCR integrations — minor risk during the deploy window.

---

## Older versions

(Add new sections at the top as future upgrades require operator action.)
