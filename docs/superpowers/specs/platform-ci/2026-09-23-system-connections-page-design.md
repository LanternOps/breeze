# System page: connection status + deprecations (design)

**Date:** 2026-09-23 · **Status:** approved in chat (Todd, 2026-09-23); Fable quorum 2026-09-23 = APPROVE WITH AMENDMENTS, all 7 findings adopted (see end) · **Related:** #6605 (Deprecations, PR #6744)

## Why

Operators have no usable place to see which integrations a deployment has
configured. (Prior art: `GET /system/config-status`, `apps/api/src/routes/system.ts:33`,
returns a handful of env booleans to partner-scope users with `ORGS_READ`, but
has no consumer anywhere in the repo — see D9.) The answer lives in `.env`
(and compose files), spread over ~440 distinct `process.env.*` names plus ~64
more read only through helpers such as `envFlag(name)` in `apps/api/src`, only ~154 of which
pass through the validated `envSchema` (`apps/api/src/config/validate.ts`).
A read-only "System" page gives platform admins a setup summary: what is
available, what is enabled, what is half-configured, and the non-secret
settings that explain why.

## Decisions

| # | Decision |
|---|---|
| D1 | **Read-only.** The page shows status and non-secret values. Nothing is editable. |
| D2 | **Secrets are never shown** — not masked, not last-4. A secret var renders only as `set` / `not set`. |
| D3 | **Curated registry** (approach A), not derived from `envSchema` (only ~154 of ~434 vars are in it) and not a thin `/health` view. |
| D4 | **Config only, no live probes.** "Enabled" means configured, not "the remote service answered". Live probes are a possible follow-up for a few entries. |
| D5 | **API container's environment only.** web / portal / worker env is out of scope; the page says so. |
| D6 | **Platform admins only.** Deployment-wide data. Reuses `platformAdminMiddleware` via `adminRoutes`; no new permission. |
| D7 | **Home:** `/admin/system` with tabs **Connections** and **Deprecations**; nav entry "System" in the Administration section. PR #6744 merges as-is first; W02 moves its page into the Deprecations tab and redirects `/settings/system/deprecations`. |
| D8 | **Default-deny secrecy.** Every registry var is `secret: true` unless explicitly marked `secret: false`. |
| D9 | **One home.** W01 deletes `GET /system/config-status` (`routes/system.ts:33-80`, zero consumers, weaker partner-scope gate) and its tests, so there is one env-status truth. |
| D10 | **Status mirrors the resolvers, not raw `process.env`.** `core` entries (database, Redis, email) implement a custom `status()` that follows the real resolution: `resolveRedisUrl` (`services/redis.ts` — `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD[_FILE]`), the `DATABASE_URL_APP` derivation (`config/validate.ts:1012-1020`), and email provider auto-detect. |
| D11 | **`*_FILE` indirection.** A var counts as `set` if either `X` or `X_FILE` is set. The builder never opens the file. |

## Components

### 1. Registry — `apps/api/src/system/connections/registry.ts`

```ts
type ConnectionVar = {
  name: string;            // env var name
  secret?: boolean;        // default true (D8); false = value may be displayed
  required?: boolean;      // part of the "fully configured" set
};

type ConnectionStatus = 'enabled' | 'disabled' | 'misconfigured' | 'required_missing';

type ConnectionEntry = {
  id: string;              // stable, kebab-case
  group: ConnectionGroup;
  label: string;           // English source; web localizes by id
  docsUrl?: string;        // optional; if present, a test asserts the page exists under apps/docs
  core?: boolean;          // core services: unset => required_missing, never "disabled"
  vars: ConnectionVar[];
  status(env: Readonly<Record<string, string | undefined>>): {
    status: ConnectionStatus;
    reason?: string;       // e.g. "SMTP_HOST is set but SMTP_PASS is missing" — names vars, never values
  };
};
```

A default `status` helper covers the common shape (all `required` vars set →
enabled; none set → disabled, or `required_missing` when `core`; some set →
misconfigured, reason lists the missing names). Entries with real logic
(e.g. email provider = SMTP **or** Resend; hosted vs self-host) supply their own.

