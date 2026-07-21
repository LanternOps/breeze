# Ticketing Phase 4 — Inbound Email Settings + Review Queue (PR 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give partner admins a UI to turn email-to-ticket on, see/copy their inbound address, set the (reserved) default-triage org and autoresponder preference, and work the quarantine/review queue — Convert-to-ticket (creates a `source:'email'` ticket and links the inbound row) or Dismiss. The review-queue routes are partner-scoped + admin-gated on the backend; the settings write reuses the existing self-partner `PATCH /partners/me` (org-write + MFA gate). Every web mutation is routed through `runAction`.

**Architecture:** Three new partner-scoped handlers added to the existing `ticketConfigRoutes` (`apps/api/src/routes/ticketConfig.ts`) reusing its `authMiddleware → requireScope('partner','system') → writePerm (TICKETS_WRITE) → requirePartnerId → adminMiddleware` chain: `GET /ticket-config/email-inbound` (paginated review-queue list), `POST /ticket-config/email-inbound/:id/convert`, `PATCH /ticket-config/email-inbound/:id/dismiss`. Read of the on/off + address + triage + autoresponder config piggybacks on the existing `GET /ticket-config` via a small additive `inbound` block surfaced by `getTicketConfig`; **write** piggybacks on the existing `GET /partners/me` + `PATCH /partners/me` settings-merge route (no new settings route). The web side adds an `inbound` tab to `TicketingSettingsPage.tsx`, gated on the admin/TICKETS_WRITE capability, mounting a new `InboundEmailCard` React island (BillablesExportCard structure + TicketStatusesTab `runAction` discipline).

**Tech Stack:** API — Hono + Drizzle + Zod + Vitest. Web — Astro + React island + Tailwind + Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md` (D3 quarantine/review queue/convert; D4/D5 addressing + Model-B seam display; §2 config in `partners.settings.ticketing.inbound` + `ticket_email_inbound` columns; §6 isolation for new admin routes; §7 Settings card + review queue; §9 testing).

**Depends on PR 1 (`feat/ticketing-email-ingest`, plan `docs/superpowers/plans/ticketing/2026-06-13-ticketing-phase4-email-ingest-backend.md`) being merged first.** PR 1 ships: the `ticket_email_inbound` + `partner_inbound_domains` schema (`apps/api/src/db/schema/emailInbound.ts`, barrel-exported), their migration + RLS + allowlist + forge tests, `MailgunInboundProvider`, `resolvePartnerByRecipient`, `inboundEmailWorker`, the webhook route `POST /webhooks/tickets/email-inbound`, the `createTicket` `source:'email'` extension that accepts `submitterEmail`/`submitterName`, and the `ticket.commented` `inbound:true` flag + notify-worker no-echo guard. **This plan does NOT rebuild any of that** — it consumes `ticketEmailInbound` (the Drizzle table), `createTicket({ source:'email', ... })`, and `getConfig().TICKETS_INBOUND_DOMAIN`. (Confirmed prerequisites already in the tree: `tickets.submitter_email`/`submitter_name` columns exist — `apps/api/src/db/schema/portal.ts:53-54` — and `ticket_source` enum includes `'email'` — `portal.ts:8` — so the convert path's `submitterEmail` write is real once PR 1's `createTicket` `source:'email'` variant lands.)

**Scope of THIS plan (spec §11 PR 4).** Deliverables, exactly: (a) backend partner-scoped routes — read/update inbound settings (`enabled`, `autoresponderEnabled`, `defaultTriageOrgId`, and the self-hosted `address` override round-trip), list review-queue rows, convert-to-ticket, dismiss; (b) the Inbound Email settings card (enable toggle, copyable inbound address derived from slug, default-triage-org picker labelled reserved, autoresponder toggle); (c) the review-queue UI (list `quarantined`/`failed`, Convert-to-ticket, Dismiss) via `runAction` + `no-silent-mutations` enrollment; tests on both layers. Out of scope: outbound threading/autoresponder send logic (PR 3), the Model-B custom-domain wizard, per-org inbound addresses, and a UI editor for the self-hosted `address` override (the card preserves an existing override but does not expose an editor for it — D4 follow-up).

**Plan-level decisions (deltas/clarifications vs spec + research open questions, decided here):**
- **Settings read surface:** rather than have the card parse `partners.settings` JSONB on the client, `getTicketConfig(partnerId)` (`apps/api/src/services/ticketConfigService.ts`) gains an additive `inbound` block: `{ enabled, address, addressOverride, defaultTriageOrgId, autoresponderEnabled, slug, domainConfigured }`. `address` is the resolved address shown in the UI: the `settings.ticketing.inbound.address` override when present (self-hosted, D4), else the derived `{slug}@{TICKETS_INBOUND_DOMAIN}`. `addressOverride` is the **raw override value** (`settings.ticketing.inbound.address` or `null`) — distinct from `address` so the card can re-send the override on write without ever persisting the *derived* address as an override (blocker fix; see "Settings write surface"). `domainConfigured` is `false` when `TICKETS_INBOUND_DOMAIN` is unset so the card can show a "platform inbound domain not configured" hint. Reads come back on the **existing** `GET /ticket-config` the card already calls — one round-trip.
- **Settings write surface + the `address`-preservation hazard (BLOCKER fix):** the card writes the config fields via the existing `PATCH /partners/me` (`apps/api/src/routes/orgs.ts:479`). We extend the inline `partnerSettingsSchema` (`orgs.ts:309`) with an optional `ticketing.inbound` block (including `address`). **The route's merge is the load-bearing risk:** `PATCH /partners/me` does a shallow top-level merge (`{ ...currentSettings, ...body.settings }`, orgs.ts:496) and ONLY deep-merges `security` (orgs.ts:505-510). `ticketing` is **top-level shallow-REPLACED** — so any PATCH that sends a *partial* `ticketing.inbound` silently destroys omitted fields, and `address` (the self-hosted override, spec §2/`spec.md:76`) is a real omitted field. The card therefore must send the **complete** `ticketing.inbound` object on every write: `{ enabled, defaultTriageOrgId, autoresponderEnabled }` **plus** `address: cfg.addressOverride` **only when `cfg.addressOverride` is non-null** (never the derived value, which would persist a derived address as a spurious override and break self-hosted recomputation). Guarded by a real red→green test (Task 4) that a `ticketing.inbound` PATCH preserves a pre-existing `settings.ticketing.inbound.address` override AND `settings.security.ipAllowlist`.
- **Settings-write gate is NOT admin-parity (acknowledged divergence):** the review-queue routes carry `writePerm (TICKETS_WRITE) + adminMiddleware` (platform-admin / wildcard role). The settings *write* reuses `PATCH /partners/me`, gated by `requireScope('partner') + requirePartner + requireOrgWrite + requireMfa()` (orgs.ts:479) — **org-write, NOT admin, and with an MFA step-up**. This is intentional for v1: config toggles are a self-partner settings write on the own-partner row (RLS-backed, no cross-partner surface), so they sit behind the same gate as the rest of `/partners/me` (branding, business hours, security policy). The queue beside them is a stricter admin surface because it can create tickets in any org under the partner and read raw inbound mail. We do **not** add a new admin-gated settings route in v1 to avoid forking partner-settings persistence; if admin parity is later required, add a dedicated `PATCH /ticket-config/email-inbound/settings` under `ticketConfigRoutes` with `writePerm + adminMiddleware`. The Inbound tab is only shown to admin/TICKETS_WRITE users anyway (see "Tab visibility"), so org-write-but-not-admin users never reach the settings write in practice.
- **MFA step-up on the settings write (codebase accuracy):** `PATCH /partners/me` carries `requireMfa()`, which throws `HTTPException(403, { message: 'MFA required' })` when the token hasn't satisfied MFA (`apps/api/src/middleware/auth.ts:542-556`). That is a **403 with no machine `code`** in the body — so `runAction` surfaces the `errorFallback` toast (it is NOT a 401, so it does not trigger the login redirect). The card's `errorFallback` for saves is written to be actionable ("Could not save inbound email settings — your session may need MFA re-verification. Retry."), and `FRIENDLY_CODES` is irrelevant here because the body has no `code`. No special-casing beyond the friendly fallback message is needed for v1.
- **Tab visibility:** the `inbound` tab in `TicketingSettingsPage.tsx` is rendered only when the user has the admin/TICKETS_WRITE capability (the same capability the queue routes require), so a `tickets:read`-only partner user never sees a half-broken card whose queue fetch 403s. The card additionally handles a 403 from the queue fetch distinctly (renders the settings section + an "admin only" notice in place of the queue) as defense-in-depth, in case the tab is reached directly via hash.
- **Convert org source (research open Q1):** the Convert action **always prompts for an org** via a picker; `defaultTriageOrgId` only **pre-selects** the picker's initial value (operator can change it). Spec §4 keeps `defaultTriageOrgId` "reserved" for a future auto-accept mode — it is NOT used to auto-create; it is purely a UX default for the manual convert. The picker is mandatory and its value is what the API receives.
- **Convert actor = the real authenticated admin (resolves the sentinel question for this PR):** the convert action is initiated by a *real* authenticated partner admin, so `convertEmailInbound` threads that user's id/name (`auth.user.id` / `auth.user.name`, populated on `AuthContext.user` — `apps/api/src/middleware/auth.ts:16-22`) from the route into `createTicket(..., actor)`. This gives correct audit attribution (who converted the email) and sidesteps the all-zero-UUID sentinel risk entirely — `createTicket` stamps `actor.userId` into the `ticket.created` event `actorUserId` and the audit `actorId` (`apps/api/src/services/ticketService.ts:285,290`); `audit_logs.actor_id` is `NOT NULL` but **un-constrained** (`apps/api/src/db/schema/audit.ts:13` — no `.references()`), so a real user id is correct and a synthetic one is unnecessary. The worker-path system-actor question stays in PR 1's court.
- **Empty-sender convert is blocked (minor quality fix):** `ticket_email_inbound.from_address` is nullable and quarantined rows are the "unknown sender" case where it may be absent. Converting with `submitterEmail: ''` would create a ticket that can never receive a reply (defeating the `source:'email'` `submitterEmail` extension, spec §6). So `convertEmailInbound` rejects a row with a null/empty `fromAddress` with `400 INBOUND_ROW_NO_SENDER`; the card surfaces a clear message telling the tech the email had no usable From address.
- **Dismiss terminal state (research open Q2):** Dismiss sets `parse_status='ignored'` (reusing PR 1's existing terminal value for "do not process"; no enum/schema change). The review queue lists only `parse_status IN ('quarantined','failed')`, so an `ignored` row drops out of the queue but stays in the table for audit. No new `'dismissed'` value.
- **Permission gate (research open Q3/Q4):** all three new routes carry `writePerm (TICKETS_WRITE)` + `adminMiddleware` (reused verbatim from `ticketConfig.ts:50`). `GET /ticket-config/email-inbound` uses `writePerm` (not `readPerm`) deliberately: it is an admin-only review surface, consistent with the mutations beside it. (This is the only authorization asymmetry vs the settings write, justified above.)
- **Idempotency on convert/dismiss (research open Q7):** both mutations only act on a row whose current `parse_status IN ('quarantined','failed')`; a second click (already `created`/`ignored`) → `409 INBOUND_ROW_ALREADY_RESOLVED`. The card refetches the list after each action so the resolved row disappears.
- **Pagination:** `GET /ticket-config/email-inbound` returns `{ data: [...], pagination: { page, limit, total } }` (the `tickets.ts` shape). `page` default 1, `limit` default 50, capped 100. The card renders Prev/Next when `total > limit`.
- **Service-layer for the new routes:** the three handlers' DB work lives in `ticketConfigService.ts` (new `listEmailInboundQueue`, `convertEmailInbound`, `dismissEmailInbound`), keeping the route thin and matching the existing `getTicketConfig`/`createTicketStatus` split. New error codes go on `TicketConfigServiceErrorCode`.

**Worktree:** create via superpowers:using-git-worktrees from `origin/main` **after PR 1 is merged**, branch `feat/ticketing-email-settings`. Run `pnpm install` in fresh worktrees; **symlink the gitignored `.env.test`** for any integration test. Prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. First commit: this plan.

---

### Task 1: Backend — extend `partnerSettingsSchema` + `getTicketConfig` with the `inbound` block

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (the inline `partnerSettingsSchema`, ~line 309)
- Modify: `apps/api/src/services/ticketConfigService.ts` (`getTicketConfig`, line 330)
- Modify: `apps/api/src/services/ticketConfigService.test.ts`

- [ ] **Step 1: Extend `partnerSettingsSchema` to accept `ticketing.inbound`**

In `apps/api/src/routes/orgs.ts`, inside the `partnerSettingsSchema = z.object({ ... })` block (line 309), add a sibling key (top-level, NOT under `security` — a top-level sibling so the `security`-only deep-merge at orgs.ts:505 never touches it):

```typescript
  ticketing: z.object({
    inbound: z.object({
      enabled: z.boolean().optional(),
      address: z.string().email().optional().or(z.literal('')),
      defaultTriageOrgId: z.string().uuid().nullable().optional(),
      autoresponderEnabled: z.boolean().optional(),
    }).optional(),
  }).optional(),
