# Caller Verification W03: Links, Public Challenge Card, and Mailbox Reads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver SMS and email challenges after commit, let the recipient confirm or reject the exact request on an anonymous page, and supply the canonical target mailbox set that prevents circular email verification.

**Architecture:** W01 owns the verification ledger, destination provenance, policy, state machine, transactional outbox, and gate. W03 adds an encrypted link delivery envelope to that hook, a narrow system-context public router, an Astro/React card, and an OID-only mailbox read across direct Graph, the read executor, and Delegant. All decisions still pass through W01 `applyDecision`; all enforcement remains dark until W05. The public response never reveals which number matched. Redis bounds starts, public requests, and unsuccessful token searches separately.

**Tech Stack:** Hono, TypeScript, Zod, Drizzle/PostgreSQL, Redis, Twilio Messaging, existing transactional email layout, Astro React islands, react-i18next, Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md` (v5). Covers W03; D2, D4, D9–D10, D12, D16; “Same-mailbox rule”; link delivery and rate limits in “Service layer”; both public API rows; public-page copy; public concurrent-CAS/late-rejection integration tests. Read the review tables, especially v3 P2, v4 P9, and v5 P9. Cross-wave names and signatures come from `docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md`.

## Global Constraints

- **Dependency boundary:** W01 must land first. The product modules `apps/api/src/services/callerVerification/` and its schema do not exist at this checkout. The companion W01 plan now defines `ports.ts` (Task 5), `start` (Task 10), and a row-backed publisher. References below marked **W01 anchor** are contractual modifications to that prerequisite, not claims of existing line numbers. Before implementation, locate those anchors with `rg -n` and record current lines in the PR. Do not implement an alternative state machine or generic outbox in W03.
- **RLS enabled + forced + policies in the creating migration.** W01 owns all four tables: `callerVerifications` → `caller_verifications`, `callerVerificationSubjectBindings` → `caller_verification_subject_bindings`, `callerVerificationDestinations` → `caller_verification_destinations`, `callerVerificationPolicies` → `caller_verification_policies`. W03 adds two sensitive columns to the existing verification table, with its own forward migration; it introduces no table. Preserve W01 cascade, export, merge, dual-axis, and XOR registrations.
- **Composite FKs carrying `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.** Preserve column-specific `SET NULL` actions, and never name a column `device_id`/`ticket_id` on the new tables. Snapshot names remain `workstation_device_ref`, `ticket_ref`, `consumed_intent_ref`.
- **Migrations are idempotent, with no inner `BEGIN`/`COMMIT`; DML migrations start with `SELECT set_config('breeze.scope','system',true);`.** W01 slots remain `2026-10-15-180000-caller-verification-tables.sql`, `2026-10-15-180100-caller-verification-policies.sql`, `2026-10-15-180200-caller-verification-destinations-backfill.sql`; W05 owns `2026-10-15-180300-action-intents-caller-target.sql`. W03 adds the previously unallocated `2026-10-15-180250-caller-verification-link-delivery.sql` between W01 and W05 because its prepare port has no token/order storage. The four reserved filenames above stay verbatim. Re-check `ls apps/api/migrations | sort | tail -1` before commit and rename upward if an unshipped feature migration no longer sorts after main; sweep references. Never rename a shipped migration or consume another wave's slot.
- **Readiness flag `CALLER_VERIFICATION_ENABLED` stays false.** Consume `isCallerVerificationEnabled(): boolean` from W01 `gate.ts`, backed by `apps/api/src/config`. Public GET and POST return 404 before Redis/DB when disabled. The page renders no card or active control on that response. W05 alone enables enforcement and entry points.
- **Short DB scopes.** Public token lookup and the decision transaction alone run inside `withSystemDbAccessContext`; use `runOutsideDbContext` before that wrapper. Network delivery, Redis, HTML rendering, and response formatting run after it returns. Never promote the entire Hono request to system. `db/index.ts:528` preserves an existing nested context; `:610` is the system wrapper; `:801` is `runOutsideDbContext`.
- **Decision contract stays verbatim:** `applyDecision(input: { verificationId: string; decision: { kind: 'choice'; value: string } | { kind: 'not_me' } | { kind: 'timeout' } | { kind: 'undeliverable'; reason: string }; principal?: { osPrincipal: string; osUsername: string; upn: string | null }; fromIp?: string }): Promise<VerificationView>`. Number choices use one pending/unexpired CAS. Public `not_me` accepts any non-rejected state within 24 hours of creation; do not put it behind the choice expiry predicate.
- **Public opacity:** unknown, spent and expired GETs share `{ status: 'expired' }`; every syntactically valid POST outcome shares `{ status: 'received' }`, including misses and CAS losers. Both routes use `Cache-Control: no-store, private`. Do not return IDs, match-value roles, destination addresses, grant status, tier, or fence state.
- **Secrets:** token = 32 random bytes, base64url; only SHA-256 hex in `challenge_token_hash`. W01's durable delivery payload may contain encrypted token material, never plaintext; audits/ticket events contain IDs only. Never log the URL or token. No Graph aliases or credentials in public JSON.
- **Stored order:** the specified schema has two decoys and one match but no order column. Task 1 adds `challenge_choices char(2)[]`, stores its role-independent permutation once in `prepare`, and GET returns that tuple verbatim. `sealed_link_token text` stores encrypted retry material. Both columns are `excludedSensitive` in the export registry; no JSON/JSONB/bytea or new table is needed. Never put the match first by convention or reshuffle on GET.
- **URL fact:** Quick Support uses `process.env.PUBLIC_WEB_URL` at `routes/remote/supportSessions.ts:130`, returning `/quick?code=…` at `:138`. Neither `supportPublic.ts` nor `partnerLoginBranding.ts` has a partner app-domain resolver. Use the configured application origin for this deployment, with the partner's branding; Task 1 requires HTTPS. Do not invent `partner.appUrl`, trust Host headers, or send links to a portal domain.
- **Web mutations via `runAction`** (`apps/web/src/lib/runAction.ts:43`), anonymous `fetch`, and a mounted toast container. `AuthLayout.astro` does not supply one. `treatUnauthorizedAsError: true` prevents a public recipient's error from being silently treated as a technician session expiry.
- **i18n: real translations in 8 locales**, namespace `callerVerification.json`: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. W04 merges into this namespace. Add zero-duplicate baseline entries to all seven non-English maps in `translationCoverage.test.ts`; do not increase allowances to accept copied English.
- **M365 facts:** `aiToolsM365.ts:73` currently selects direct/Delegant only; typed control-plane reads are separate at `:354`. W03 adds a mailbox-only by-org dispatcher. No fabricated `AuthContext`, no email-string identity fallback, no backend fallback after a selected backend fails. A Delegant broker implementation is external to this repository; its new read contract must be deployed before W05 can count Delegant email verifications.
- **Tests:** API `cd apps/api && npx vitest run <path>`; web `cd apps/web && npx vitest run <path>`. No pnpm `test -- --run`, no trailing-slash substring trap. Live suites require `pnpm test-stack up` / `pnpm test-stack down`. RLS coverage has its own `vitest.config.rls-coverage.ts`, not the integration config that explicitly excludes it.
- **Execution branch:** `feature/<parent#>-caller-verification/wave-<sub#>`. Resolve the actual issue numbers from the wave's tracking issue before execution; PR body must contain `Closes #<sub#>`. This document-writing task creates only this file: no registration, issue edits, commit, push, or product changes now. Commit/PR steps below are for the eventual implementer.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-180250-caller-verification-link-delivery.sql`, `apps/api/src/db/schema/callerVerification.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts` | durable encrypted link material and stored order, sensitive export classification |
| `apps/api/src/services/callerVerification/ports.ts`, `linkPorts.ts`, `linkPorts.test.ts` | compose W01/W02 preparation, delivery and availability hooks |
| `apps/web/src/lib/i18n/callerVerification.test.ts` | required public-card copy in eight catalogs |
| `apps/api/src/services/callerVerification/linkChallenge.ts`, `linkChallenge.test.ts` | token, encrypted envelope, immutable candidate order, absolute URL |
| `apps/api/src/services/callerVerification/service.ts`, `service.test.ts` | W01 start budget, delivery-envelope producer, decision CAS integration |
| `apps/api/src/services/callerVerification/deliverers/link.ts`, `link.test.ts` | post-commit SMS/email delivery adapter |
| `apps/api/src/services/email.ts`, `email.callerVerification.test.ts` | branded transactional template |
| `apps/api/src/services/supportCodeMissBudget.ts`, `supportCodeMissBudget.test.ts` | namespace-isolated two-tier budget |
| `apps/api/src/services/callerVerification/publicLookup.ts`, `publicLookup.test.ts` | token lookup and safe card projection |
| `apps/api/src/routes/callerVerifyPublic.ts`, `callerVerifyPublic.test.ts` | public GET/POST and request budget |
| `apps/api/src/index.ts` | unauthenticated `/verify` mount adjacent to `/support` |
| `apps/api/src/routes/callerVerifyPublic.integration.test.ts` | real Postgres/Redis, CAS, late rejection, budgets |
| `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts` | exclude/include the co-located live suite |
| `packages/shared/src/m365/readActions.ts`, `readActions.test.ts` | dedicated OID-only mailbox read and field allowlist |
| `apps/api/src/services/m365DirectGraph.ts`, `m365DirectGraph.test.ts` | tenant-pinned direct read and tenant-keyed token cache |
| `apps/m365-graph-read-executor/src/microsoft/readActions.ts`, `readActions.test.ts` | executor dispatch and four-field projection |
| `apps/api/src/services/m365ControlPlane/readActionService.ts`, `readActionService.test.ts` | ambient-RLS mailbox execution without synthetic auth |
| `apps/api/src/services/delegantClient.ts`, `delegantClient.test.ts` | explicit mailbox tool contract |
| `apps/api/src/services/aiToolsM365.ts`, `aiToolsM365.test.ts` | mailbox backend selection and attribution |
| `apps/api/src/services/callerVerification/mailboxes.ts`, `mailboxes.test.ts` | canonical lowercased mailbox set |
| `apps/api/src/services/callerVerification/gate.ts`, `gate.test.ts`, `index.ts` | real fetcher wiring and typed refusal |
| `apps/web/src/locales/en/callerVerification.json` | English public-card catalog |
| `apps/web/src/locales/de-DE/callerVerification.json`, `es-419/callerVerification.json`, `fr-CA/callerVerification.json`, `fr-FR/callerVerification.json`, `it-IT/callerVerification.json`, `pt-BR/callerVerification.json`, `tr-TR/callerVerification.json` | translated catalogs; all paths relative to `apps/web/src/locales/` |
| `apps/web/src/lib/i18n/translationCoverage.test.ts` | new namespace in each baseline map |
| `apps/web/src/components/callerVerification/CallerVerifyCard.tsx`, `CallerVerifyCard.test.tsx` | anonymous card, lifecycle, mutation feedback |
| `apps/web/src/pages/verify/[token].astro` | public entry page and no-store/referrer headers |
| `apps/api/src/services/callerVerification/w03.contract.test.ts` | wave reachability and public-shape regressions |

### Task 1: Link material and the W01 post-commit delivery seam

**Files:**
- Create: `apps/api/migrations/2026-10-15-180250-caller-verification-link-delivery.sql`.
- Modify: `apps/api/src/db/schema/callerVerification.ts` (**W01 Task 3 anchor:** `challengeTokenHash`), `apps/api/src/services/tenantExportPolicyRegistry.ts:41` (`caller_verifications` entry created by W01).
- Create: `apps/api/src/services/callerVerification/linkChallenge.ts`, `apps/api/src/services/callerVerification/linkChallenge.test.ts`.
- Read dependency: `apps/api/src/services/callerVerification/service.ts` (**W01 plan Task 10:** existing `ports.prepare(row,token)` call; no second token producer).

**Interfaces:**
- Consumes: W01 `StartInput`, `CallerVerificationActor`, `VerificationView`; `encryptSecret(value, options): string | null`, `decryptSecret(value, options): string | null` at `services/secretCrypto.ts:388,421`.
- Produces: `newLinkChallenge(verificationId: string): { challengeTokenHash: string; sealedToken: string }`; `openLinkToken(id: string, sealed: string): string`; `linkUrl(token: string): string`; `storedChoices(id: string, matchValue: string, decoyValues: string[]): [string,string,string]`.
- New W03 delivery payload extension: `{ verificationId: string; sealedToken: string; choices: [string,string,string] }`. W01 retains ownership of enqueue, claim, retry, acknowledgement and retention. Its committed hook calls Task 3 `deliverLink(payload)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { newLinkChallenge, openLinkToken, storedChoices, linkUrl } from './linkChallenge';

describe('link challenge material', () => {
  it('builds only an HTTPS application link from trusted deployment config',()=>{
    const token='A'.repeat(43);
    try {
      vi.stubEnv('PUBLIC_WEB_URL','https://app.example.com');expect(linkUrl(token)).toBe(`https://app.example.com/verify/${token}`);
      for(const value of ['http://app.example.com','https://user:pass@app.example.com','https://app.example.com/?next=x']) {
        vi.stubEnv('PUBLIC_WEB_URL',value);expect(()=>linkUrl(token)).toThrow();
      }
    } finally {vi.unstubAllEnvs();}
  });
  it('stores only a digest and encrypted recoverable delivery token', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const material = newLinkChallenge(id);
    const token = openLinkToken(id, material.sealedToken);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(material.challengeTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(material.sealedToken).not.toContain(token);
    expect(newLinkChallenge(id).challengeTokenHash).not.toBe(material.challengeTokenHash);
  });
  it('is stable, complete, and independent of which candidate is the match', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const first = storedChoices(id, '42', ['17', '83']);
    expect(new Set(first)).toEqual(new Set(['42', '17', '83']));
    expect(storedChoices(id, '17', ['83', '42'])).toEqual(first);
    expect(storedChoices(id, '42', ['17', '83'])).toEqual(first);
    expect(() => storedChoices(id, '42', ['42', '83'])).toThrow();
  });
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/callerVerification/linkChallenge.test.ts`.
Expected: missing `./linkChallenge`.

- [ ] **Step 3: Implement material generation and canonical stored order**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from '../secretCrypto';

export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function sealLinkToken(verificationId: string, token: string): string {
  if (!LINK_TOKEN_RE.test(token)) throw new Error('link_token_invalid');
  // Embed the ID as well as AAD: legacy v1 encryption does not bind AAD.
  const sealedToken = encryptSecret(JSON.stringify({ verificationId, token }), {
    aad: `caller-verification:${verificationId}`,
  });
  if (!sealedToken) throw new Error('link_token_encryption_failed');
  return sealedToken;
}
export function newLinkChallenge(verificationId: string) {
  const token = randomBytes(32).toString('base64url');
  return { challengeTokenHash: hashLinkToken(token), sealedToken: sealLinkToken(verificationId, token) };
}
export function openLinkToken(id: string, sealed: string): string {
  const raw = decryptSecret(sealed, { aad: `caller-verification:${id}` });
  const value = JSON.parse(raw ?? 'null');
  if (!value || value.verificationId !== id || typeof value.token !== 'string'
    || !LINK_TOKEN_RE.test(value.token)) throw new Error('link_token_invalid');
  return value.token;
}
export function storedChoices(id: string, matchValue: string, decoyValues: string[]): [string,string,string] {
  const values = [matchValue, ...decoyValues];
  if (values.length !== 3 || new Set(values).size !== 3 || values.some(v => !/^\d{2}$/.test(v))) {
    throw new Error('challenge_choices_invalid');
  }
  // Rank every value identically: changing its match/decoy role cannot change order.
  const rank = (v: string) => hashLinkToken(`${id}:${v}`);
  values.sort((a, b) => rank(a).localeCompare(rank(b)) || a.localeCompare(b));
  return values as [string,string,string];
}
export function linkUrl(token: string): string {
  if (!LINK_TOKEN_RE.test(token)) throw new Error('link_token_invalid');
  const base = new URL(process.env.PUBLIC_WEB_URL ?? '');
  if (base.protocol !== 'https:' || base.username || base.password
    || base.search || base.hash || base.pathname !== '/') throw new Error('app_url_invalid');
  return new URL(`/verify/${token}`, base).href;
}
```

W01 `start` already generates a 32-byte token, stores its SHA-256 digest, inserts the row, then calls `ports.prepare(row, token)` in that transaction (W01 plan Task 10). Preserve that producer; do not generate a second token. Task 3's `prepareLink` encrypts that exact token and stores the tuple below. `sealLinkToken(verificationId,token)` above is shared by preparation and the unit-tested generator.