**Groups:** Core (database, Redis, public URLs) · Email · Storage & Backups ·
AI · Billing · Microsoft 365 · Identity / SSO · Remote access (TURN) ·
Agent releases · Observability (Sentry, Loki) · Security / abuse ·
Integrations (Delegant, MCP, …). The exact entry list is assembled in W01
from the env inventory; expect ~30–40 entries.

**Internal list — `INTERNAL_ENV_VARS`** (same directory): env vars that are
not an operator-facing connection (timeouts, concurrency knobs, `NODE_ENV`,
test/E2E vars, debug flags). Each line carries a one-phrase reason.

### 2. Report builder — `buildConnectionsReport(env)`

Pure function: takes an env snapshot, returns

```ts
{
  version: string;               // APP_VERSION
  deployMode: 'hosted' | 'self_host';
  scope: 'api';                  // D5
  summary: Record<ConnectionStatus, number>;
  groups: Array<{
    group: ConnectionGroup;
    entries: Array<{
      id; label; docsUrl; status; reason?;
      vars: Array<{ name; secret: boolean; set: boolean; value?: string }>; // value only when secret === false
    }>;
  }>;
}
```

`value` is populated only for `secret: false` vars. The builder is the only
place that reads values; it never logs them.

### 3. API — `GET /api/v1/admin/system/connections`

Mounted via `adminRoutes.route('/system', …)` in
`apps/api/src/routes/admin/index.ts`, behind `platformAdminMiddleware`
(line 17). **Never** add a new `api.route('/admin/...')` in `apps/api/src/index.ts`
— that mounts outside the gate. The gate's audit row records method + path
only (`middleware/platformAdmin.ts:31-34`), never bodies. Calls `buildConnectionsReport(process.env)`.
No DB access, so it cannot hang or fail on DB state. Only GET; other methods
404. Response is `Cache-Control: no-store`.

### 4. Web — `/admin/system`

- `apps/web/src/pages/admin/system.astro` + `SystemPage.tsx` with tabs
  **Connections** (default) and **Deprecations** (tab state in the URL,
  e.g. `?tab=deprecations`).
- Connections tab: summary strip ("23 enabled · 9 disabled · 2 misconfigured"),
  "show problems only" filter, cards grouped by section. Each card: label,
  status badge, reason, key/value list (secret vars as a `set` / `not set`
  pill, never a value), docs link. Footnote: "Shows the API container's
  environment only."
- Deprecations tab: the `SystemDeprecationsPage` component from #6744, moved.
  `/settings/system/deprecations` redirects to `/admin/system?tab=deprecations`.
- Sidebar: single "System" entry in Administration (replaces #6744's
  "Deprecations" entry). Satisfies `Sidebar.nav.test.tsx`'s
  platform-admin-only-in-Administration rule.
- Strings in all 8 locales; non-English flagged for native review. Gates
  that apply: `titleKeyUsage.test.ts`, locale parity, translation coverage and
  key usage (`apps/web/src/lib/i18n/`). The redirect stub uses
  `Astro.redirect(..., 301)`, the pattern `settingsPageRegistry.test.ts`
  already exempts.

## Safety invariants (tests that carry the design)

1. **Coverage ratchet.** A test scans `apps/api/src/**/*.ts`, excluding
   `*.test.ts` **and** `src/__tests__/**`, and collects env names from every
   read shape the codebase uses:
   - `process.env.X`, `process.env['X']`, `process.env["X"]`;
   - literal first arguments to the env helpers: `envFlag`, `envInt`, `envStr`,
     `envFloat`, `getEnvString`, `positiveIntEnv`, `cronFromEnv`, and the local
     `envInt`/`envFlag` copies (e.g. `routes/mcpServer.ts`,
     `db/wedgedBackends.ts`) — match `\b(envFlag|envInt|envStr|envFloat|getEnvString|positiveIntEnv|cronFromEnv)\(\s*['"]([A-Z0-9_]+)['"]`;
   - every key in `ENV_SCHEMA_KEYS` (`config/validate.ts`);
   - every `enableEnvVar` in the builtin-extension registry
     (`extensions/builtinRegistry.ts`), enumerated from the registry itself.

   It fails if any name is in neither the registry nor `INTERNAL_ENV_VARS`. New env vars cannot silently skip
   the page. It also fails on registry/internal entries that no longer appear
   in code (stale) and on names present in both.