```

No route-handler change is needed: `PATCH /partners/me` (orgs.ts:479) already does `{ ...currentSettings, ...body.settings }` (line 496), which carries `ticketing` through as a top-level sibling of `security`. The `security` deep-merge (lines 505-510) does not touch `ticketing`. **This shallow replace is exactly why the card must send the complete `ticketing.inbound` object (see Task 5 / Task 4).**

- [ ] **Step 2: Update the EXISTING `getTicketConfig` test's FIFO queue, then add the failing `inbound` test**

`ticketConfigService.test.ts` uses a hoisted **FIFO** db mock: `dbMocks.selectResults` is an array of result rows, and each `db.select()...(where|orderBy|limit)` terminal `.shift()`s the next entry (see the file's own comment at line 5). The existing `getTicketConfig` test (`describe('getTicketConfig')`, line 124) enqueues exactly two results in order: **(1) statuses select, (2) priorities select** (the `readPriorities` internal select). Task 1 Step 4 adds a **third** read — the `partners` row — placed **AFTER** `readPriorities` in `getTicketConfig`. So the existing test must enqueue a third result in that position or it will break by `.shift()`ing the wrong row.

First, update the existing test (line 124's `it('merges priority defaults for unset priorities')`) to enqueue the partners row third:

```typescript
describe('getTicketConfig', () => {
  it('merges priority defaults for unset priorities', async () => {
    dbMocks.selectResults.push([{ id: 's-1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true }]); // (1) statuses
    dbMocks.selectResults.push([{ priority: 'high', label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 }]); // (2) priorities
    dbMocks.selectResults.push([{ slug: 'acme', settings: {} }]); // (3) partners row (new — keeps the FIFO aligned)
    const cfg = await getTicketConfig(PARTNER);
    expect(cfg.statuses).toHaveLength(1);
    expect(cfg.priorities.high).toEqual({ label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
    expect(cfg.priorities.low).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.normal).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.urgent).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
  });
});
```

Then add the new `inbound` block test. To control `getConfig().TICKETS_INBOUND_DOMAIN` per-case, mock the `getConfig` accessor at the top of the file (alongside the existing mocks) so the domain can be toggled; the existing tests are unaffected because they don't read config:

```typescript
// near the other vi.mock(...) calls at the top of the file:
const { configRef } = vi.hoisted(() => ({ configRef: { current: { TICKETS_INBOUND_DOMAIN: 'tickets.example.com' as string | undefined } } }));
vi.mock('../config/validate', () => ({ getConfig: () => configRef.current }));
```

```typescript
describe('getTicketConfig inbound block', () => {
  beforeEach(() => { configRef.current.TICKETS_INBOUND_DOMAIN = 'tickets.example.com'; });

  function enqueueForInbound(partnerRow: unknown) {
    dbMocks.selectResults.push([]); // (1) statuses
    dbMocks.selectResults.push([]); // (2) priorities
    dbMocks.selectResults.push([partnerRow]); // (3) partners row
  }

  it('derives the platform inbound address from slug when no override', async () => {
    enqueueForInbound({ slug: 'acme', settings: { ticketing: { inbound: { enabled: true, autoresponderEnabled: false } } } });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.enabled).toBe(true);
    expect(cfg.inbound.address).toBe('acme@tickets.example.com');
    expect(cfg.inbound.addressOverride).toBeNull();
    expect(cfg.inbound.autoresponderEnabled).toBe(false);
    expect(cfg.inbound.slug).toBe('acme');
    expect(cfg.inbound.domainConfigured).toBe(true);
  });
  it('prefers an explicit address override (self-hosted) and exposes it as addressOverride', async () => {
    enqueueForInbound({ slug: 'acme', settings: { ticketing: { inbound: { address: 'support@tickets.acme.com' } } } });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.address).toBe('support@tickets.acme.com');
    expect(cfg.inbound.addressOverride).toBe('support@tickets.acme.com');
  });
  it('defaults enabled=false, autoresponderEnabled=true, addressOverride=null when config absent', async () => {
    enqueueForInbound({ slug: 'acme', settings: {} });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.enabled).toBe(false);
    expect(cfg.inbound.autoresponderEnabled).toBe(true);
    expect(cfg.inbound.defaultTriageOrgId).toBeNull();
    expect(cfg.inbound.addressOverride).toBeNull();
  });
  it('reports domainConfigured=false and empty address when TICKETS_INBOUND_DOMAIN is unset', async () => {
    configRef.current.TICKETS_INBOUND_DOMAIN = undefined;
    enqueueForInbound({ slug: 'acme', settings: {} });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.domainConfigured).toBe(false);
    expect(cfg.inbound.address).toBe('');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts -t "inbound block" --pool=forks
```

Expected: FAIL — `cfg.inbound` is undefined.

- [ ] **Step 4: Implement the `inbound` block in `getTicketConfig`**

In `apps/api/src/services/ticketConfigService.ts`, add the imports at the top (`config` and `partners`):

```typescript
import { getConfig } from '../config/validate';
import { partners } from '../db/schema';
```

Then replace the `getTicketConfig` body (currently `const priorities = await readPriorities(partnerId); return { statuses, priorities };` at lines 345-346) so it ALSO reads the partner row **after** `readPriorities` (this ordering must match the FIFO sequence updated in Step 2 — statuses, priorities, partners):

```typescript
  const priorities = await readPriorities(partnerId);

  const [partner] = await db
    .select({ slug: partners.slug, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const slug = partner?.slug ?? '';
  const settings = (partner?.settings as Record<string, unknown> | null) ?? {};
  const inboundCfg = (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
    { enabled?: boolean; address?: string; defaultTriageOrgId?: string | null; autoresponderEnabled?: boolean } | undefined) ?? {};
  const domain = getConfig().TICKETS_INBOUND_DOMAIN ?? '';
  const domainConfigured = domain.length > 0;
  const derived = domainConfigured && slug ? `${slug}@${domain}` : '';
  const addressOverride = (inboundCfg.address && inboundCfg.address.length > 0) ? inboundCfg.address : null;

  const inbound = {
    enabled: inboundCfg.enabled ?? false,
    address: addressOverride ?? derived,
    addressOverride,
    defaultTriageOrgId: inboundCfg.defaultTriageOrgId ?? null,
    autoresponderEnabled: inboundCfg.autoresponderEnabled ?? true,
    slug,
    domainConfigured,
  };

  return { statuses, priorities, inbound };
```

(`TICKETS_INBOUND_DOMAIN` is added to the env schema in `apps/api/src/config/validate.ts` by PR 1 and read via `getConfig()` — confirm with `grep -n TICKETS_INBOUND_DOMAIN apps/api/src/config/validate.ts`; if missing, add `TICKETS_INBOUND_DOMAIN: z.string().optional()` to the envSchema. The `eq` import already exists in this file.)

- [ ] **Step 5: Run to verify it passes (whole file, to prove the FIFO update kept the existing test green)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts --pool=forks
```

Expected: PASS (full file green — including the existing `getTicketConfig` test, which now enqueues the partners row).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/services/ticketConfigService.ts apps/api/src/services/ticketConfigService.test.ts
git commit -m "feat(ticketing): inbound config in getTicketConfig + partner settings schema (Phase 4)"
```

---

### Task 2: Backend — `listEmailInboundQueue` service + `GET /ticket-config/email-inbound` route

**Files:**
- Modify: `apps/api/src/services/ticketConfigService.ts` (new `listEmailInboundQueue` + error codes)
- Modify: `apps/api/src/routes/ticketConfig.ts` (new route)
- Modify: `apps/api/src/services/ticketConfigService.test.ts`
- Modify: `apps/api/src/routes/ticketConfig.test.ts`

- [ ] **Step 1: Add the review-queue error codes**

In `apps/api/src/services/ticketConfigService.ts`, extend `TicketConfigServiceErrorCode` (line 272):

```typescript
export type TicketConfigServiceErrorCode =
  | 'STATUS_NAME_TAKEN'
  | 'STATUS_NOT_FOUND'
  | 'SYSTEM_STATUS_IMMUTABLE'
  | 'SYSTEM_STATUS_REQUIRED'
  | 'INBOUND_ROW_NOT_FOUND'
  | 'INBOUND_ROW_ALREADY_RESOLVED'
  | 'INBOUND_ROW_NO_SENDER'
  | 'ORG_NOT_ACCESSIBLE';
```

- [ ] **Step 2: Write the failing `listEmailInboundQueue` service test**

In `apps/api/src/services/ticketConfigService.test.ts`, add. The FIFO db mock supports chained `.from().where().orderBy()` / `.limit().offset()` and a count terminal; enqueue the rows result, then the count result:

```typescript
describe('listEmailInboundQueue', () => {
  it('returns quarantined+failed rows scoped to the partner with pagination', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: 'acme@tickets.example.com', subject: 'printer', parseStatus: 'quarantined', error: null, ticketId: null, createdAt: new Date('2026-06-13T00:00:00Z') }]); // rows
    dbMocks.selectResults.push([{ total: 1 }]); // count
    const res = await listEmailInboundQueue('p-1', { page: 1, limit: 50 });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].parseStatus).toBe('quarantined');
    expect(res.pagination).toEqual({ page: 1, limit: 50, total: 1 });
  });
  it('caps limit at 100 and floors page at 1', async () => {
    dbMocks.selectResults.push([]); // rows
    dbMocks.selectResults.push([{ total: 0 }]); // count
    const res = await listEmailInboundQueue('p-1', { page: 0, limit: 9999 });
    expect(res.pagination.limit).toBe(100);
    expect(res.pagination.page).toBe(1);
  });
});
```

> If the file's db mock does not already expose an `.offset()` terminal on the select chain (Task 2 uses `.orderBy().limit().offset()`), extend the hoisted mock's chain object so `orderBy` returns `{ limit: () => ({ offset: () => Promise.resolve(r) }) }` alongside the existing terminals, returning the same `r` (the shifted FIFO result). Keep the existing `then`/`limit`/`orderBy` terminals intact so the other tests still resolve.

- [ ] **Step 3: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts -t "listEmailInboundQueue" --pool=forks
```