The W01 row-outbox has publication markers but no encrypted-token/order columns. Create this forward DDL migration; do not edit W01's shipped migration:

```sql
ALTER TABLE caller_verifications ADD COLUMN IF NOT EXISTS sealed_link_token text;
ALTER TABLE caller_verifications ADD COLUMN IF NOT EXISTS challenge_choices char(2)[];
DO $$ BEGIN
 ALTER TABLE caller_verifications ADD CONSTRAINT cv_link_choices_chk CHECK (
  challenge_choices IS NULL OR (cardinality(challenge_choices)=3
   AND array_position(challenge_choices,NULL) IS NULL
   AND challenge_choices[1] <> challenge_choices[2]
   AND challenge_choices[1] <> challenge_choices[3]
   AND challenge_choices[2] <> challenge_choices[3]
   AND challenge_choices @> ARRAY[match_value]
   AND challenge_choices @> decoy_values));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

No DML or inner transaction. Existing RLS remains enabled and forced. In W01's Drizzle `callerVerifications` object add `sealedLinkToken: text('sealed_link_token')` and `challengeChoices: char('challenge_choices',{length:2}).array()`. Add both SQL column names to `caller_verifications.excludedSensitive` in `CORE_TENANT_EXPORT_POLICY`; neither is `included` or `excludedOpen`. No cascade or merge membership changes because the table is already registered. This closes a concrete missing prerequisite with two columns rather than inventing a generic outbox or reusing ticket-only storage.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/callerVerification/linkChallenge.test.ts src/services/callerVerification/service.test.ts`.
Run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` as well. Expected: material tests and W01 atomicity/delivery tests pass; start still returns `Promise<VerificationView>` with 202 route semantics and no public token in that view.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-15-180250-caller-verification-link-delivery.sql apps/api/src/db/schema/callerVerification.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/callerVerification/linkChallenge.ts apps/api/src/services/callerVerification/linkChallenge.test.ts
git commit -m "feat(caller-verification): prepare durable encrypted link challenges"
```

### Task 2: Branded link email using the existing layout

**Files:**
- Create: `apps/api/src/services/email.callerVerification.test.ts`.
- Modify: `apps/api/src/services/email.ts:851` (beside exported `buildPortalInviteTemplate`).