2. **Secret canary.** For every registry var with `secret !== false`, set the
   env value to a unique canary (`CANARY_<name>_<random>`); build the report,
   serialize it, and assert no canary substring appears. Also run through
   the route handler and assert on the HTTP body. **Value-shape guard:** for
   every `secret: false` var, a test fixture of realistic values asserts the
   rendered value contains no URL userinfo (`://…@`) and does not parse as
   JSON containing `private_key`; the builder also refuses (renders `set`) any
   non-secret value with URL userinfo at runtime.
3. **Secret-name guard.** Any var whose name matches
   `/SECRET|KEY|TOKEN|PASS|PRIVATE|DSN|CREDENTIAL|URL|URI|ENDPOINT|SERVICE_ACCOUNT|JWK|SID|WEBHOOK|SIGNING|CERT|SALT|SEED|ENCRYPT|JSON|B64|BASE64/`
   must stay `secret: true` unless listed in `SECRET_NAME_EXCEPTIONS` with a
   reason. `URL` is unanchored so `DATABASE_URL_APP` (a full DSN) matches;
   `SERVICE_ACCOUNT` catches `FIREBASE_SERVICE_ACCOUNT` /
   `PLAY_INTEGRITY_SERVICE_ACCOUNT` (JSON with a private key); `URI` catches
   `CSP_REPORT_URI` (Sentry key in query). Public URLs like `PUBLIC_API_URL`
   go on the exception list explicitly.
4. **Reason strings name vars, never values.** Canary test covers `reason`
   too (it is part of the serialized report).
5. **Status truthfulness (one per core entry).** e.g. compose-style env
   (`REDIS_HOST` + `REDIS_PASSWORD_FILE`, no `REDIS_URL`) ⇒ Redis `enabled`;
   `DATABASE_URL` + `POSTGRES_PASSWORD`, no `DATABASE_URL_APP` ⇒ database
   `enabled`; `RESEND_API_KEY` only ⇒ email `enabled` (provider `resend`).
6. **Access.** No session → 401; partner admin → 403; org user → 403; platform
   admin → 200; POST/PUT/PATCH/DELETE → 404.

## Non-goals

- Editing configuration from the UI.
- Live connectivity probes (possible follow-up per entry).
- Showing web / portal / worker / agent environment.
- Moving env vars into `envSchema`.

## Delivery

One feature issue, two waves:

- **W01 (API):** registry + `INTERNAL_ENV_VARS` + `buildConnectionsReport` +
  route + all six invariant tests + delete `/system/config-status` (D9). Red first. Depends on nothing.
- **W02 (Web):** `/admin/system` page with tabs, Connections UI, move the
  Deprecations page from #6744 into its tab with redirect, nav swap, locales.
  Depends on W01 and on #6744 being merged.

## Risks

- **Registry drift** — mitigated by the coverage ratchet (invariant 1).
- **Misclassified secret** — mitigated by default-deny (D8), the name guard
  (invariant 3) and the canary (invariant 2). A var that is secret but has an
  innocuous name and is wrongly marked `secret: false` is the residual risk;
  every `secret: false` line is reviewed in the W01 PR.
- **Status wording overclaims** — "Enabled" means configured only (D4); the
  page header says so.

## Quorum record (Fable, 2026-09-23)

Verdict **APPROVE WITH AMENDMENTS**. Adopted:

1. [blocker] Secret-name guard missed `DATABASE_URL_APP`, `*_SERVICE_ACCOUNT`, `CSP_REPORT_URI` → broadened regex + value-shape guard (invariants 2, 3).
2. [blocker] Ratchet missed ~64 names read via `envFlag`/`envInt`/`cronFromEnv`/builtin `enableEnvVar` → multi-shape scan + `ENV_SCHEMA_KEYS` + `__tests__/**` exclusion (invariant 1).
3. [should-fix] Undisclosed prior art `/system/config-status` → delete it (D9). Verified zero consumers outside `system.test.ts`.
4. [should-fix] Derived values (Redis, `DATABASE_URL_APP`, email auto-detect, `_FILE`) → D10, D11, invariant 5.
5. [nit] Mount only via `adminRoutes.route(...)`; audit logs method+path only → §3.
6. [nit] Name the web locale gates and the redirect pattern → §4.
7. [nit] `docsUrl` optional, with an existence test.