Expected: FAIL — `listEmailInboundQueue` is not exported.

- [ ] **Step 4: Implement `listEmailInboundQueue`**

In `apps/api/src/services/ticketConfigService.ts`, extend the drizzle imports (`desc`, `inArray`, `count` — `and`/`eq`/`asc` already imported at the top) and add `ticketEmailInbound` (PR 1's table) to the schema import:

```typescript
import { eq, and, asc, desc, inArray, count } from 'drizzle-orm';
// ...add ticketEmailInbound to the existing schema import:
import { ticketStatuses, ticketPrioritySettings, orgTicketSettings, ticketEmailInbound, partners } from '../db/schema';
```

Add the function:

```typescript
const REVIEW_STATUSES = ['quarantined', 'failed'] as const;

export interface EmailInboundQueueRow {
  id: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  parseStatus: string;
  error: string | null;
  ticketId: string | null;
  createdAt: Date;
}

export async function listEmailInboundQueue(
  partnerId: string,
  opts: { page: number; limit: number },
): Promise<{ data: EmailInboundQueueRow[]; pagination: { page: number; limit: number; total: number } }> {
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit) || 50));
  const offset = (page - 1) * limit;

  const where = and(
    eq(ticketEmailInbound.partnerId, partnerId),
    inArray(ticketEmailInbound.parseStatus, REVIEW_STATUSES as unknown as string[]),
  );

  const data = await db
    .select({
      id: ticketEmailInbound.id,
      fromAddress: ticketEmailInbound.fromAddress,
      toAddress: ticketEmailInbound.toAddress,
      subject: ticketEmailInbound.subject,
      parseStatus: ticketEmailInbound.parseStatus,
      error: ticketEmailInbound.error,
      ticketId: ticketEmailInbound.ticketId,
      createdAt: ticketEmailInbound.createdAt,
    })
    .from(ticketEmailInbound)
    .where(where)
    .orderBy(desc(ticketEmailInbound.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: count() })
    .from(ticketEmailInbound)
    .where(where);

  return { data, pagination: { page, limit, total: Number(total) } };
}
```

- [ ] **Step 5: Run to verify the service test passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts -t "listEmailInboundQueue" --pool=forks
```

Expected: PASS.

- [ ] **Step 6: Add the route**

In `apps/api/src/routes/ticketConfig.ts`, after the `GET /` handler (line 64) and BEFORE the `/statuses/...` literal routes / `/:id` (Hono matching is registration-ordered, and `/email-inbound` is a distinct literal so ordering vs `/statuses/...` doesn't matter — just keep it above any `/:id` param route). Import the query-validation deps (`zValidator`/`z` already imported) and the service fns:

```typescript
import {
  getTicketConfig, createTicketStatus, updateTicketStatus, reorderTicketStatuses,
  upsertPrioritySettings, TicketConfigServiceError,
  listEmailInboundQueue, convertEmailInbound, dismissEmailInbound,
} from '../services/ticketConfigService';
```

```typescript
const emailInboundQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /email-inbound — review queue (quarantined + failed). Admin-only surface,
// so it carries writePerm + adminMiddleware like the mutations beside it.
ticketConfigRoutes.get('/email-inbound', scopes, writePerm, adminMiddleware, zValidator('query', emailInboundQuerySchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const { page, limit } = c.req.valid('query');
  const result = await listEmailInboundQueue(partnerId, { page, limit });
  return c.json(result);
});
```

- [ ] **Step 7: Write the failing route test (use the REAL harness — serviceMocks + permsRef, not headers)**

`apps/api/src/routes/ticketConfig.test.ts` authenticates via the hoisted `authRef`/`permsRef` (no header object exists), mocks the service via the hoisted `serviceMocks` block (lines 3-10), drives admin via `permsRef.current = ADMIN_PERMS` (the wildcard, line 49) plus `authRef.current.user.isPlatformAdmin`, and exercises routes with `ticketConfigRoutes.request(path, init)`. The partner id is `'p-1'`. **First add the three new service fns to the hoisted `serviceMocks` object** (so the `vi.mock` spread `{ ...actual, ...serviceMocks }` exposes them as mocks):

```typescript
// in the vi.hoisted serviceMocks object (lines 4-10):
  serviceMocks: {
    getTicketConfig: vi.fn(),
    createTicketStatus: vi.fn(),
    updateTicketStatus: vi.fn(),
    reorderTicketStatuses: vi.fn(),
    upsertPrioritySettings: vi.fn(),
    listEmailInboundQueue: vi.fn(),
    convertEmailInbound: vi.fn(),
    dismissEmailInbound: vi.fn(),
  },
```

Then add the GET tests (drive admin by flipping `permsRef.current = ADMIN_PERMS`; the `beforeEach` already resets it to the tickets-only perms, which makes `adminMiddleware` return 403):

```typescript
describe('GET /ticket-config/email-inbound', () => {
  it('403 when not admin (default tickets-only perms)', async () => {
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(403);
  });
  it('403 when no partner context', async () => {
    permsRef.current = ADMIN_PERMS;
    authRef.current.user.isPlatformAdmin = true;
    authRef.current.partnerId = null;
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(403);
  });
  it('returns the paginated queue for an admin partner user', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.listEmailInboundQueue.mockResolvedValue({ data: [{ id: 'r-1', parseStatus: 'quarantined' }], pagination: { page: 1, limit: 50, total: 1 } });
    const res = await ticketConfigRoutes.request('/email-inbound');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe('r-1');
    expect(serviceMocks.listEmailInboundQueue).toHaveBeenCalledWith('p-1', { page: 1, limit: 50 });
  });
});
```

- [ ] **Step 8: Run to verify the route test passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketConfig.test.ts -t "email-inbound" --pool=forks
```