**Interfaces:**
- Consumes: `EmailTemplate` at `email.ts:135`; `renderLayout(options: RenderLayoutOptions): string` at `emailLayout.ts:33`; `renderButton(label: string, url: string): string` at `:84`; `escapeHtml(value: string): string` at `:95`.
- Produces: `buildCallerVerificationTemplate(p: { partnerName: string; technicianLabel: string; requestLabel: string; url: string }): EmailTemplate`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest';
import { buildCallerVerificationTemplate } from './email';
it('uses the shared shell, names the request and escapes partner-controlled text', () => {
  const result = buildCallerVerificationTemplate({ partnerName: 'Example MSP',
    technicianLabel: '<script>bad</script>', requestLabel: 'reset the password for alex@example.com',
    url: `https://app.example.com/verify/${'A'.repeat(43)}` });
  expect(result.html).toContain('Example MSP');
  expect(result.html).toContain('&lt;script&gt;');
  expect(result.html).not.toContain('<script>bad');
  expect(result.html).toContain('reset the password for alex@example.com');
  expect(result.html).toContain('role="presentation"');
  expect(result.text).toContain('number you already have');
  expect(result.text).not.toMatch(/proves|read.*code.*back/i);
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/email.callerVerification.test.ts`.
Expected: template export missing.

- [ ] **Step 3: Add the template**

```ts
export function buildCallerVerificationTemplate(p: {
  partnerName: string; technicianLabel: string; requestLabel: string; url: string;
}): EmailTemplate {
  const subject = 'Review a support request';
  const request = `${p.technicianLabel} from ${p.partnerName} wants to ${p.requestLabel}.`;
  const caution = `If you are not sure, hang up and call ${p.partnerName} on the number you already have.`;
  const body = `<p style="${BODY_PARA}">${escapeHtml(request)}</p>
    ${renderButton('Review request', p.url)}
    <p style="${MUTED_PARA}">The page shows the request and lets you choose “This is not me”. This link expires in 10 minutes.</p>
    <p style="${MUTED_PARA}">${escapeHtml(caution)}</p>`;
  return {
    subject,
    html: renderLayout({ title: subject, preheader: request, heading: subject,
      body, brandName: p.partnerName }),
    text: [request, `Review request: ${p.url}`, 'The link expires in 10 minutes.',
      'Choose “This is not me” if you did not request this.', caution].join('\n\n'),
  };
}
```

The existing shell has `brandName`, not `logoUrl` or an arbitrary theme object. Use its real interface. Do not send the match number in either channel. API transactional templates currently use English; translated recipient-page copy is Task 12, without introducing a new API localization stack here.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/email.callerVerification.test.ts src/services/email.test.ts`.
Expected: new escaping/copy test and existing provider tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.callerVerification.test.ts
git commit -m "feat(caller-verification): add branded request confirmation email"
```

### Task 3: Deliver links from the committed outbox hook

**Files:**
- Create: `apps/api/src/services/callerVerification/deliverers/link.ts`, `apps/api/src/services/callerVerification/deliverers/link.test.ts`.
- Modify: `apps/api/src/services/callerVerification/ports.ts` (**W01 plan Task 5:** `prepare`, `deliver`, `available`); Create: `apps/api/src/services/callerVerification/linkPorts.ts`, `apps/api/src/services/callerVerification/linkPorts.test.ts`.

**Interfaces:**
- Consumes: `getTwilioService(mode: TwilioServiceMode = 'verify'): TwilioService | null` at `twilio.ts:191`; `sendSmsMessage(phoneNumber: string, message: string, options: TwilioSmsSendOptions = {}): Promise<TwilioSmsResult>` at `:107`; `getEmailService(): EmailService | null` at `email.ts:409`; `sendEmail(params: SendEmailParams): Promise<void>` at `:240`; W01 `applyDecision`.
- Produces: `deliverLink(payload: { verificationId: string; sealedToken: string; choices: [string,string,string] }): Promise<void>`.

- [ ] **Step 1: Write the failing delivery test**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), sms: vi.fn(), mail: vi.fn(), decide: vi.fn() }));
vi.mock('../publicLookup', () => ({ loadLinkDelivery: mocks.load }));
vi.mock('../service', () => ({ applyDecision: mocks.decide }));
vi.mock('../../twilio', () => ({ getTwilioService: (mode: string) => {
  if (mode !== 'messaging') throw new Error('Wrong Twilio mode');
  return { sendSmsMessage: mocks.sms };
} }));
vi.mock('../../email', () => ({ getEmailService: () => ({ sendEmail: mocks.mail }),
  buildCallerVerificationTemplate: () => ({ subject: 'Review', html: '<p>Review</p>', text: 'Review' }) }));
vi.mock('../../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn() }));
import { deliverLink } from './link';
import { newLinkChallenge, storedChoices } from '../linkChallenge';
const id = '11111111-1111-4111-8111-111111111111';
const material = newLinkChallenge(id);
const payload = { verificationId: id, sealedToken: material.sealedToken,
  choices: storedChoices(id, '42', ['17', '83']) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
  mocks.load.mockResolvedValue({ id, method: 'sms', status: 'pending',
    challengeTokenHash: material.challengeTokenHash, destination: '+15555550123',
    partnerName: 'Example MSP', technicianLabel: 'Taylor', requestLabel: 'reset the password for Alex' });
});
it('uses Messaging and maps a returned send failure to an undeliverable decision', async () => {
  mocks.sms.mockResolvedValue({ success: false, error: 'provider detail' });
  await deliverLink(payload);
  expect(mocks.sms).toHaveBeenCalledWith('+15555550123', expect.stringContaining('/verify/'));
  expect(mocks.decide).toHaveBeenCalledWith({ verificationId: id,
    decision: { kind: 'undeliverable', reason: 'sms_send_failed' } });
});
it('does not deliver a terminal or stale-destination row', async () => {
  mocks.load.mockResolvedValue(null);
  await deliverLink(payload);
  expect(mocks.sms).not.toHaveBeenCalled();
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('sends email through sendEmail and never approves on send success', async () => {
  mocks.load.mockResolvedValue({ id, method: 'email', status: 'pending',
    challengeTokenHash: material.challengeTokenHash, destination: 'alex@example.com',
    partnerName: 'Example MSP', technicianLabel: 'Taylor', requestLabel: 'disable the account for Alex' });
  await deliverLink(payload);
  expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ to: 'alex@example.com' }));
  expect(mocks.decide).not.toHaveBeenCalled();
});
```

Also create `linkPorts.test.ts`; this pins real persistence and the publisher adapter, without a provider call:

```ts
import { expect,it,vi } from 'vitest';
const state=vi.hoisted(()=>({row:null as any,write:vi.fn(),deliver:vi.fn()}));
vi.mock('../../db',()=>({assertInTransaction:vi.fn(),runOutsideDbContext:(f:()=>unknown)=>f(),
 withSystemDbAccessContext:(f:()=>unknown)=>f(),db:{
 update:()=>({set:(value:unknown)=>{state.write(value);return {where:async()=>[]};}}),
 select:()=>({from:()=>({where:()=>({limit:async()=>[state.row]})})})}}));
vi.mock('./deliverers/link',()=>({deliverLink:state.deliver}));
import { prepareLink,deliverPreparedLink } from './linkPorts';
import { newLinkChallenge,openLinkToken } from './linkChallenge';
it('stores the same retry token and passes its persisted order to delivery',async()=>{
 const id='11111111-1111-4111-8111-111111111111',m=newLinkChallenge(id);
 const token=openLinkToken(id,m.sealedToken);
 const row={id,method:'sms',status:'pending',challengeTokenHash:m.challengeTokenHash,matchValue:'42',decoyValues:['17','83']};
 await prepareLink(row as never,token);
 const saved=state.write.mock.calls[0]![0];state.row={...row,...saved};
 expect(openLinkToken(id,saved.sealedLinkToken)).toBe(token);
 await deliverPreparedLink(id);
 expect(state.deliver).toHaveBeenCalledWith({verificationId:id,sealedToken:saved.sealedLinkToken,choices:saved.challengeChoices});
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/callerVerification/deliverers/link.test.ts`.
Expected: missing `./link`.

- [ ] **Step 3: Implement the deliverer**

```ts
import { runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { getTwilioService } from '../../twilio';
import { getEmailService, buildCallerVerificationTemplate } from '../../email';
import { applyDecision } from '../service';
import { loadLinkDelivery } from '../publicLookup';
import { hashLinkToken, openLinkToken, linkUrl } from '../linkChallenge';

export async function deliverLink(payload: {
  verificationId: string; sealedToken: string; choices: [string,string,string];
}): Promise<void> {
  return runOutsideDbContext(async () => {
    const row = await withSystemDbAccessContext(() => loadLinkDelivery(payload.verificationId));
    if (!row) return;
    let reason: string | null = null;
    try {
      const token = openLinkToken(row.id, payload.sealedToken);
      if (hashLinkToken(token) !== row.challengeTokenHash) throw new Error('link_token_mismatch');
      const url = linkUrl(token);
      if (row.method === 'sms') {
        const twilio = getTwilioService('messaging');
        if (!twilio) reason = 'sms_not_configured';
        else {
          const result = await twilio.sendSmsMessage(row.destination,
            `${row.technicianLabel} from ${row.partnerName} wants to ${row.requestLabel}. Review: ${url}. If unsure, hang up and call the number you already have.`);
          if (!result.success) reason = 'sms_send_failed';
        }
      } else {
        const email = getEmailService();
        if (!email) reason = 'email_not_configured';
        else await email.sendEmail({ to: row.destination,
          ...buildCallerVerificationTemplate({ ...row, url }) });
      }
    } catch {
      reason = row.method === 'sms' ? 'sms_delivery_failed' : 'email_delivery_failed';
    }
    if (reason) await withSystemDbAccessContext(() => applyDecision({
      verificationId: row.id, decision: { kind: 'undeliverable', reason },
    }));
  });
}
```

Task 5 supplies `loadLinkDelivery`; it is deliberately a new helper, not an existing export. The link port below adapts W01’s committed `deliver(id)` hook to `deliverLink(payload)`. Leave its workstation arm untouched. `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` load in the constructor (`twilio.ts:39`); sender comes from `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_PHONE_NUMBER` (`:42–43`). `getTwilioService('messaging')` alone does not guarantee a sender; the returned `success:false` is authoritative. No Twilio Verify code or check API is involved.

Add `linkPorts.ts` and `linkPorts.test.ts` to this task's Create files, and modify `ports.ts` at its W01 `prepare`, `deliver`, `available` default implementations. Export these helpers from `linkPorts.ts`; imports of the deliverer are dynamic to avoid a service→ports→deliverer→service initialization cycle:

```ts
import { eq } from 'drizzle-orm';
import { db, assertInTransaction, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { callerVerifications as v } from '../../db/schema/callerVerification';
import type { VerificationRow } from './types';
import { sealLinkToken, hashLinkToken, storedChoices } from './linkChallenge';
import { getTwilioService } from '../twilio';
import { getEmailService } from '../email';
export async function prepareLink(row: VerificationRow, token: string | null): Promise<void> {
  assertInTransaction('callerVerification.prepareLink');
  if (!token || hashLinkToken(token) !== row.challengeTokenHash) throw new Error('link_token_mismatch');
  await db.update(v).set({ sealedLinkToken: sealLinkToken(row.id, token),
    challengeChoices: storedChoices(row.id,row.matchValue,row.decoyValues) }).where(eq(v.id,row.id));
}
export async function deliverPreparedLink(id: string): Promise<void> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select().from(v).where(eq(v.id,id)).limit(1)));
  if (!row || row.status !== 'pending') return;
  if (!row.sealedLinkToken || row.challengeChoices?.length !== 3) throw new Error('link_not_prepared');
  const { deliverLink } = await import('./deliverers/link');
  await deliverLink({ verificationId:id, sealedToken:row.sealedLinkToken,
    choices:row.challengeChoices as [string,string,string] });
}
export function linkAvailable(method:'sms'|'email'): boolean {
  return method === 'email' ? getEmailService() !== null : !!getTwilioService('messaging')?.hasMessagingConfiguration();
}
```

In each W01 default port, use these method-specific branches before its current unavailable/workstation behavior. This is registration at the canonical ports module, not a startup mutation that can overwrite a W02 adapter:

```ts
// available(method,orgId,deviceId), before its existing workstation branch:
if (method === 'sms' || method === 'email') return (await import('./linkPorts')).linkAvailable(method);
// prepare(row,token), before its existing workstation branch:
if (row.method === 'sms' || row.method === 'email') return (await import('./linkPorts')).prepareLink(row,token);
// deliver(id), before its existing workstation branch:
const [verification] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
  db.select({ method:v.method }).from(v).where(eq(v.id,id)).limit(1)));
if (verification?.method === 'sms' || verification?.method === 'email') {
  return (await import('./linkPorts')).deliverPreparedLink(id);
}
```

Add the `db`, context, `v` and `eq` imports shown above to `ports.ts`. If W02 is already merged, preserve its workstation implementations after these branches; no W02 signature changes. W01 `jobs/callerVerificationPublisher.ts` calls `callerVerificationPorts.deliver(row.id)` after its committed-row scan. The publisher marks `deliveryPublishedAt` only after that promise resolves. This exact hook is the post-commit invocation.

Task 3's port registration below binds the row-backed W01 publisher; it owns duplicate claims. At-least-once delivery can repeat the same link after a crash between provider acceptance and acknowledgement; never mint a new token on retry. Provider acceptance never changes status to `verified`. Propagate a failing `applyDecision` so W01 retries its durable delivery record; do not swallow a DB failure as successful delivery.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/callerVerification/deliverers/link.test.ts src/services/notificationSenders/smsSender.test.ts`.
Expected: pass using mocked provider transports, with no network calls. The full module resolves after Task 5; before that use the explicit `publicLookup` mock above.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/callerVerification/deliverers/link.ts apps/api/src/services/callerVerification/deliverers/link.test.ts apps/api/src/services/callerVerification/linkPorts.ts apps/api/src/services/callerVerification/linkPorts.test.ts apps/api/src/services/callerVerification/ports.ts
git commit -m "feat(caller-verification): deliver SMS and email links after commit"
```

### Task 4: Namespace the miss budget and limit technician starts

**Files:**
- Modify: `apps/api/src/services/supportCodeMissBudget.ts:130,184,224` (key helpers and exported check/record functions), `apps/api/src/services/supportCodeMissBudget.test.ts:29` (existing fake Redis harness).
- Modify: `apps/api/src/services/callerVerification/service.ts`, `apps/api/src/services/callerVerification/service.test.ts` (**W01 anchors:** start before random generation; existing service mocks).

**Interfaces:**
- Consumes: `rateLimiter(redis: Redis | null, key: string, limit: number, windowSeconds: number, cost = 1, options: RateLimiterOptions = {}): Promise<RateLimitResult>` from `services/rate-limit.ts:42`; `getRedis()` from `services/redis.ts`.
- Produces: optional final `namespace: 'support-code' | 'caller-verification' = 'support-code'` on both `isSupportCodeMissBudgetExhausted(redis, ip, namespace?)` and `recordSupportCodeMiss(redis, ip, namespace?)`; original two-argument callers unchanged.

- [ ] **Step 1: Add the failing namespace test to the existing harness**

```ts
it('caller-verification misses never exhaust Quick Support', async () => {
  const redis = fakeRedis();
  for (let n = 0; n < 30; n++) await recordSupportCodeMiss(redis, IP_A, 'caller-verification');
  expect(await isSupportCodeMissBudgetExhausted(redis, IP_A, 'caller-verification')).toBe(true);
  expect(await isSupportCodeMissBudgetExhausted(redis, IP_A)).toBe(false);
  expect(await isSupportCodeMissBudgetExhausted(redis, IP_B, 'caller-verification')).toBe(false);
});
```

In W01 `service.test.ts`, add these imports/mocks and use its actual `ref`, `makeDbMock`, `actor`, `org`, and `user` fixtures. Place the limiter immediately after both `reachableContact` reads, before policy resolution:

```ts
vi.mock('../rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: () => null }));
import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';
it('refuses the eleventh technician start before inserting or delivering', async () => {
  const mock=makeDbMock(); ref.db=mock.db;
  mock.results.push([{id:user,orgId:org,siteId:null}], [{id:user,orgId:org,siteId:null}]);
  vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed:false,remaining:0,resetAt:new Date(Date.now()+600_000) });
  await expect(start(actor,{orgId:org,contactId:user,method:'callback_attestation',actionScope:'any'}))
    .rejects.toMatchObject({code:'start_rate_limited'});
  expect(rateLimiter).toHaveBeenCalledWith(getRedis(),`caller-verification:start:${actor.userId}`,10,600);
  expect(mock.calls.some(call=>call.name==='insert')).toBe(false);
});
```

Set the limiter's default in the existing `beforeEach` to `mockResolvedValue({allowed:true,remaining:9,resetAt:new Date(Date.now()+600_000)})` so the rest of W01's behavior remains exercised.

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/supportCodeMissBudget.test.ts src/services/callerVerification/service.test.ts`.
Expected: namespace isolation and missing start-limiter assertion fail.

- [ ] **Step 3: Generalize keys without changing the existing algorithm**

Replace the two fixed-key declarations and key helper with:

```ts
type MissNamespace = 'support-code' | 'caller-verification';
function globalMissBudgetKey(namespace: MissNamespace): string {
  return `${namespace}:miss-budget`;
}
function sourceMissBudgetKey(ip: string, namespace: MissNamespace): string {
  return `${globalMissBudgetKey(namespace)}:src:${rateLimitIpKey(ip)}`;
}
```

Add the optional argument to both functions. At the beginning of each body define `const globalKey = globalMissBudgetKey(namespace)` and pass `namespace` to `sourceMissBudgetKey`. Replace their Redis references to `GLOBAL_MISS_BUDGET_KEY` with `globalKey`. Keep the existing rolling-window MULTI commands and 30/source, 500/global, 60-second constants. Keep its support-specific metrics/latch strictly support-specific with these exact guards:

```ts
// In the reader, replacing the existing latch reset:
if (namespace === 'support-code' && globalCount < MISS_BUDGET_GLOBAL_PER_WINDOW) globalBudgetTripped = false;
// In recordSupportCodeMiss, replacing its initial onMiss call:
if (namespace === 'support-code') metricsRecorder.onMiss();
// Immediately after record's Redis exec and count extraction, before its
// support metric/latch/warning section:
if (namespace !== 'support-code') return;
```

This preserves support metrics and their existing warning verbatim; caller-verification cannot increment Quick Support metrics or suppress its warning. Its Redis keys retain their own TTL and counters. Miss-budget reads still fail open only because the preceding public per-IP `rateLimiter` fails closed on Redis outage.

In W01 `start`, after readiness and actor/org authorization but before token generation/INSERT, insert:

```ts
const rate = await rateLimiter(getRedis(), `caller-verification:start:${actor.userId}`, 10, 600);
if (!rate.allowed) throw new Invalid(
  'start_rate_limited', 'Too many caller verification starts; try again later.');
```

Import `rateLimiter` from `../rate-limit`, `getRedis` from `../redis`, and the existing W01 error class. Key is technician-only, not technician+org. Preserve the contact-level policy cap and advisory lock; this second budget never replaces them. Preserve W01's validation-error adapter; its response exposes the code so W04 can translate it.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/supportCodeMissBudget.test.ts src/routes/supportPublic.test.ts src/services/callerVerification/service.test.ts src/services/rate-limit.test.ts`.
Expected: all pass, including existing /64 folding, global backstop, window drain and Redis-outage tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/supportCodeMissBudget.ts apps/api/src/services/supportCodeMissBudget.test.ts apps/api/src/services/callerVerification/service.ts apps/api/src/services/callerVerification/service.test.ts
git commit -m "feat(caller-verification): isolate public miss budgets and cap starts"
```

### Task 5: Safe public lookup and card projection

**Files:**
- Create: `apps/api/src/services/callerVerification/publicLookup.ts`, `apps/api/src/services/callerVerification/publicLookup.test.ts`.
- Create: `apps/api/src/routes/callerVerifyPublic.ts`, `apps/api/src/routes/callerVerifyPublic.test.ts`.
- Modify: `apps/api/src/index.ts:75,866` (public import and mount).

**Interfaces:**
- Consumes: W01 `callerVerifications`, `callerVerificationDestinations`; existing `contacts` (`db/schema/contacts.ts`), `organizations`, `partners`, `partnerLoginBranding`; Task 1 material helpers; `getTrustedClientIp` and `rateLimitIpKey` from `services/clientIp`.
- Produces: `lookupPublicToken(hash: string): Promise<PublicLookup | null>`, `toPublicCard(row: PublicLookup): PublicCard`, `loadLinkDelivery(id: string): Promise<LinkDelivery | null>`; router `callerVerifyPublicRoutes` with GET `/:token`, mounted at `/verify`.

- [ ] **Step 1: Write the failing projection and GET tests**

`publicLookup.test.ts`:

```ts
import { expect, it } from 'vitest';
import { toPublicCard, type PublicLookup } from './publicLookup';
const input = { verification: { id: '11111111-1111-4111-8111-111111111111',
  technicianLabel: 'Taylor', actionScope: 'reset_password', targetLabel: 'alex@example.com',
  matchValue: '42', decoyValues: ['17', '83'], challengeChoices: ['17','42','83'], reverseCode: '7291',
  expiresAt: new Date('2026-09-19T20:00:00Z') }, contactName: 'Alex Example',
  partnerName: 'Example MSP', logoUrl: 'javascript:alert(1)', accentColor: '#123456', headline: null,
} as PublicLookup;
it('only projects the recipient fields, never match roles or identifiers', () => {
  const card = toPublicCard(input);
  expect(card.contactFirstName).toBe('Alex');
  expect(card.branding?.logoUrl).toBeNull();
  expect(card.choices).toHaveLength(3);
  expect(Object.keys(card).sort()).toEqual(['actionScope','branding','choices','contactFirstName',
    'expiresAt','reverseCode','status','targetLabel','technicianLabel'].sort());
  expect(JSON.stringify(card)).not.toContain('matchValue');
  expect(JSON.stringify(card)).not.toContain(input.verification.id);
});
```

`callerVerifyPublic.test.ts` starts with this complete mock harness:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), lookup: vi.fn(), limit: vi.fn(),
  exhausted: vi.fn(), miss: vi.fn(), decide: vi.fn() }));
vi.mock('../services/callerVerification/gate', () => ({ isCallerVerificationEnabled: mocks.enabled }));
vi.mock('../services/callerVerification/publicLookup', () => ({ lookupPublicToken: mocks.lookup,
  toPublicCard: () => ({ status: 'pending', choices: ['17','42','83'] }) }));
vi.mock('../services/callerVerification/service', () => ({ applyDecision: mocks.decide }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.limit }));
vi.mock('../services/supportCodeMissBudget', () => ({
  isSupportCodeMissBudgetExhausted: mocks.exhausted, recordSupportCodeMiss: mocks.miss }));
vi.mock('../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../services/clientIp', async importActual => ({ ...await importActual<typeof import('../services/clientIp')>(),
  getTrustedClientIp: () => '198.51.100.10' }));
import { callerVerifyPublicRoutes } from './callerVerifyPublic';
const app = new Hono().route('/verify', callerVerifyPublicRoutes);
const path = `/verify/${'A'.repeat(43)}`;
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled.mockReturnValue(true);
  mocks.limit.mockResolvedValue({ allowed: true }); mocks.exhausted.mockResolvedValue(false);
  mocks.lookup.mockResolvedValue(null);
});
it('is dark before any lookup or rate budget', async () => {
  mocks.enabled.mockReturnValue(false);
  const res = await app.request(path);
  expect(res.status).toBe(404); expect(mocks.limit).not.toHaveBeenCalled();
  expect(res.headers.get('Cache-Control')).toBe('no-store, private');
});
it.each([null, { verification: { status: 'verified', expiresAt: new Date(Date.now()+60_000) } },
  { verification: { status: 'pending', expiresAt: new Date(0) } }])('hides unavailable card states', async row => {
  mocks.lookup.mockResolvedValue(row);
  const res = await app.request(path);
  expect(res.status).toBe(200); expect(await res.json()).toEqual({ status: 'expired' });
});
it('renders only a pending live card and does not spend miss budget', async () => {
  mocks.lookup.mockResolvedValue({ verification: { status: 'pending', expiresAt: new Date(Date.now()+60_000), challengeChoices: ['17','42','83'] } });
  expect(await (await app.request(path)).json()).toEqual({ status: 'pending', choices: ['17','42','83'] });
  expect(mocks.miss).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/callerVerification/publicLookup.test.ts src/routes/callerVerifyPublic.test.ts`.
Expected: new modules missing.

- [ ] **Step 3: Implement the query and projection**

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { callerVerifications, callerVerificationDestinations, contacts, organizations,
  partners, partnerLoginBranding } from '../../db/schema';
import { hashLinkToken } from './linkChallenge';
import { normalizeDestination } from './destinations';
import type { CallerVerificationActionScope } from './types';

function lookupQuery() {
  return db.select({ verification: callerVerifications, contactName: contacts.name,
    email: contacts.email, mobile: contacts.mobile, partnerName: partners.name,
    logoUrl: partnerLoginBranding.logoUrl, accentColor: partnerLoginBranding.accentColor,
    headline: partnerLoginBranding.headline }).from(callerVerifications)
    .leftJoin(contacts, and(eq(contacts.id, callerVerifications.contactId), eq(contacts.orgId, callerVerifications.orgId)))
    .leftJoin(organizations, eq(organizations.id, callerVerifications.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(partnerLoginBranding, eq(partnerLoginBranding.partnerId, partners.id));
}
export type PublicLookup = Awaited<ReturnType<typeof lookupQuery>>[number];
export async function lookupPublicToken(hash: string): Promise<PublicLookup | null> {
  const [row] = await lookupQuery().where(eq(callerVerifications.challengeTokenHash, hash)).limit(1);
  return row ?? null;
}
function text(value: string | null, cap: number): string | null {
  return value?.trim().slice(0, cap) || null;
}
function logo(value: string | null): string | null {
  try { return value && new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}
export interface PublicCard {
  status: 'pending';
  branding: { partnerName: string; logoUrl: string | null; accentColor: string | null; headline: string | null } | null;
  contactFirstName: string | null; technicianLabel: string;
  actionScope: CallerVerificationActionScope; targetLabel: string | null;
  reverseCode: string; choices: [string,string,string]; expiresAt: string;
}
export function toPublicCard(row: PublicLookup): PublicCard {
  const v = row.verification;
  const name = text(row.partnerName, 120);
  return { status: 'pending', branding: name ? { partnerName: name, logoUrl: logo(row.logoUrl),
    accentColor: row.accentColor && /^#[0-9a-f]{6}$/i.test(row.accentColor) ? row.accentColor : null,
    headline: text(row.headline, 200) } : null,
    contactFirstName: text(row.contactName, 255)?.split(/\s+/u)[0] ?? null,
    technicianLabel: v.technicianLabel, actionScope: v.actionScope, targetLabel: v.targetLabel,
    reverseCode: v.reverseCode, choices: v.challengeChoices as [string,string,string],
    expiresAt: v.expiresAt.toISOString() };
}
export interface LinkDelivery {
  id: string; method: 'sms' | 'email'; challengeTokenHash: string;
  destination: string | null; partnerName: string; technicianLabel: string; requestLabel: string;
}
export async function loadLinkDelivery(id: string): Promise<LinkDelivery | null> {
  const [row] = await lookupQuery().where(and(eq(callerVerifications.id, id),
    eq(callerVerifications.status, 'pending'), sql`${callerVerifications.expiresAt} > now()`)).limit(1);
  if (!row || !['sms','email'].includes(row.verification.method)) return null;
  const v = row.verification;
  const method = v.method as 'sms' | 'email';
  const [destination] = v.destinationId ? await db.select().from(callerVerificationDestinations)
    .where(and(eq(callerVerificationDestinations.id, v.destinationId),
      eq(callerVerificationDestinations.orgId, v.orgId), eq(callerVerificationDestinations.contactId, v.contactId),
      isNull(callerVerificationDestinations.supersededAt))).limit(1) : [];
  const raw = normalizeDestination(method === 'email' ? 'email' : 'mobile', method === 'email' ? row.email : row.mobile);
  const kind = method === 'email' ? 'email' : 'mobile';
  const value = raw && destination?.kind === kind && hashLinkToken(raw) === destination.valueHash ? raw : null;
  const target = v.targetLabel ?? 'the requested account';
  const requestLabel = v.actionScope === 'reset_password' ? `reset the password for ${target}`
    : v.actionScope === 'disable_user' ? `disable the account for ${target}` : `confirm a support request for ${target}`;
  return { id: v.id, method, challengeTokenHash: v.challengeTokenHash ?? '', destination: value,
    partnerName: row.partnerName ?? 'Breeze', technicianLabel: v.technicianLabel, requestLabel };
}
```

`normalizeDestination(kind,value)` is the W01 plan Task 8 export; it validates email and E.164 and returns null for invalid legacy values. Reuse it exactly. A mismatched or superseded destination is unusable, never silently redirected to a new contact value. Add this guard inside Task 3's `try`, before token opening, so a missing destination becomes an explicit decision:

```ts
if (!row.destination) {
  await withSystemDbAccessContext(() => applyDecision({ verificationId: row.id,
    decision: { kind: 'undeliverable', reason: 'destination_changed' } }));
  return;
}
```

Move that guard before the provider `try` so a failed DB decision propagates to W01's retry handling, rather than being reclassified as a provider failure.

`callerVerifyPublic.ts`:

```ts
import { Hono } from 'hono';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isCallerVerificationEnabled } from '../services/callerVerification/gate';
import { lookupPublicToken, toPublicCard } from '../services/callerVerification/publicLookup';
import { LINK_TOKEN_RE, hashLinkToken } from '../services/callerVerification/linkChallenge';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { isSupportCodeMissBudgetExhausted, recordSupportCodeMiss } from '../services/supportCodeMissBudget';

export const callerVerifyPublicRoutes = new Hono();
callerVerifyPublicRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store, private');
  c.header('Referrer-Policy', 'no-referrer');
  if (!isCallerVerificationEnabled()) return c.json({ error: 'Not found' }, 404);
  const ip = getTrustedClientIp(c, 'unknown');
  const limit = await rateLimiter(getRedis(), `caller-verification:public:${rateLimitIpKey(ip)}`, 30, 60);
  if (!limit.allowed) return c.json({ error: 'rate limited' }, 429);
  await next();
});
callerVerifyPublicRoutes.get('/:token', async c => {
  const token = c.req.param('token');
  if (!LINK_TOKEN_RE.test(token)) return c.json({ status: 'expired' });
  const redis = getRedis(); const ip = getTrustedClientIp(c, 'unknown');
  if (await isSupportCodeMissBudgetExhausted(redis, ip, 'caller-verification')) {
    return c.json({ error: 'rate limited' }, 429);
  }
  const row = await runOutsideDbContext(() => withSystemDbAccessContext(() => lookupPublicToken(hashLinkToken(token))));
  if (!row) await recordSupportCodeMiss(redis, ip, 'caller-verification');
  if (!row || row.verification.status !== 'pending' || row.verification.expiresAt <= new Date()
    || row.verification.challengeChoices?.length !== 3) {
    return c.json({ status: 'expired' });
  }
  return c.json(toPublicCard(row));
});
```

Unlike Quick Support's spent-code accounting, only unknown caller tokens consume misses; a resolvable late rejection is not a guessing attempt. The generic card body remains identical for every unavailable state. Add `import { callerVerifyPublicRoutes } from './routes/callerVerifyPublic';` beside index line 75 and `api.route('/verify', callerVerifyPublicRoutes);` beside line 866. No `authMiddleware`, permission middleware, or partner-policy promotion wraps this mount.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/callerVerification/publicLookup.test.ts src/routes/callerVerifyPublic.test.ts src/services/callerVerification/deliverers/link.test.ts`.
Expected: pending-only projection, no-store, dark flag, and delivery destination guard pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/callerVerification/publicLookup.ts apps/api/src/services/callerVerification/publicLookup.test.ts apps/api/src/services/callerVerification/deliverers/link.ts apps/api/src/routes/callerVerifyPublic.ts apps/api/src/routes/callerVerifyPublic.test.ts apps/api/src/index.ts
git commit -m "feat(caller-verification): expose anonymous request confirmation cards"
```

### Task 6: Public POST, one decision CAS, and late rejection

**Files:**
- Modify: `apps/api/src/routes/callerVerifyPublic.ts`, `apps/api/src/routes/callerVerifyPublic.test.ts` (Task 5 GET sibling).
- Modify: `apps/api/src/services/callerVerification/service.ts`, `apps/api/src/services/callerVerification/service.test.ts` (**W01 anchor:** `applyDecision` status update).

**Interfaces:**
- Consumes: the unchanged `applyDecision` signature in Global Constraints; POST JSON `{ choice: 'NN' | 'not_me' }`.
- Produces: POST `/:token`; W01 `not_me` predicate admits link rows for 24 hours irrespective of previous status; successful decision records trusted `fromIp` in `decided_from_ip`.

- [ ] **Step 1: Append failing POST tests using Task 5's harness**

```ts
const post = (body: unknown) => app.request(path, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
it.each(['42','17','not_me'])('answers generically to both a miss and a resolved %s', async choice => {
  expect(await (await post({ choice })).json()).toEqual({ status: 'received' });
  mocks.lookup.mockResolvedValue({ verification: { id: '11111111-1111-4111-8111-111111111111',
    status: 'expired', createdAt: new Date(), expiresAt: new Date(0) } });
  expect(await (await post({ choice })).json()).toEqual({ status: 'received' });
  expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ fromIp: '198.51.100.10', decision:
    choice === 'not_me' ? { kind: 'not_me' } : { kind: 'choice', value: choice } }));
});
it.each([{ choice: '4' }, { choice: 42 }, {}, { choice: '42', orgId: 'forged' }])('rejects malformed choices', async body => {
  expect((await post(body)).status).toBe(400);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it('returns 429 before lookup when either budget is unavailable', async () => {
  mocks.exhausted.mockResolvedValue(true);
  expect((await post({ choice: '42' })).status).toBe(429);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/routes/callerVerifyPublic.test.ts`.
Expected: POST requests are 404 before implementation.

- [ ] **Step 3: Add POST and tighten W01's existing update predicate**

Import `z` from `zod`, `applyDecision` from `../services/callerVerification/service`, and `CallerVerificationValidationError` from `../services/callerVerification/errors` into the route. Append:

```ts
const choiceSchema = z.object({ choice: z.union([z.literal('not_me'), z.string().regex(/^\d{2}$/)]) }).strict();
callerVerifyPublicRoutes.post('/:token', async c => {
  const parsed = choiceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid choice' }, 400);
  const token = c.req.param('token');
  if (!LINK_TOKEN_RE.test(token)) return c.json({ status: 'received' });
  const redis = getRedis(); const ip = getTrustedClientIp(c, 'unknown');
  if (await isSupportCodeMissBudgetExhausted(redis, ip, 'caller-verification')) {
    return c.json({ error: 'rate limited' }, 429);
  }
  const found = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const row = await lookupPublicToken(hashLinkToken(token));
    if (!row) return false;
    try { await applyDecision({ verificationId: row.verification.id,
      decision: parsed.data.choice === 'not_me' ? { kind: 'not_me' } : { kind: 'choice', value: parsed.data.choice },
      ...(ip === 'unknown' ? {} : { fromIp: ip }) });
    } catch (error) {
      if (!(error instanceof CallerVerificationValidationError && error.code === 'not_found')) throw error;
    }
    return true;
  }));
  if (!found) await recordSupportCodeMiss(redis, ip, 'caller-verification');
  return c.json({ status: 'received' });
});
```

The W01 companion plan implements `handleRejection` synchronously in the decision transaction: it creates the fence and incident, and leaves `rejectionNotifiedAt=null` for the row-backed publisher. Preserve that transaction; do not pre-set `rejected_by_user` and then call a handler that returns early for an already-rejected row. Replace W01 `applyDecision` with this body, retaining its exact exported signature. Add `getCurrentDbAccessContext` to its DB imports; `lockContact`, `view`, `loadVerification`, `targetContact`, `ports`, `recordEffect`, `computeTier`, `bindingsForContact`, `currentDestination` and `isEstablished` are the W01 Task 10–11 imports/helpers.

```ts
export async function applyDecision(input: { verificationId: string; decision:
  {kind:'choice';value:string}|{kind:'not_me'}|{kind:'timeout'}|{kind:'undeliverable';reason:string};
  principal?:{osPrincipal:string;osUsername:string;upn:string|null};fromIp?:string }):Promise<VerificationView> {
  const decide = async ():Promise<VerificationView> => {
    const [row]=await db.select().from(v).where(eq(v.id,input.verificationId)).limit(1);
    if(!row) throw new Invalid('not_found','Verification not found');
    if(input.decision.kind==='not_me') {
      await lockContact(row.orgId,row.contactId);
      const fresh=await loadVerification(row.orgId,row.id);
      const [eligible]=await db.select({id:v.id}).from(v).where(and(eq(v.id,row.id),
        sql`${v.status} <> 'rejected_by_user'`,
        sql`(${v.method} NOT IN ('sms','email') OR ${v.createdAt} > now()-interval '24 hours')`)).limit(1);
      if(!eligible) return view(fresh,null,await targetContact(fresh));
      await handleRejection(row.id);
      if(input.fromIp) await db.update(v).set({decidedFromIp:input.fromIp}).where(eq(v.id,row.id));
      return view(await loadVerification(row.orgId,row.id),null,await targetContact(row));
    }
    return withSubjectLocks(db,[row.requesterBindingId,row.targetBindingId],async()=>{
      const fresh=await loadVerification(row.orgId,row.id);
      const status=decisionStatus(fresh.status,fresh.expiresAt,input.decision,fresh.matchValue);
      if(!status) return view(fresh,null,await targetContact(fresh));
      const p=await getEffectivePolicy(row.orgId),bindings=await bindingsForContact(row.orgId,row.contactId);
      const bound=!!input.principal&&bindings.some(b=>b.osPrincipal===input.principal!.osPrincipal
        &&!!input.principal!.upn&&b.upnSnapshot?.toLowerCase()===input.principal!.upn.toLowerCase());
      const dest=row.method==='sms'||row.method==='email'
        ?await currentDestination(row.orgId,row.contactId,row.method==='sms'?'mobile':'email'):null;
      const tier=computeTier({method:row.method,boundPrincipal:bound,
        destinationEstablished:!!dest&&dest.id===row.destinationId&&isEstablished(dest,p),policy:p});
      const [changed]=await db.update(v).set({status,decidedAt:new Date(),decidedFromIp:input.fromIp,
        osPrincipalObserved:input.principal?.osPrincipal,tier:tier.tier,tierReason:tier.reason,
        ...(input.decision.kind==='undeliverable'?{reason:input.decision.reason}:{}) })
        .where(and(eq(v.id,row.id),eq(v.status,'pending'),
          ...(input.decision.kind==='choice'?[sql`${v.expiresAt}>now()`]:[]))).returning();
      if(changed) await recordEffect(changed,status);
      return view(changed??await loadVerification(row.orgId,row.id),null,await targetContact(row));
    });
  };
  // Public lookup and CAS already have a short system transaction. Reuse it;
  // unconditionally detaching here would hold two pooled connections.
  if(getCurrentDbAccessContext()?.scope==='system') return decide();
  return runOutsideDbContext(()=>withSystemDbAccessContext(decide,'callerVerification.applyDecision'));
}
```

Number choices always carry the database `expires_at > now()` predicate, even if W01's pure `decisionStatus` computes `expired`. Timeout retains its separate pending-only transition. The contact lock serializes late rejection eligibility with W01 rejection/override; `handleRejection` takes the same reentrant contact lock and ordered subject locks before its non-rejected CAS. Only that handler opens the incident. The public response ignores the resulting view. Duplicate decisions leave the first decision IP intact.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/routes/callerVerifyPublic.test.ts src/services/callerVerification/service.test.ts`.
Expected: generic responses, timeout regression, late not-me, and duplicate decisions pass. Actual one-winner semantics are proved against Postgres next.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/callerVerifyPublic.ts apps/api/src/routes/callerVerifyPublic.test.ts apps/api/src/services/callerVerification/service.ts apps/api/src/services/callerVerification/service.test.ts
git commit -m "feat(caller-verification): accept public choices and late rejection atomically"
```

### Task 7: Real public-route integration, including a counted CAS winner

**Files:**
- Create: `apps/api/src/routes/callerVerifyPublic.integration.test.ts`.
- Modify: `apps/api/vitest.integration.config.ts:11` (include), `apps/api/vitest.config.ts:16` (exclude).
- Modify: `apps/api/src/services/callerVerification/service.ts` (**W01 anchor:** decision CAS) only if the behavioral tests identify an incorrect predicate or duplicate effect.

**Interfaces:**
- Consumes: `getTestDb()` and `getTestRedis()` at integration `setup.ts:54,91`; `createPartner`, `createOrganization`, `createUser` in `db-utils.ts:176,216,129`; real `handleRejection` and public routes.
- Produces: live test proving `breeze_app` system-context reachability, one changed row across concurrent requests, late rejection+incident, and namespace-specific budgets.

- [ ] **Step 1: Write the fixture and failing live tests**

```ts
import '../__tests__/integration/setup';
import { getTestDb, getTestRedis } from '../__tests__/integration/setup';
import { createPartner, createOrganization, createUser } from '../__tests__/integration/db-utils';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { callerVerifications, contacts, incidents } from '../db/schema';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { hashLinkToken } from '../services/callerVerification/linkChallenge';
import { handleRejection } from '../services/callerVerification/rejection';
import { callerVerifyPublicRoutes } from './callerVerifyPublic';

const app = new Hono().route('/verify', callerVerifyPublicRoutes);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const post = (token: string, choice: string) => app.request(`/verify/${token}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
beforeEach(() => vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({ partnerId: partner.id, email: `${randomUUID()}@example.com`, name: 'Taylor' });
  const [contact] = await getTestDb().insert(contacts).values({ orgId: org.id,
    name: 'Alex Example', email: 'alex@example.com' }).returning();
  if (!contact) throw new Error('contact fixture missing');
  const token = randomBytes(32).toString('base64url');
  const [v] = await getTestDb().insert(callerVerifications).values({ orgId: org.id,
    contactId: contact.id, initiatedByUserId: tech.id, technicianLabel: 'Taylor',
    method: 'email', actionScope: 'any', status: 'pending', tier: 1, tierReason: 'destination_recent',
    targetLabel: 'alex@example.com', matchValue: '42', decoyValues: ['17','83'], challengeChoices: ['17','42','83'], reverseCode: '7291',
    challengeTokenHash: hashLinkToken(token), attemptNo: 1, expiresAt: new Date(Date.now()+600_000),
  }).returning();
  if (!v) throw new Error('verification fixture missing');
  return { org, contact, v, token };
}
it('serves an unauthenticated live card through the real app-role system context', async () => {
  const f = await seed();
  const res = await app.request(`/verify/${f.token}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'pending', contactFirstName: 'Alex' });
  expect(res.headers.get('Cache-Control')).toBe('no-store, private');
});
it('has exactly one decision UPDATE across concurrent correct and wrong choices', async () => {
  const f = await seed();
  // A transaction-local temporary trigger is not visible to other pooled
  // connections. Use a uniquely named ordinary test-only trigger instead.
  const suffix = randomUUID().replaceAll('-', '');
  const table = `cv_probe_${suffix}`, fn = `cv_count_${suffix}`, trigger = `cv_trigger_${suffix}`;
  const admin = getTestDb();
  await admin.execute(sql.raw(`CREATE TABLE public.${table} (verification_id uuid)`));
  await admin.execute(sql.raw(`GRANT INSERT ON public.${table} TO breeze_app`));
  await admin.execute(sql.raw(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.status IS DISTINCT FROM NEW.status THEN
      INSERT INTO public.${table} VALUES (NEW.id); END IF; RETURN NEW; END $$`));
  await admin.execute(sql.raw(`CREATE TRIGGER ${trigger} AFTER UPDATE ON caller_verifications
    FOR EACH ROW EXECUTE FUNCTION public.${fn}()`));
  try {
    const responses = await Promise.all([post(f.token, '42'), post(f.token, '17')]);
    for (const response of responses) expect(await response.json()).toEqual({ status: 'received' });
    const rows = await admin.execute(sql.raw(`SELECT count(*)::int AS n FROM public.${table}
      WHERE verification_id = '${f.v.id}'::uuid`));
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
    const [v] = await admin.select().from(callerVerifications).where(eq(callerVerifications.id, f.v.id));
    expect(['verified','wrong_choice']).toContain(v?.status);
  } finally {
    await admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON caller_verifications`));
    await admin.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${fn}()`));
    await admin.execute(sql.raw(`DROP TABLE IF EXISTS public.${table}`));
  }
});
it('honors an expired not_me and opens exactly one p2 incident on replay', async () => {
  const f = await seed();
  await getTestDb().update(callerVerifications).set({ status: 'expired', expiresAt: new Date(0) })
    .where(eq(callerVerifications.id, f.v.id));
  expect(await (await post(f.token, 'not_me')).json()).toEqual({ status: 'received' });
  const [v] = await getTestDb().select().from(callerVerifications).where(eq(callerVerifications.id, f.v.id));
  expect(v?.status).toBe('rejected_by_user'); expect(v?.decidedAt).toBeInstanceOf(Date);
  await asSystem(() => handleRejection(f.v.id));
  await asSystem(() => handleRejection(f.v.id));
  const opened = await getTestDb().select().from(incidents).where(and(eq(incidents.orgId, f.org.id),
    eq(incidents.sourceType, 'caller_verification'), eq(incidents.sourceRef, f.v.id)));
  expect(opened).toHaveLength(1); expect(opened[0]?.severity).toBe('p2');
});
it('does not honor not_me beyond the 24-hour public window', async () => {
  const f = await seed();
  await getTestDb().update(callerVerifications).set({ createdAt: new Date(Date.now()-86_401_000) })
    .where(eq(callerVerifications.id, f.v.id));
  await post(f.token, 'not_me');
  const [v] = await getTestDb().select().from(callerVerifications).where(eq(callerVerifications.id, f.v.id));
  expect(v?.status).toBe('pending');
});
it('trips the real global miss budget without tripping the support namespace', async () => {
  const f = await seed(); const redis = getTestRedis();
  const entries = Array.from({ length: 500 }, (_, i) => [Date.now(), `guess-${i}`]).flat();
  await redis.zadd('caller-verification:miss-budget', ...entries);
  expect((await app.request(`/verify/${f.token}`)).status).toBe(429);
  expect(await redis.zcard('support-code:miss-budget')).toBe(0);
});
it('trips the source miss budget independently of the global backstop',async()=>{
 const f=await seed(),redis=getTestRedis();
 await redis.zadd('caller-verification:miss-budget:src:unknown',...Array.from({length:30},(_,i)=>[Date.now(),`source-${i}`]).flat());
 expect((await app.request(`/verify/${f.token}`)).status).toBe(429);
 expect(await redis.zcard('caller-verification:miss-budget')).toBe(0);
});
it('the thirty-first public request is limited even when every lookup succeeds', async () => {
  const f = await seed();
  for (let i = 0; i < 30; i++) expect((await app.request(`/verify/${f.token}`)).status).toBe(200);
  expect((await app.request(`/verify/${f.token}`)).status).toBe(429);
});
```

Add these imports and the committed-row publisher/rollback test to the same live suite. The provider port is mocked; preparation, publication scan, marker update and rollback use real Postgres:

```ts
import { db } from '../db';
import { prepareLink } from '../services/callerVerification/linkPorts';
import { callerVerificationPorts } from '../services/callerVerification/ports';
import { publishCallerVerificationEffects } from '../jobs/callerVerificationPublisher';
it('publishes prepared committed links and cannot publish a rolled-back row',async()=>{
 const f=await seed(); await asSystem(()=>prepareLink(f.v,f.token));
 const rolledBackId=randomUUID();
 await expect(asSystem(async()=>{
  const [row]=await db.insert(callerVerifications).values({...f.v,id:rolledBackId,
   challengeTokenHash:hashLinkToken('B'.repeat(43))}).returning();
  await prepareLink(row!,'B'.repeat(43));throw new Error('rollback probe');
 })).rejects.toThrow('rollback probe');
 const deliver=vi.spyOn(callerVerificationPorts,'deliver').mockResolvedValue();
 try {
  await publishCallerVerificationEffects();await publishCallerVerificationEffects();
  expect(deliver).toHaveBeenCalledTimes(1);expect(deliver).toHaveBeenCalledWith(f.v.id);
  const [saved]=await getTestDb().select().from(callerVerifications).where(eq(callerVerifications.id,f.v.id));
  expect(saved?.deliveryPublishedAt).toBeInstanceOf(Date);expect(saved?.sealedLinkToken).not.toContain(f.token);
 } finally {deliver.mockRestore();}
});
```

Only the temporary probe uses admin SQL; the route and decision use production `db` as `breeze_app`. Generated identifiers and UUIDs are test-owned, never request input. The probe counts writes rather than checking only final status, which would miss a last-writer-wins bug. The fixture deliberately uses `actionScope:'any'`; it does not forge an unbound reset grant.

- [ ] **Step 2: Register and run to failure**

Add the literal path `'src/routes/callerVerifyPublic.integration.test.ts'` to integration `include` and unit `exclude`. These are separate lists; neither is a blanket suffix rule. Start the worktree stack with `pnpm test-stack up`. Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/callerVerifyPublic.integration.test.ts`.
Expected before Task 6's CAS predicate: the concurrent-write count or late-rejection assertion fails. If tasks were executed in order and it is already green, temporarily remove only the corresponding new predicate locally, observe red, restore it before commit. Never accept zero collected tests.

- [ ] **Step 3: Apply the minimal implementation and prove the outbox boundary**

Restore Task 6's exact CAS predicates; use the W01 incident implementation with its existing unique `(org_id,source_type,source_ref)` index (`db/schema/incidentResponse.ts:86`). The late-rejection test calls the real handler twice for deterministic idempotency. W01 opens the incident inside `applyDecision` through `handleRejection`, so the assertion observes the actual route transaction before replay. Its publisher subsequently consumes `rejectionNotifiedAt IS NULL` for notification; it does not create the fence or incident. Task 3's port test and the publisher test below prove link delivery reachability.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/callerVerifyPublic.integration.test.ts`.
Expected: eight live tests, no mocked DB/rate limiter, one concurrent state update and one incident. Integration setup truncates tenant roots with CASCADE and flushes Redis before each test (`setup.ts:366,384`); do not delete append-only audit rows yourself.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/callerVerifyPublic.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/api/src/services/callerVerification/service.ts
git commit -m "test(caller-verification): prove public CAS rejection and budgets on live stores"
```

### Task 8: Shared OID-only `m365.user.mailboxes` action

**Files:**
- Modify: `packages/shared/src/m365/readActions.ts:13,25,40` (catalog, fields, union).
- Modify: `packages/shared/src/m365/readActions.test.ts:14,29` (inventory and schema cases).

**Interfaces:**
- Consumes: `guidSchema`, `M365ReadAction`, `M365ReadActionId` in that module.
- Produces: `{ type: 'm365.user.mailboxes'; userId: string }` in `m365ReadActionSchema`; projection exactly `id`, `userPrincipalName`, `mail`, `proxyAddresses`. `packages/shared/src/m365/index.ts:3` already exports the module.

- [ ] **Step 1: Add the failing tests**

```ts
it('accepts mailbox reads only for an OID with exactly four projected fields', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  expect(m365ReadActionSchema.parse({ type: 'm365.user.mailboxes', userId })).toEqual({ type: 'm365.user.mailboxes', userId });
  expect(M365_READ_ACTION_FIELDS['m365.user.mailboxes']).toEqual(['id','userPrincipalName','mail','proxyAddresses']);
  expect(m365ReadActionSchema.safeParse({ type: 'm365.user.mailboxes', userId: 'alex@example.com' }).success).toBe(false);
  expect(m365ReadActionSchema.safeParse({ type: 'm365.user.mailboxes', userId, select: ['passwordProfile'] }).success).toBe(false);
  expect(M365_READ_ACTION_FIELDS['m365.user.get']).not.toContain('proxyAddresses');
});
```

- [ ] **Step 2: Run to failure**

Run: `cd packages/shared && npx vitest run src/m365/readActions.test.ts`.
Expected: unrecognized discriminator/absent field allowlist.

- [ ] **Step 3: Add the catalog entry, projection, and union member**

Insert `'m365.user.mailboxes',` after `'m365.user.get'` in `M365_READ_ACTION_IDS`, and:

```ts
// M365_READ_ACTION_FIELDS:
'm365.user.mailboxes': ['id', 'userPrincipalName', 'mail', 'proxyAddresses'],
// m365ReadActionSchema discriminated union, after user.get:
z.object({ type: z.literal('m365.user.mailboxes'), userId: guidSchema }).strict(),
```

Update the exact action inventory in the existing test to include this thirteenth action. Add the valid `{ type:'m365.user.mailboxes', userId:'11111111-1111-4111-8111-111111111111' }` to its valid variants. Do not broaden `user.get`, allow caller-supplied Graph paths, or add Graph scopes.

- [ ] **Step 4: Run to pass**

Run: `cd packages/shared && npx vitest run src/m365/readActions.test.ts`.
Expected: all thirteen discriminators validated, mailbox UPN rejected.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/readActions.ts packages/shared/src/m365/readActions.test.ts
git commit -m "feat(m365): define canonical mailbox read action"
```

### Task 9: Direct Graph mailbox projection and tenant-safe token reuse

**Files:**
- Modify: `apps/api/src/services/m365DirectGraph.ts:73,105,124,212` (cache, `getToken`, `invokeDirect`).
- Modify: `apps/api/src/services/m365DirectGraph.test.ts:1,69` (existing row/fetch mocks).
- Modify: `apps/api/src/services/delegantClient.ts:38` (`DelegantToolName` union).

**Interfaces:**
- Consumes: `invokeDirect(orgId, toolName, params)` and `graphFetch(token, method, path, body?, opts?)`, existing signatures unchanged; Task 8 action schema.
- Produces: tool name `'get_user_mailboxes'`; `getToken(orgId: string, expectedTenantId?: string): Promise<{ token: string } | DirectInvokeError>`; mailbox tool requires `{ userId: string; expectedTenantId: string }`.

- [ ] **Step 1: Add failing direct-backend cases to its existing test harness**

```ts
it('projects aliases but never extra Graph fields', async () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const resource = { id: userId, userPrincipalName: 'alex@example.com', mail: null,
    proxyAddresses: ['SMTP:alias@example.com'], passwordProfile: { password: 'secret' } };
  const fetch = mockFetch(200, resource);
  const result = await invokeDirect('org-1', 'get_user_mailboxes', { userId, expectedTenantId: mockRow.tenantId });
  expect(result).toEqual({ kind: 'ok', data: { id: userId, userPrincipalName: 'alex@example.com',
    mail: null, proxyAddresses: ['SMTP:alias@example.com'] } });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe(`/v1.0/users/${userId}`);
  expect(url.searchParams.get('$select')).toBe('id,userPrincipalName,mail,proxyAddresses');
});
it('rejects a different current tenant before token or Graph access', async () => {
  const fetch = mockFetch(200, {});
  const result = await invokeDirect('org-1', 'get_user_mailboxes', {
    userId: '22222222-2222-4222-8222-222222222222', expectedTenantId: '33333333-3333-4333-8333-333333333333' });
  expect(result).toMatchObject({ kind: 'error', code: 'tenant_mismatch' });
  expect(acquireClientCredentialsToken).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('does not reuse a cached token after the connection tenant changes', async () => {
  await getToken('org-1');
  selectRows = [{ ...mockRow, tenantId: '33333333-3333-4333-8333-333333333333' }];
  await getToken('org-1');
  expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts`.
Expected: unsupported mailbox tool and stale tenant cache assertion.

- [ ] **Step 3: Implement the dedicated read**

Add `'get_user_mailboxes'` to `DelegantToolName`. In `getToken`, add the optional parameter and immediately after its missing-row check:

```ts
if (expectedTenantId && row.tenantId?.toLowerCase() !== expectedTenantId.toLowerCase()) {
  return { kind: 'error', code: 'tenant_mismatch', message: 'Microsoft 365 tenant changed.' };
}
const cacheKey = `${orgId}:${row.tenantId}:${row.clientId}`;
```

For the mailbox path, load the connection under a short system read, because W01 deliberately performs mailbox I/O outside its DB transactions. Add `withSystemDbAccessContext` to the DB import; replace only `getToken`'s opening query with:

```ts
const loadConnectionRow = () => db.select().from(m365Connections).where(and(
  eq(m365Connections.orgId,orgId),eq(m365Connections.profile,'legacy-direct'),eq(m365Connections.status,'active'))).limit(1);
const [row] = expectedTenantId
  ? await withSystemDbAccessContext(loadConnectionRow,'callerVerification.mailboxes.directConnection')
  : await loadConnectionRow();
```

The closure ends before decryption, token acquisition, cache use, or Graph I/O. Existing ordinary callers retain ambient RLS. Replace the old `cacheKey` declaration rather than creating two declarations; update the cache comment at line 73. Keep the mismatch check before cache lookup, decryption and Azure token acquisition. Add imports of `m365ReadActionSchema` and `M365_READ_ACTION_FIELDS` from `@breeze/shared/m365`. At the beginning of `invokeDirect`, before its existing ordinary `getToken` call:

```ts
if (toolName === 'get_user_mailboxes') {
  const parsed = m365ReadActionSchema.safeParse({ type: 'm365.user.mailboxes', userId: params.userId });
  const tenant = params.expectedTenantId;
  if (!parsed.success || parsed.data.type !== 'm365.user.mailboxes'
    || typeof tenant !== 'string' || !isM365TenantId(tenant)) {
    return { kind: 'error', code: 'bad_request', message: 'A pinned tenant and user OID are required.' };
  }
  const auth = await getToken(orgId, tenant);
  if ('kind' in auth) return auth;
  const fields = M365_READ_ACTION_FIELDS['m365.user.mailboxes'];
  const query = new URLSearchParams({ '$select': fields.join(',') });
  const response = await graphFetch(auth.token, 'GET', `/users/${encodeURIComponent(parsed.data.userId)}?${query}`);
  if (response.kind !== 'ok') return response;
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    return { kind: 'error', code: 'graph_response_invalid', message: 'Unexpected mailbox response.' };
  }
  const raw = response.data as Record<string, unknown>;
  return { kind: 'ok', data: Object.fromEntries(fields.filter(key => key in raw).map(key => [key, raw[key]])) };
}
```

Missing `proxyAddresses` stays missing; Task 11 rejects it. Do not silently manufacture an empty array. Existing `get_user`, disable and password-reset cases retain their behavior; W05 owns their dispatch enforcement.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts`.
Expected: exact field projection, tenant mismatch before I/O and cache invalidation pass along with existing mutation mapping.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365DirectGraph.ts apps/api/src/services/m365DirectGraph.test.ts apps/api/src/services/delegantClient.ts
git commit -m "feat(m365): read target mailboxes through tenant-pinned direct Graph"
```

### Task 10: Read executor and control-plane mailbox entry

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/readActions.ts:121`, `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts:58,73,90`.
- Modify: `apps/api/src/services/m365ControlPlane/readActionService.ts:103,142,178`, `apps/api/src/services/m365ControlPlane/readActionService.test.ts` (existing service harness).

**Interfaces:**
- Consumes: `executeGraphReadAction(action: M365ReadAction, context: GraphReadActionContext): Promise<ReadActionResult>`; private `projectedResource` at executor `readActions.ts:75`; existing read budget/runtime/audit helpers.
- Produces: `executeM365MailboxReadByOrg(orgId: string, subject: { entraTenantId: string; entraOid: string }, actorId: string): Promise<Record<string, unknown>>`. It follows the by-org signature precedent at `writeActionService.ts:98` without synthetic `AuthContext`; W01 calls it outside a DB context, so only its org-filtered connection read elects system scope.

- [ ] **Step 1: Add the failing executor test**

```ts
it('returns exactly the mailbox projection, retaining explicit empty aliases', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const { client, readResourceCalls } = createStubGraphClient({ resource: {
    id: userId, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [], displayName: 'Alex' } });
  expect(await executeGraphReadAction({ type: 'm365.user.mailboxes', userId },
    { accessToken: ACCESS_TOKEN, graphClient: client })).toEqual({ success: true, kind: 'resource',
      resource: { id: userId, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [] } });
  expect(readResourceCalls[0]?.select).toEqual(['id','userPrincipalName','mail','proxyAddresses']);
});
```

In `readActionService.test.ts`, import `executeM365MailboxReadByOrg`, add `withSystemDbAccessContext: async (fn:()=>Promise<unknown>)=>fn()` to its `../../db` mock, and place these cases inside the existing describe so its `beforeEach` initializes the executor and budget:

```ts
it('mailbox reads pin tenant and OID in the executor envelope',async()=>{
 dbMocks.selectResults.push([connectionRow()]);
 executorMocks.executeReadAction.mockResolvedValue({success:true,kind:'resource',resource:{id:ORG_ID,proxyAddresses:[]}});
 await executeM365MailboxReadByOrg(ORG_ID,{entraTenantId:TENANT_ID,entraOid:ORG_ID},'tech');
 expect(executorMocks.executeReadAction).toHaveBeenCalledWith(expect.objectContaining({tenantId:TENANT_ID,
  action:{type:'m365.user.mailboxes',userId:ORG_ID}}));
});
it.each(['tenant','budget','disabled'])('mailbox %s refusal makes zero executor calls',async failure=>{
 dbMocks.selectResults.push([connectionRow({tenantId:failure==='tenant'?'wrong-tenant':TENANT_ID})]);
 if(failure==='budget')budgetMocks.consume.mockResolvedValue({allowed:false});
 if(failure==='disabled')runtimeMocks.enabled.mockReturnValue(false);
 await expect(executeM365MailboxReadByOrg(ORG_ID,{entraTenantId:TENANT_ID,entraOid:ORG_ID},'tech')).rejects.toThrow();
 expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
});
```

The direct test's DB mock also gains `withSystemDbAccessContext: async (fn:()=>Promise<unknown>)=>fn()` for its new connection-load seam; live integration retains the real wrapper.

- [ ] **Step 2: Run to failure**

Run: `cd apps/m365-graph-read-executor && npx vitest run src/microsoft/readActions.test.ts`.
Expected: mailbox dispatch missing.

- [ ] **Step 3: Implement dispatch and the org-only control-plane function**

Add this switch arm beside `m365.user.get`:

```ts
case 'm365.user.mailboxes':
  return await projectedResource(graphClient, { accessToken,
    path: `/users/${encodeURIComponent(action.userId)}`, select: fields }, fields);
