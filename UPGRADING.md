# Upgrading Breeze

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

- `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` — currently defaults to `true`; flips to `false` next release. Migrate clients to read `breeze_refresh_token` HttpOnly cookie instead of JSON `refreshToken`.
- `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` — currently defaults to `true`; flips to `false` next release. Migrate webhook senders to HMAC.
- `ENROLLMENT_SECRET_ENFORCEMENT_MODE=warn` — accepted in this release only. Next release will require either `AGENT_ENROLLMENT_SECRET` or per-key secrets.
- Legacy enrollment-key pepper fallback (`APP_ENCRYPTION_KEY`/`JWT_SECRET`) — will be removed once existing keys are re-hashed under `ENROLLMENT_KEY_PEPPER`.
- Legacy `enc:v1:` decrypt fallback to `JWT_SECRET`/`SESSION_SECRET` — will be removed once `re-encrypt-secrets.ts` has been run on all deployments.

### Optional cleanups

- Run `pnpm tsx scripts/re-encrypt-secrets.ts` to migrate `enc:v1:` rows under `APP_ENCRYPTION_KEY`. After this, the `JWT_SECRET` decrypt fallback becomes dead code (cleaned up in the next release).
- Pause the OAuth stale-client cleanup cron for 24h after deploy if you have active MCP/DCR integrations — minor risk during the deploy window.

---

## Older versions

(Add new sections at the top as future upgrades require operator action.)