Expected: the GET tests PASS (convert/dismiss tests come in Task 3).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/ticketConfigService.ts apps/api/src/services/ticketConfigService.test.ts apps/api/src/routes/ticketConfig.ts apps/api/src/routes/ticketConfig.test.ts
git commit -m "feat(ticketing): review-queue list route GET /ticket-config/email-inbound (Phase 4)"
```

---

### Task 3: Backend — `convertEmailInbound` + `dismissEmailInbound` services + routes

**Files:**
- Modify: `apps/api/src/services/ticketConfigService.ts`
- Modify: `apps/api/src/routes/ticketConfig.ts`
- Modify: `apps/api/src/services/ticketConfigService.test.ts`
- Modify: `apps/api/src/routes/ticketConfig.test.ts`

- [ ] **Step 1: Write the failing service tests (convert + dismiss)**

In `apps/api/src/services/ticketConfigService.test.ts`, add. Mock `./ticketService`'s `createTicket` (a new hoisted mock — see note) and enqueue db results for the row read + org-guard read; the FIFO mock also serves the `.update().returning()` via `dbMocks.updateResult`:

```typescript
// near the top mocks: createTicket is in ./ticketService — mock it so convert doesn't hit the real service.
const { createTicketMock } = vi.hoisted(() => ({ createTicketMock: vi.fn() }));
vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, createTicket: createTicketMock };
});
```

```typescript
const ACTOR = { userId: 'admin-u-1', name: 'Ada Admin' };

describe('convertEmailInbound', () => {
  beforeEach(() => createTicketMock.mockReset());

  it('creates a source:email ticket for the chosen org and links the row', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { text: 'help' } }]); // row read
    dbMocks.selectResults.push([{ id: 'o-1' }]); // org guard read
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: 'acme@tickets.example.com', subject: 'printer', parseStatus: 'created', error: null, ticketId: 't-9', createdAt: new Date() }];
    createTicketMock.mockResolvedValue({ id: 't-9', internalNumber: 'T-2026-0007' });
    const row = await convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR);
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'o-1', source: 'email', submitterEmail: 'jane@x.com' }),
      ACTOR,
    );
    expect(row.ticketId).toBe('t-9');
    expect(row.parseStatus).toBe('created');
  });
  it('throws INBOUND_ROW_NOT_FOUND when the row is not under this partner', async () => {
    dbMocks.selectResults.push([]); // scoped row read → []
    await expect(convertEmailInbound('p-1', 'r-x', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws INBOUND_ROW_ALREADY_RESOLVED for a non-queue row (idempotency)', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'created' }]);
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_ALREADY_RESOLVED' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws INBOUND_ROW_NO_SENDER when the row has no from address', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: null, subject: 'x', toAddress: 'acme@tickets.example.com', raw: {} }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]); // org guard (still read before the sender check; order tolerant)
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NO_SENDER' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws ORG_NOT_ACCESSIBLE when the chosen org is not under the partner', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'x', toAddress: 'acme@tickets.example.com', raw: {} }]);
    dbMocks.selectResults.push([]); // org guard read → []
    await expect(convertEmailInbound('p-1', 'r-1', 'o-other', ACTOR)).rejects.toMatchObject({ code: 'ORG_NOT_ACCESSIBLE' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
});

describe('dismissEmailInbound', () => {
  it("sets parse_status='ignored' scoped to (id, partnerId)", async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'failed' }]); // row read
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: null, toAddress: null, subject: null, parseStatus: 'ignored', error: null, ticketId: null, createdAt: new Date() }];
    const row = await dismissEmailInbound('p-1', 'r-1');
    expect(row.parseStatus).toBe('ignored');
  });
  it('throws INBOUND_ROW_NOT_FOUND for a foreign-partner row', async () => {
    dbMocks.selectResults.push([]); // scoped read returns []
    await expect(dismissEmailInbound('p-1', 'r-x')).rejects.toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
  });
  it('throws INBOUND_ROW_ALREADY_RESOLVED for an already-ignored row', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'ignored' }]);
    await expect(dismissEmailInbound('p-1', 'r-1')).rejects.toMatchObject({ code: 'INBOUND_ROW_ALREADY_RESOLVED' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts -t "convertEmailInbound|dismissEmailInbound" --pool=forks
```

Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement both services**

In `apps/api/src/services/ticketConfigService.ts`, import `createTicket` + `TicketActor` and the orgs table (`organizations` for the org-belongs-to-partner guard):

```typescript
import { createTicket, type TicketActor } from './ticketService';
import { organizations } from '../db/schema';
```

Add the shared queue-row read guard and the two functions. **The convert actor is the real authenticated admin, passed in from the route — no synthetic sentinel:**

```typescript
async function readQueueRow(partnerId: string, id: string) {
  const [row] = await db
    .select({
      id: ticketEmailInbound.id,
      partnerId: ticketEmailInbound.partnerId,
      parseStatus: ticketEmailInbound.parseStatus,
      fromAddress: ticketEmailInbound.fromAddress,
      toAddress: ticketEmailInbound.toAddress,
      subject: ticketEmailInbound.subject,
      raw: ticketEmailInbound.raw,
    })
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .limit(1);
  if (!row) throw new TicketConfigServiceError('Inbound email not found', 404, 'INBOUND_ROW_NOT_FOUND');
  if (!(REVIEW_STATUSES as readonly string[]).includes(row.parseStatus)) {
    throw new TicketConfigServiceError('This inbound email has already been handled', 409, 'INBOUND_ROW_ALREADY_RESOLVED');
  }
  return row;
}

const returnQueueCols = {
  id: ticketEmailInbound.id,
  fromAddress: ticketEmailInbound.fromAddress,
  toAddress: ticketEmailInbound.toAddress,
  subject: ticketEmailInbound.subject,
  parseStatus: ticketEmailInbound.parseStatus,
  error: ticketEmailInbound.error,
  ticketId: ticketEmailInbound.ticketId,
  createdAt: ticketEmailInbound.createdAt,
};

export async function convertEmailInbound(partnerId: string, id: string, orgId: string, actor: TicketActor): Promise<EmailInboundQueueRow> {
  const row = await readQueueRow(partnerId, id);

  // Guard (spec §6): the chosen org must belong to the resolved partner.
  const [orgOk] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId)))
    .limit(1);
  if (!orgOk) throw new TicketConfigServiceError('That organization is not in your partner', 400, 'ORG_NOT_ACCESSIBLE');

  // A ticket with no sender email can never receive a reply — the whole point of
  // source:'email' is the submitterEmail recipient (spec §6). Block instead of
  // silently creating a reply-less ticket.
  const submitterEmail = (row.fromAddress ?? '').trim();
  if (!submitterEmail) {
    throw new TicketConfigServiceError('This email has no usable sender address; it cannot be converted to a ticket', 400, 'INBOUND_ROW_NO_SENDER');
  }

  const raw = (row.raw as Record<string, unknown> | null) ?? {};
  const description = typeof raw.text === 'string' ? raw.text : (typeof raw['stripped-text'] === 'string' ? raw['stripped-text'] as string : '');
  const fromName = typeof raw.fromName === 'string' ? raw.fromName : undefined;

  const ticket = await createTicket(
    {
      orgId,
      subject: row.subject?.trim() || '(no subject)',
      description,
      source: 'email',
      submitterEmail,
      submitterName: fromName,
    },
    actor,
  );

  const [updated] = await db
    .update(ticketEmailInbound)
    .set({ ticketId: ticket.id, parseStatus: 'created' })
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .returning(returnQueueCols);
  return updated;
}

export async function dismissEmailInbound(partnerId: string, id: string): Promise<EmailInboundQueueRow> {
  await readQueueRow(partnerId, id);
  const [updated] = await db
    .update(ticketEmailInbound)
    .set({ parseStatus: 'ignored' })
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .returning(returnQueueCols);
  return updated;
}
```

> The `createTicket` call here is the **only** ticket-creation path in PR 4 — it reuses PR 1 Task 8's `source:'email'` variant (which requires a non-empty `submitterEmail: string`; the `INBOUND_ROW_NO_SENDER` guard above guarantees it). No `ticket.commented`/`ticket.created` event is emitted by hand; `createTicket` already emits its own and stamps `actor.userId` (the real admin) into the audit/event trail. The convert just flips the inbound row to `created` + links the ticket id.

- [ ] **Step 4: Run to verify the service tests pass (whole file)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketConfigService.test.ts --pool=forks
```

Expected: PASS (whole file).

- [ ] **Step 5: Add the routes (thread the real authenticated admin as actor)**

In `apps/api/src/routes/ticketConfig.ts`, after the `GET /email-inbound` handler. Add a body schema and the two handlers (literal `/email-inbound/:id/...` paths — keep them above any bare `/:id` param route). The convert handler reads `c.get('auth')` to build the `TicketActor` from the real user:

```typescript
const convertEmailInboundSchema = z.object({ orgId: z.string().uuid() });

ticketConfigRoutes.post('/email-inbound/:id/convert', scopes, writePerm, adminMiddleware, zValidator('param', idParam), zValidator('json', convertEmailInboundSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const auth = c.get('auth') as AuthContext;
  try {
    const { id } = c.req.valid('param');
    const { orgId } = c.req.valid('json');
    const row = await convertEmailInbound(partnerId, id, orgId, { userId: auth.user.id, name: auth.user.name });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.patch('/email-inbound/:id/dismiss', scopes, writePerm, adminMiddleware, zValidator('param', idParam), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    const row = await dismissEmailInbound(partnerId, id);
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
```

(`handleServiceError` (line 29) already maps `TicketConfigServiceError` → `{ error, code }` at `err.status`, so the new `INBOUND_*` / `ORG_NOT_ACCESSIBLE` codes surface to the client automatically. `AuthContext` is already imported at ticketConfig.ts:6.)

- [ ] **Step 6: Write the failing route tests (convert + dismiss) using the REAL harness**

In `apps/api/src/routes/ticketConfig.test.ts`, add (the `convertEmailInbound`/`dismissEmailInbound` mocks were already added to `serviceMocks` in Task 2 Step 7; the test user is `authRef.current.user = { id: 'u-1', name: 'Tess Tech', ... }`; partner id is `'p-1'`; drive admin via `permsRef.current = ADMIN_PERMS`):

```typescript
const INBOUND_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-0000000000aa';

describe('POST /ticket-config/email-inbound/:id/convert', () => {
  it('403 for non-admin (default perms)', async () => {
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(403);
  });
  it('400 when orgId is missing/not a uuid', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
  it('converts and forwards the authenticated admin as the actor', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockResolvedValue({ id: 'r-1', parseStatus: 'created', ticketId: 't-9' });
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.convertEmailInbound).toHaveBeenCalledWith('p-1', INBOUND_ID, ORG_ID, { userId: 'u-1', name: 'Tess Tech' });
  });
  it('surfaces ORG_NOT_ACCESSIBLE as 400 with code', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockRejectedValue(new TicketConfigServiceError('no', 400, 'ORG_NOT_ACCESSIBLE'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ORG_NOT_ACCESSIBLE');
  });
  it('surfaces INBOUND_ROW_NO_SENDER as 400 with code', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.convertEmailInbound.mockRejectedValue(new TicketConfigServiceError('no sender', 400, 'INBOUND_ROW_NO_SENDER'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: ORG_ID }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INBOUND_ROW_NO_SENDER');
  });
});

describe('PATCH /ticket-config/email-inbound/:id/dismiss', () => {
  it('dismisses and returns the row', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.dismissEmailInbound.mockResolvedValue({ id: 'r-1', parseStatus: 'ignored' });
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/dismiss`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(serviceMocks.dismissEmailInbound).toHaveBeenCalledWith('p-1', INBOUND_ID);
  });
  it('surfaces INBOUND_ROW_ALREADY_RESOLVED as 409', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.dismissEmailInbound.mockRejectedValue(new TicketConfigServiceError('done', 409, 'INBOUND_ROW_ALREADY_RESOLVED'));
    const res = await ticketConfigRoutes.request(`/email-inbound/${INBOUND_ID}/dismiss`, { method: 'PATCH' });
    expect(res.status).toBe(409);
  });
});
```

> `TicketConfigServiceError` must be importable in the test. It's already exported from `../services/ticketConfigService` and the test imports `ticketConfigRoutes` from `./ticketConfig`; add `import { TicketConfigServiceError } from '../services/ticketConfigService';` near the top imports if it isn't already present (the existing `TicketConfigServiceError` describe block at line 303 of the *service* test confirms the export; the *route* test needs its own import).

- [ ] **Step 7: Run to verify the route tests pass (whole file)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketConfig.test.ts --pool=forks
```