```

Add the mailbox action using `userId: DEVICE_ID` to `SAMPLE_ACTIONS`; add `'/users/' + DEVICE_ID` to `EXPECTED_PATH`; add the ID to `RESOURCE_ACTION_IDS`. These three exhaustive fixtures are required for typecheck as well as runtime tests. `graphClient.ts:465` already accepts `select`; no transport change is needed.

In API `readActionService.ts`, append the following function using its existing imports and private helpers. Add `m365ReadActionSchema` to the shared import and `withSystemDbAccessContext` to its DB import. The fetcher is internal to an already-authorized gate, never a new public tool:

```ts
export async function executeM365MailboxReadByOrg(orgId: string,
  subject: { entraTenantId: string; entraOid: string }, actorId: string): Promise<Record<string, unknown>> {
  if (!isM365GraphReadToolsEnabledForOrg(orgId)) throw new Error('tools_disabled');
  const action = m365ReadActionSchema.parse({ type: 'm365.user.mailboxes', userId: subject.entraOid });
  const [connection] = await withSystemDbAccessContext(() => db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId), eq(m365Connections.profile, PROFILE))).limit(1), 'callerVerification.mailboxes.readConnection');
  if (connectionNotReadyState(connection) || !connection) throw new Error('connection_not_ready');
  if (connection.tenantId?.toLowerCase() !== subject.entraTenantId.toLowerCase()) throw new Error('tenant_mismatch');
  if (!(await consumeM365ReadActionBudget(connection.id)).allowed) throw new Error('read_rate_limited');
  const auditBase = { orgId, connectionId: connection.id, actionType: action.type, actorId };
  const request = requestLikeFromSnapshot({});
  try {
    const result = await runtimeClient(loadM365CustomerGraphReadRuntimeConfig()).executeReadAction({
      correlationId: randomUUID(), tenantId: subject.entraTenantId, action });
    recordM365ReadActionEvent(request, { ...auditBase,
      outcome: result.success ? 'ok' : result.errorCode,
      itemCount: result.success && result.kind === 'resource' ? 1 : 0, truncated: false });
    if (!result.success || result.kind !== 'resource') throw new Error('subject_mailboxes_unknown');
    return result.resource;
  } catch (error) {
    if (error instanceof GraphReadExecutorClientError) recordM365ReadActionEvent(request,
      { ...auditBase, outcome: 'executor_unavailable', itemCount: 0, truncated: false });
    throw error;
  }
}
```

No connection profile ambiguity: query explicitly uses `customer-graph-read`, with the existing org/profile uniqueness. No network call occurs if tenant mismatch, disabled tools, invalid OID, missing connection, or exhausted budget. The outbound tenant is the one already compared against the pinned subject; there is no second connection reload.

- [ ] **Step 4: Run to pass**

Run: `cd apps/m365-graph-read-executor && npx vitest run src/microsoft/readActions.test.ts src/operations.test.ts`.
Run: `cd apps/api && npx vitest run src/services/m365ControlPlane/readActionService.test.ts`.
Expected: executor projection and existing read auth/budget/audit behavior pass. Task 11's dispatcher suite exercises this new function through its explicit backend boundary; keep existing authenticated read entry unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/readActions.ts apps/m365-graph-read-executor/src/microsoft/readActions.test.ts apps/api/src/services/m365ControlPlane/readActionService.ts apps/api/src/services/m365ControlPlane/readActionService.test.ts
git commit -m "feat(m365): execute mailbox reads through the Graph control plane"
```

