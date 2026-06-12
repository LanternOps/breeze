# PAM Web Admin UI — Implementation Plan

**Issue:** LanternOps/breeze#1159
**Hard dependency:** #1163 (PAM backend control plane) — this UI calls `/api/v1/pam/*`, which #1163 creates. **Do not start until #1163 is merged.**
**Reference scaffold:** DNS Security page (PR #847) — `apps/web/src/components/dnsSecurity/`, `apps/web/src/pages/dns-security.astro`.
**Design sources:** issue #1159 body; `internal/BE-17-privileged-access-management.md` (Phase 4 UX); [Discussion #858](https://github.com/LanternOps/breeze/discussions/858) §2 + §7 Phase 1.
**Status:** Draft, ready for pickup once #1163 lands. Author: triage pass 2026-06-09.

---

## Goal

A `/pam` admin page with four tabs — **Overview** (active elevations, recent decisions), **Requests** (pending + decided queue with approve/deny/revoke), **Rules** (`pam_rules` CRUD), **Audit** (filterable history + export). Live-updating via the existing event stream. Mirrors the DNS Security 4-tab pattern; adds two things that page lacks but PAM requires: **role-gating** (privileged surface) and **`data-testid` coverage** (e2e).

## Endpoints consumed (all from #1163)

`GET /api/v1/pam/elevation-requests` · `POST .../:id/respond` · `POST .../:id/revoke` · `GET .../active` · `GET/POST/PATCH/DELETE .../rules`. Live feed: `elevation.*` events on `/api/v1/events/ws`.

## Conventions (grounded in the reference page)

- **Astro shell:** `apps/web/src/pages/pam.astro` = `<DashboardLayout title="PAM"><PamPage client:load /></DashboardLayout>` (mirror `dns-security.astro:6-7`). Auth/session gating is inherited from the layout (`AuthOverlay`/`AccountInactiveGuard`/`AdminSessionManager`).
- **Tab state via `window.location.hash`** (CLAUDE.md URL-state rule): copy `readTabFromHash()` / `switchTab` (`window.location.hash = tab; setActiveTab(tab)`) / `hashchange` listener from `DnsSecurityPage.tsx:10-32`. `VALID_TABS = ['overview','requests','rules','audit']`.
- **Per-tab data:** `fetchWithAuth` from `../../stores/auth` (no react-query, no service client — match `DnsSecurityPoliciesTab.tsx:3,46`). `useState` data/loading/error + `useCallback(signal)` fetcher + `useEffect` with `AbortController`. Unwrap `body.data ?? body`. 401 → `navigateTo('/login', { replace: true })`.
- **Mutations via `runAction`** from `../../lib/runAction` (match `AddDnsPolicyModal.tsx:4,100-115`): `runAction({ request, errorFallback, successMessage, onUnauthorized })`. Catch `ActionError` 401 silently; non-401 already toasted. This satisfies the `no-silent-mutations` guard (CLAUDE.md §runAction).
- **Modals:** `Dialog` from `../shared/Dialog`, `useId()` for field ids (match `AddDnsPolicyModal.tsx:2,31`). On success: `onSaved()` (parent refetch) then `onClose()`.
- **Loading/error/empty:** spinner / `role="alert"` red banner / dashed-border placeholder, as in `DnsSecurityPoliciesTab.tsx:139-157`.

---

## Task 1 — Page shell + sidebar + tab routing

- `apps/web/src/pages/pam.astro` and `apps/web/src/components/pam/PamPage.tsx` (hash tabs, `TabButton` with `role="tab"`/`aria-selected` from `DnsSecurityPage.tsx:71-98`).
- Sidebar: add to `apps/web/src/components/layout/Sidebar.tsx` `navSections` **`'security'` section (~L124, next to DNS Security)**: `{ name: 'PAM', href: '/pam', icon: KeyRound }` (lucide-react import). `NavItem` shape is `{ name, href, icon }` — no role field on the entry itself (gating is Task 6).
- Add `data-testid="pam-tab-{overview|requests|rules|audit}"` to each tab button (see Task 7).

## Task 2 — Overview tab

- `PamOverviewTab.tsx`: `GET /api/v1/pam/active` → table of active elevations (device, user, exe, flow_type, granted-by, expires-in countdown). Plus a recent-decisions strip (`GET elevation-requests?limit=10&status=approved,denied,auto_approved`). StatCards (active count, pending count, auto-elevate hit rate) — mirror `DnsSecurityOverviewTab.tsx` skeleton card pattern.
- Live updates: subscribe via `useEventStream` (Task 5) to refetch on `elevation.activated/expired/revoked`.

## Task 3 — Requests tab (the core operator surface)

- `PamRequestsTab.tsx`: `GET elevation-requests` with filter controls (status, flow_type, device, date range). Paginated table; each row shows the request detail (exe path, signer, hash, parent process, requester reason, policy/rule match).
- Row actions gated by role (Task 6): **Approve** (opens `RespondModal` → duration + optional reason → `POST :id/respond {decision:'approve'}`), **Deny** (`RespondModal` deny → reason), **Revoke** (for active rows → `POST :id/revoke {reason}`). All via `runAction`; on success refetch.
- CAS-aware UX: a 409 from respond/revoke (row already transitioned) surfaces a friendly "already actioned — refreshing" toast and refetches, rather than an error.

## Task 4 — Rules + Audit tabs

- `PamRulesTab.tsx`: `GET .../rules` table ordered by priority; **Add/Edit Rule** modal (`PamRuleModal.tsx`) — name, criteria (signer/hash/path-glob/parent/user/AD-group/time-window), verdict (`auto_approve|auto_deny|require_approval|ignore`), scope (device/site/org/partner), enabled toggle. Priority reorder (drag handle like `OrganizationsPage.tsx:496` or up/down buttons). Create/update/delete via `runAction`.
- `PamAuditTab.tsx`: `GET elevation-requests` (audit projection / or a dedicated audit endpoint if #1163 exposes one) with rich filters; **Export** button (CSV download of the filtered set). Read-only.

## Task 5 — Live updates via `useEventStream`

- The reference DNS page does **not** use live updates — this is net-new. Use the existing hook `apps/web/src/hooks/useEventStream.ts` (already consumed by `DevicesPage.tsx`/`DeviceDetailPage.tsx`; connects to `/api/v1/events/ws`). Subscribe in `PamPage` (or per-tab) and refetch the active/requests queries on `elevation.requested/approved/denied/expired/revoked`. Debounce bursty refetches.

## Task 6 — Role-gating (PAM is privileged — reference page has none)

- The DNS page has **no** role/permission gate; PAM must not be that permissive. Read the current user from `useAuthStore` (`apps/web/src/stores/auth.ts`) and gate **mutating actions** (approve/deny/revoke, rule CRUD) behind the PAM-manage permission/role; read-only viewers see the queues but disabled actions.
- This is **defense-in-depth only** — the real enforcement is server-side in #1163, which mirrors `actuateElevation.ts:88-90`: `requireScope('organization','partner','system')` + `requirePermission(...)` + `requireMfa()`. Cross-ref: confirm #1163 introduces a `PERMISSIONS.PAM_MANAGE` (or reuses an existing privileged scope) — if it reuses `DEVICES_EXECUTE`, gate the web actions on the same. Note this dependency in the #1163 PR if the permission doesn't exist yet.

## Task 7 — `data-testid` coverage + e2e spec

- The reference page ships **zero** testids (relies on ARIA). CLAUDE.md requires e2e to query by `data-testid` only — so **add the convention here**: `data-testid="pam-tab-requests"`, `pam-request-row-{id}`, `pam-approve-btn-{id}`, `pam-deny-btn-{id}`, `pam-revoke-btn-{id}`, `pam-rule-row-{id}`, `pam-add-rule-btn`, `pam-active-row-{id}` (mirror the `org-row-${id}` style at `OrganizationsPage.tsx:479`).
- Add a Playwright spec `e2e-tests/tests/*.spec.ts` (or a YAML test under `e2e-tests/tests/` per the runner) covering: load page → switch tabs → approve a seeded pending request → it leaves the Requests queue and appears in Overview/active. Page Object under `e2e-tests/pages/`.

## Task 8 — Component tests

- Vitest + jsdom per tab: loading/error/empty render; filter state; `runAction` success path refetches; 401 redirects; role-gate hides actions for non-privileged user. Mock `fetchWithAuth`. Place `*.test.tsx` alongside components (match the `dnsSecurity/*.test.tsx` set).

---

## Sequencing & estimate

Task 1 first (shell unblocks all tabs). Tasks 2–4 parallelizable across tabs. Tasks 5–7 layer on. Effort: **L** (~1–1.5 wk). Ships the **Phase 1 demoable slice** together with #1163: a technician can watch a UAC-intercept request arrive, approve it from the web, and see it actuate — zero Windows-broker changes required (the agent already ingests via #959; #960 actuates).

## Risks / watch-items

- **Blocked on #1163** — every tab 404s without the API. Verify #1163 is merged and the endpoint shapes match before starting; if #1163's response envelopes differ from `body.data ?? body`, adjust the unwrap.
- **Permission model** — if #1163 didn't add a PAM-specific permission, Task 6 has nothing precise to gate on; resolve in the #1163 PR.
- **Astro island hydration** — `client:load` is required (forms need event handlers attached); don't use `client:visible` for the action buttons.

## Self-review checklist

- [ ] All mutations go through `runAction` (no silent mutations; `no-silent-mutations` test passes / allowlist untouched).
- [ ] Tab state in `window.location.hash`, not query params (CLAUDE.md).
- [ ] Mutating actions role-gated client-side; server enforces via #1163 guards.
- [ ] `data-testid` on every interactive element + a Playwright spec exists.
- [ ] 401 path redirects to `/login`; 409 (CAS race) refetches gracefully.
- [ ] Live `elevation.*` events refresh the Overview/Requests views.