Expected: PASS (whole file — the existing status/priority route tests are untouched because `serviceMocks` only gained keys).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/ticketConfigService.ts apps/api/src/services/ticketConfigService.test.ts apps/api/src/routes/ticketConfig.ts apps/api/src/routes/ticketConfig.test.ts
git commit -m "feat(ticketing): convert + dismiss review-queue routes (real admin actor, no-sender guard)"
```

---

### Task 4: Backend — `PATCH /partners/me` regression tests (ticketing.inbound preserves security AND the address override)

**Files:**
- Modify: `apps/api/src/routes/orgs.test.ts`

This task has TWO tests with a **real red→green cycle**, not a characterization no-op. The blocker-#1 data-loss path (an `address` override silently destroyed) gets a dedicated failing-first test; the R8 `security.ipAllowlist`-preservation path gets a second test. Both mirror the existing `settings.security.ipAllowlist` block harness (`orgs.test.ts:435-520`): `mockCurrentPartnerSelect(settings)` seeds the current partner row, `mockUpdateCapture()` captures the `set(...)` payload, and partner-scope is injected via `setAuthContext({ scope: 'partner', partnerId: 'partner-123' })`. `requireMfa()` is mocked as a pass-through in this file (`orgs.test.ts:147`), so the MFA gate doesn't block the test.

- [ ] **Step 1: Write the address-override test FIRST and run it BEFORE Task 1's schema change so it fails (meaningful red)**

> **Ordering note (TDD rigor):** if you are executing tasks strictly in order, Task 1's schema extension already landed, so to see a real red phase for THIS test, temporarily check it against a tree WITHOUT the `ticketing` key in `partnerSettingsSchema` (e.g. run it on the commit before Task 1, or comment out the `ticketing` schema key, run, observe FAIL, restore). Without the schema key, `updatePartnerSettingsSchema` strips `ticketing` from the body → the PATCH never carries it → `captured.settings.ticketing` is `undefined` → the assertion fails. This proves the test can fail and is not a silent no-op. Re-add the schema key (Task 1) to make it green.

In `apps/api/src/routes/orgs.test.ts`, inside a new (or the existing) `describe('PATCH /orgs/partners/me ...')` block — using the same `mockCurrentPartnerSelect`/`mockUpdateCapture` helpers (lift them to a shared scope if they're nested inside the `:id` describe; they're plain functions, safe to duplicate locally), and `patchMe` hitting `/orgs/partners/me`:

```typescript
describe('PATCH /orgs/partners/me — ticketing.inbound merge safety', () => {
  function patchMe(body: unknown) {
    return app.request('/orgs/partners/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('preserves a pre-existing settings.ticketing.inbound.address override (blocker #1)', async () => {
    setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
    mockCurrentPartnerSelect({
      ticketing: { inbound: { enabled: false, address: 'support@tickets.acme.com', autoresponderEnabled: true } },
    });
    const getCaptured = mockUpdateCapture();

    // Card re-sends the COMPLETE ticketing.inbound including the override it read back.
    const res = await patchMe({ settings: { ticketing: { inbound: {
      enabled: true,
      defaultTriageOrgId: null,
      autoresponderEnabled: false,
      address: 'support@tickets.acme.com',
    } } } });

    expect(res.status).toBe(200);
    expect(getCaptured().settings.ticketing.inbound.address).toBe('support@tickets.acme.com');
    expect(getCaptured().settings.ticketing.inbound.enabled).toBe(true);
    expect(getCaptured().settings.ticketing.inbound.autoresponderEnabled).toBe(false);
  });
```

- [ ] **Step 2: Add the `security.ipAllowlist`-preservation test (R8) in the same block**

```typescript
  it('preserves settings.security.ipAllowlist when only ticketing.inbound is patched (R8)', async () => {
    setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
    mockCurrentPartnerSelect({
      security: { ipAllowlist: ['203.0.113.0/24'], requireMfa: true },
      ticketing: { inbound: { enabled: false } },
    });
    const getCaptured = mockUpdateCapture();

    const res = await patchMe({ settings: { ticketing: { inbound: {
      enabled: true, defaultTriageOrgId: null, autoresponderEnabled: false,
    } } } });

    expect(res.status).toBe(200);
    expect(getCaptured().settings.security.ipAllowlist).toEqual(['203.0.113.0/24']);
    expect(getCaptured().settings.ticketing.inbound.enabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run both tests — they must PASS on the post-Task-1 tree**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts -t "ticketing.inbound merge safety" --pool=forks
```

Expected: PASS (both). If the address test FAILS, the Task 1 schema key was nested under `security` (stripping `ticketing`) or omitted `address` — re-check that `ticketing` is a top-level sibling and its `inbound.address` field is present. (The `security` test confirms the deep-merge still protects `security` because `ticketing` is a top-level sibling and shallow-replaced losslessly when sent whole.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/orgs.test.ts
git commit -m "test(ticketing): PATCH /partners/me preserves ticketing.inbound.address override + security.ipAllowlist"
```

---

### Task 5: Frontend — `InboundEmailCard` component (settings + review queue)

**Files:**
- Create: `apps/web/src/components/settings/InboundEmailCard.tsx`
- Modify: `apps/web/src/components/settings/TicketingSettingsPage.tsx` (add `inbound` tab, admin-gated)

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/settings/InboundEmailCard.tsx`. It (a) loads `GET /ticket-config` for the `inbound` settings block + `GET /ticket-config/email-inbound` for the queue + `GET /orgs/organizations?limit=100` for the org pickers; (b) renders the settings (enable toggle, copyable address, triage-org picker labelled reserved, autoresponder toggle) saving via `PATCH /partners/me` through `runAction`, **always sending the complete `ticketing.inbound` object including `address: cfg.addressOverride` only when the override is set**; (c) renders the review queue with Convert (org picker) + Dismiss through `runAction`. It handles a 403 from the queue fetch distinctly (renders the settings + an "admin only" notice in place of the queue). Mirror `TicketStatusesTab.tsx` for the `runAction`/`friendlyCode`/`UNAUTHORIZED`/`handleActionError` discipline and `BillablesExportCard.tsx` for the org load (`/orgs/organizations?limit=100` → `{ data: [{ id, name }] }`) + card chrome.

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { showToast } from '../shared/Toast';

interface InboundConfig {
  enabled: boolean;
  address: string;
  addressOverride: string | null;
  defaultTriageOrgId: string | null;
  autoresponderEnabled: boolean;
  slug: string;
  domainConfigured: boolean;
}

interface QueueRow {
  id: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  parseStatus: 'quarantined' | 'failed';
  error: string | null;
  ticketId: string | null;
  createdAt: string;
}

interface OrgOption { id: string; name: string }

const FRIENDLY_CODES: Record<string, string> = {
  ORG_NOT_ACCESSIBLE: 'That organization is not available under your partner.',
  INBOUND_ROW_NOT_FOUND: 'That inbound email is no longer available.',
  INBOUND_ROW_ALREADY_RESOLVED: 'That inbound email was already handled. Refreshing the list.',
  INBOUND_ROW_NO_SENDER: 'This email has no usable sender address, so it cannot become a ticket. Dismiss it or follow up out-of-band.',
};
const friendlyCode = (code: string): string | undefined => FRIENDLY_CODES[code];
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const PAGE_SIZE = 50;
const SAVE_ERROR = 'Could not save inbound email settings — your session may need MFA re-verification. Retry.';

export default function InboundEmailCard() {
  const [cfg, setCfg] = useState<InboundConfig | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [queueForbidden, setQueueForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [convertOpenId, setConvertOpenId] = useState<string | null>(null);
  const [convertOrgId, setConvertOrgId] = useState('');

  const loadConfig = useCallback(async () => {
    const res = await fetchWithAuth('/ticket-config');
    if (!res.ok) { setError(true); return; }
    const body = (await res.json()) as { data: { inbound: InboundConfig } };
    setCfg(body.data.inbound);
  }, []);

  const loadQueue = useCallback(async (p: number) => {
    const res = await fetchWithAuth(`/ticket-config/email-inbound?page=${p}&limit=${PAGE_SIZE}`);
    if (res.status === 403) { setQueueForbidden(true); return; } // admin-only queue; settings still usable
    if (!res.ok) { setError(true); return; }
    setQueueForbidden(false);
    const body = (await res.json()) as { data: QueueRow[]; pagination: { total: number } };
    setRows(body.data);
    setTotal(body.pagination.total);
  }, []);

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations?limit=100');
    if (res.ok) {
      const body = (await res.json()) as { data?: OrgOption[] };
      if (body.data) setOrgs(body.data);
    }
  }, []);

  const loadAll = useCallback(async (p: number) => {
    setLoading(true); setError(false);
    try { await Promise.all([loadConfig(), loadQueue(p), loadOrgs()]); }
    catch { setError(true); }
    setLoading(false);
  }, [loadConfig, loadQueue, loadOrgs]);

  useEffect(() => { void loadAll(1); }, [loadAll]);

  const saveConfig = useCallback(async (patch: Partial<Pick<InboundConfig, 'enabled' | 'defaultTriageOrgId' | 'autoresponderEnabled'>>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    // Send the COMPLETE ticketing.inbound object — the route shallow-replaces
    // `ticketing`, so any omitted field is destroyed. Include `address` ONLY when
    // there is a real self-hosted override (never the derived value).
    const inbound: Record<string, unknown> = {
      enabled: next.enabled,
      defaultTriageOrgId: next.defaultTriageOrgId,
      autoresponderEnabled: next.autoresponderEnabled,
    };
    if (next.addressOverride) inbound.address = next.addressOverride;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/orgs/partners/me', {
          method: 'PATCH',
          body: JSON.stringify({ settings: { ticketing: { inbound } } }),
        }),
        errorFallback: SAVE_ERROR,
        successMessage: 'Inbound email settings saved',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      setCfg(next);
    } catch (err) {
      handleActionError(err, SAVE_ERROR);
    } finally { setSaving(false); }
  }, [cfg]);

  const convert = useCallback(async (id: string) => {
    if (!convertOrgId) { showToast({ type: 'error', message: 'Pick an organization first.' }); return; }
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-config/email-inbound/${id}/convert`, { method: 'POST', body: JSON.stringify({ orgId: convertOrgId }) }),
        errorFallback: 'Convert to ticket failed. Retry.',
        successMessage: 'Ticket created from email',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      setConvertOpenId(null);
      await loadQueue(page);
    } catch (err) {
      handleActionError(err, 'Convert to ticket failed. Retry.');
      await loadQueue(page); // already-resolved → refresh so the stale row clears
    }
  }, [convertOrgId, page, loadQueue]);

  const dismiss = useCallback(async (id: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-config/email-inbound/${id}/dismiss`, { method: 'PATCH' }),
        errorFallback: 'Dismiss failed. Retry.',
        successMessage: 'Inbound email dismissed',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      await loadQueue(page);
    } catch (err) {
      handleActionError(err, 'Dismiss failed. Retry.');
      await loadQueue(page);
    }
  }, [page, loadQueue]);

  const copyAddress = useCallback(() => {
    if (cfg?.address) { void navigator.clipboard?.writeText(cfg.address); showToast({ type: 'success', message: 'Inbound address copied' }); }
  }, [cfg]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const goPage = useCallback((p: number) => { setPage(p); void loadQueue(p); }, [loadQueue]);

  if (loading) return <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-email-loading">Loading.</p>;
  if (error || !cfg) return (
    <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-email-error">
      Inbound email settings failed to load.{' '}
      <button type="button" onClick={() => void loadAll(1)} className="underline hover:text-foreground" data-testid="inbound-email-retry">Retry</button>
    </p>
  );

  return (
    <div className="max-w-3xl space-y-6" data-testid="inbound-email-card">
      <section className="rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold">Inbound email</h2>
        <p className="mb-3 text-xs text-muted-foreground">Turn email addressed to your inbound address into tickets.</p>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} disabled={saving} onChange={(e) => void saveConfig({ enabled: e.target.checked })} data-testid="inbound-enabled-toggle" />
          Enable email-to-ticket
        </label>

        <div className="mt-3">
          <label className="text-xs font-medium">Inbound address</label>
          {cfg.domainConfigured ? (
            <div className="mt-0.5 flex items-center gap-2">
              <input readOnly value={cfg.address} className="flex-1 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm" data-testid="inbound-address" />
              <button type="button" onClick={copyAddress} className="rounded-md border px-2.5 py-1.5 text-sm" data-testid="inbound-address-copy">Copy</button>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-amber-600" data-testid="inbound-address-unconfigured">
              The platform inbound domain isn't configured yet. Contact your administrator.
            </p>
          )}
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium" htmlFor="inbound-triage-org">Default triage organization <span className="text-muted-foreground">(reserved for future use)</span></label>
          <select
            id="inbound-triage-org"
            value={cfg.defaultTriageOrgId ?? ''}
            disabled={saving}
            onChange={(e) => void saveConfig({ defaultTriageOrgId: e.target.value || null })}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="inbound-triage-org"
          >
            <option value="">None</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.autoresponderEnabled} disabled={saving} onChange={(e) => void saveConfig({ autoresponderEnabled: e.target.checked })} data-testid="inbound-autoresponder-toggle" />
          Send an autoresponse acknowledging new email tickets
        </label>
      </section>

      <section className="rounded-lg border p-4" data-testid="inbound-review-queue">
        <h2 className="mb-1 text-sm font-semibold">Review queue</h2>
        <p className="mb-3 text-xs text-muted-foreground">Quarantined (unknown sender) and failed inbound emails. Convert to a ticket or dismiss.</p>
        {queueForbidden ? (
          <p className="text-sm text-muted-foreground" data-testid="inbound-review-forbidden">The review queue is available to admins only.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="inbound-review-empty">Nothing to review.</p>
        ) : (
          <table className="min-w-full divide-y text-sm">
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`inbound-row-${r.id}`}>
                  <td className="px-2 py-2 align-top">
                    <div className="font-medium">{r.fromAddress ?? '(unknown sender)'}</div>
                    <div className="text-muted-foreground">{r.subject ?? '(no subject)'}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <span className="rounded border px-1 py-0.5">{r.parseStatus}</span>{' '}
                      {new Date(r.createdAt).toLocaleString()}
                      {r.parseStatus === 'failed' && r.error && <span className="ml-2 text-red-600">{r.error}</span>}
                    </div>
                    {convertOpenId === r.id && (
                      <div className="mt-2 flex items-center gap-2" data-testid={`inbound-convert-form-${r.id}`}>
                        <select value={convertOrgId} onChange={(e) => setConvertOrgId(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm" data-testid={`inbound-convert-org-${r.id}`}>
                          <option value="">Select organization…</option>
                          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                        <button type="button" onClick={() => void convert(r.id)} disabled={!convertOrgId} className="rounded-md bg-primary px-2.5 py-1 text-sm text-white disabled:opacity-50" data-testid={`inbound-convert-submit-${r.id}`}>Create ticket</button>
                        <button type="button" onClick={() => setConvertOpenId(null)} className="rounded-md border px-2.5 py-1 text-sm">Cancel</button>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right align-top space-x-2 whitespace-nowrap">
                    <button type="button" onClick={() => { setConvertOpenId(r.id); setConvertOrgId(cfg.defaultTriageOrgId ?? ''); }} className="text-muted-foreground hover:text-foreground" data-testid={`inbound-convert-${r.id}`}>Convert to ticket</button>
                    <button type="button" onClick={() => void dismiss(r.id)} className="text-muted-foreground hover:text-foreground" data-testid={`inbound-dismiss-${r.id}`}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!queueForbidden && totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between text-sm" data-testid="inbound-pagination">
            <button type="button" onClick={() => goPage(page - 1)} disabled={page <= 1} className="rounded-md border px-2.5 py-1 disabled:opacity-40" data-testid="inbound-page-prev">Prev</button>
            <span className="text-muted-foreground">Page {page} of {totalPages}</span>
            <button type="button" onClick={() => goPage(page + 1)} disabled={page >= totalPages} className="rounded-md border px-2.5 py-1 disabled:opacity-40" data-testid="inbound-page-next">Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Mount the `inbound` tab, gated on the admin/TICKETS_WRITE capability**

In `apps/web/src/components/settings/TicketingSettingsPage.tsx`: import the card and the capability check, add `'inbound'` to `VALID_TABS` (line 8) and conditionally to the `TABS` array (line 11) and the panel render. The tab is only listed/rendered when the user has the queue's capability so a `tickets:read`-only user never reaches a card whose queue 403s.

```tsx
import InboundEmailCard from './InboundEmailCard';
import { hasPermission } from '../../lib/permissions'; // confirm the web-side capability helper name/path; mirror how other settings tabs gate admin-only surfaces. If the web app reads caps from the auth store, use that instead.
```

```tsx
const VALID_TABS = ['statuses', 'priorities', 'categories', 'export', 'inbound'] as const;
```

Compute the capability near the top of the component (the web app exposes the current user's permissions via the auth store — confirm the exact accessor with `grep -rn "hasPermission\|isPlatformAdmin\|permissions" apps/web/src/stores/auth.ts apps/web/src/lib/` and use whatever the other admin-gated settings surfaces use; the gate must be true for platform admins or wildcard/`tickets:write`-admin roles, matching the route's `adminMiddleware`):

```tsx
  const canManageInbound = /* hasPermission(perms, 'tickets', 'write') && isAdmin */;
```

Build the visible tabs conditionally and render the panel only when allowed:

```tsx
const BASE_TABS: Array<{ id: Tab; label: string }> = [
  { id: 'statuses', label: 'Statuses' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'categories', label: 'Categories' },
  { id: 'export', label: 'Export' },
];
// inside the component, after canManageInbound is known:
const TABS = canManageInbound ? [...BASE_TABS, { id: 'inbound' as Tab, label: 'Inbound Email' }] : BASE_TABS;
```

```tsx
      {activeTab === 'export' && <BillablesExportCard />}

      {activeTab === 'inbound' && canManageInbound && (
        <div data-testid="ticketing-tab-panel-inbound">
          <InboundEmailCard />
        </div>
      )}
```

> If the web app does not have a synchronous capability accessor available in this component (some settings pages gate purely server-side), fall back to: always list the tab, but rely on the card's own 403-handling (`inbound-review-forbidden`) for the queue, and accept that a non-admin who opens the tab sees the settings section + the admin-only queue notice. Prefer the capability gate; the 403 handler is the defense-in-depth backstop. Document whichever you chose in the PR description.

- [ ] **Step 3: Typecheck the web app**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: clean (no new errors from these files).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/InboundEmailCard.tsx apps/web/src/components/settings/TicketingSettingsPage.tsx
git commit -m "feat(ticketing): Inbound Email settings card + review queue UI (Phase 4)"
```

---

### Task 6: Frontend — enroll in `no-silent-mutations` + component tests

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add to `TARGET_GLOBS`)
- Create: `apps/web/src/components/settings/InboundEmailCard.test.tsx`

- [ ] **Step 1: Enroll the new file in the no-silent-mutations guard**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS` (alongside the other `settings/` ticketing files at lines 45-47):

```typescript
  'src/components/settings/InboundEmailCard.tsx',
```

- [ ] **Step 2: Run the guard — it must pass (all three mutations are runAction-wrapped)**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/__tests__/no-silent-mutations.test.ts --pool=forks
```

Expected: PASS. If it FAILS pointing at `InboundEmailCard.tsx`, a `PATCH`/`POST` `fetchWithAuth` escaped a `runAction` wrapper — wrap it (no `runaction-exempt` markers; every mutation here has user-facing feedback).

- [ ] **Step 3: Write the component tests**

Create `apps/web/src/components/settings/InboundEmailCard.test.tsx` (Vitest + Testing Library + jsdom; mock `fetchWithAuth` per call URL, mock `runAction` to pass-through to `request` so the real fetch mock is exercised, mock `showToast`). Cover render, the complete-`ticketing.inbound` save body (including the address-override round-trip), convert, dismiss, the unconfigured-domain hint, and the admin-only-queue 403 branch:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// pass-through runAction so the request fn (and thus fetchWithAuth) runs
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: { request: () => Promise<Response> }) => { const r = await o.request(); return r.json().catch(() => null); },
  handleActionError: vi.fn(),
}));