### Task 11: Delegant, backend selection, mailbox normalization, and gate wiring

**Files:**
- Modify: `apps/api/src/services/delegantClient.ts:71,107`, `apps/api/src/services/delegantClient.test.ts` (broker payload contract).
- Modify: `apps/api/src/services/aiToolsM365.ts:59,73,102`, `apps/api/src/services/aiToolsM365.test.ts` (new internal dispatcher, existing tools unchanged).
- Create: `apps/api/src/services/callerVerification/mailboxes.ts`, `apps/api/src/services/callerVerification/mailboxes.test.ts`.
- Modify: `apps/api/src/services/callerVerification/gate.ts`, `apps/api/src/services/callerVerification/gate.test.ts`, `apps/api/src/services/callerVerification/index.ts` (**W01 anchors:** mailbox fetcher stub, email candidate check, barrel exports).

**Interfaces:**
- Consumes: `EntraSubject { entraTenantId: string; entraOid: string }`; `DelegantInvokeArgs` at `delegantClient.ts:47`; existing `principals(auth)` environment convention at `aiToolsM365.ts:59`.
- Produces: `fetchTargetMailboxes(orgId: string, subject: EntraSubject): Promise<Set<string>>` verbatim; new `withMailboxReader<T>(userId: string, fn: () => Promise<T>): Promise<T>` and `fetchMailboxResourceByOrg(orgId: string, subject: EntraSubject): Promise<unknown>` in `aiToolsM365.ts`.

