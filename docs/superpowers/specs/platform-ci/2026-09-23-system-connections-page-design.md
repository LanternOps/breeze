# System page: connection status + deprecations (design)

**Date:** 2026-09-23 · **Status:** approved in chat (Todd, 2026-09-23) · **Related:** #6605 (Deprecations, PR #6744)

## Why

Operators have no single place to see which integrations a deployment has
configured. The answer lives in `.env` (and compose files), spread over
~434 distinct `process.env.*` reads in `apps/api/src`, only ~154 of which
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
  docsUrl?: string;        // apps/docs page
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

Mounted in `apps/api/src/routes/admin/index.ts` under `adminRoutes`
(`platformAdminMiddleware`). Calls `buildConnectionsReport(process.env)`.
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
- Strings in all 8 locales; non-English flagged for native review.

## Safety invariants (tests that carry the design)

1. **Coverage ratchet.** A test scans `apps/api/src/**/*.ts` (excluding tests)
   for `process.env.X` / `process.env['X']` and fails if any `X` is in neither
   the registry nor `INTERNAL_ENV_VARS`. New env vars cannot silently skip
   the page. It also fails on registry/internal entries that no longer appear
   in code (stale) and on names present in both.
2. **Secret canary.** For every registry var with `secret !== false`, set the
   env value to a unique canary (`CANARY_<name>_<random>`); build the report,
   serialize it, and assert no canary substring appears. Also run through
   the route handler and assert on the HTTP body.
3. **Secret-name guard.** Any var whose name matches
   `/SECRET|KEY|TOKEN|PASS|PRIVATE|DSN|CREDENTIAL|_URL$/` must stay
   `secret: true` unless listed in `SECRET_NAME_EXCEPTIONS` with a reason.
   `_URL$` is included because URLs embed credentials (`DATABASE_URL`,
   `REDIS_URL`); public URLs like `PUBLIC_API_URL` go on the exception list
   explicitly.
4. **Reason strings name vars, never values.** Canary test covers `reason`
   too (it is part of the serialized report).
5. **Access.** No session → 401; partner admin → 403; org user → 403; platform
   admin → 200; POST/PUT/PATCH/DELETE → 404.

## Non-goals

- Editing configuration from the UI.
- Live connectivity probes (possible follow-up per entry).
- Showing web / portal / worker / agent environment.
- Moving env vars into `envSchema`.

## Delivery

One feature issue, two waves:

- **W01 (API):** registry + `INTERNAL_ENV_VARS` + `buildConnectionsReport` +
  route + all five invariant tests. Red first. Depends on nothing.
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