import InboundEmailCard from './InboundEmailCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

const CFG = { enabled: false, address: 'acme@tickets.example.com', addressOverride: null, defaultTriageOrgId: null, autoresponderEnabled: true, slug: 'acme', domainConfigured: true };

function routeFetch(queue: unknown[], cfg: typeof CFG = CFG) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/ticket-config') return Promise.resolve(jsonRes({ data: { inbound: cfg } }));
    if (url.startsWith('/ticket-config/email-inbound?')) return Promise.resolve(jsonRes({ data: queue, pagination: { page: 1, limit: 50, total: queue.length } }));
    if (url === '/orgs/organizations?limit=100') return Promise.resolve(jsonRes({ data: [{ id: 'o-1', name: 'Acme Org' }] }));
    if (url.includes('/convert')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'created' } }));
    if (url.includes('/dismiss')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'ignored' } }));
    if (url === '/orgs/partners/me') return Promise.resolve(jsonRes({ id: 'p-1' }));
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

beforeEach(() => { fetchWithAuth.mockReset(); });

describe('InboundEmailCard', () => {
  it('renders the inbound address and review queue', async () => {
    routeFetch([{ id: 'r-1', fromAddress: 'jane@x.com', subject: 'printer', parseStatus: 'quarantined', error: null, ticketId: null, createdAt: new Date().toISOString() }]);
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-email-card')).toBeTruthy();
    expect((screen.getByTestId('inbound-address') as HTMLInputElement).value).toBe('acme@tickets.example.com');
    expect(screen.getByTestId('inbound-row-r-1')).toBeTruthy();
  });

  it('toggling enable PATCHes /orgs/partners/me with the COMPLETE ticketing.inbound (no address when override is null)', async () => {
    routeFetch([]);
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-enabled-toggle'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })));
    const body = JSON.parse((fetchWithAuth.mock.calls.find((c) => c[0] === '/orgs/partners/me')![1] as { body: string }).body);
    expect(body.settings.ticketing.inbound.enabled).toBe(true);
    expect(body.settings.ticketing.inbound).toHaveProperty('defaultTriageOrgId');
    expect(body.settings.ticketing.inbound).toHaveProperty('autoresponderEnabled');
    expect(body.settings.ticketing.inbound).not.toHaveProperty('address'); // derived address is NOT re-sent as an override
  });

  it('re-sends a self-hosted address override on save so the merge does not destroy it (blocker #1)', async () => {
    routeFetch([], { ...CFG, address: 'support@tickets.acme.com', addressOverride: 'support@tickets.acme.com' });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-autoresponder-toggle'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })));
    const body = JSON.parse((fetchWithAuth.mock.calls.find((c) => c[0] === '/orgs/partners/me')![1] as { body: string }).body);
    expect(body.settings.ticketing.inbound.address).toBe('support@tickets.acme.com');
  });

  it('Convert opens the org picker and POSTs convert with the chosen orgId', async () => {
    routeFetch([{ id: 'r-1', fromAddress: 'jane@x.com', subject: 'printer', parseStatus: 'quarantined', error: null, ticketId: null, createdAt: new Date().toISOString() }]);
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-row-r-1');
    fireEvent.click(screen.getByTestId('inbound-convert-r-1'));
    fireEvent.change(screen.getByTestId('inbound-convert-org-r-1'), { target: { value: 'o-1' } });
    fireEvent.click(screen.getByTestId('inbound-convert-submit-r-1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-config/email-inbound/r-1/convert', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse((fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/convert'))![1] as { body: string }).body);
    expect(body.orgId).toBe('o-1');
  });

  it('Dismiss PATCHes the dismiss route and refetches', async () => {
    routeFetch([{ id: 'r-1', fromAddress: 'jane@x.com', subject: 'printer', parseStatus: 'failed', error: 'boom', ticketId: null, createdAt: new Date().toISOString() }]);
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-row-r-1');
    fireEvent.click(screen.getByTestId('inbound-dismiss-r-1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-config/email-inbound/r-1/dismiss', expect.objectContaining({ method: 'PATCH' })));
  });

  it('shows the unconfigured-domain hint when domainConfigured is false', async () => {
    routeFetch([], { ...CFG, address: '', domainConfigured: false });
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-address-unconfigured')).toBeTruthy();
  });

  it('renders the admin-only notice when the queue fetch 403s but keeps settings usable', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ticket-config') return Promise.resolve(jsonRes({ data: { inbound: CFG } }));
      if (url.startsWith('/ticket-config/email-inbound?')) return Promise.resolve(jsonRes({ error: 'admin' }, false, 403));
      if (url === '/orgs/organizations?limit=100') return Promise.resolve(jsonRes({ data: [] }));
      return Promise.resolve(jsonRes({ data: [] }));
    });
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-email-card')).toBeTruthy();
    expect(screen.getByTestId('inbound-review-forbidden')).toBeTruthy();
    expect(screen.getByTestId('inbound-enabled-toggle')).toBeTruthy(); // settings still rendered
  });
});
```

- [ ] **Step 4: Run the component tests**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/InboundEmailCard.test.tsx --pool=forks
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/components/settings/InboundEmailCard.test.tsx
git commit -m "test(ticketing): InboundEmailCard tests + no-silent-mutations enrollment (Phase 4)"
```

---

### Task 7: Final verification + PR

- [ ] **Step 1: API typecheck + affected suites**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketConfig.test.ts src/services/ticketConfigService.test.ts src/routes/orgs.test.ts src/services/ticketService.test.ts --pool=forks
```

Expected: clean typecheck (pre-existing `agents.test.ts`/`apiKeyAuth.test.ts` errors are known — see CLAUDE.md); the four suites pass. (`ticketService.test.ts` is included because Task 3 mocks `createTicket` from it; confirm the mock doesn't bleed — they're separate files, so it won't.)

- [ ] **Step 2: Web typecheck + affected suites**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/InboundEmailCard.test.tsx src/lib/__tests__/no-silent-mutations.test.ts --pool=forks
```

Expected: clean typecheck; both suites pass.

- [ ] **Step 3: Manual smoke (optional, needs local stack)** — log in as a partner **admin**, open `/settings/ticketing#tab=inbound`: the card loads, the address shows `{slug}@{TICKETS_INBOUND_DOMAIN}` and copies; toggling Enable/autoresponder persists (refresh keeps the value); a seeded `quarantined` `ticket_email_inbound` row appears, Convert with an org picks creates a ticket attributed to YOUR user (check the ticket's audit/created-by) and the row leaves the queue; a `quarantined` row with a NULL `from_address` returns `INBOUND_ROW_NO_SENDER` (friendly toast, no ticket); Dismiss removes a `failed` row. Then log in as a `tickets:read`-only partner user: the Inbound tab is not listed (or, if you chose the 403-fallback, the queue shows the admin-only notice while settings render). (To seed a row: insert under system context or via the PR 1 worker against a test envelope.)

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/ticketing-email-settings
gh pr create --title "feat(ticketing): Phase 4 inbound email settings + review queue" --body "$(cat <<'EOF'
Phase 4 PR 4 — Settings + review queue for email-to-ticket. Spec: docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md (§2, §6, §7; D3/D4/D5).

**Backend:**
- GET /ticket-config/email-inbound — paginated review queue (parse_status IN quarantined,failed); writePerm + adminMiddleware.
- POST /ticket-config/email-inbound/:id/convert — createTicket source:email for a chosen org, links the row (parse_status=created); writePerm + adminMiddleware. Actor = the authenticated admin (correct audit attribution). Rejects rows with no sender (INBOUND_ROW_NO_SENDER) and orgs outside the partner (ORG_NOT_ACCESSIBLE); idempotent (INBOUND_ROW_ALREADY_RESOLVED).
- PATCH /ticket-config/email-inbound/:id/dismiss — parse_status=ignored; writePerm + adminMiddleware.
- getTicketConfig now returns an additive inbound block (enabled/address/addressOverride/defaultTriageOrgId/autoresponderEnabled/slug/domainConfigured). Settings writes go through the existing PATCH /partners/me (partnerSettingsSchema extended with ticketing.inbound). Note: that route is org-write + requireMfa() gated (NOT admin) — a deliberate divergence from the admin-gated queue, documented in the plan.

**Frontend:** new InboundEmailCard under Settings → Ticketing → Inbound Email (tab shown to admin/TICKETS_WRITE users only) — enable toggle, copyable slug-derived address, reserved default-triage-org picker, autoresponder toggle, and the quarantined/failed review queue with Convert-to-ticket (org picker) + Dismiss. All mutations via runAction; enrolled in no-silent-mutations. A queue 403 renders an admin-only notice without breaking the settings.

**Merge safety (BLOCKER fix):** PATCH /partners/me shallow-replaces the top-level `ticketing` key, so the card always sends the COMPLETE ticketing.inbound object and re-sends a self-hosted `address` override only when set. Regression tests prove a ticketing.inbound PATCH preserves both an existing address override and security.ipAllowlist.

**Reuses PR 1 (#<ingest-pr>):** ticket_email_inbound table, createTicket source:email, TICKETS_INBOUND_DOMAIN. No worker/webhook changes here.

**Out of scope:** outbound threading + autoresponder send (PR 3), Model-B custom-domain wizard, a UI editor for the address override.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (for the implementer)

- **PR 1 must be merged first.** This plan imports `ticketEmailInbound` from `apps/api/src/db/schema` and `createTicket({ source:'email' })`. If you branch before PR 1 lands, those symbols won't exist and Tasks 2/3 won't compile. Confirm with `grep -rn "ticketEmailInbound" apps/api/src/db/schema/` (must resolve) and that `createTicket`'s `source:'email'` variant accepts `submitterEmail: string` (`grep -n "source: 'email'" apps/api/src/services/ticketService.ts`) before starting.
- **`getTicketConfig` is also called by `TicketStatusesTab`/`TicketPrioritiesTab`** — adding the `inbound` key to its return is additive (those callers read `.statuses`/`.priorities` only), so no existing web caller breaks. The FIFO db-mock in `ticketConfigService.test.ts` DOES need the third (partners) result enqueued in the existing `getTicketConfig` test — Task 1 Step 2 does exactly this; Step 5 runs the whole file to prove it.
- **`partnerSettingsSchema` is defined inline in `orgs.ts:309`, not in `@breeze/shared`.** Extend it there. Do not create a parallel schema. `updatePartnerSettingsSchema` (orgs.ts:436) wraps it as `{ settings: partnerSettingsSchema.optional(), name, billingEmail }`.
- **Top-level `ticketing` vs `security` deep-merge (the blocker):** the merge only deep-merges `security` (orgs.ts:505). `ticketing` is shallow-REPLACED. This is safe ONLY because the card sends the complete `ticketing.inbound` object including the `address` override when present. Task 4's two tests (address-override + security.ipAllowlist preservation) are the guard; both have a real red→green cycle (Task 4 Step 1's ordering note shows how to observe the address test fail without the schema key).
- **`address` is read-only in the card** (derived from slug, or the override echoed back). The self-hosted override (D4) is settable via the API (`partnerSettingsSchema` accepts `address`) but the v1 card does not expose an editor for it — surfacing that editor is a follow-up. The card MUST still round-trip `addressOverride` on every save (it does, via `saveConfig`) so the override is never destroyed; do not wire an address *input* to `saveConfig` in v1.
- **Convert actor is the real admin, not a sentinel.** `convertEmailInbound(partnerId, id, orgId, actor)` takes the `TicketActor` and the route builds it from `c.get('auth').user` (`{ userId: auth.user.id, name: auth.user.name }`). `createTicket` stamps `actor.userId` into the audit `actorId` and the `ticket.created` event; `audit_logs.actor_id` is NOT NULL but un-constrained (no FK — `apps/api/src/db/schema/audit.ts:13`), so a real user id is correct and there is no all-zero-UUID risk to resolve in this PR.
- **Empty-sender convert is blocked** with `INBOUND_ROW_NO_SENDER` (400) so a quarantined row with no usable `from_address` can't produce a reply-less ticket; the card surfaces a friendly message. Dismiss has no such guard (dismissing a no-sender row is fine).
- **Settings-write authorization divergence is intentional and documented.** The queue routes are admin-gated (`writePerm + adminMiddleware`); the settings write reuses `PATCH /partners/me` (`requireScope('partner') + requireOrgWrite + requireMfa()`), which is org-write, not admin, and carries an MFA step-up that can 403. The Inbound tab is admin-gated on the web so org-write-non-admins don't reach the settings write; the save's `errorFallback` is worded to cover an MFA-required 403 (no machine code in that body, so no FRIENDLY_CODES entry applies).
- **403 on the queue fetch is handled distinctly** (`inbound-review-forbidden`) so a single 403 doesn't nuke the whole card; combined with the admin tab-gate this is belt-and-suspenders.
- **Pagination `count()`:** `count` is imported from `drizzle-orm`; `Number(total)` guards the bigint-string return from postgres.js.
- **Risks carried from research:** R1 (terminal state) → resolved to `ignored`; R2 (org picker vs default) → picker mandatory, default pre-selects; R3 (partner-admin granularity) → queue reuses platform-admin/wildcard `adminMiddleware` exactly as status/priority config does (no new partner-admin role this phase); R8 (settings merge) → Task 4's two tests (address override + security.ipAllowlist).