- [ ] **Step 1: Write the failing normalized-set tests**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../aiToolsM365', () => ({ fetchMailboxResourceByOrg: read }));
import { fetchTargetMailboxes } from './mailboxes';
const subject = { entraTenantId: '11111111-1111-4111-8111-111111111111',
  entraOid: '22222222-2222-4222-8222-222222222222' };
beforeEach(() => vi.clearAllMocks());
it('normalizes target UPN, mail, and SMTP aliases only', async () => {
  read.mockResolvedValue({ id: subject.entraOid, userPrincipalName: 'Alex@Example.com', mail: null,
    proxyAddresses: ['SMTP:Primary@Example.com','smtp:Alias@Example.com','X500:legacy','SIP:ignored'] });
  expect(await fetchTargetMailboxes('org-A', subject)).toEqual(new Set([
    'alex@example.com','primary@example.com','alias@example.com' ]));
  expect(read).toHaveBeenCalledWith('org-A', subject);
});
it.each([
  { id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null },
  { id: '33333333-3333-4333-8333-333333333333', userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [] },
  { id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [null] },
])('fails closed for incomplete or rebound data', async resource => {
  read.mockResolvedValue(resource);
  await expect(fetchTargetMailboxes('org-A', subject)).rejects.toThrow();
});
it('propagates backend failure instead of returning an empty mailbox set', async () => {
  read.mockRejectedValue(new Error('executor unavailable'));
  await expect(fetchTargetMailboxes('org-A', subject)).rejects.toThrow('executor unavailable');
});
```

Append this broker test inside `delegantClient.test.ts`'s existing `invokeDelegantTool response mapping` describe (its real `baseArgs`, `env`, and `mockFetchOnce` helpers):

```ts
it('mailbox tool sends pinned parameters and strips extra fields',async()=>{
 const userId='11111111-1111-4111-8111-111111111111',expectedTenantId=baseArgs().connection.m365TenantId;
 const fetch=mockFetchOnce(200,{isError:false,data:{id:userId,userPrincipalName:'a@example.com',mail:null,proxyAddresses:[],displayName:'hidden'}});
 const args={...baseArgs(),toolName:'get_user_mailboxes' as const,parameters:{userId,expectedTenantId}};
 const result=await invokeDelegantTool(args,{env,fetchImpl:fetch});
 expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({toolName:'get_user_mailboxes',parameters:{userId,expectedTenantId}});
 expect(result).toMatchObject({kind:'ok',data:{id:userId,proxyAddresses:[]}});
 expect(JSON.stringify(result)).not.toContain('displayName');
 fetch.mockClear();await invokeDelegantTool({...args,parameters:{userId,expectedTenantId:'wrong'}},{env,fetchImpl:fetch});
 expect(fetch).not.toHaveBeenCalled();
});
```

In `aiToolsM365.test.ts`, extend its read-service mock with `executeM365MailboxReadByOrg:vi.fn()`; import it and `fetchMailboxResourceByOrg`, `withMailboxReader`. Add this explicit connection-query mock and tests. The existing tool tests do not query `db` directly; the mock also supplies context wrappers to preserve their imported helpers:

```ts
const mailboxDb=vi.hoisted(()=>({rows:[] as unknown[][]}));
vi.mock('../db',()=>({withDbAccessContext:async(_c:unknown,f:()=>Promise<unknown>)=>f(),
 withSystemDbAccessContext:async(f:()=>Promise<unknown>)=>f(),db:{select:()=>({from:()=>({where:()=>{
  const result=Promise.resolve(mailboxDb.rows.shift()??[]);return Object.assign(result,{limit:()=>result});
 }})})}}));
it.each(['direct','controlPlane','delegant'])('routes mailbox reads through %s only',async backend=>{
 const target={entraTenantId:'11111111-1111-4111-8111-111111111111',entraOid:'22222222-2222-4222-8222-222222222222'};
 vi.mocked(hasDirectM365Connection).mockResolvedValue(backend==='direct');
 mailboxDb.rows=backend==='controlPlane'?[[{id:'read'}]]:[[],[{...activeConn,orgId:'org-A',m365TenantId:target.entraTenantId}]];
 vi.mocked(invokeDirect).mockResolvedValue({kind:'ok',data:{id:target.entraOid}});
 vi.mocked(executeM365MailboxReadByOrg).mockResolvedValue({id:target.entraOid});
 vi.mocked(invokeDelegantTool).mockResolvedValue({kind:'ok',data:{id:target.entraOid}});
 await expect(withMailboxReader('tech',()=>fetchMailboxResourceByOrg('org-A',target))).resolves.toEqual({id:target.entraOid});
 expect(invokeDirect).toHaveBeenCalledTimes(backend==='direct'?1:0);
 expect(executeM365MailboxReadByOrg).toHaveBeenCalledTimes(backend==='controlPlane'?1:0);
 expect(invokeDelegantTool).toHaveBeenCalledTimes(backend==='delegant'?1:0);
});
it('does not fall back after a selected backend fails',async()=>{
 vi.mocked(hasDirectM365Connection).mockResolvedValue(true);
 vi.mocked(invokeDirect).mockResolvedValue({kind:'error',code:'auth_failed',message:'no token'});
 await expect(withMailboxReader('tech',()=>fetchMailboxResourceByOrg('org-A',{entraTenantId:'tenant',entraOid:'oid'}))).rejects.toThrow();
 expect(invokeDelegantTool).not.toHaveBeenCalled();expect(executeM365MailboxReadByOrg).not.toHaveBeenCalled();
});
```

Reset `mailboxDb.rows=[]` and `hasDirectM365Connection.mockResolvedValue(false)` in the existing `beforeEach`; otherwise one new direct test would steer unrelated legacy tests. Append the ambiguity assertion:
```ts
it('refuses multiple matching Delegant connections',async()=>{
 vi.mocked(hasDirectM365Connection).mockResolvedValue(false);
 mailboxDb.rows=[[],[activeConn,activeConn]];
 await expect(withMailboxReader('tech',()=>fetchMailboxResourceByOrg('org-A',{
  entraTenantId:'11111111-1111-4111-8111-111111111111',entraOid:'22222222-2222-4222-8222-222222222222'}))).rejects.toThrow();
 expect(invokeDelegantTool).not.toHaveBeenCalled();
});
```
No fixture uses a UPN as an accepted mailbox action.

- [ ] **Step 2: Run to failure**

Run: `cd apps/api && npx vitest run src/services/callerVerification/mailboxes.test.ts`.
Expected: missing mailbox module.

- [ ] **Step 3: Implement all three dispatch branches and the set**

Add imports in `aiToolsM365.ts`: `AsyncLocalStorage` from `node:async_hooks`, `randomUUID` from `node:crypto`, `and`, `eq` from `drizzle-orm`, `db` and `withSystemDbAccessContext` from `../db`, `m365Connections`, `delegantM365Connections` from `../db/schema`, `executeM365MailboxReadByOrg` from the read service, and type `EntraSubject` from `./callerVerification/types`. Then append:

```ts
const mailboxReader = new AsyncLocalStorage<string>();
export function withMailboxReader<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return mailboxReader.run(userId, fn);
}
export async function fetchMailboxResourceByOrg(orgId: string, subject: EntraSubject): Promise<unknown> {
  const userId = mailboxReader.getStore();
  if (!userId) throw new Error('mailbox_reader_missing');
  // Internal gate-only adapter; every elevated query is constrained to its org.
  if (await withSystemDbAccessContext(() => hasDirectM365Connection(orgId), 'callerVerification.mailboxes.directProbe')) {
    const result = await invokeDirect(orgId, 'get_user_mailboxes', {
      userId: subject.entraOid, expectedTenantId: subject.entraTenantId });
    if (result.kind !== 'ok') throw new Error(result.code);
    return result.data;
  }
  const [readConnection] = await withSystemDbAccessContext(() => db.select({ id: m365Connections.id }).from(m365Connections)
    .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'customer-graph-read'))).limit(1));
  if (readConnection) return executeM365MailboxReadByOrg(orgId, subject, userId);
  const connections = await withSystemDbAccessContext(() => db.select().from(delegantM365Connections).where(and(
    eq(delegantM365Connections.orgId, orgId), eq(delegantM365Connections.status, 'active'),
    eq(delegantM365Connections.m365TenantId, subject.entraTenantId))));
  if (connections.length !== 1) throw new Error('mailbox_connection_ambiguous_or_missing');
  const connection = connections[0]!;
  if(connection.orgId !== orgId || connection.m365TenantId !== subject.entraTenantId) throw new Error('tenant_mismatch');
  const result = await invokeDelegantTool({ connection, toolName: 'get_user_mailboxes',
    parameters: { userId: subject.entraOid, expectedTenantId: subject.entraTenantId },
    actingUser: { breezeUserId: userId, delegantPrincipalId: process.env.DELEGANT_ACTING_USER_ID ?? '' },
    agent: { delegantPrincipalId: process.env.DELEGANT_AGENT_ID ?? '' },
    sessionId: `caller-verification:${randomUUID()}` }, { env });
  if (result.kind !== 'ok') throw new Error(result.code);
  return result.data;
}
```

Reader attribution is request-local async state, not a mutable module-level user ID. It works in the headless gate because the gate has `technicianUserId`; it does not synthesize auth or trust a new public actor field. The broker session string is an audit correlation for this internal read, not an invented interactive session or step-up grant. Preserve static Delegant principal IDs exactly as the existing client does.

In `delegantClient.ts`, import `m365ReadActionSchema` and `M365_READ_ACTION_FIELDS`. At the beginning of `invokeDelegantTool`, before JWT minting, add:

```ts
if (args.toolName === 'get_user_mailboxes') {
  const action = m365ReadActionSchema.safeParse({ type: 'm365.user.mailboxes', userId: args.parameters.userId });
  if (!action.success || args.parameters.expectedTenantId !== args.connection.m365TenantId) {
    return { kind: 'error', code: 'bad_request', message: 'Mailbox subject does not match the connection.' };
  }
}
```

After `result = await mapResponse(resp)`, add projection only for the mailbox tool:

```ts
if (args.toolName === 'get_user_mailboxes' && result.kind === 'ok') {
  const raw = result.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    result = { kind: 'error', code: 'tool_error', message: 'Unexpected mailbox response.' };
  } else {
    const data = raw as Record<string, unknown>;
    result = { ...result, data: Object.fromEntries(M365_READ_ACTION_FIELDS['m365.user.mailboxes']
      .filter(key => key in data).map(key => [key, data[key]])) };
  }
}
```

The wire contract remains `{ toolName: 'get_user_mailboxes', parameters: { userId, expectedTenantId } }` at `/v1/tools/invoke`. The external broker must implement an OID-only `/users/{userId}?$select=id,userPrincipalName,mail,proxyAddresses` read against its verified connection tenant and return the four fields. This repository contains no broker server, so do not pretend this client edit deploys one. Unsupported-tool, omitted-alias, permission, connection, and transport responses refuse `subject_mailboxes_unknown`; W05 readiness requires a successful broker contract smoke test with these fields.

`mailboxes.ts`:

```ts
import { z } from 'zod';
import type { EntraSubject } from './types';
import { fetchMailboxResourceByOrg } from '../aiToolsM365';
const mailboxResource = z.object({ id: z.string().guid(), userPrincipalName: z.string().min(1),
  mail: z.string().nullable(), proxyAddresses: z.array(z.string()) });
export async function fetchTargetMailboxes(orgId: string, subject: EntraSubject): Promise<Set<string>> {
  const row = mailboxResource.parse(await fetchMailboxResourceByOrg(orgId, subject));
  if (row.id.toLowerCase() !== subject.entraOid.toLowerCase()) throw new Error('subject_mailboxes_unknown');
  return new Set([row.userPrincipalName, ...(row.mail === null ? [] : [row.mail]),
    ...row.proxyAddresses.filter(value => /^(?:SMTP|smtp):/.test(value)).map(value => value.slice(5)),
  ].map(value => value.toLowerCase()));
}
```

Wire the W01 ports rather than bypassing its mailbox prefetch. In `ports.ts`, replace the unavailable `mailboxes` default with:

```ts
mailboxes: async ({orgId,target}) => {
  const { fetchTargetMailboxes } = await import('./mailboxes');
  return [...await fetchTargetMailboxes(orgId,target)];
},
```

In `gate.ts`, import `withMailboxReader` from `../aiToolsM365` and replace only `await ports.mailboxes({orgId:input.orgId,target:input.target})` with:

```ts
await withMailboxReader(input.technicianUserId,
  () => ports.mailboxes({orgId:input.orgId,target:input.target}))
```

Keep W01's surrounding normalization/hash pipeline and catch-to-`mailboxHashes=null` unchanged. It prefetches outside a DB scope and then rechecks candidates under subject locks. Only an email candidate requires a known mailbox set; a Graph outage must not invalidate a usable SMS or workstation grant. W01's existing email branch converts null to `reason='subject_mailboxes_unknown'` and its `refuse` helper constructs the exact cross-wave error payload. Query the target OID, including a manager-authorized disable of another person. Export `fetchTargetMailboxes` from `index.ts`. The adapter does not widen authenticated tools: only the existing gate supplies the technician reader context after its authorization/policy checks.

- [ ] **Step 4: Run to pass**

Run: `cd apps/api && npx vitest run src/services/callerVerification/mailboxes.test.ts src/services/callerVerification/gate.test.ts src/services/aiToolsM365.test.ts src/services/delegantClient.test.ts src/services/m365ControlPlane/readActionService.test.ts`.
Expected: normalization failures never become empty sets; existing tool routing unaffected. Preserve W01 gate tests for email aliases and add the real fetcher mock to its existing dependency seam, asserting `reason:'subject_mailboxes_unknown'` and no consumption when `fetchTargetMailboxes` rejects.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delegantClient.ts apps/api/src/services/delegantClient.test.ts apps/api/src/services/aiToolsM365.ts apps/api/src/services/aiToolsM365.test.ts apps/api/src/services/callerVerification/mailboxes.ts apps/api/src/services/callerVerification/mailboxes.test.ts apps/api/src/services/callerVerification/gate.ts apps/api/src/services/callerVerification/gate.test.ts apps/api/src/services/callerVerification/index.ts apps/api/src/services/callerVerification/ports.ts
git commit -m "feat(caller-verification): resolve target mailbox sets across M365 backends"
```

### Task 12: Public-card copy in all eight locales

**Files:**
- Create: `apps/web/src/locales/en/callerVerification.json`, `apps/web/src/locales/de-DE/callerVerification.json`, `apps/web/src/locales/es-419/callerVerification.json`, `apps/web/src/locales/fr-CA/callerVerification.json`, `apps/web/src/locales/fr-FR/callerVerification.json`, `apps/web/src/locales/it-IT/callerVerification.json`, `apps/web/src/locales/pt-BR/callerVerification.json`, `apps/web/src/locales/tr-TR/callerVerification.json`.
- Create: `apps/web/src/lib/i18n/callerVerification.test.ts`.
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts:15` (seven baseline objects; inventory equality at `:771`).

**Interfaces:**
- Consumes: automatic catalog discovery in `apps/web/src/lib/i18n/index.ts:19` and interpolation parity in `localeParity.test.ts`.
- Produces: `callerVerification` namespace's `public` object used by Task 13; W04 can add technician-facing keys without replacing it.

- [ ] **Step 1: Write the failing catalog test**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const locales = ['en','de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR'];
it.each(locales)('%s supplies request-confirmation and independent callback copy', locale => {
  const file = new URL(`../../locales/${locale}/callerVerification.json`, import.meta.url);
  const messages = JSON.parse(readFileSync(file, 'utf8')).public;
  expect(messages.request).toContain('{{technician}}');
  expect(messages.request).toContain('{{partner}}');
  expect(messages.reset_password).toContain('{{target}}');
  expect(messages.disable_user).toContain('{{target}}');
  expect(messages.caution).toContain('{{partner}}');
  expect(messages.caution.length).toBeGreaterThan(35);
  expect(messages.notMe.length).toBeGreaterThan(3);
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/web && npx vitest run src/lib/i18n/callerVerification.test.ts`.
Expected: catalog files missing.

- [ ] **Step 3: Write the catalogs and baseline registrations**

Each block below is the complete initial file for its named locale. If W04 has landed additional keys, merge this `public` object rather than overwriting its namespace. Keep interpolation names identical.

`en/callerVerification.json`:

```json
{ "public": {
  "title": "Review a support request", "loading": "Loading request…", "hello": "Hello, {{name}}",
  "request": "{{technician}} from {{partner}} wants to:",
  "reset_password": "Reset the password for {{target}}", "disable_user": "Disable the account for {{target}}",
  "any": "Confirm a support request for {{target}}", "target": "the requested account", "provider": "your support provider",
  "reverse": "Request code", "choose": "Tap the number your technician asks you to select. Never read a code back.",
  "notMe": "This is not me", "caution": "Only tap a number if you are on the phone with {{technician}} right now. If you are not sure, hang up and call {{partner}} on the number you already have.",
  "expires": "Expires in {{seconds}} seconds", "expired": "This request is unavailable or has expired.",
  "received": "Your response has been received.", "failed": "Could not send your response. Please try again.",
  "loadFailed": "Could not load the request. Please try again.", "retry": "Try again", "sending": "Sending…"
} }
```

`de-DE/callerVerification.json`:

```json
{ "public": {
  "title": "Supportanfrage prüfen", "loading": "Anfrage wird geladen…", "hello": "Hallo {{name}}",
  "request": "{{technician}} von {{partner}} möchte:",
  "reset_password": "Das Passwort für {{target}} zurücksetzen", "disable_user": "Das Konto von {{target}} deaktivieren",
  "any": "Eine Supportanfrage für {{target}} bestätigen", "target": "das betreffende Konto", "provider": "Ihren Supportanbieter",
  "reverse": "Anfragecode", "choose": "Tippen Sie auf die Zahl, die Ihnen Ihr Techniker nennt. Lesen Sie niemals einen Code vor.",
  "notMe": "Das bin nicht ich", "caution": "Tippen Sie nur auf eine Zahl, wenn Sie gerade mit {{technician}} telefonieren. Wenn Sie unsicher sind, legen Sie auf und rufen Sie {{partner}} unter der Ihnen bereits bekannten Nummer an.",
  "expires": "Läuft in {{seconds}} Sekunden ab", "expired": "Diese Anfrage ist nicht verfügbar oder abgelaufen.",
  "received": "Ihre Antwort wurde empfangen.", "failed": "Ihre Antwort konnte nicht gesendet werden. Bitte versuchen Sie es erneut.",
  "loadFailed": "Die Anfrage konnte nicht geladen werden. Bitte versuchen Sie es erneut.", "retry": "Erneut versuchen", "sending": "Wird gesendet…"
} }
```

`es-419/callerVerification.json`:

```json
{ "public": {
  "title": "Revisa una solicitud de soporte", "loading": "Cargando solicitud…", "hello": "Hola, {{name}}",
  "request": "{{technician}}, de {{partner}}, quiere:",
  "reset_password": "Restablecer la contraseña de {{target}}", "disable_user": "Deshabilitar la cuenta de {{target}}",
  "any": "Confirmar una solicitud de soporte para {{target}}", "target": "la cuenta indicada", "provider": "tu proveedor de soporte",
  "reverse": "Código de la solicitud", "choose": "Toca el número que te indique tu técnico. Nunca leas un código en voz alta.",
  "notMe": "No soy yo", "caution": "Toca un número solo si estás hablando por teléfono con {{technician}} en este momento. Si tienes dudas, cuelga y llama a {{partner}} al número que ya tienes.",
  "expires": "Vence en {{seconds}} segundos", "expired": "Esta solicitud no está disponible o ya venció.",
  "received": "Recibimos tu respuesta.", "failed": "No se pudo enviar tu respuesta. Inténtalo de nuevo.",
  "loadFailed": "No se pudo cargar la solicitud. Inténtalo de nuevo.", "retry": "Intentar de nuevo", "sending": "Enviando…"
} }
```

`fr-CA/callerVerification.json`:

```json
{ "public": {
  "title": "Vérifier une demande de soutien", "loading": "Chargement de la demande…", "hello": "Bonjour {{name}}",
  "request": "{{technician}}, de {{partner}}, souhaite :",
  "reset_password": "Réinitialiser le mot de passe de {{target}}", "disable_user": "Désactiver le compte de {{target}}",
  "any": "Confirmer une demande de soutien pour {{target}}", "target": "le compte concerné", "provider": "votre fournisseur de soutien",
  "reverse": "Code de la demande", "choose": "Touchez le numéro indiqué par votre technicien. Ne lisez jamais un code à voix haute.",
  "notMe": "Ce n’est pas moi", "caution": "Touchez un numéro seulement si vous êtes au téléphone avec {{technician}} en ce moment. En cas de doute, raccrochez et appelez {{partner}} au numéro que vous avez déjà.",
  "expires": "Expire dans {{seconds}} secondes", "expired": "Cette demande n’est pas disponible ou a expiré.",
  "received": "Votre réponse a été reçue.", "failed": "Impossible d’envoyer votre réponse. Veuillez réessayer.",
  "loadFailed": "Impossible de charger la demande. Veuillez réessayer.", "retry": "Réessayer", "sending": "Envoi en cours…"
} }
```

`fr-FR/callerVerification.json`:

```json
{ "public": {
  "title": "Vérifier une demande d’assistance", "loading": "Chargement de la demande…", "hello": "Bonjour {{name}}",
  "request": "{{technician}}, de {{partner}}, souhaite :",
  "reset_password": "Réinitialiser le mot de passe de {{target}}", "disable_user": "Désactiver le compte de {{target}}",
  "any": "Confirmer une demande d’assistance pour {{target}}", "target": "le compte concerné", "provider": "votre prestataire d’assistance",
  "reverse": "Code de la demande", "choose": "Appuyez sur le numéro indiqué par votre technicien. Ne lisez jamais un code à voix haute.",
  "notMe": "Ce n’est pas moi", "caution": "Appuyez sur un numéro uniquement si vous êtes au téléphone avec {{technician}} en ce moment. En cas de doute, raccrochez et appelez {{partner}} au numéro que vous possédez déjà.",
  "expires": "Expire dans {{seconds}} secondes", "expired": "Cette demande est indisponible ou a expiré.",
  "received": "Votre réponse a bien été reçue.", "failed": "Impossible d’envoyer votre réponse. Veuillez réessayer.",
  "loadFailed": "Impossible de charger la demande. Veuillez réessayer.", "retry": "Réessayer", "sending": "Envoi en cours…"
} }
```

`it-IT/callerVerification.json`:

```json
{ "public": {
  "title": "Controlla una richiesta di assistenza", "loading": "Caricamento della richiesta…", "hello": "Ciao {{name}}",
  "request": "{{technician}} di {{partner}} vuole:",
  "reset_password": "Reimpostare la password di {{target}}", "disable_user": "Disattivare l’account di {{target}}",
  "any": "Confermare una richiesta di assistenza per {{target}}", "target": "l’account indicato", "provider": "il tuo fornitore di assistenza",
  "reverse": "Codice della richiesta", "choose": "Tocca il numero indicato dal tecnico. Non leggere mai un codice ad alta voce.",
  "notMe": "Non sono io", "caution": "Tocca un numero solo se sei al telefono con {{technician}} in questo momento. In caso di dubbi, riaggancia e chiama {{partner}} al numero che hai già.",
  "expires": "Scade tra {{seconds}} secondi", "expired": "Questa richiesta non è disponibile o è scaduta.",
  "received": "La tua risposta è stata ricevuta.", "failed": "Impossibile inviare la risposta. Riprova.",
  "loadFailed": "Impossibile caricare la richiesta. Riprova.", "retry": "Riprova", "sending": "Invio in corso…"
} }
```

`pt-BR/callerVerification.json`:

```json
{ "public": {
  "title": "Confira uma solicitação de suporte", "loading": "Carregando solicitação…", "hello": "Olá, {{name}}",
  "request": "{{technician}}, da {{partner}}, quer:",
  "reset_password": "Redefinir a senha de {{target}}", "disable_user": "Desativar a conta de {{target}}",
  "any": "Confirmar uma solicitação de suporte para {{target}}", "target": "a conta indicada", "provider": "seu provedor de suporte",
  "reverse": "Código da solicitação", "choose": "Toque no número indicado pelo técnico. Nunca leia um código em voz alta.",
  "notMe": "Não sou eu", "caution": "Só toque em um número se estiver ao telefone com {{technician}} agora. Se tiver dúvidas, desligue e ligue para {{partner}} usando o número que você já tem.",
  "expires": "Expira em {{seconds}} segundos", "expired": "Esta solicitação não está disponível ou expirou.",
  "received": "Sua resposta foi recebida.", "failed": "Não foi possível enviar sua resposta. Tente novamente.",
  "loadFailed": "Não foi possível carregar a solicitação. Tente novamente.", "retry": "Tentar novamente", "sending": "Enviando…"
} }
```

`tr-TR/callerVerification.json`:

```json
{ "public": {
  "title": "Destek isteğini inceleyin", "loading": "İstek yükleniyor…", "hello": "Merhaba {{name}}",
  "request": "{{partner}} şirketinden {{technician}} şu işlemi yapmak istiyor:",
  "reset_password": "{{target}} hesabının parolasını sıfırlamak", "disable_user": "{{target}} hesabını devre dışı bırakmak",
  "any": "{{target}} için bir destek isteğini onaylamak", "target": "ilgili hesap", "provider": "destek sağlayıcınız",
  "reverse": "İstek kodu", "choose": "Teknisyeninizin seçmenizi istediği sayıya dokunun. Hiçbir kodu sesli olarak okumayın.",
  "notMe": "Bu ben değilim", "caution": "Yalnızca şu anda {{technician}} ile telefonda konuşuyorsanız bir sayıya dokunun. Emin değilseniz telefonu kapatın ve {{partner}} şirketini önceden bildiğiniz numaradan arayın.",
  "expires": "{{seconds}} saniye içinde sona erer", "expired": "Bu istek kullanılamıyor veya süresi dolmuş.",
  "received": "Yanıtınız alındı.", "failed": "Yanıtınız gönderilemedi. Lütfen yeniden deneyin.",
  "loadFailed": "İstek yüklenemedi. Lütfen yeniden deneyin.", "retry": "Yeniden dene", "sending": "Gönderiliyor…"
} }
```

Add `'callerVerification.json': 0,` to each non-English baseline object in `translationCoverage.test.ts`; the namespace inventory assertion requires it even when every phrase is translated. No i18n registration edit is necessary because glob discovery already handles the files.

- [ ] **Step 4: Run to pass**

Run: `cd apps/web && npx vitest run src/lib/i18n/callerVerification.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`.
Expected: eight catalog cases, identical interpolation keys and zero new English duplicates.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/*/callerVerification.json apps/web/src/lib/i18n/callerVerification.test.ts apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(i18n): translate caller confirmation card into all eight locales"
```

### Task 13: Public Astro page and accessible React card

**Files:**
- Create: `apps/web/src/pages/verify/[token].astro`.
- Create: `apps/web/src/components/callerVerification/CallerVerifyCard.tsx`, `apps/web/src/components/callerVerification/CallerVerifyCard.test.tsx`.

**Interfaces:**
- Consumes: anonymous GET/POST `/api/v1/verify/:token`, Task 12 `callerVerification` namespace, `runAction`, default `ToastContainer` from `components/shared/Toast.tsx:94`.
- Produces: `CallerVerifyCard({ token }: { token: string })`; `client:load` page matching `pages/quick.astro:1–11`, with no technician auth guard.

- [ ] **Step 1: Write failing component tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import CallerVerifyCard from './CallerVerifyCard';
const token = 'A'.repeat(43);
const card = { status: 'pending', branding: { partnerName: 'Example MSP', logoUrl: null, accentColor: null, headline: null },
  contactFirstName: 'Alex', technicianLabel: 'Taylor', actionScope: 'reset_password', targetLabel: 'alex@example.com',
  reverseCode: '7291', choices: ['83','42','17'], expiresAt: new Date(Date.now()+600_000).toISOString() };
afterEach(() => vi.unstubAllGlobals());
it('names the exact request, preserves choices, and sends a generic confirmation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(card))
    .mockResolvedValueOnce(Response.json({ status: 'received' }));
  vi.stubGlobal('fetch', fetch); render(<CallerVerifyCard token={token} />);
  expect(await screen.findByText('Taylor from Example MSP wants to:')).toBeTruthy();
  expect(screen.getByText('Reset the password for alex@example.com')).toBeTruthy();
  expect(screen.getByTestId('caller-verify-reverse').textContent).toContain('7 2 9 1');
  expect(screen.getAllByTestId('caller-verify-choice').map(el => el.textContent)).toEqual(['83','42','17']);
  await userEvent.click(screen.getAllByTestId('caller-verify-choice')[1]!);
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining(`/verify/${token}`),
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ choice: '42' }), credentials: 'omit' })));
  expect(await screen.findByTestId('caller-verify-received')).toBeTruthy();
  expect(screen.getByTestId('caller-verify-not-me')).toBeTruthy();
});
it('keeps late rejection usable on a generic expired page', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: 'expired' }))
    .mockResolvedValueOnce(Response.json({ status: 'received' }));
  vi.stubGlobal('fetch', fetch); render(<CallerVerifyCard token={token} />);
  await userEvent.click(await screen.findByTestId('caller-verify-not-me'));
  await waitFor(() => expect(fetch.mock.calls[1]?.[1].body).toBe(JSON.stringify({ choice: 'not_me' })));
});
it('exposes no challenge controls when the server flag is off', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Not found' }, { status: 404 })));
  render(<CallerVerifyCard token={token} />);
  await screen.findByTestId('caller-verify-expired');
  expect(screen.queryByTestId('caller-verify-not-me')).toBeNull();
  expect(screen.queryAllByTestId('caller-verify-choice')).toHaveLength(0);
});
it('shows a failed mutation and leaves retry possible', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(card))
    .mockRejectedValueOnce(new Error('offline')));
  render(<CallerVerifyCard token={token} />);
  await userEvent.click((await screen.findAllByTestId('caller-verify-choice'))[0]!);
  expect(await screen.findByTestId('caller-verify-error')).toBeTruthy();
  expect(screen.getAllByTestId('caller-verify-choice')[0]).not.toBeDisabled();
});
```

- [ ] **Step 2: Run to failure**

Run: `cd apps/web && npx vitest run src/components/callerVerification/CallerVerifyCard.test.tsx`.
Expected: missing card module.

- [ ] **Step 3: Implement the card and page**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { runAction } from '../../lib/runAction';
import ToastContainer from '../shared/Toast';
type Card = { status: 'pending'; branding: { partnerName: string; logoUrl: string | null;
  accentColor: string | null; headline: string | null } | null; contactFirstName: string | null;
  technicianLabel: string; actionScope: 'reset_password' | 'disable_user' | 'any'; targetLabel: string | null;
  reverseCode: string; choices: [string,string,string]; expiresAt: string };
const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();
export default function CallerVerifyCard({ token }: { token: string }) {
  const { t } = useTranslation('callerVerification');
  const [card, setCard] = useState<Card | null>(null);
  const [state, setState] = useState<'loading'|'ready'|'expired'|'disabled'|'error'>('loading');
  const [received, setReceived] = useState(false), [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now()), [retry, setRetry] = useState(0);
  const inFlight = useRef(false);
  const url = `${API_BASE}/api/v1/verify/${encodeURIComponent(token)}`;
  useEffect(() => {
    const abort = new AbortController(); setState('loading');
    void fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: abort.signal })
      .then(async response => {
        if (response.status === 404) { setState('disabled'); return; }
        if (!response.ok) throw new Error('load_failed');
        const data = await response.json();
        if (data.status !== 'pending') { setState('expired'); return; }
        setCard(data as Card); setState('ready');
      }).catch(() => { if (!abort.signal.aborted) setState('error'); });
    return () => abort.abort();
  }, [url, retry]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer); }, []);
  const seconds = card ? Math.max(0, Math.ceil((Date.parse(card.expiresAt)-now)/1000)) : 0;
  const live = state === 'ready' && seconds > 0 && !received;
  async function choose(choice: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailed(false);
    try {
      await runAction({ request: () => fetch(url, { method: 'POST', credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }) }), treatUnauthorizedAsError: true,
        errorFallback: t('public.failed'), successMessage: t('public.received'),
        friendly: () => t('public.failed') });
      setReceived(true); if (choice === 'not_me') setRejected(true);
    } catch { setFailed(true); } finally { inFlight.current = false; setBusy(false); }
  }
  const partner = card?.branding?.partnerName ?? t('public.provider');
  const safeLogo = card?.branding?.logoUrl?.startsWith('https://') ? card.branding.logoUrl : undefined;
  return <section className="space-y-5 rounded-xl border bg-card p-6" data-testid="caller-verify-card">
    <ToastContainer />
    <h2 className="text-xl font-semibold">{t('public.title')}</h2>
    {state === 'loading' && <p role="status">{t('public.loading')}</p>}
    {state === 'error' && <><p role="alert">{t('public.loadFailed')}</p>
      <button type="button" onClick={() => setRetry(n => n+1)}>{t('public.retry')}</button></>}
    {card && <>
      {safeLogo && <img src={safeLogo} alt={partner} referrerPolicy="no-referrer" className="max-h-12 max-w-full" />}
      {card.contactFirstName && <p>{t('public.hello', { name: card.contactFirstName })}</p>}
      <p>{t('public.request', { technician: card.technicianLabel, partner })}</p>
      <p className="break-words font-semibold">{t(`public.${card.actionScope}`, { target: card.targetLabel ?? t('public.target') })}</p>
      {live && <><p>{t('public.reverse')}</p>
        <p data-testid="caller-verify-reverse" className="text-center font-mono text-4xl tracking-widest">{card.reverseCode.split('').join(' ')}</p>
        <p>{t('public.choose')}</p><div className="grid grid-cols-3 gap-3">
          {card.choices.map(choice => <button key={choice} type="button" data-testid="caller-verify-choice"
            disabled={busy} onClick={() => void choose(choice)}
            className="min-h-16 rounded-lg border text-2xl font-semibold focus-visible:outline focus-visible:outline-2 disabled:opacity-50">{choice}</button>)}
        </div><p>{t('public.expires', { seconds })}</p></>}
      <p>{t('public.caution', { technician: card.technicianLabel, partner })}</p>
    </>}
    {(state === 'expired' || state === 'disabled' || (state === 'ready' && seconds === 0 && !received))
      && <p data-testid="caller-verify-expired">{t('public.expired')}</p>}
    {received && <p role="status" data-testid="caller-verify-received">{t('public.received')}</p>}
    {failed && <p role="alert" data-testid="caller-verify-error">{t('public.failed')}</p>}
    {['ready','expired'].includes(state) && !rejected && <button type="button" disabled={busy}
      data-testid="caller-verify-not-me" className="min-h-12 w-full rounded-lg border border-destructive px-4 text-destructive"
      onClick={() => void choose('not_me')}>{busy ? t('public.sending') : t('public.notMe')}</button>}
  </section>;
}
```

The retained “not me” control after a number, a local countdown expiry, or an expired GET is intentional. Its generic POST result does not promise an incident for an unknown or older-than-24-hour token. No green “verified” badge appears on this anonymous surface. The synchronous ref prevents a double click before React has rendered `disabled`.

`apps/web/src/pages/verify/[token].astro`:

```astro
---
import AuthLayout from '../../layouts/AuthLayout.astro';
import CallerVerifyCard from '../../components/callerVerification/CallerVerifyCard';
import messages from '../../locales/en/callerVerification.json';
export const prerender = false;
Astro.response.headers.set('Cache-Control', 'no-store, private');
Astro.response.headers.set('Referrer-Policy', 'no-referrer');
const token = Astro.params.token ?? '';
---
<AuthLayout title={messages.public.title}>
  <CallerVerifyCard token={token} client:load />
</AuthLayout>
```

Use the explicit i18n import like `QuickLandingPage.tsx:7`; the public layout has no Sidebar to initialize it. `AuthLayout` contributes the existing page frame; the island mounts its own toast container. No token goes into browser storage, telemetry, analytics events, or referrer headers.

- [ ] **Step 4: Run to pass**

Run: `cd apps/web && npx vitest run src/components/callerVerification/CallerVerifyCard.test.tsx src/components/quick/QuickLandingPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`.
Expected: number submission, expired rejection, flag-off and mutation-failure cases pass; Quick Support remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add 'apps/web/src/pages/verify/[token].astro' apps/web/src/components/callerVerification/CallerVerifyCard.tsx apps/web/src/components/callerVerification/CallerVerifyCard.test.tsx
git commit -m "feat(caller-verification): add public request confirmation page"
```

### Task 14: Wave verification, contract audit, and PR

**Files:**
- Create: `apps/api/src/services/callerVerification/w03.contract.test.ts`.
- Modify: only files identified by a failing W03 assertion in Tasks 1–13; no enforcement enablement, agent command, or IPC change beyond this wave’s explicit DDL.

**Interfaces:**
- Consumes: `GET /verify/:token`, `POST /verify/:token`, `fetchTargetMailboxes(orgId, subject): Promise<Set<string>>`, W01 start/applyDecision/outbox/gate contracts.
- Produces: green targeted, typecheck, contract and live suites; open PR with `Closes #<sub#>` and the readiness dependency recorded.

- [ ] **Step 1: Write the failing reachability contract**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
it('mounts the public router once and retains shared decision/gate seams', () => {
  expect(read('../../index.ts')).toContain("api.route('/verify', callerVerifyPublicRoutes)");
  const route = read('../../routes/callerVerifyPublic.ts');
  expect(route).toContain('applyDecision(');
  expect(route).toContain('withSystemDbAccessContext(');
  expect(route).toContain('no-store, private');
  expect(route).not.toContain('authMiddleware');
  expect(read('./gate.ts')).toContain('withMailboxReader(');
  expect(read('./ports.ts')).toContain('fetchTargetMailboxes(orgId,target)');
  expect(read('./service.ts')).toContain('caller-verification:start:');
});
it('delivery uses Messaging and neither public code nor audits expose token material', () => {
  const delivery = read('./deliverers/link.ts');
  expect(delivery).toContain("getTwilioService('messaging')");
  expect(delivery).not.toContain('sendVerificationCode');
  expect(delivery).toContain('applyDecision(');
  const lookup = read('./publicLookup.ts');
  const projection = lookup.slice(lookup.indexOf('export function toPublicCard'), lookup.indexOf('export interface LinkDelivery'));
  expect(projection).not.toContain('challengeTokenHash:');
  expect(projection).not.toContain('matchValue:');
});
```

- [ ] **Step 2: Observe a discriminating failure**

Run: `cd apps/api && npx vitest run src/services/callerVerification/w03.contract.test.ts`.
Expected after Tasks 1–13: pass. To demonstrate that this new test guards real wiring, remove the new `/verify` mount locally, run again expecting the mount assertion to fail, then restore the exact mount from Task 5. Do not commit the negative control.

- [ ] **Step 3: Restore the minimal implementation and typecheck**

Implementation restoration is exactly `api.route('/verify', callerVerifyPublicRoutes);`. Run from the repository root, each subshell independently:

```bash
(cd packages/shared && npx tsc --noEmit -p tsconfig.json)
(cd apps/api && npx tsc --noEmit -p tsconfig.json)
(cd apps/m365-graph-read-executor && npx tsc --noEmit -p tsconfig.json)
pnpm --filter @breeze/web typecheck
```

Do not call a nonexistent root `typecheck` script. Confirm the exhaustive executor fixture maps contain the thirteenth action. Check `rg -n 'get_user_mailboxes|m365.user.mailboxes|fetchTargetMailboxes' apps/api/src apps/m365-graph-read-executor/src packages/shared/src/m365` shows all three implementations and the gate import.

- [ ] **Step 4: Run targeted and standing contracts to pass**

```bash
(cd apps/api && npx vitest run src/services/callerVerification src/routes/callerVerifyPublic.test.ts src/services/supportCodeMissBudget.test.ts src/routes/supportPublic.test.ts src/services/email.callerVerification.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/m365DirectGraph.test.ts src/services/delegantClient.test.ts src/services/aiToolsM365.test.ts src/services/m365ControlPlane/readActionService.test.ts)
(cd packages/shared && npx vitest run src/m365/readActions.test.ts)
(cd apps/m365-graph-read-executor && npx vitest run src/microsoft/readActions.test.ts src/operations.test.ts)
(cd apps/web && npx vitest run src/components/callerVerification/CallerVerifyCard.test.tsx src/lib/i18n/callerVerification.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
```

Read the reported test-file counts. Unit configuration must exclude the co-located live route suite. The W01 service/gate tests must execute, not be silently absent. Run `src/services/callerVerification/linkPorts.test.ts` and the live publisher path in Task 7; the companion W01 plan defines `publishCallerVerificationEffects` in `jobs/callerVerificationPublisher.ts`.

- [ ] **Step 5: Run live DB and tenancy contracts**

```bash
pnpm test-stack up
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/callerVerifyPublic.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.config.integration-suite-coverage.ts src/__tests__/integration/integration-suite-coverage.integration.test.ts)
pnpm test-stack down
```

Run `pnpm db:check-drift` against the migrated test stack before teardown. Expected: every named suite runs with nonzero tests; the public suite has eight cases; RLS remains enabled+forced; no device/ticket snapshot-name discovery; all columns remain export-classified. Always tear down in a shell `trap` or `finally` if a command fails. Do not enable the production flag to run tests. The live rejection case requires W01's incident behavior and is a hard dependency failure if that implementation is only a stub.

- [ ] **Step 6: Commit and open the implementation PR**

```bash
ls apps/api/migrations | sort | tail -1
git diff --check
git add apps/api/src/services/callerVerification/w03.contract.test.ts
git commit -m "test(caller-verification): pin W03 public delivery and mailbox wiring"
git push -u origin HEAD
```

Use the resolved tracking numbers, with the branch exactly `feature/<parent#>-caller-verification/wave-<sub#>`. Write the PR description to `/tmp/caller-verification-w03-pr.md` during implementation and run `gh pr create --base main --title "feat(caller-verification): links, public confirmation, and mailbox reads" --body-file /tmp/caller-verification-w03-pr.md`. Body must include `Closes #<sub#>`, the spec/plan links, the exact executed test commands and results, and these concrete scope notes: readiness stays false; public choice outcomes are opaque; late rejection fences synchronously; W01 owns outbox delivery; Delegant broker support is a W05 activation prerequisite. Do not claim an external broker deployment or full W05 incident fan-out shipped here. Stop at an open PR; no merge or issue closure command belongs to this wave plan.

## Self-review

**Spec coverage.** Link token and asynchronous delivery → Tasks 1–3. D2 exact technician/action/target, reverse code, three stable candidates, rejection and independent callback script → Tasks 5, 12–13. Public route scope, readiness, no-store, rate limits and two-tier miss budget → Tasks 4–6. One-winner CAS, late rejection and incident idempotency → Task 7. Dedicated four-field mailbox action across direct Graph, control plane and Delegant → Tasks 8–11. Gate fetcher and failure-to-`subject_mailboxes_unknown` → Task 11. All wave checks and PR → Task 14.

**Contract consistency.** No table, enum, route, command or IPC rename. W01 service signatures are retained; `fetchTargetMailboxes(orgId, subject): Promise<Set<string>>` is the W03 addition. New private adapter names are explicitly defined here, not attributed to nonexistent source. `getTwilioService('messaging')` and `sendSmsMessage(phoneNumber,message,options?)` are the real Twilio path. The email helper reuses `renderLayout`, not a guessed template API. The flag remains off.

**Verified discrepancies.** There is no current W01 product implementation or generic after-commit hook; the companion plan defines row-backed publication and explicit ports. Task 1 closes its absent token/order persistence with a forward migration. Existing ticket/intent outboxes cannot substitute for it. There is no partner-specific application-domain column or resolver; configured `PUBLIC_WEB_URL` supplies the deployment's application origin. The original schema has no choice-order column; Task 1 adds a sensitive array and GET reads that stored tuple. `aiToolsM365` has two existing backend arms, with control-plane reads separate; this plan adds the three-way mailbox-only dispatcher. The Delegant broker is external, so unsupported mailbox reads fail closed until it is upgraded.

**Review rationale retained.** Late rejection is not blocked by a pending/expiry precheck; public number matching does not establish technician identity; aliases come from the pinned target OID; missing alias data never becomes an empty success; provider success never approves a grant; current destination hash prevents a delayed worker from sending to a replacement address; a counted SQL-update probe detects last-writer-wins; separate Redis namespaces prevent caller traffic from exhausting Quick Support.

**Execution limits.** This is an implementation plan, not a report of tests run or code deployed. All new interfaces, files and commands have explicit tasks. The only cross-wave missing artifacts are identified as W01 prerequisites; their source lines cannot honestly be supplied before W01 lands. The document-writing change touches only this plan and leaves the index and companion wave plans unchanged.
