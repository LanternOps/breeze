---
tracking_issue: LanternOps/breeze#6180
---
# Partner Sending Domains W01: Sender Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outbound email in the API declares *what it is* (`purpose`) instead of *who it is from* (`from`). One reviewable registry, `MAIL_PURPOSES`, classifies all 27 production send sites into the platform lane or a partner stream; `resolveSender` turns a purpose into a From address; `EmailService.deliverRaw` becomes the single raw entry point W02's `static`/`fake` adapters will use. **Nothing about any rendered email changes** — From, Reply-To, headers, recipients and body are byte-identical to today under `EMAIL_PROVIDER` = `resend`, `smtp` and `mailgun`, proved by a golden test over every purpose × every provider.

**Architecture:** Two new files under `apps/api/src/services/emailDomains/`. `mailPurposes.ts` is a declarative `as const satisfies Record<string, MailPurposePolicy>` registry plus the derived `MailPurpose` / `PartnerLaneMailPurpose` / `PlatformMailPurpose` types — the compile-time guard for spec G5 ("an unclassified send does not compile"). `senderResolution.ts` owns the pure sender logic: `fromWithDisplayName` (moved verbatim off `EmailService`, now a pure function over `defaultFrom`), `platformFallbackFrom` (the purpose's fallback From — `default` or `"<Partner> via Breeze"`), and `resolveSender`, which in W01 **always** returns the platform lane with reason `platform_purpose` | `no_partner` | `lane_unconfigured` and performs **no database access at all**. `services/email.ts` splits in two: `deliverRaw(message: RawEmailMessage)` holds today's transport bodies verbatim with an explicit `from`, and `sendEmail(params: SendEmailParams)` becomes resolve → `deliverRaw`. Call sites are migrated in cohorts behind a transitional type (optional `purpose`, `from` still accepted) so the repo compiles and its tests stay green after every task; the last code task flips `purpose` to required and deletes `from`.

**Tech Stack:** TypeScript (Hono API), Vitest (unit only — W01 adds no migration, no schema, no route, no integration suite), `tsc --noEmit` over `apps/api/tsconfig.json`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md` §8.1 (the `purpose` contract), §8.2 (classification of today's send sites — normative), §8.3 (the fallback-From half only; the partner branch is W04), §14 (the "W01 golden test" bullet, the `sendEmail` bullet's fallback assertions, the registry property tests), §15 row W01. Plan index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md` — amendments 2, 4, 5, 6 and the "Defined in W01" contract block.

---

## Plan amendments

Deviations from, and corrections to, the spec's §8.2 table and the index's W01 contract block. Each was verified against the code on 2026-09-17.

1. **§8.2 misses one send site: `routes/auth/verifyEmail.ts:201`.** The table's `routes/auth/verifyEmail.ts` row lists only `auth.email_verification`, and attributes `auth.email_changed` solely to `routes/users.ts`. But `verifyEmail.ts:201` calls `emailService.sendEmailChanged({ to: previousEmail, newEmail: result.email, pending: false })` — the completion notice to the abandoned address. Classified by the §8.2 rules as **platform** (`auth.email_changed`): it is account-recovery-class mail to an MSP staff mailbox. It needs no call-site edit because `sendEmailChanged` hard-codes its purpose (Task 4).

2. **§8.2 splits `jobs/ticketNotifyWorker.ts` into two rows, but there is exactly ONE `sendEmail` call.** Both audiences are collected into a single `EmailPayload[]` and sent by one loop at `ticketNotifyWorker.ts:589`. W01 therefore makes `EmailPayload` itself a discriminated union carrying `purpose` (and, on the customer branch, `partnerId`), and the send loop branches on it. The classification is unchanged: assignee/SLA payloads are `ticket.staff_notification` (platform), requester/autoresponse payloads are `ticket.customer_notification` (partner / `support`).

3. **`fromWithDisplayName(defaultFrom, displayName)` is exported from `senderResolution.ts`.** The index's contract block lists only `resolveSender` and `platformFallbackFrom`. Exporting the pure helper as well is additive and is needed to keep one existing assertion alive: `email.test.ts`'s "falls back to the default sender when the name is empty after sanitizing" case is unreachable through `platformFallbackFrom`, because that function appends `" via Breeze"` to the partner name, so the sanitized display name is never empty.

4. **`SendEmailBase` is exported.** The index shows `interface SendEmailBase` without `export`. The golden test builds one shared message object typed as `SendEmailBase`, and W02's `PartnerLaneMessage = RawEmailMessage` reads better with the base visible. Export is additive; no name changes.

5. **Two partner-lane sites pass `partnerId: null` in W01**, which the spec explicitly allows (§8.1: "`null` resolves to the platform sender, for call sites that cannot always resolve a partner"), because neither has a partner id in hand and W01 adds no database reads:
   - `routes/portal/auth.ts:594` (`portal.password_reset`) — the `portalUsers` row it read selects `id, email, orgId, authMethod`; the partner is one join away.
   - `services/reportDelivery.ts:141` (`report.delivery`) — `emailReportRun` takes only email-address strings, a branding bag and a timezone ("touch no db handle", per its own module docstring); neither caller (`jobs/reportScheduleWorker.ts:605`, `services/reportNarrativeDelivery.ts:275`) holds a partner id either.
   W04 is the wave that decides whether to widen those reads; until then both correctly resolve to the platform sender.

6. **Amendment 6 of the index is confirmed and pinned.** The Mailgun branch drops `cc`: `sendViaMailgun` *supports* `cc` (`services/email.ts:736`, `:755`, `:783`) but `sendEmail`'s Mailgun call at `services/email.ts:275-284` never passes it. `deliverRaw` keeps that omission verbatim and the golden test asserts `body.getAll('cc')` is empty on Mailgun while Resend and SMTP receive the `cc`.

7. **`reportDelivery.snapshot.test.ts` has six whole-envelope snapshots that will change.** `pinnable()` spreads the entire `sendEmail` params object, so adding `purpose` and `partnerId` rewrites `apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap`. Both `reportDelivery.ts` send sites are therefore migrated in the *same* task (Task 7) so the snapshot is regenerated exactly once and no task leaves that file red.

---

## Global Constraints

- **No rendered email changes.** From, Reply-To, To/Cc, headers and bodies are byte-identical to today under each `EMAIL_PROVIDER` (`resend`, `smtp`, `mailgun`). This is the wave's acceptance criterion (spec §15 row W01) and the golden test is its proof.
- **No database read anywhere in W01.** `resolveSender` returns the platform lane for every input; the partner branch (and its read) is W04. No call site may gain a query to supply `partnerId` — pass `null` and record it (spec §8.1).
- **No new env var.** W01 reads no new configuration; `config/env.ts` and `config/validate.ts` are untouched (spec G7: "no new required env var, no boot refusal").
- **No migration, no schema, no route, no worker.** W01 is types and call sites only. The index reserves no migration slot for it.
- Branch `feature/6180-partner-sending-domains/wave-6181`; PR body contains `Closes #6181`. `get_feature_status` before starting.
- Test command form: `cd apps/api && npx vitest run <path>` — never `pnpm --filter … test -- --run <path>` (it runs the whole suite; CLAUDE.md "Two traps"). Vitest path filters are plain substrings, so list sibling files explicitly.
- Typecheck command (what CI's `typecheck` job runs, from the repo root): `pnpm exec tsc --noEmit --project apps/api/tsconfig.json`. `apps/api/tsconfig.json` has `"include": ["src/**/*"]`, so **test files are type-checked** — a test that constructs `SendEmailParams` must compile.
- Rigor is **low/medium** for this wave (index "Rules every wave inherits": W01 is wide but low-risk): red first on every task, typecheck, affected tests, then the full `apps/api` unit suite before the PR. No RLS or integration contract suite is needed — W01 adds no table and no DB access.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

**Why this task order.** Removing `from` and requiring `purpose` breaks all 27 call sites in one edit, which is unreviewable and leaves the repo red for several tasks. So Tasks 1–3 add the registry, the resolver and `deliverRaw` behind a *transitional* `SendEmailParams` (optional `purpose`, `from` still accepted); Tasks 4–7 migrate call sites in cohorts grouped by which test files they redden; Task 8 flips `purpose` to required and deletes `from`, which the compiler then proves is complete. The repo compiles and its tests pass after every single task.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/emailDomains/mailPurposes.ts` (+ `.test.ts`) | `MAIL_PURPOSES`, `MailPurpose`, `PartnerLaneMailPurpose`, `PlatformMailPurpose`, `mailPurposePolicy` (Task 1) |
| `apps/api/src/services/emailDomains/senderResolution.ts` (+ `.test.ts`) | `fromWithDisplayName`, `platformFallbackFrom`, `resolveSender`, `ResolvedSender`, `PlatformLaneReason` (Task 2) |
| `apps/api/src/services/email.ts` | `SendEmailBase`, `RawEmailMessage`, `deliverRaw`, `sendEmail` = resolve → deliver, named-helper purposes (Tasks 3, 4, 8) |
| `apps/api/src/services/email.golden.test.ts` | every purpose × `resend`/`smtp`/`mailgun`: From, Reply-To, headers, cc pinned (Task 3) |
| `jobs/authEmailWorker.ts`, `routes/auth/verifyEmail.ts`, `routes/users.ts`, `routes/portal/auth.ts`, `routes/orgPortalUsers.ts` | named-helper call sites (Task 4) |
| `jobs/aiBudgetAlertDelivery.ts`, `jobs/mfaEnrollmentNotice.ts`, `modules/mcpInvites/tools/sendDeploymentInvites.ts`, `routes/auth/accountDeletion.ts`, `services/aiToolsGoogle.ts`, `services/contractRenewal.ts`, `services/opsAlerts.ts`, `services/quoteOutcomeNotify.ts`, `services/tenantOffboarding.ts` | direct platform-lane `sendEmail` sites (Task 5) |
| `apps/api/src/jobs/ticketNotifyWorker.ts` | `EmailPayload` discriminated union + per-payload purpose (Task 6) |
| `services/reportDelivery.ts`, `services/quoteLifecycle.ts`, `services/invoicePdf.ts` (+ their pinned tests and snapshot) | customer-facing sends (Task 7) |
| `apps/api/src/services/email.test.ts`, `apps/api/src/services/email.headers.test.ts` | updated for the required `purpose` and the removed `fromWithDisplayName` (Tasks 2, 8) |
| `apps/api/src/services/email.deliverRawScope.test.ts` | source scan: `deliverRaw(` appears nowhere outside `services/email.ts` and `services/emailDomains/` (Task 9) |
| `apps/api/src/services/emailDomains/mailPurposes.callSites.test.ts` | source scan: no dead registry entries (Task 9) |

---

### Task 1: The `MAIL_PURPOSES` registry

**Files:**
- Create: `apps/api/src/services/emailDomains/mailPurposes.ts`
- Create: `apps/api/src/services/emailDomains/mailPurposes.test.ts` (Test)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type PartnerMailStream = 'support' | 'billing' | 'general';
  export type MailPurposePolicy =
    | { lane: 'platform' }
    | { lane: 'partner'; stream: PartnerMailStream; fallbackFrom: 'default' | 'partner_display_name' };
  export const MAIL_PURPOSES: { readonly [k: string]: MailPurposePolicy };
  export type MailPurpose = keyof typeof MAIL_PURPOSES;
  export type PartnerLaneMailPurpose = ...;
  export type PlatformMailPurpose = Exclude<MailPurpose, PartnerLaneMailPurpose>;
  export function mailPurposePolicy(purpose: MailPurpose): MailPurposePolicy;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/emailDomains/mailPurposes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MAIL_PURPOSES,
  mailPurposePolicy,
  type MailPurpose,
  type PartnerMailStream,
} from './mailPurposes';

const ALL_PURPOSES = Object.keys(MAIL_PURPOSES) as MailPurpose[];
const STREAMS: PartnerMailStream[] = ['support', 'billing', 'general'];

describe('MAIL_PURPOSES registry (spec §8.1, §8.2)', () => {
  it('classifies every purpose into exactly one well-formed lane', () => {
    expect(ALL_PURPOSES.length).toBeGreaterThan(0);
    for (const purpose of ALL_PURPOSES) {
      const policy = mailPurposePolicy(purpose);
      if (policy.lane === 'platform') {
        expect(Object.keys(policy)).toEqual(['lane']);
        continue;
      }
      expect(policy.lane).toBe('partner');
      expect(STREAMS).toContain(policy.stream);
      expect(['default', 'partner_display_name']).toContain(policy.fallbackFrom);
    }
  });

  it('mailPurposePolicy returns the registry entry itself, not a copy', () => {
    for (const purpose of ALL_PURPOSES) {
      expect(mailPurposePolicy(purpose)).toBe(MAIL_PURPOSES[purpose]);
    }
  });

  // Spec §8.2 is normative. Pinning the exact classification here makes the
  // review artefact (the table) a test, not a comment: a later wave that wants
  // to move mail onto a partner's domain has to edit this list on purpose.
  it('pins the §8.2 classification of every purpose', () => {
    expect(MAIL_PURPOSES).toEqual({
      'auth.password_reset': { lane: 'platform' },
      'auth.email_verification': { lane: 'platform' },
      'auth.email_change_verify': { lane: 'platform' },
      'auth.email_changed': { lane: 'platform' },
      'auth.signup_existing_account': { lane: 'platform' },
      'auth.staff_invite': { lane: 'platform' },
      'auth.account_locked': { lane: 'platform' },
      'security.mfa_enrollment': { lane: 'platform' },
      'account.deletion_requested': { lane: 'platform' },
      'account.deletion_declined': { lane: 'platform' },
      'account.purge_warning': { lane: 'platform' },
      'ops.alert': { lane: 'platform' },
      'staff.ai_budget_alert': { lane: 'platform' },
      'staff.contract_renewal': { lane: 'platform' },
      'staff.quote_outcome': { lane: 'platform' },
      'staff.alert_notification': { lane: 'platform' },
      'staff.workspace_drift_report': { lane: 'platform' },
      'staff.report_failure': { lane: 'platform' },
      'deployment.invite': { lane: 'platform' },
      'ticket.staff_notification': { lane: 'platform' },
      'ticket.customer_notification': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'portal.invite': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'portal.password_reset': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
      'quote.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
      'invoice.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
      'report.delivery': { lane: 'partner', stream: 'general', fallbackFrom: 'default' },
    });
  });

  // Spec §8.3: the display-name From is what quote and invoice sends produce
  // TODAY, and nothing else. Extending it to more purposes is a separate
  // product change, so it must not happen by accident in a later wave.
  it('uses the partner_display_name fallback only for quote.sent and invoice.sent', () => {
    const branded = ALL_PURPOSES.filter((p) => {
      const policy = mailPurposePolicy(p);
      return policy.lane === 'partner' && policy.fallbackFrom === 'partner_display_name';
    });
    expect(branded.sort()).toEqual(['invoice.sent', 'quote.sent']);
  });

  // Index amendment 5: the test send bypasses sendEmail entirely and
  // staff.sending_domain_status arrives with its send site in W03. Neither
  // may be added here early, or the "no dead entries" scan (Task 9) fails.
  it('does not carry W03-owned or tag-only purposes', () => {
    expect(ALL_PURPOSES).not.toContain('staff.sending_domain_status');
    expect(ALL_PURPOSES).not.toContain('sending_domain.test');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/mailPurposes.test.ts
```

Expected failure: `Failed to load .../mailPurposes.test.ts` … `Cannot find module './mailPurposes'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/emailDomains/mailPurposes.ts`:

```ts
/**
 * The mail-purpose registry (partner sending domains, spec §8.1/§8.2).
 *
 * Every outbound email declares WHAT IT IS; this one file decides who it is
 * FROM. That inversion is the point: the classification becomes a single
 * reviewable list instead of a `from:` argument scattered across 27 call
 * sites, platform purposes short-circuit before any lookup, and the purpose
 * doubles as the delivery-event tag in W06.
 *
 * Adding a purpose is a product decision, not a mechanical one. The rules
 * (spec §8.2):
 *   - Mail from Breeze to the PARTNER'S OWN STAFF stays on the platform
 *     sender. Account recovery must never depend on the partner's DNS, and
 *     staff mailboxes usually live on the very domain being sent from.
 *   - Customer-facing mail goes on a partner stream.
 *   - Agent-deployment invites stay on the platform sender: they carry
 *     installer links to arbitrary typed addresses, which is exactly the
 *     shape hosted abuse takes, so the recipient must see Breeze's name and
 *     abuse contact.
 *
 * This module imports nothing. It must stay free of the db, config and
 * transport layers so a platform purpose can be resolved with no I/O.
 */

export type PartnerMailStream = 'support' | 'billing' | 'general';

export type MailPurposePolicy =
  | { lane: 'platform' }
  | {
      lane: 'partner';
      stream: PartnerMailStream;
      /**
       * The From used when no partner identity applies — which in W01 is
       * ALWAYS. It preserves what each send site does TODAY:
       *   'default'              → the bare EMAIL_FROM.
       *   'partner_display_name' → `"<Partner> via Breeze" <EMAIL_FROM address>`.
       * Only quote.sent and invoice.sent, the two sites that do this now.
       */
      fallbackFrom: 'default' | 'partner_display_name';
    };

export const MAIL_PURPOSES = {
  // ---- platform lane: auth and account recovery ---------------------------
  'auth.password_reset': { lane: 'platform' },
  'auth.email_verification': { lane: 'platform' },
  'auth.email_change_verify': { lane: 'platform' },
  'auth.email_changed': { lane: 'platform' },
  'auth.signup_existing_account': { lane: 'platform' },
  'auth.staff_invite': { lane: 'platform' },
  'auth.account_locked': { lane: 'platform' },
  'security.mfa_enrollment': { lane: 'platform' },
  'account.deletion_requested': { lane: 'platform' },
  'account.deletion_declined': { lane: 'platform' },
  'account.purge_warning': { lane: 'platform' },

  // ---- platform lane: operations and MSP staff notices --------------------
  'ops.alert': { lane: 'platform' },
  'staff.ai_budget_alert': { lane: 'platform' },
  'staff.contract_renewal': { lane: 'platform' },
  'staff.quote_outcome': { lane: 'platform' },
  'staff.alert_notification': { lane: 'platform' },
  'staff.workspace_drift_report': { lane: 'platform' },
  'staff.report_failure': { lane: 'platform' },
  'deployment.invite': { lane: 'platform' },
  'ticket.staff_notification': { lane: 'platform' },

  // ---- partner lane -------------------------------------------------------
  'ticket.customer_notification': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'portal.invite': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'portal.password_reset': { lane: 'partner', stream: 'support', fallbackFrom: 'default' },
  'quote.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
  'invoice.sent': { lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' },
  'report.delivery': { lane: 'partner', stream: 'general', fallbackFrom: 'default' },
} as const satisfies Record<string, MailPurposePolicy>;

export type MailPurpose = keyof typeof MAIL_PURPOSES;

/** The purposes whose registry entry is a partner-lane policy. */
export type PartnerLaneMailPurpose = {
  [K in MailPurpose]: (typeof MAIL_PURPOSES)[K] extends { lane: 'partner' } ? K : never;
}[MailPurpose];

export type PlatformMailPurpose = Exclude<MailPurpose, PartnerLaneMailPurpose>;

export function mailPurposePolicy(purpose: MailPurpose): MailPurposePolicy {
  return MAIL_PURPOSES[purpose];
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/emailDomains/mailPurposes.test.ts
```

Expected: `Test Files  1 passed (1)`, 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/emailDomains/mailPurposes.ts apps/api/src/services/emailDomains/mailPurposes.test.ts
git commit -m "$(cat <<'EOF'
feat(email): MAIL_PURPOSES registry — one file classifies every outbound email

Spec §8.1/§8.2. Declarative `as const satisfies` registry plus the derived
MailPurpose / PartnerLaneMailPurpose / PlatformMailPurpose types that will make
an unclassified send a compile error (G5). No behaviour yet: nothing imports it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `resolveSender` and the platform fallback From

**Files:**
- Create: `apps/api/src/services/emailDomains/senderResolution.ts`
- Create: `apps/api/src/services/emailDomains/senderResolution.test.ts` (Test)
- Modify: `apps/api/src/services/email.test.ts:94-125` (delete the `fromWithDisplayName` describe block — its four cases move to the new test file)

**Interfaces:**
- Consumes: `mailPurposePolicy`, `MailPurpose`, `PartnerMailStream` from `./mailPurposes`.
- Produces:
  ```ts
  export type PlatformLaneReason =
    | 'platform_purpose' | 'no_partner' | 'lane_unconfigured'
    | 'not_allowlisted' | 'partner_ineligible' | 'no_identity'
    | 'domain_not_sendable' | 'over_cap';
  export type ResolvedSender =
    | { lane: 'platform'; from: string; reason: PlatformLaneReason }
    | { lane: 'partner'; from: string; replyTo: string | null; partnerId: string;
        domainId: string; domain: string; stream: PartnerMailStream };
  export interface ResolveSenderInput {
    purpose: MailPurpose; partnerId: string | null;
    partnerName?: string | null; defaultFrom: string;
  }
  export function fromWithDisplayName(defaultFrom: string, displayName: string): string;
  export function platformFallbackFrom(purpose: MailPurpose, defaultFrom: string, partnerName?: string | null): string;
  export function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender>;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/emailDomains/senderResolution.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES, mailPurposePolicy, type MailPurpose } from './mailPurposes';
import { fromWithDisplayName, platformFallbackFrom, resolveSender } from './senderResolution';

// W04 TRIPWIRE. In W01 senderResolution imports nothing from the db layer, so
// this factory is never invoked and this mock cannot fail — it is stated here
// so that the moment W04 adds the partner-lane read, every assertion below
// (all of which are platform-lane inputs) proves the short-circuit still
// happens BEFORE any database access, which is spec §8.1's first property.
vi.mock('../../db', () => new Proxy({}, {
  get(_target, property) {
    if (typeof property === 'symbol') return undefined;
    throw new Error(`resolveSender touched the db module (.${String(property)}) on a platform-lane input`);
  },
}));

const DEFAULT_FROM = 'Breeze <no-reply@2breeze.app>';
const ALL_PURPOSES = Object.keys(MAIL_PURPOSES) as MailPurpose[];
const PLATFORM_PURPOSES = ALL_PURPOSES.filter((p) => mailPurposePolicy(p).lane === 'platform');
const PARTNER_PURPOSES = ALL_PURPOSES.filter((p) => mailPurposePolicy(p).lane === 'partner');

describe('fromWithDisplayName (moved verbatim off EmailService, spec §0.3)', () => {
  it('wraps the default address with a quoted display name', () => {
    expect(fromWithDisplayName('noreply@example.com', 'Acme MSP via Breeze'))
      .toBe('"Acme MSP via Breeze" <noreply@example.com>');
  });

  it('extracts the address when the default already carries a display name', () => {
    expect(fromWithDisplayName('Breeze <noreply@example.com>', 'Acme MSP via Breeze'))
      .toBe('"Acme MSP via Breeze" <noreply@example.com>');
  });

  it('strips header-breaking characters from the display name', () => {
    expect(fromWithDisplayName('noreply@example.com', 'Evil"\r\nBcc: victim <x>'))
      .toBe('"Evil Bcc: victim x" <noreply@example.com>');
  });

  it('falls back to the default sender when the name is empty after sanitizing', () => {
    expect(fromWithDisplayName('noreply@example.com', '"<>"')).toBe('noreply@example.com');
  });

  it('falls back to the default sender when it carries no address at all', () => {
    expect(fromWithDisplayName('not-an-address', 'Acme MSP')).toBe('not-an-address');
  });
});

describe('platformFallbackFrom (spec §8.3)', () => {
  it('returns the bare default for every purpose except quote.sent and invoice.sent', () => {
    for (const purpose of ALL_PURPOSES) {
      if (purpose === 'quote.sent' || purpose === 'invoice.sent') continue;
      expect(platformFallbackFrom(purpose, DEFAULT_FROM, 'Acme MSP')).toBe(DEFAULT_FROM);
    }
  });

  it('brands quote.sent and invoice.sent with "<Partner> via Breeze"', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, 'Acme MSP'))
      .toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');
    expect(platformFallbackFrom('invoice.sent', DEFAULT_FROM, 'Acme MSP'))
      .toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');
  });

  // Byte-identity with the pre-W01 call sites, which read
  // `partnerName ? fromWithDisplayName(...) : undefined` — a falsy name meant
  // the bare default, and an all-whitespace name did NOT.
  it('falls back to the bare default when the partner name is missing or empty', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, null)).toBe(DEFAULT_FROM);
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, undefined)).toBe(DEFAULT_FROM);
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, '')).toBe(DEFAULT_FROM);
  });

  it('keeps an all-whitespace partner name branded, exactly as the old call sites did', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, '   '))
      .toBe('"via Breeze" <no-reply@2breeze.app>');
  });
});

describe('resolveSender (W01: always the platform lane)', () => {
  it('returns platform_purpose for every platform purpose, whatever partnerId is passed', async () => {
    for (const purpose of PLATFORM_PURPOSES) {
      for (const partnerId of [null, 'partner-1']) {
        const resolved = await resolveSender({ purpose, partnerId, defaultFrom: DEFAULT_FROM });
        expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
      }
    }
  });

  it('returns no_partner for a partner purpose with a null partnerId', async () => {
    for (const purpose of PARTNER_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: null, defaultFrom: DEFAULT_FROM });
      expect(resolved.lane).toBe('platform');
      expect(resolved.lane === 'platform' && resolved.reason).toBe('no_partner');
    }
  });

  it('returns lane_unconfigured for a partner purpose with a partner — the lane does not exist until W04', async () => {
    for (const purpose of PARTNER_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: 'partner-1', defaultFrom: DEFAULT_FROM });
      expect(resolved.lane).toBe('platform');
      expect(resolved.lane === 'platform' && resolved.reason).toBe('lane_unconfigured');
    }
  });

  it('carries the purpose fallback From onto the platform result', async () => {
    const branded = await resolveSender({
      purpose: 'invoice.sent', partnerId: 'partner-1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM,
    });
    expect(branded.from).toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');

    const plain = await resolveSender({
      purpose: 'ticket.customer_notification', partnerId: 'partner-1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM,
    });
    expect(plain.from).toBe(DEFAULT_FROM);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/emailDomains/senderResolution.test.ts
```

Expected failure: `Cannot find module './senderResolution'`.

- [ ] **Step 3: Implement** — create `apps/api/src/services/emailDomains/senderResolution.ts`:

```ts
import {
  mailPurposePolicy,
  type MailPurpose,
  type PartnerMailStream,
} from './mailPurposes';

/**
 * Sender resolution (partner sending domains, spec §8.3).
 *
 * In W01 this ALWAYS returns the platform lane and performs NO database
 * access. W04 adds the partner branch — a single indexed read joining
 * partners, partner_sender_identities and partner_sending_domains — between
 * the `no_partner` guard and the `lane_unconfigured` return below. The types
 * are already the final ones so no later wave has to change them.
 *
 * This module must stay pure: EmailService passes its configured EMAIL_FROM
 * in as `defaultFrom` rather than being imported, which keeps the dependency
 * one-way (email.ts -> senderResolution.ts) and makes every case unit-testable
 * without a transport.
 */

export type PlatformLaneReason =
  // W01
  | 'platform_purpose'
  | 'no_partner'
  | 'lane_unconfigured'
  // W04
  | 'not_allowlisted'
  | 'partner_ineligible'
  | 'no_identity'
  | 'domain_not_sendable'
  | 'over_cap';

export type ResolvedSender =
  | { lane: 'platform'; from: string; reason: PlatformLaneReason }
  | {
      lane: 'partner';
      from: string;
      replyTo: string | null;
      partnerId: string;
      domainId: string;
      domain: string;
      stream: PartnerMailStream;
    };

export interface ResolveSenderInput {
  purpose: MailPurpose;
  partnerId: string | null;
  /** Only read for a `partner_display_name` fallback. Never a database read. */
  partnerName?: string | null;
  /** EmailService's configured EMAIL_FROM (already provider-resolved). */
  defaultFrom: string;
}

/**
 * The default sender with a custom display name — keeps the envelope address
 * (so SPF/DKIM alignment is untouched) while showing e.g.
 * `"Acme MSP via Breeze" <no-reply@2breeze.app>` in the customer's inbox.
 * The display name is stripped of header-breaking characters; falls back to
 * the plain default sender when nothing usable survives.
 *
 * Moved verbatim from `EmailService.fromWithDisplayName` (services/email.ts).
 */
export function fromWithDisplayName(defaultFrom: string, displayName: string): string {
  const match = defaultFrom.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = (match?.[1] ?? defaultFrom).trim();
  const safe = displayName.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe || !address.includes('@')) return defaultFrom;
  return `"${safe}" <${address}>`;
}

/**
 * The From a purpose uses when no partner identity applies — i.e. exactly what
 * that send site produced BEFORE this feature. This is what makes W01
 * byte-identical, and it matters most on self-hosted: an operator whose
 * EMAIL_FROM is already `"Acme Support" <support@acme.com>` must not see
 * ticket mail relabelled "Acme MSP via Breeze" by an upgrade (spec §8.3).
 *
 * The falsy-name check is deliberately NOT a trim: the old call sites read
 * `partnerName ? fromWithDisplayName(...) : undefined`, so an all-whitespace
 * name produced a branded From and must keep doing so.
 */
export function platformFallbackFrom(
  purpose: MailPurpose,
  defaultFrom: string,
  partnerName?: string | null,
): string {
  const policy = mailPurposePolicy(purpose);
  if (policy.lane !== 'partner' || policy.fallbackFrom !== 'partner_display_name') return defaultFrom;
  if (!partnerName) return defaultFrom;
  return fromWithDisplayName(defaultFrom, `${partnerName} via Breeze`);
}

export async function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender> {
  const from = platformFallbackFrom(input.purpose, input.defaultFrom, input.partnerName);
  const policy = mailPurposePolicy(input.purpose);

  // Property 1 (spec §8.1): a platform purpose returns before any database
  // read and can never produce a partner-lane result, whatever partnerId the
  // caller passes. G4 depends on it — a partner's sending reputation must not
  // be able to stop a password reset.
  if (policy.lane === 'platform') {
    return { lane: 'platform', from, reason: 'platform_purpose' };
  }

  // A call site that cannot always resolve a partner passes null (spec §8.1).
  if (!input.partnerId) {
    return { lane: 'platform', from, reason: 'no_partner' };
  }

  // W04 inserts the partner branch here. Until then the partner lane does not
  // exist, so every customer-facing purpose falls back to today's sender.
  return { lane: 'platform', from, reason: 'lane_unconfigured' };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/emailDomains/senderResolution.test.ts
```

Expected: `Test Files  1 passed (1)`, 13 tests passed.

- [ ] **Step 5: Delete the duplicated `fromWithDisplayName` block from `email.test.ts`**

In `apps/api/src/services/email.test.ts`, delete lines 94–125 in full — the whole block from `  describe('fromWithDisplayName', () => {` through its closing `  });` (the four cases now live in `senderResolution.test.ts`, three of them verbatim). The line after the deleted block is `  it('uses SMTP when EMAIL_PROVIDER is smtp', async () => {`.

- [ ] **Step 6: Confirm `email.test.ts` still passes**

```bash
cd apps/api && npx vitest run src/services/email.test.ts
```

Expected: pass, with 4 fewer tests than before (`fromWithDisplayName` is still a method on `EmailService` at this point — Task 8 removes it).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/emailDomains/senderResolution.ts apps/api/src/services/emailDomains/senderResolution.test.ts apps/api/src/services/email.test.ts
git commit -m "$(cat <<'EOF'
feat(email): resolveSender + platformFallbackFrom (platform lane only)

Spec §8.3. Pure module: fromWithDisplayName moves off EmailService as a
function over defaultFrom, platformFallbackFrom reproduces each purpose's
CURRENT From, and resolveSender always returns the platform lane with reason
platform_purpose | no_partner | lane_unconfigured. No database access; the W04
partner branch slots in between the last two returns without a type change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `deliverRaw`, the transitional `SendEmailParams`, and the golden test

The golden test is written first and is the red step: it cannot compile against today's `sendEmail`, which has no `purpose`. Once `sendEmail` resolves through `resolveSender` and delivers through `deliverRaw`, it passes — and from then on it is the wave's acceptance criterion.

**Files:**
- Modify: `apps/api/src/services/email.ts:17-30` (split `SendEmailParams` into `SendEmailBase` + transitional params + `RawEmailMessage`), `:240-318` (`sendEmail` → `deliverRaw`, plus the new `sendEmail`), `:730-733` (`sendViaMailgun` signature)
- Create: `apps/api/src/services/email.golden.test.ts` (Test)

**Interfaces:**
- Consumes: `resolveSender` from `./emailDomains/senderResolution`; `MailPurpose` from `./emailDomains/mailPurposes`.
- Produces:
  ```ts
  export interface SendEmailBase { to; cc?; subject; html; text?; replyTo?; headers?; attachments? }
  export interface RawEmailMessage extends SendEmailBase { from: string }
  // TRANSITIONAL until Task 8:
  export interface SendEmailParams extends SendEmailBase {
    from?: string; purpose?: MailPurpose; partnerId?: string | null; partnerName?: string | null;
  }
  class EmailService {
    sendEmail(params: SendEmailParams): Promise<void>;
    deliverRaw(message: RawEmailMessage): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing golden test** — create `apps/api/src/services/email.golden.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import type { SendEmailBase, SendEmailParams } from './email';

/**
 * W01 acceptance criterion (spec §14, §15): for EVERY purpose, the rendered
 * From, Reply-To, recipients and headers equal what the send site produced
 * before the sender contract landed, under EVERY EMAIL_PROVIDER. This is the
 * "upgrade changes nothing" guarantee in code — and the one test that a
 * self-hoster's mail silently changing would have to break first.
 *
 * Nothing here asserts a partner-lane send: in W01 there is no partner lane,
 * so every purpose resolves to the platform sender. W04 adds partner-lane
 * cases beside these; these rows must keep passing unchanged.
 */

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

const DEFAULT_FROM = 'Breeze <no-reply@2breeze.app>';
const BRANDED_FROM = '"Acme MSP via Breeze" <no-reply@2breeze.app>';
const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

const MESSAGE: SendEmailBase = {
  to: ['customer@example.test', 'second@example.test'],
  cc: ['cc@example.test'],
  subject: 'Golden subject',
  html: '<p>golden</p>',
  text: 'golden',
  replyTo: 'reply@example.test',
  headers: { 'Message-ID': '<ticket-t1@tickets.example.test>', 'Auto-Submitted': 'auto-replied' },
};

const GOLDEN: Array<{ name: string; params: SendEmailParams; expectedFrom: string }> = [
  { name: 'auth.password_reset', params: { ...MESSAGE, purpose: 'auth.password_reset' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_verification', params: { ...MESSAGE, purpose: 'auth.email_verification' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_change_verify', params: { ...MESSAGE, purpose: 'auth.email_change_verify' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_changed', params: { ...MESSAGE, purpose: 'auth.email_changed' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.signup_existing_account', params: { ...MESSAGE, purpose: 'auth.signup_existing_account' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.staff_invite', params: { ...MESSAGE, purpose: 'auth.staff_invite' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.account_locked', params: { ...MESSAGE, purpose: 'auth.account_locked' }, expectedFrom: DEFAULT_FROM },
  { name: 'security.mfa_enrollment', params: { ...MESSAGE, purpose: 'security.mfa_enrollment' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.deletion_requested', params: { ...MESSAGE, purpose: 'account.deletion_requested' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.deletion_declined', params: { ...MESSAGE, purpose: 'account.deletion_declined' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.purge_warning', params: { ...MESSAGE, purpose: 'account.purge_warning' }, expectedFrom: DEFAULT_FROM },
  { name: 'ops.alert', params: { ...MESSAGE, purpose: 'ops.alert' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.ai_budget_alert', params: { ...MESSAGE, purpose: 'staff.ai_budget_alert' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.contract_renewal', params: { ...MESSAGE, purpose: 'staff.contract_renewal' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.quote_outcome', params: { ...MESSAGE, purpose: 'staff.quote_outcome' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.alert_notification', params: { ...MESSAGE, purpose: 'staff.alert_notification' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.workspace_drift_report', params: { ...MESSAGE, purpose: 'staff.workspace_drift_report' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.report_failure', params: { ...MESSAGE, purpose: 'staff.report_failure' }, expectedFrom: DEFAULT_FROM },
  { name: 'deployment.invite', params: { ...MESSAGE, purpose: 'deployment.invite' }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.staff_notification', params: { ...MESSAGE, purpose: 'ticket.staff_notification' }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.customer_notification (with partner)', params: { ...MESSAGE, purpose: 'ticket.customer_notification', partnerId: PARTNER_ID }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.customer_notification (no partner)', params: { ...MESSAGE, purpose: 'ticket.customer_notification', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'portal.invite', params: { ...MESSAGE, purpose: 'portal.invite', partnerId: PARTNER_ID }, expectedFrom: DEFAULT_FROM },
  { name: 'portal.password_reset', params: { ...MESSAGE, purpose: 'portal.password_reset', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'report.delivery', params: { ...MESSAGE, purpose: 'report.delivery', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'quote.sent (partner named)', params: { ...MESSAGE, purpose: 'quote.sent', partnerId: PARTNER_ID, partnerName: 'Acme MSP' }, expectedFrom: BRANDED_FROM },
  { name: 'quote.sent (no partner name)', params: { ...MESSAGE, purpose: 'quote.sent', partnerId: PARTNER_ID, partnerName: null }, expectedFrom: DEFAULT_FROM },
  { name: 'invoice.sent (partner named)', params: { ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER_ID, partnerName: 'Acme MSP' }, expectedFrom: BRANDED_FROM },
  { name: 'invoice.sent (no partner name)', params: { ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER_ID, partnerName: null }, expectedFrom: DEFAULT_FROM },
];

const originalEnv = { ...process.env };

function resetEmailEnv() {
  for (const key of [
    'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
    'MAILGUN_BASE_URL', 'MAILGUN_FROM', 'SMTP_TIMEOUT_MS', 'MAILGUN_TIMEOUT_MS',
  ]) delete process.env[key];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  resetEmailEnv();
  resendSendMock.mockResolvedValue({ error: null });
  smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

async function service() {
  const { EmailService } = await import('./email');
  return new EmailService();
}

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(resendSendMock).toHaveBeenCalledTimes(1);
      const arg = resendSendMock.mock.calls[0]![0];
      expect(arg.from).toBe(row.expectedFrom);
      expect(arg.to).toEqual(MESSAGE.to);
      expect(arg.cc).toEqual(MESSAGE.cc);
      expect(arg.subject).toBe(MESSAGE.subject);
      expect(arg.html).toBe(MESSAGE.html);
      expect(arg.text).toBe(MESSAGE.text);
      expect(arg.replyTo).toBe(MESSAGE.replyTo);
      expect(arg.headers).toEqual(MESSAGE.headers);
      expect(arg.attachments).toBeUndefined();
    });
  }
});

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=smtp', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
      const arg = smtpSendMailMock.mock.calls[0]![0];
      expect(arg.from).toBe(row.expectedFrom);
      expect(arg.to).toEqual(MESSAGE.to);
      expect(arg.cc).toEqual(MESSAGE.cc);
      expect(arg.subject).toBe(MESSAGE.subject);
      expect(arg.replyTo).toBe(MESSAGE.replyTo);
      // Threading headers are lifted into nodemailer's dedicated options so it
      // does not ALSO auto-generate a second Message-Id.
      expect(arg.messageId).toBe('<ticket-t1@tickets.example.test>');
      expect(arg.inReplyTo).toBeUndefined();
      expect(arg.references).toBeUndefined();
      expect(arg.headers).toEqual({ 'Auto-Submitted': 'auto-replied' });
    });
  }
});

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body ?? ''));
      expect(body.get('from')).toBe(row.expectedFrom);
      expect(body.getAll('to')).toEqual(MESSAGE.to);
      expect(body.get('subject')).toBe(MESSAGE.subject);
      expect(body.get('html')).toBe(MESSAGE.html);
      expect(body.get('text')).toBe(MESSAGE.text);
      expect(body.getAll('h:Reply-To')).toEqual([MESSAGE.replyTo]);
      expect(body.get('h:Message-ID')).toBe('<ticket-t1@tickets.example.test>');
      expect(body.get('h:Auto-Submitted')).toBe('auto-replied');
      // PINNED AS-IS, not fixed (plan index amendment 6): sendEmail's Mailgun
      // branch has never passed `cc` through to sendViaMailgun, which does
      // support it. Fixing that changes what recipients see, so it is a
      // separate issue, not part of a byte-identical wave.
      expect(body.getAll('cc')).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/email.golden.test.ts
```

Expected failure: a TypeScript/transform error on `import type { SendEmailBase, SendEmailParams } from './email'` — `Module '"./email"' has no exported member 'SendEmailBase'` — and, once that resolves, `Object literal may only specify known properties, and 'purpose' does not exist in type 'SendEmailParams'`.

- [ ] **Step 3: Split the params types in `apps/api/src/services/email.ts`**

Replace lines 17–30 (the whole `export interface SendEmailParams { … }` block, from `export interface SendEmailParams {` through its closing `}`) with:

```ts
export interface SendEmailBase {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | string[];
  // Custom RFC headers for threading + loop-prevention (Phase 4):
  // Message-ID, In-Reply-To, References, Auto-Submitted. Flat map; each
  // provider maps it natively (Resend/SMTP `headers`, Mailgun `h:` fields).
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

/**
 * A message whose sender has already been decided. The ONLY shape that reaches
 * a transport. `services/emailDomains/**` uses it for the `static` and `fake`
 * adapters and the test send, which hand a custom From to the platform
 * transport (plan index amendment 2).
 */
export interface RawEmailMessage extends SendEmailBase {
  from: string;
}

/**
 * TRANSITIONAL (W01 Task 3 → Task 8). `purpose` is optional and the raw `from`
 * is still accepted so the 27 call sites can migrate in reviewable cohorts
 * without the repo going red. Task 8 removes `from` and makes `purpose`
 * required through the discriminated union in the plan index, which is what
 * makes an unclassified send a compile error (spec G5).
 */
export interface SendEmailParams extends SendEmailBase {
  from?: string;
  purpose?: MailPurpose;
  partnerId?: string | null;
  partnerName?: string | null;
}
```

Add the two imports directly under the existing `import nodemailer …` / `import { Resend } …` lines at the top of the file:

```ts
import type { MailPurpose } from './emailDomains/mailPurposes';
import { resolveSender } from './emailDomains/senderResolution';
```

- [ ] **Step 4: Split `sendEmail` into `sendEmail` + `deliverRaw`**

Replace the whole `async sendEmail(params: SendEmailParams): Promise<void> { … }` method (currently `apps/api/src/services/email.ts:240-318`, ending at the closing brace after the `this.smtpTransport.sendMail({…})` call) with:

```ts
  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, cc, subject, html, text, from, replyTo, headers, attachments } = params;

    // A migrated call site names a purpose and the registry decides the
    // sender; an unmigrated one still passes `from` and is untouched. Both
    // land on exactly today's address — see platformFallbackFrom.
    const resolved = params.purpose
      ? await resolveSender({
        purpose: params.purpose,
        partnerId: params.partnerId ?? null,
        partnerName: params.partnerName ?? null,
        defaultFrom: this.defaultFrom,
      })
      : null;

    await this.deliverRaw({
      to,
      cc,
      subject,
      html,
      text,
      replyTo,
      headers,
      attachments,
      from: from ?? resolved?.from ?? this.defaultFrom,
    });
  }

  /**
   * @internal The one raw entry point: it takes an explicit From and asks no
   * questions. Only `services/emailDomains/**` may call it (enforced by
   * `email.deliverRawScope.test.ts`) — product code calls `sendEmail` and
   * declares a purpose, or the classification G5 depends on leaks away.
   */
  async deliverRaw(message: RawEmailMessage): Promise<void> {
    const { to, cc, subject, html, text, from, replyTo, headers, attachments } = message;
    const sender = from;

    if (this.provider === 'resend') {
      if (!this.resend) {
        throw new Error('Resend transport is not initialized');
      }

      const { error } = await this.resend.emails.send({
        from: sender,
        to,
        cc,
        subject,
        html,
        text,
        replyTo,
        headers,
        attachments: attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        }))
      });
      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }
      return;
    }

    if (this.provider === 'mailgun') {
      if (!this.mailgunConfig) {
        throw new Error('Mailgun config is not initialized');
      }

      // `cc` is deliberately NOT forwarded: sendViaMailgun supports it, this
      // call has never passed it, and W01 is byte-identical by construction.
      // Fixing it is its own issue (plan index amendment 6).
      await sendViaMailgun(this.mailgunConfig, {
        from: sender,
        to,
        subject,
        html,
        text,
        replyTo,
        headers,
        attachments
      });
      return;
    }

    if (!this.smtpTransport) {
      throw new Error('SMTP transport is not initialized');
    }

    // Lift Message-ID / In-Reply-To / References (case-insensitive) out of the
    // generic `headers` map into nodemailer's dedicated options. Passing a
    // `Message-ID` header AND letting nodemailer auto-generate its own would emit
    // TWO Message-Id headers; using the `messageId` option makes our anchor the
    // single canonical Message-Id so SMTP threading round-trips. The remaining
    // headers (e.g. Auto-Submitted) stay in the generic map.
    const { messageId, inReplyTo, references, rest } = liftThreadingHeaders(headers);

    await this.smtpTransport.sendMail({
      from: sender,
      to,
      cc,
      subject,
      html,
      text,
      replyTo,
      messageId,
      inReplyTo,
      references,
      headers: rest,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType
      }))
    });
  }
```

- [ ] **Step 5: Retype `sendViaMailgun`**

At `apps/api/src/services/email.ts:730-733`, change:

```ts
async function sendViaMailgun(
  config: MailgunProviderConfig,
  params: SendEmailParams & { from: string }
): Promise<void> {
```

to:

```ts
async function sendViaMailgun(
  config: MailgunProviderConfig,
  params: RawEmailMessage
): Promise<void> {
```

- [ ] **Step 6: Run the golden test and watch it pass**

```bash
cd apps/api && npx vitest run src/services/email.golden.test.ts
```

Expected: `Test Files  1 passed (1)`, 87 tests passed (29 rows × 3 providers).

- [ ] **Step 7: Confirm nothing else moved**

```bash
cd apps/api && npx vitest run src/services/email.test.ts src/services/email.headers.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: both suites pass; `tsc` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.golden.test.ts
git commit -m "$(cat <<'EOF'
feat(email): deliverRaw + the W01 golden test

Splits EmailService.sendEmail into resolve (resolveSender) and deliver
(deliverRaw, today's transport bodies verbatim with an explicit From).
RawEmailMessage is the shape W02's static/fake adapters and test send need
(plan index amendment 2). SendEmailParams is transitional: `purpose` optional,
`from` still accepted, so the 27 call sites migrate in cohorts.

email.golden.test.ts pins every purpose x resend/smtp/mailgun: From, Reply-To,
recipients, headers, and the Mailgun cc drop as-is (amendment 6).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Named-helper purposes

`EmailService`'s named helpers (`sendPasswordReset`, `sendVerificationEmail`, …) hard-code their purpose where they have one audience, and take it where two audiences share them (spec §8.1). Changing a helper's param type breaks all its callers at once, so every helper and every helper call site lands in this one task.

**Files:**
- Modify: `apps/api/src/services/email.ts:57-62` (`PasswordResetEmailParams`), `:64-71` (`PortalInviteEmailParams`), `:73-78` (`VerificationEmailParams`), `:320-398` (the eight helper bodies)
- Modify: `apps/api/src/jobs/authEmailWorker.ts:127`, `:201`
- Modify: `apps/api/src/routes/auth/verifyEmail.ts:350`
- Modify: `apps/api/src/routes/users.ts:756`
- Modify: `apps/api/src/routes/portal/auth.ts:594`
- Modify: `apps/api/src/routes/orgPortalUsers.ts:84-96`

**Interfaces:**
- Consumes: `SendEmailParams` (transitional) from Task 3.
- Produces: `PasswordResetEmailParams` (discriminated on `purpose`), `VerificationEmailParams.purpose`, `PortalInviteEmailParams.partnerId`. Helper call sites now supply a purpose where the helper cannot know it.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/services/email.golden.test.ts`, at the end of the file:

```ts
describe('named helpers carry their purpose to the transport (spec §8.1)', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  it('sendPasswordReset carries the auth purpose for staff', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPasswordReset({ to: 'admin@msp.test', resetUrl: 'https://app.test/r', purpose: 'auth.password_reset' });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'auth.password_reset' });
    expect(resendSendMock.mock.calls[0]![0].from).toBe(DEFAULT_FROM);
  });

  it('sendPasswordReset carries the portal purpose and partner for a portal user', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPasswordReset({
      to: 'buyer@customer.test', resetUrl: 'https://portal.test/r',
      purpose: 'portal.password_reset', partnerId: PARTNER_ID,
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'portal.password_reset', partnerId: PARTNER_ID });
  });

  it('sendVerificationEmail carries whichever verification purpose it was given', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendVerificationEmail({ to: 'a@msp.test', verificationUrl: 'https://app.test/v', purpose: 'auth.email_change_verify' });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'auth.email_change_verify' });
  });

  it('sendPortalInvite is a partner-stream send carrying the partner', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPortalInvite({ to: 'buyer@customer.test', inviteUrl: 'https://portal.test/i', partnerId: PARTNER_ID });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'portal.invite', partnerId: PARTNER_ID });
  });

  it('the single-audience helpers hard-code their purpose', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendInvite({ to: 'new@msp.test', inviteUrl: 'https://app.test/i' });
    await svc.sendAccountLocked({ to: 'a@msp.test', resetUrl: 'https://app.test/r', lockoutMinutes: 15 });
    await svc.sendEmailChanged({ to: 'old@msp.test', newEmail: 'new@msp.test' });
    await svc.sendSignupAttemptOnExistingAccount({ to: 'a@msp.test' });
    await svc.sendAlertNotification({ to: 'a@msp.test', alertName: 'Disk', severity: 'high', summary: 'full' });
    expect(spy.mock.calls.map((c) => c[0].purpose)).toEqual([
      'auth.staff_invite',
      'auth.account_locked',
      'auth.email_changed',
      'auth.signup_existing_account',
      'staff.alert_notification',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/email.golden.test.ts
```

Expected failure: `Object literal may only specify known properties, and 'purpose' does not exist in type 'PasswordResetEmailParams'`.

- [ ] **Step 3: Retype the three helper param interfaces in `apps/api/src/services/email.ts`**

Replace lines 57–62:

```ts
export interface PasswordResetEmailParams {
  to: string | string[];
  name?: string;
  resetUrl: string;
  supportEmail?: string;
}
```

with:

```ts
/**
 * Two audiences share this template: an MSP staff account (platform lane —
 * account recovery must never depend on a partner's DNS, spec §8.2) and a
 * customer's portal login (partner lane, `support` stream). The purpose is
 * therefore a caller decision, and it drags `partnerId` with it.
 */
export type PasswordResetEmailParams = {
  to: string | string[];
  name?: string;
  resetUrl: string;
  supportEmail?: string;
} & (
  | { purpose: 'auth.password_reset' }
  | { purpose: 'portal.password_reset'; partnerId: string | null }
);
```

Replace lines 64–71:

```ts
export interface PortalInviteEmailParams {
  to: string | string[];
  inviteUrl: string;
  orgName?: string;
  inviterName?: string;
  message?: string;
  supportEmail?: string;
}
```

with:

```ts
export interface PortalInviteEmailParams {
  to: string | string[];
  inviteUrl: string;
  orgName?: string;
  inviterName?: string;
  message?: string;
  supportEmail?: string;
  /**
   * The partner that owns the org this invite belongs to — the `support`
   * stream's sender once W04 lands. Must come from a row the call site already
   * read or from the verified auth context, never from request input (§8.1).
   */
  partnerId: string | null;
}
```

Replace lines 73–78:

```ts
export interface VerificationEmailParams {
  to: string | string[];
  name?: string;
  verificationUrl: string;
  supportEmail?: string;
}
```

with:

```ts
export interface VerificationEmailParams {
  to: string | string[];
  name?: string;
  verificationUrl: string;
  supportEmail?: string;
  /**
   * `auth.email_verification` for signup and resend; `auth.email_change_verify`
   * for the link sent to a NEW address during an email change. Both are
   * platform purposes — same lane, different delivery-event tag (§9.3).
   */
  purpose: 'auth.email_verification' | 'auth.email_change_verify';
}
```

- [ ] **Step 4: Pass the purpose through the eight helper bodies**

In `apps/api/src/services/email.ts`, rewrite the helper block that currently spans lines 320–398 so each `this.sendEmail({…})` call names a purpose:

```ts
  async sendPasswordReset(params: PasswordResetEmailParams): Promise<void> {
    const template = buildPasswordResetTemplate(params);
    if (params.purpose === 'portal.password_reset') {
      await this.sendEmail({
        to: params.to,
        subject: template.subject,
        html: template.html,
        text: template.text,
        purpose: 'portal.password_reset',
        partnerId: params.partnerId
      });
      return;
    }
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'auth.password_reset'
    });
  }

  async sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
    const template = buildVerificationTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: params.purpose
    });
  }

  async sendInvite(params: InviteEmailParams): Promise<void> {
    const template = buildInviteTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'auth.staff_invite'
    });
  }

  async sendAlertNotification(params: AlertNotificationEmailParams): Promise<void> {
    const template = buildAlertNotificationTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'staff.alert_notification'
    });
  }

  async sendAccountLocked(params: AccountLockedEmailParams): Promise<void> {
    const template = buildAccountLockedTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'auth.account_locked'
    });
  }

  async sendEmailChanged(params: EmailChangedEmailParams): Promise<void> {
    const template = buildEmailChangedTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'auth.email_changed'
    });
  }

  async sendSignupAttemptOnExistingAccount(params: SignupAttemptOnExistingAccountEmailParams): Promise<void> {
    const template = buildSignupAttemptOnExistingAccountTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'auth.signup_existing_account'
    });
  }

  async sendPortalInvite(params: PortalInviteEmailParams): Promise<void> {
    const template = buildPortalInviteTemplate(params);
    await this.sendEmail({
      to: params.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'portal.invite',
      partnerId: params.partnerId
    });
  }
```

- [ ] **Step 5: Migrate the helper call sites**

`apps/api/src/jobs/authEmailWorker.ts:127` — the password reset the auth-email worker sends to an MSP staff address:

```ts
  await emailService.sendPasswordReset({ to: eligibility.email, resetUrl });
```
becomes
```ts
  await emailService.sendPasswordReset({ to: eligibility.email, resetUrl, purpose: 'auth.password_reset' });
```

`apps/api/src/jobs/authEmailWorker.ts:201`:

```ts
  await emailService.sendVerificationEmail({ to: rec.email, name: rec.name, verificationUrl });
```
becomes
```ts
  await emailService.sendVerificationEmail({ to: rec.email, name: rec.name, verificationUrl, purpose: 'auth.email_verification' });
```

`apps/api/src/routes/auth/verifyEmail.ts:350` — the "resend verification" route:

```ts
    await emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      verificationUrl,
    });
```
becomes
```ts
    await emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      verificationUrl,
      purpose: 'auth.email_verification',
    });
```

`apps/api/src/routes/users.ts:756` — the link sent to the NEW address during a self-service email change:

```ts
      await emailService.sendVerificationEmail({ to: pendingNewEmail, name: updated.name ?? undefined, verificationUrl })
```
becomes
```ts
      await emailService.sendVerificationEmail({ to: pendingNewEmail, name: updated.name ?? undefined, verificationUrl, purpose: 'auth.email_change_verify' })
```

`apps/api/src/routes/portal/auth.ts:594` — the portal password reset. `partnerId` is `null`: the `portalUsers` row this route read selects `id, email, orgId, authMethod` only, and W01 adds no database reads (plan amendment 5):

```ts
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl
        });
```
becomes
```ts
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl,
          purpose: 'portal.password_reset',
          // The portal_users row read above carries orgId, not partnerId, and
          // W01 adds no database read. A null partnerId resolves to the
          // platform sender, which is exactly today's behaviour (§8.1).
          partnerId: null
        });
```

`apps/api/src/routes/orgPortalUsers.ts:84-96` — `issueAndSendInvite` already receives the Hono context, so the partner comes from the verified auth context, never from request input. Change the function body:

```ts
async function issueAndSendInvite(c: any, orgId: string, user: { id: string; email: string }, orgName: string | null, inviterName: string | null | undefined, message?: string): Promise<boolean> {
  const rawToken = await storePortalInviteToken(user.id);
  if (!rawToken) return false; // redis unavailable — do not email a dead invite link
  const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);
  const emailService = getEmailService();
  if (!emailService) return false;
  try {
    await emailService.sendPortalInvite({ to: user.email, inviteUrl, orgName: orgName ?? undefined, inviterName: inviterName ?? undefined, message });
    return true;
```

becomes

```ts
async function issueAndSendInvite(c: any, orgId: string, user: { id: string; email: string }, orgName: string | null, inviterName: string | null | undefined, message?: string): Promise<boolean> {
  const rawToken = await storePortalInviteToken(user.id);
  if (!rawToken) return false; // redis unavailable — do not email a dead invite link
  const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);
  const emailService = getEmailService();
  if (!emailService) return false;
  // Partner from the VERIFIED auth context, never request input (spec §8.1).
  // These routes are requireScope('partner', 'system'); a system-scope caller
  // has partnerId === null, which resolves to the platform sender.
  const partnerId = (c.get('auth') as AuthContext | undefined)?.partnerId ?? null;
  try {
    await emailService.sendPortalInvite({ to: user.email, inviteUrl, orgName: orgName ?? undefined, inviterName: inviterName ?? undefined, message, partnerId });
    return true;
```

(`AuthContext` is already imported in `orgPortalUsers.ts` — it is used at lines 58, 169, 259 and 274.)

- [ ] **Step 6: Run the affected tests**

```bash
cd apps/api && npx vitest run \
  src/services/email.golden.test.ts \
  src/jobs/authEmailWorker.test.ts \
  src/routes/auth/verifyEmail.test.ts \
  src/routes/users.test.ts \
  src/routes/portal/auth.test.ts \
  src/routes/orgPortalUsers.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all suites pass (every existing assertion on these helpers uses `expect.objectContaining`, so an added `purpose` is invisible to them); `tsc` prints nothing. If `src/routes/auth/verifyEmail.test.ts` does not exist, drop it from the list — do not add a trailing slash to any of these paths (vitest's filter is a plain substring, not a directory prefix).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.golden.test.ts apps/api/src/jobs/authEmailWorker.ts apps/api/src/routes/auth/verifyEmail.ts apps/api/src/routes/users.ts apps/api/src/routes/portal/auth.ts apps/api/src/routes/orgPortalUsers.ts
git commit -m "$(cat <<'EOF'
feat(email): named helpers declare their purpose

Spec §8.1: a helper hard-codes its purpose when it has one audience and takes
it when two share it. sendPasswordReset splits staff (auth.password_reset,
platform) from portal (portal.password_reset, partner/support);
sendVerificationEmail takes auth.email_verification vs auth.email_change_verify;
sendPortalInvite carries the partner from the verified auth context.

routes/portal/auth.ts passes partnerId: null — the portal_users row it read has
no partner and W01 adds no database read (§8.1 allows null).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Direct platform-lane `sendEmail` sites

Ten call sites that build their own template and call `sendEmail` directly, all of them mail to MSP staff or to platform operators — every one a platform purpose (spec §8.2). `services/reportDelivery.ts` is deliberately NOT in this task: both of its sends share one pinned snapshot file, so they migrate together in Task 7.

**Files:**
- Modify: `apps/api/src/jobs/aiBudgetAlertDelivery.ts:218`
- Modify: `apps/api/src/jobs/mfaEnrollmentNotice.ts:279`
- Modify: `apps/api/src/modules/mcpInvites/tools/sendDeploymentInvites.ts:145-150`
- Modify: `apps/api/src/routes/auth/accountDeletion.ts:169-174`, `:673`
- Modify: `apps/api/src/services/aiToolsGoogle.ts:1316-1320`
- Modify: `apps/api/src/services/contractRenewal.ts:79`
- Modify: `apps/api/src/services/opsAlerts.ts:68-73`
- Modify: `apps/api/src/services/quoteOutcomeNotify.ts:94-99`
- Modify: `apps/api/src/services/tenantOffboarding.ts:1814-1830`

**Interfaces:**
- Consumes: transitional `SendEmailParams` (Task 3), `MAIL_PURPOSES` keys (Task 1).
- Produces: nothing new. Each site now names its purpose; the resolved From is unchanged (`fallbackFrom: 'default'` for all ten).

- [ ] **Step 1: `apps/api/src/jobs/aiBudgetAlertDelivery.ts:218`**

```ts
          await emailService.sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
```
becomes
```ts
          await emailService.sendEmail({ to, subject: email.subject, html: email.html, text: email.text, purpose: 'staff.ai_budget_alert' });
```

- [ ] **Step 2: `apps/api/src/jobs/mfaEnrollmentNotice.ts:279`**

```ts
      await emailService.sendEmail({ to: row.email, subject, html, text });
```
becomes
```ts
      await emailService.sendEmail({ to: row.email, subject, html, text, purpose: 'security.mfa_enrollment' });
```

- [ ] **Step 3: `apps/api/src/modules/mcpInvites/tools/sendDeploymentInvites.ts:145-150`**

```ts
      await emailSvc.sendEmail({
        to: email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
```
becomes
```ts
      // Platform sender, deliberately (spec §8.2, D3): deployment invites carry
      // installer links to arbitrary typed addresses — the exact shape hosted
      // abuse takes — so the recipient must see Breeze's name and abuse contact,
      // never an MSP's domain. `partnerId` is in scope here and is NOT passed.
      await emailSvc.sendEmail({
        to: email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
        purpose: 'deployment.invite',
      });
```

- [ ] **Step 4: `apps/api/src/routes/auth/accountDeletion.ts:169-174`**

```ts
    await emailService.sendEmail({
      to: recipientEmails,
      subject,
      html,
      text,
    });
```
becomes
```ts
    await emailService.sendEmail({
      to: recipientEmails,
      subject,
      html,
      text,
      purpose: 'account.deletion_requested',
    });
```

- [ ] **Step 5: `apps/api/src/routes/auth/accountDeletion.ts:673`**

```ts
    await emailService.sendEmail({ to: opts.user.email, subject, html, text });
```
becomes
```ts
    await emailService.sendEmail({ to: opts.user.email, subject, html, text, purpose: 'account.deletion_declined' });
```

- [ ] **Step 6: `apps/api/src/services/aiToolsGoogle.ts:1316-1320`**

```ts
    await svc.sendEmail({
      to,
      subject: `Google Workspace security drift — ${ctx.conn.customerDomain}`,
      html: renderDriftHtml(ctx.conn.customerDomain, drift),
    });
```
becomes
```ts
    await svc.sendEmail({
      to,
      subject: `Google Workspace security drift — ${ctx.conn.customerDomain}`,
      html: renderDriftHtml(ctx.conn.customerDomain, drift),
      purpose: 'staff.workspace_drift_report',
    });
```

- [ ] **Step 7: `apps/api/src/services/contractRenewal.ts:79`**

```ts
        await emailService.sendEmail({ to: recipients.map((r) => r.email), subject: tpl.subject, html: tpl.html, text: tpl.text });
```
becomes
```ts
        // To MSP staff, not the customer (spec §8.2) — platform sender.
        await emailService.sendEmail({ to: recipients.map((r) => r.email), subject: tpl.subject, html: tpl.html, text: tpl.text, purpose: 'staff.contract_renewal' });
```

- [ ] **Step 8: `apps/api/src/services/opsAlerts.ts:68-73`**

```ts
    await email.sendEmail({
      to,
      subject: `[Breeze ops] ${msg.title}`,
      text: msg.body,
      html: msg.html ?? `<pre>${msg.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
    });
```
becomes
```ts
    await email.sendEmail({
      to,
      subject: `[Breeze ops] ${msg.title}`,
      text: msg.body,
      html: msg.html ?? `<pre>${msg.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
      purpose: 'ops.alert',
    });
```

- [ ] **Step 9: `apps/api/src/services/quoteOutcomeNotify.ts:94-99`**

```ts
    await emailService.sendEmail({
      to: prepared.recipient,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
```
becomes
```ts
    // The INTERNAL notification to the MSP tech who sent the quote, not the
    // customer-facing quote itself (spec §8.2) — platform sender.
    await emailService.sendEmail({
      to: prepared.recipient,
      subject: template.subject,
      html: template.html,
      text: template.text,
      purpose: 'staff.quote_outcome',
    });
```

- [ ] **Step 10: `apps/api/src/services/tenantOffboarding.ts:1814`**

In the `await emailService.sendEmail({ … })` call that begins at line 1814, add one property after the `html: renderLayout({ … })` argument, immediately before the call's closing `});`:

```ts
            purpose: 'account.purge_warning',
```

so the call reads `sendEmail({ to: emails, subject: …, text: …, html: renderLayout({…}), purpose: 'account.purge_warning' })`.

- [ ] **Step 11: Run the affected tests**

```bash
cd apps/api && npx vitest run \
  src/jobs/aiBudgetAlertDelivery.test.ts \
  src/jobs/mfaEnrollmentNotice.test.ts \
  src/modules/mcpInvites/tools/sendDeploymentInvites.test.ts \
  src/routes/auth/accountDeletion.test.ts \
  src/routes/auth/accountDeletion.admin.test.ts \
  src/services/aiToolsGoogle.test.ts \
  src/services/contractRenewal.sweepScope.test.ts \
  src/services/opsAlerts.test.ts \
  src/services/quoteOutcomeNotify.test.ts \
  src/services/tenantOffboarding.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all pass. Every existing assertion on these ten sites uses `expect.objectContaining`, so the added `purpose` is invisible.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/jobs/aiBudgetAlertDelivery.ts apps/api/src/jobs/mfaEnrollmentNotice.ts apps/api/src/modules/mcpInvites/tools/sendDeploymentInvites.ts apps/api/src/routes/auth/accountDeletion.ts apps/api/src/services/aiToolsGoogle.ts apps/api/src/services/contractRenewal.ts apps/api/src/services/opsAlerts.ts apps/api/src/services/quoteOutcomeNotify.ts apps/api/src/services/tenantOffboarding.ts
git commit -m "$(cat <<'EOF'
feat(email): classify the ten direct platform-lane send sites

Spec §8.2. ops.alert, staff.ai_budget_alert, staff.contract_renewal,
staff.quote_outcome, staff.workspace_drift_report, security.mfa_enrollment,
account.deletion_requested, account.deletion_declined, account.purge_warning,
deployment.invite. All mail to MSP staff or platform operators, all resolving
to the same EMAIL_FROM they use today.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Ticket notification purposes

Spec §8.2 lists ticket mail as two rows, but `ticketNotifyWorker` collects both audiences into one `EmailPayload[]` and sends them from a single call (plan amendment 2). `EmailPayload` therefore becomes a discriminated union that carries the purpose, and the send loop branches on it.

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts:68-79` (`EmailPayload`), `:167-174` (assignee payload), `:231-237` and `:265-272` (requester payloads), `:345` (autoresponse payload), `:416-421` (SLA payload), `:589-595` (the send)

**Interfaces:**
- Consumes: transitional `SendEmailParams`.
- Produces (module-private):
  ```ts
  type EmailPayloadSender =
    | { purpose: 'ticket.staff_notification' }
    | { purpose: 'ticket.customer_notification'; partnerId: string | null };
  type EmailPayload = EmailPayloadBase & EmailPayloadSender;
  ```

- [ ] **Step 1: Write the failing test** — create `apps/api/src/jobs/ticketNotifyWorker.purposes.test.ts` is NOT needed; instead append this test to the existing suite. Open `apps/api/src/jobs/ticketNotifyWorker.test.ts` and add, inside the outermost `describe` (immediately before its closing `});`):

```ts
  // Spec §8.2: ticket mail to a TECHNICIAN is platform-lane (staff mailboxes
  // usually live on the very domain being sent from), ticket mail to a
  // REQUESTER is the partner's `support` stream. Both leave through the same
  // send loop, so the purpose has to ride on the payload.
  it('tags the assignee notification as platform and the requester notification as partner', async () => {
    const calls = sendEmailMock.mock.calls.map((c) => c[0] as { purpose?: string; partnerId?: string | null });
    for (const call of calls) {
      expect(call.purpose === 'ticket.staff_notification' || call.purpose === 'ticket.customer_notification').toBe(true);
      if (call.purpose === 'ticket.customer_notification') {
        expect(call).toHaveProperty('partnerId');
      } else {
        expect(call).not.toHaveProperty('partnerId');
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });
```

This test reads whatever the preceding tests in the file already sent, so it only has to be reached after at least one send — keep it last in the file. If the suite's `beforeEach` resets `sendEmailMock`, move this assertion into the existing assigned-notification test and the existing requester test instead, asserting `expect(arg.purpose).toBe('ticket.staff_notification')` and `expect(arg.purpose).toBe('ticket.customer_notification')` on the `arg` those tests already capture.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/ticketNotifyWorker.test.ts
```

Expected failure: `expected false to be true` — no payload carries a `purpose` yet.

- [ ] **Step 3: Make `EmailPayload` a discriminated union**

Replace `apps/api/src/jobs/ticketNotifyWorker.ts:68-79`:

```ts
interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  bestEffort?: boolean; // if true, swallow send errors
  replyTo?: string;
  headers?: Record<string, string>;
  // Customer-facing only: when the partner has a connected M365 mailbox, the reply
  // is sent FROM that mailbox via Graph (native threading) instead of EmailService.
  // Tech/assignee payloads never set this, so they always use EmailService.
  graphMailbox?: { tenantId: string; mailbox: string; originalMessageId: string | null };
}
```

with:

```ts
interface EmailPayloadBase {
  to: string;
  subject: string;
  html: string;
  bestEffort?: boolean; // if true, swallow send errors
  replyTo?: string;
  headers?: Record<string, string>;
  // Customer-facing only: when the partner has a connected M365 mailbox, the reply
  // is sent FROM that mailbox via Graph (native threading) instead of EmailService.
  // Tech/assignee payloads never set this, so they always use EmailService.
  graphMailbox?: { tenantId: string; mailbox: string; originalMessageId: string | null };
}

/**
 * Who this ticket email is FOR, in the sender contract's terms (spec §8.2).
 * Both audiences leave through the same send loop below, so the classification
 * has to travel with each payload rather than being decided at the transport.
 * Precedence for customer mail is unchanged: connected Graph mailbox first,
 * then the partner lane (W04), then the platform sender.
 */
type EmailPayloadSender =
  | { purpose: 'ticket.staff_notification' }
  | { purpose: 'ticket.customer_notification'; partnerId: string | null };

type EmailPayload = EmailPayloadBase & EmailPayloadSender;
```

- [ ] **Step 4: Tag the five payload construction sites**

`apps/api/src/jobs/ticketNotifyWorker.ts:167-174` (assignee — staff):

```ts
  const emails: EmailPayload[] = assignee.email
    ? [{
        to: assignee.email,
        subject: `[${label}] Assigned to you: ${ticket.subject}`,
        html: `<p>You have been assigned ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
        bestEffort: true,
        purpose: 'ticket.staff_notification',
      }]
    : [];
```

`apps/api/src/jobs/ticketNotifyWorker.ts:231-237` (un-threaded requester — customer):

```ts
  if (!commentId) {
    return [{
      to: ticket.submitterEmail,
      subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
      html,
      graphMailbox,
      purpose: 'ticket.customer_notification',
      partnerId: ticket.partnerId ?? null
    }];
  }
```

`apps/api/src/jobs/ticketNotifyWorker.ts:265-272` (threaded requester — customer):

```ts
  return [{
    to: ticket.submitterEmail,
    subject: `[${label}] ${subjectPrefix}: ${ticket.subject}`,
    html,
    replyTo,
    headers,
    graphMailbox,
    purpose: 'ticket.customer_notification',
    partnerId: ticket.partnerId ?? null
  }];
```

`apps/api/src/jobs/ticketNotifyWorker.ts:345` (autoresponse — customer):

```ts
  return [{ to: event.payload.to, subject: tpl.subject, html: tpl.html, replyTo, headers, bestEffort: true, graphMailbox, purpose: 'ticket.customer_notification', partnerId: ticket.partnerId ?? null }];
```

`apps/api/src/jobs/ticketNotifyWorker.ts:416-421` (SLA breach to the owner — staff):

```ts
        emails.push({
          to: assignee.email,
          subject: `SLA breached: ${label} — ${ticket.subject}`,
          html: `<p>The ${escapeHtml(target)} SLA breached for ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
          bestEffort: true,
          purpose: 'ticket.staff_notification',
        });
```

(`ticket.partnerId` is the tickets row's own nullable `partner_id` — `apps/api/src/db/schema/portal.ts` declares it `uuid('partner_id').references(() => partners.id)` with no `.notNull()`. It is the same value the Graph-mailbox lookup two lines above already uses, so no new read is introduced.)

- [ ] **Step 5: Branch the send**

Replace `apps/api/src/jobs/ticketNotifyWorker.ts:589-595`:

```ts
      await email.sendEmail({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        replyTo: payload.replyTo,
        headers: payload.headers
      });
```

with:

```ts
      // Branch rather than spread: `purpose` is the discriminant of
      // SendEmailParams, so a union-typed value would not narrow.
      if (payload.purpose === 'ticket.customer_notification') {
        await email.sendEmail({
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          replyTo: payload.replyTo,
          headers: payload.headers,
          purpose: 'ticket.customer_notification',
          partnerId: payload.partnerId
        });
        return;
      }
      await email.sendEmail({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        replyTo: payload.replyTo,
        headers: payload.headers,
        purpose: 'ticket.staff_notification'
      });
```

(The enclosing `const send = async () => { … }` already returns after the Graph branch, so an early `return` here is the existing idiom and ends the closure, not the loop.)

- [ ] **Step 6: Run the affected tests**

```bash
cd apps/api && npx vitest run \
  src/jobs/ticketNotifyWorker.test.ts \
  src/jobs/ticketNotifyWorker.leak.test.ts \
  src/jobs/ticketNotifyWorker.graphFork.test.ts \
  src/services/ticketEventsContract.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all pass. The three worker suites read individual fields or use `expect.objectContaining`, so the added properties are invisible to them.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(email): per-payload ticket purposes

Spec §8.2 lists ticket mail as two rows but there is one send loop, so
EmailPayload becomes a discriminated union: assignee and SLA payloads are
ticket.staff_notification (platform), requester and autoresponse payloads are
ticket.customer_notification (partner/support) carrying the ticket row's own
partner_id. No new read; the Graph-mailbox precedence is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Customer-facing sends — quotes, invoices, scheduled reports

The three sites whose rendered From is actually produced by the code being moved, plus the four test files that pin it. `reportDelivery.ts`'s two sends are here together because they share one snapshot file (plan amendment 7). This task also deletes the now-dead `fromWithDisplayName` stubs from four mock factories so Task 11's grep is clean.

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts:783-791`
- Modify: `apps/api/src/services/invoicePdf.ts:890-903`
- Modify: `apps/api/src/services/reportDelivery.ts:58-62`, `:141-157`
- Modify: `apps/api/src/services/quoteLifecycle.test.ts:87`, `:636-641` (Test)
- Modify: `apps/api/src/services/invoiceResend.test.ts:86-90`, `:98-103` (Test)
- Modify: `apps/api/src/services/quoteLifecycle.supersede.test.ts:82` (Test)
- Modify: `apps/api/src/__tests__/integration/quoteSendLockRelease.integration.test.ts:53` (Test)
- Modify: `apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap` (regenerated)

**Interfaces:**
- Consumes: transitional `SendEmailParams`, `platformFallbackFrom` (indirectly, through `resolveSender`).
- Produces: `emailReportRun` and `emailReportFailure` keep their signatures; the two billing sites stop calling `EmailService.fromWithDisplayName` and pass `partnerId` + `partnerName` instead.

- [ ] **Step 1: Rewrite the two pinned From assertions (red)**

In `apps/api/src/services/quoteLifecycle.test.ts`, replace lines 636–641:

```ts
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      // Display name is the MSP ("via Breeze" keeps the platform address honest);
      // the envelope address itself stays the platform's for SPF/DKIM alignment.
      from: '"Acme MSP via Breeze" <no-reply@test.example>',
      replyTo: 'accounts@acmemsp.example',
    }));
```

with:

```ts
    // The From itself is now decided inside EmailService and pinned by
    // email.golden.test.ts ('"Acme MSP via Breeze" <EMAIL_FROM address>' for
    // quote.sent). What THIS site is responsible for is naming the purpose and
    // handing over the partner it already read.
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'quote.sent',
      partnerId: 'p1',
      partnerName: 'Acme MSP',
      replyTo: 'accounts@acmemsp.example',
    }));
    expect(sendEmailMock.mock.calls[0]![0]).not.toHaveProperty('from');
```

In `apps/api/src/services/invoiceResend.test.ts`, replace line 101:

```ts
    expect(envelope.from).toBe('Lantern MSP via Breeze <no-reply@breeze.test>');
```

with:

```ts
    // As above: the rendered From moved into EmailService (pinned by
    // email.golden.test.ts); this site supplies the purpose and the partner.
    expect(envelope.purpose).toBe('invoice.sent');
    expect(envelope.partnerId).toBe('p1');
    expect(envelope.partnerName).toBe('Lantern MSP');
    expect(envelope).not.toHaveProperty('from');
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/services/quoteLifecycle.test.ts src/services/invoiceResend.test.ts
```

Expected failure: both suites report the envelope still carries `from: '"Acme MSP via Breeze" <no-reply@test.example>'` / `'Lantern MSP via Breeze <no-reply@breeze.test>'` and no `purpose`.

- [ ] **Step 3: `apps/api/src/services/quoteLifecycle.ts:783-791`**

```ts
    await emailService.sendEmail({
      to: recipients,
      cc: opts.cc && opts.cc.length > 0 ? opts.cc : undefined,
      from: partnerName ? emailService.fromWithDisplayName(`${partnerName} via Breeze`) : undefined,
      replyTo,
      subject: template.subject, html: template.html, text: template.text,
      attachments: pdf ? [{ filename: `${quoteNumber}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
    });
```

becomes

```ts
    await emailService.sendEmail({
      to: recipients,
      cc: opts.cc && opts.cc.length > 0 ? opts.cc : undefined,
      // MSP-branded envelope: the registry's `partner_display_name` fallback
      // renders "<Partner> via Breeze" on the platform's own from-address
      // (SPF/DKIM stays aligned — we never spoof the MSP's domain) until the
      // partner has a verified sending domain. Both values come from rows this
      // function already holds, never from request input (spec §8.1).
      purpose: 'quote.sent',
      partnerId: quote.partnerId,
      partnerName: partnerName ?? null,
      replyTo,
      subject: template.subject, html: template.html, text: template.text,
      attachments: pdf ? [{ filename: `${quoteNumber}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined,
    });
```

(`quote` is `QuoteRow = typeof quotes.$inferSelect` and is destructured into this function at `quoteLifecycle.ts:665`; `partnerName` is `partnerRow?.name`, set at `:678`.)

- [ ] **Step 4: `apps/api/src/services/invoicePdf.ts:890-903`**

```ts
    await emailService.sendEmail({
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      // MSP-branded envelope, mirroring the quote send path: display name
      // "<Partner> via Breeze" on the platform address (SPF/DKIM stays
      // aligned), replies routed to the MSP's billing inbox.
      from: partner?.name ? emailService.fromWithDisplayName(`${partner.name} via Breeze`) : undefined,
      replyTo: partner?.billingEmail?.trim() || undefined,
```

becomes

```ts
    await emailService.sendEmail({
      to: recipients,
      cc: cc.length > 0 ? cc : undefined,
      // MSP-branded envelope, mirroring the quote send path: the registry's
      // `partner_display_name` fallback renders "<Partner> via Breeze" on the
      // platform address (SPF/DKIM stays aligned), replies routed to the MSP's
      // billing inbox. Both values come from rows read above (spec §8.1).
      purpose: 'invoice.sent',
      partnerId: invoice.partnerId,
      partnerName: partner?.name ?? null,
      replyTo: partner?.billingEmail?.trim() || undefined,
```

(`invoice.partnerId` is the same value the Stripe lookup at `invoicePdf.ts:867` uses; `partner` is the row selected at `:831`.)

- [ ] **Step 5: `apps/api/src/services/reportDelivery.ts:58-62`**

```ts
  await email.sendEmail({
    to: opts.recipients,
    subject: `Scheduled report failed: ${opts.reportName}`,
    html,
  });
```
becomes
```ts
  // Platform sender (spec §8.2): this tells the MSP's own people that their
  // scheduled report did not arrive — not a customer-facing deliverable.
  await email.sendEmail({
    to: opts.recipients,
    subject: `Scheduled report failed: ${opts.reportName}`,
    html,
    purpose: 'staff.report_failure',
  });
```

- [ ] **Step 6: `apps/api/src/services/reportDelivery.ts:141`**

Add two properties to the `await email.sendEmail({ … })` call that begins at line 141, immediately after `to: opts.recipients,`:

```ts
    // The scheduled report itself IS a customer deliverable — partner lane,
    // `general` stream (spec §8.2). partnerId is null in W01: emailReportRun
    // takes only address strings, a branding bag and a timezone ("touch no db
    // handle" — module docstring), and neither caller
    // (jobs/reportScheduleWorker.ts:605, services/reportNarrativeDelivery.ts:275)
    // holds a partner id either. W01 adds no reads; null resolves to the
    // platform sender, i.e. exactly today's From (§8.1).
    purpose: 'report.delivery',
    partnerId: null,
```

- [ ] **Step 7: Delete the four dead `fromWithDisplayName` mock stubs**

`apps/api/src/services/quoteLifecycle.test.ts:87` —
```ts
  return { ...actual, getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock, fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>` })) };
```
becomes
```ts
  return { ...actual, getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock })) };
```

`apps/api/src/services/quoteLifecycle.supersede.test.ts:82` — delete the whole line:
```ts
      fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>`,
```

`apps/api/src/services/invoiceResend.test.ts:86-90` —
```ts
    getEmailServiceMock.mockReturnValue({
      sendEmail: sendEmailMock,
      fromWithDisplayName: (name: string) => `${name} <no-reply@breeze.test>`,
    });
```
becomes
```ts
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
```

`apps/api/src/__tests__/integration/quoteSendLockRelease.integration.test.ts:53` — delete the whole line:
```ts
      fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>`,
```

- [ ] **Step 8: Run the tests and regenerate the report snapshots**

```bash
cd apps/api && npx vitest run src/services/quoteLifecycle.test.ts src/services/quoteLifecycle.supersede.test.ts src/services/invoiceResend.test.ts
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts
```

The first command must pass. The second FAILS first, with six snapshot mismatches each adding `"partnerId": null` and `"purpose": "report.delivery"` (or `"purpose": "staff.report_failure"` on the failure-mail snapshot). Inspect the diff — every changed line must be one of those two keys and nothing else — then accept it:

```bash
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts -u
git diff --stat apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap
```

Expected after `-u`: the suite passes and `git diff` on the `.snap` shows only added `partnerId` / `purpose` lines — no change to `html`, `text`, `subject`, `to` or `attachments`. If any other line moved, stop: the wave's acceptance criterion has been violated.

- [ ] **Step 9: Run the rest of the affected tests**

```bash
cd apps/api && npx vitest run \
  src/services/reportDelivery.threatDetection.test.ts \
  src/jobs/reportScheduleWorker.test.ts \
  src/services/reportNarrativeDelivery.test.ts \
  src/routes/quotes/lifecycle.test.ts \
  src/routes/quotesPublic.test.ts \
  src/services/email.golden.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all pass; `tsc` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/quoteLifecycle.ts apps/api/src/services/invoicePdf.ts apps/api/src/services/reportDelivery.ts apps/api/src/services/quoteLifecycle.test.ts apps/api/src/services/quoteLifecycle.supersede.test.ts apps/api/src/services/invoiceResend.test.ts apps/api/src/__tests__/integration/quoteSendLockRelease.integration.test.ts apps/api/src/services/__snapshots__/reportDelivery.snapshot.test.ts.snap
git commit -m "$(cat <<'EOF'
feat(email): classify the customer-facing sends (quote, invoice, report)

quote.sent and invoice.sent now pass purpose + partnerId + partnerName instead
of calling EmailService.fromWithDisplayName; the registry's
`partner_display_name` fallback renders exactly the same
'"<Partner> via Breeze" <EMAIL_FROM address>'. report.delivery is the partner
`general` stream with partnerId: null (emailReportRun holds no partner and W01
adds no reads, §8.1); emailReportFailure is staff.report_failure.

The two tests that pinned the literal From now pin the inputs that produce it;
the From itself is pinned once, in email.golden.test.ts. reportDelivery
snapshots regenerated: only partnerId/purpose keys added.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The flip — `purpose` required, `from` removed

Every call site now names a purpose, so the transitional escape hatch closes. This is the task that delivers spec G5: after it, an unclassified send does not compile.

**Files:**
- Modify: `apps/api/src/services/email.ts` (the transitional `SendEmailParams`, `sendEmail`'s body, and the `fromWithDisplayName` method)
- Modify: `apps/api/src/services/email.test.ts:84`, `:140`, `:180`, `:222`, `:309`, `:430`, `:446`, `:488` (Test)
- Modify: `apps/api/src/services/email.headers.test.ts:29`, `:56`, `:83`, `:114` (Test)

**Interfaces:**
- Consumes: `PlatformMailPurpose`, `PartnerLaneMailPurpose` from `./emailDomains/mailPurposes`.
- Produces (the plan index's W01 contract, final form):
  ```ts
  export type SendEmailParams = SendEmailBase & (
    | { purpose: PlatformMailPurpose; partnerId?: never; partnerName?: never }
    | { purpose: PartnerLaneMailPurpose; partnerId: string | null; partnerName?: string | null }
  );
  ```
  `EmailService.fromWithDisplayName` no longer exists.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/services/email.golden.test.ts`:

```ts
describe('the sender contract is compile-enforced (spec G5)', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  it('rejects an unclassified send and a raw from at the type level', async () => {
    const svc = await service();
    // @ts-expect-error — no `purpose`: every send must declare what it is.
    await expect(svc.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>' })).resolves.toBeUndefined();
    await expect(svc.sendEmail({
      to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'ops.alert',
      // @ts-expect-error — the raw `from` is gone; the registry decides it.
      from: 'spoof@evil.test',
    })).resolves.toBeUndefined();
    // A platform purpose cannot smuggle a partner in.
    await expect(svc.sendEmail({
      to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'ops.alert',
      // @ts-expect-error — partnerId is `never` on the platform branch.
      partnerId: PARTNER_ID,
    })).resolves.toBeUndefined();
    // A partner purpose MUST state its partner, even when that is null.
    // @ts-expect-error — missing required `partnerId`.
    await expect(svc.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'quote.sent' })).resolves.toBeUndefined();
  });

  it('EmailService no longer exposes fromWithDisplayName', async () => {
    const svc = await service();
    expect((svc as unknown as Record<string, unknown>).fromWithDisplayName).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/email.golden.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected failure: `tsc` reports four `Unused '@ts-expect-error' directive.` errors (the transitional type still permits all four shapes), and the runtime test fails with `expected [Function] to be undefined`.

- [ ] **Step 3: Replace the transitional `SendEmailParams`**

In `apps/api/src/services/email.ts`, replace the whole transitional block added in Task 3:

```ts
/**
 * TRANSITIONAL (W01 Task 3 → Task 8). …
 */
export interface SendEmailParams extends SendEmailBase {
  from?: string;
  purpose?: MailPurpose;
  partnerId?: string | null;
  partnerName?: string | null;
}
```

with:

```ts
/**
 * Every send declares WHAT IT IS; `services/emailDomains/mailPurposes.ts`
 * decides who it is from. There is no raw `from`: an unclassified send does
 * not compile (spec G5), and a spoofed envelope address is unrepresentable.
 *
 * A partner-lane purpose MUST state its partner — `null` is allowed and means
 * "the platform sender", for call sites that cannot always resolve one. It has
 * to come from a row the call site already read or from the verified auth
 * context, never from request input (spec §8.1).
 */
export type SendEmailParams = SendEmailBase & (
  | { purpose: PlatformMailPurpose; partnerId?: never; partnerName?: never }
  | { purpose: PartnerLaneMailPurpose; partnerId: string | null; partnerName?: string | null }
);
```

and change the type import at the top of the file from

```ts
import type { MailPurpose } from './emailDomains/mailPurposes';
```

to

```ts
import type { PartnerLaneMailPurpose, PlatformMailPurpose } from './emailDomains/mailPurposes';
```

- [ ] **Step 4: Simplify `sendEmail`**

Replace the `sendEmail` body written in Task 3 with:

```ts
  async sendEmail(params: SendEmailParams): Promise<void> {
    const { to, cc, subject, html, text, replyTo, headers, attachments } = params;

    const resolved = await resolveSender({
      purpose: params.purpose,
      partnerId: params.partnerId ?? null,
      partnerName: params.partnerName ?? null,
      defaultFrom: this.defaultFrom,
    });

    await this.deliverRaw({
      to,
      cc,
      subject,
      html,
      text,
      replyTo,
      headers,
      attachments,
      from: resolved.from,
    });
  }
```

- [ ] **Step 5: Delete `EmailService.fromWithDisplayName`**

Delete `apps/api/src/services/email.ts:225-238` in full — the JSDoc block starting `  /**\n   * The default sender with a custom display name` through the method's closing `  }`. Its logic now lives in `services/emailDomains/senderResolution.ts` (Task 2) and nothing outside that module may reach it: the envelope address is a resolver decision, not a caller's.

- [ ] **Step 6: Give `email.test.ts`'s eight direct sends a purpose**

Every one of these is a transport-mechanics test, so any platform purpose does; use `ops.alert` throughout. In `apps/api/src/services/email.test.ts`, add `purpose: 'ops.alert'` as the last property of each of these `sendEmail({ … })` calls (original line numbers; they shift as you edit):

| Line | Test |
|---|---|
| 84 | `uses Resend in auto mode when resend config is present` |
| 140 | `uses SMTP when EMAIL_PROVIDER is smtp` |
| 180 | `falls back to SMTP in auto mode when resend is not configured` |
| 222 | `uses Mailgun when EMAIL_PROVIDER is mailgun` |
| 309 | `falls back to Mailgun in auto mode when resend and smtp are not configured` |
| 430 | `passes an AbortSignal on the Mailgun form-data (attachment) send` |
| 446 | `passes an AbortSignal on the Mailgun urlencoded (no-attachment) send` |
| 488 | `surfaces a Mailgun timeout as a named, actionable error…` |

For example, line 446:

```ts
    await service!.sendEmail({ to: 'user@example.com', subject: 'Proposal', html: '<p>hi</p>' });
```
becomes
```ts
    await service!.sendEmail({ to: 'user@example.com', subject: 'Proposal', html: '<p>hi</p>', purpose: 'ops.alert' });
```

and line 140:

```ts
    await service!.sendEmail({
      to: ['user@example.com'],
      subject: 'SMTP Test',
      html: '<p>Hello SMTP</p>',
      replyTo: 'help@example.com'
    });
```
becomes
```ts
    await service!.sendEmail({
      to: ['user@example.com'],
      subject: 'SMTP Test',
      html: '<p>Hello SMTP</p>',
      replyTo: 'help@example.com',
      purpose: 'ops.alert'
    });
```

The two `sendEmailChanged` calls at lines 257 and 288 need no change — that helper hard-codes its purpose.

- [ ] **Step 7: Give `email.headers.test.ts`'s four sends a purpose**

These exercise ticket threading headers, so the honest purpose is the ticket one. In `apps/api/src/services/email.headers.test.ts`, add to the calls at lines 29, 56, 83 and 114:

```ts
      purpose: 'ticket.customer_notification',
      partnerId: null,
```

For example, line 114:

```ts
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', 'In-Reply-To': '<a@x>', 'Auto-Submitted': 'auto-replied' },
    });
```
becomes
```ts
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', 'In-Reply-To': '<a@x>', 'Auto-Submitted': 'auto-replied' },
      purpose: 'ticket.customer_notification',
      partnerId: null,
    });
```

- [ ] **Step 8: Run everything touched and the typecheck**

```bash
cd apps/api && npx vitest run src/services/email.test.ts src/services/email.headers.test.ts src/services/email.golden.test.ts
pnpm exec tsc --noEmit --project tsconfig.json
```

Expected: all three suites pass; `tsc` prints nothing. A `tsc` error naming any other file means a call site was missed — fix it there, in this task.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/email.test.ts apps/api/src/services/email.headers.test.ts apps/api/src/services/email.golden.test.ts
git commit -m "$(cat <<'EOF'
feat(email)!: purpose is required, raw `from` is gone (spec G5)

SendEmailParams becomes the discriminated union from the plan index: a platform
purpose cannot carry a partner, a partner purpose must state one (null allowed),
and there is no `from` — the envelope address is a resolver decision.
EmailService.fromWithDisplayName is deleted; its logic lives in
services/emailDomains/senderResolution.ts.

An unclassified send now fails to compile, which is the guard the whole feature
rests on: no future email can reach a customer without someone deciding which
lane it belongs to.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The two source-scan guards

`deliverRaw` is the one place a From can be chosen freely. It exists for W02's `static`/`fake` adapters and the test send — and for nothing else, or the classification G5 depends on leaks straight back out. The second scan keeps the registry honest in the other direction: an entry nobody sends is an entry nobody reviewed.

**Files:**
- Create: `apps/api/src/services/email.deliverRawScope.test.ts` (Test)
- Create: `apps/api/src/services/emailDomains/mailPurposes.callSites.test.ts` (Test)

**Interfaces:**
- Consumes: `MAIL_PURPOSES` (Task 1); the shipped source tree.
- Produces: nothing at runtime.

- [ ] **Step 1: Write the `deliverRaw` scope guard** — create `apps/api/src/services/email.deliverRawScope.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');

/**
 * `deliverRaw` takes an explicit From and asks no questions. It exists for the
 * partner-lane adapters (`static`, `fake`) and the domain test send, which
 * legitimately hand a custom sender to the platform transport (plan index
 * amendment 2). Anywhere else it is a hole straight through the sender
 * contract: a call site that picks its own From has not been classified, and
 * G5's compile-time guard stops meaning anything.
 *
 * Test files are exempt: a suite that mocks or asserts on deliverRaw is not a
 * production sender.
 */
const ALLOWED = new Set(['services/email.ts']);
const ALLOWED_PREFIX = `services${sep}emailDomains${sep}`;

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

describe('deliverRaw scope contract', () => {
  it('is called from services/email.ts and services/emailDomains/** and nowhere else', () => {
    const violations = productionTypeScriptFiles(SRC_DIR).flatMap((absolute) => {
      const file = relative(SRC_DIR, absolute);
      if (ALLOWED.has(file.split(sep).join('/')) || file.startsWith(ALLOWED_PREFIX)) return [];
      return /\bdeliverRaw\s*\(/.test(readFileSync(absolute, 'utf8')) ? [file] : [];
    });
    expect(violations).toEqual([]);
  }, 30000);

  // Control: the scan actually reads files and the pattern actually matches,
  // so an empty result means "nobody calls it", not "nothing was scanned".
  it('does find deliverRaw where it is allowed to be', () => {
    const emailService = readFileSync(join(SRC_DIR, 'services', 'email.ts'), 'utf8');
    expect(/\bdeliverRaw\s*\(/.test(emailService)).toBe(true);
    expect(productionTypeScriptFiles(SRC_DIR).length).toBeGreaterThan(100);
  }, 30000);
});
```

- [ ] **Step 2: Write the no-dead-entries scan** — create `apps/api/src/services/emailDomains/mailPurposes.callSites.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_PURPOSES, type MailPurpose } from './mailPurposes';

const SRC_DIR = join(__dirname, '..', '..');
const REGISTRY_FILE = `services${sep}emailDomains${sep}mailPurposes.ts`;

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

describe('every mail purpose has a send site (spec §8.1, property 2)', () => {
  it('has no dead registry entries', () => {
    const sources = productionTypeScriptFiles(SRC_DIR)
      .filter((absolute) => relative(SRC_DIR, absolute) !== REGISTRY_FILE)
      .map((absolute) => readFileSync(absolute, 'utf8'));

    // Control first: the corpus is real and excludes the registry, so an
    // all-green result cannot come from having scanned nothing.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.includes(`'ops.alert'`))).toBe(true);

    const unreferenced = (Object.keys(MAIL_PURPOSES) as MailPurpose[])
      .filter((purpose) => !sources.some((source) => source.includes(`'${purpose}'`)));

    // A purpose nobody sends is a classification nobody reviewed. Either wire
    // up the send site or delete the entry — do not allowlist it here.
    expect(unreferenced).toEqual([]);
  }, 30000);
});
```

- [ ] **Step 3: Run both and watch them pass**

```bash
cd apps/api && npx vitest run src/services/email.deliverRawScope.test.ts src/services/emailDomains/mailPurposes.callSites.test.ts
```

Expected: `Test Files  2 passed (2)`, 3 tests passed. If `unreferenced` is non-empty, a call site from Tasks 4–7 was missed — go back and wire it up rather than trimming the registry.

- [ ] **Step 4: Prove the guards bite (control mutation, then revert)**

```bash
cd apps/api && printf '\nexport const __scopeGuardProbe = (): void => { void (0 as unknown as { deliverRaw(): void }).deliverRaw(); };\n' >> src/services/opsAlerts.ts
cd apps/api && npx vitest run src/services/email.deliverRawScope.test.ts
```

Expected: FAILS with `expected [ 'services/opsAlerts.ts' ] to deeply equal []`. Then revert:

```bash
git checkout -- apps/api/src/services/opsAlerts.ts
cd apps/api && npx vitest run src/services/email.deliverRawScope.test.ts
```

Expected: passes again. (Scoped to the one file — never `git checkout -- .` in a shared worktree.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.deliverRawScope.test.ts apps/api/src/services/emailDomains/mailPurposes.callSites.test.ts
git commit -m "$(cat <<'EOF'
test(email): source-scan guards for deliverRaw scope and dead registry entries

deliverRaw may be called only from services/email.ts and
services/emailDomains/** — anywhere else is a hole through the sender contract.
And every MAIL_PURPOSES entry must be referenced by a non-test source file: a
purpose nobody sends is a classification nobody reviewed. Both scans carry a
control assertion so an empty violation list cannot mean an empty corpus.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Verification

**Files:**
- Modify: none (this task only runs commands; fix in the owning task if anything fails).

**Interfaces:**
- Consumes: everything above.
- Produces: a green wave.

- [ ] **Step 1: Typecheck the whole API project, including its tests**

```bash
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no output. (`apps/api/tsconfig.json` sets `"include": ["src/**/*"]`, so every `*.test.ts` under `src/` is type-checked — this is the pass that proves no call site or test still constructs a `SendEmailParams` without a purpose.)

- [ ] **Step 2: Typecheck the other workspaces that CI type-checks separately**

```bash
pnpm --filter @breeze/shared typecheck
pnpm --filter @breeze/ext-workspace typecheck
```

Expected: both pass. Neither imports `EmailService` (verified: `grep -rn "getEmailService\|EmailService" ee packages --include='*.ts'` returns nothing), so this is a regression check, not an expected-change check.

- [ ] **Step 3: Run every test file this wave touched**

```bash
cd apps/api && npx vitest run \
  src/services/emailDomains/mailPurposes.test.ts \
  src/services/emailDomains/mailPurposes.callSites.test.ts \
  src/services/emailDomains/senderResolution.test.ts \
  src/services/email.test.ts \
  src/services/email.headers.test.ts \
  src/services/email.golden.test.ts \
  src/services/email.deliverRawScope.test.ts \
  src/services/quoteLifecycle.test.ts \
  src/services/quoteLifecycle.supersede.test.ts \
  src/services/invoiceResend.test.ts \
  src/services/reportDelivery.snapshot.test.ts \
  src/services/reportDelivery.threatDetection.test.ts \
  src/services/reportNarrativeDelivery.test.ts \
  src/services/opsAlerts.test.ts \
  src/services/quoteOutcomeNotify.test.ts \
  src/services/contractRenewal.sweepScope.test.ts \
  src/services/aiToolsGoogle.test.ts \
  src/services/tenantOffboarding.test.ts \
  src/services/ticketEventsContract.test.ts \
  src/jobs/ticketNotifyWorker.test.ts \
  src/jobs/ticketNotifyWorker.leak.test.ts \
  src/jobs/ticketNotifyWorker.graphFork.test.ts \
  src/jobs/authEmailWorker.test.ts \
  src/jobs/aiBudgetAlertDelivery.test.ts \
  src/jobs/mfaEnrollmentNotice.test.ts \
  src/jobs/reportScheduleWorker.test.ts \
  src/modules/mcpInvites/tools/sendDeploymentInvites.test.ts \
  src/routes/users.test.ts \
  src/routes/orgPortalUsers.test.ts \
  src/routes/portal/auth.test.ts \
  src/routes/auth/login.test.ts \
  src/routes/auth/accountDeletion.test.ts \
  src/routes/auth/accountDeletion.admin.test.ts \
  src/routes/quotes/lifecycle.test.ts \
  src/routes/quotesPublic.test.ts
```

Expected: every file passes. Each path is a full filename, not a directory prefix — vitest's path filter is a plain substring, so a trailing slash would silently skip dotted siblings (`auth.test.ts` vs `auth/`). Check the reported file count matches the number of paths listed; if a path reports "No test files found", correct the path rather than dropping it.

- [ ] **Step 4: Run the full API unit suite**

```bash
cd apps/api && npx vitest run
```

Expected: the whole suite green. This is the only run that catches a mock factory elsewhere in the repo whose `sendEmail` stub asserts an envelope shape.

- [ ] **Step 5: Prove no raw `from` and no `fromWithDisplayName` caller survives**

```bash
git grep -n "fromWithDisplayName" -- apps ee packages
```

Expected output, exactly these two files and nothing else:

```
apps/api/src/services/emailDomains/senderResolution.test.ts:...
apps/api/src/services/emailDomains/senderResolution.ts:...
```

```bash
git grep -n "from:" -- apps/api/src/services/quoteLifecycle.ts apps/api/src/services/invoicePdf.ts
```

Expected: no output. (Before this wave these were the only two `from:` lines in those files: `quoteLifecycle.ts:786` and `invoicePdf.ts:896`.)

```bash
git grep -n "from?: string" -- apps/api/src/services/email.ts
```

Expected: no output — `SendEmailParams` no longer has an optional `from`, and `RawEmailMessage`'s is required.

```bash
git grep -n "deliverRaw" -- apps ee packages
```

Expected: matches only in `apps/api/src/services/email.ts` and `apps/api/src/services/email.deliverRawScope.test.ts`.

- [ ] **Step 6: Confirm the wave added no migration, no env var and no schema**

```bash
git diff --stat main...HEAD -- apps/api/migrations apps/api/src/db apps/api/src/config .env.example deploy
```

Expected: no output. W01 is types and call sites only (spec §15 row W01, G7).

- [ ] **Step 7: Lint**

```bash
pnpm --filter @breeze/api lint
```

Expected: clean.

---

## Self-review

| Requirement | Source | Task |
|---|---|---|
| Central purpose registry, one entry per §8.2 row | spec §8.1, index "Defined in W01" | 1 |
| `PartnerMailStream`, `MailPurposePolicy`, `MAIL_PURPOSES`, `MailPurpose`, `PartnerLaneMailPurpose`, `PlatformMailPurpose`, `mailPurposePolicy` verbatim from the index | index contract block | 1 |
| `staff.sending_domain_status` and `sending_domain.test` NOT in the registry | index amendment 5 | 1 (asserted) |
| Registry property: a platform purpose never yields a partner lane, whatever `partnerId` | spec §8.1, §14 | 2 |
| Registry property: resolution returns before any DB access | spec §8.1, §14 | 2 (db-proxy tripwire + reason matrix) |
| Registry property: every purpose has a send site | spec §8.1, §14 | 9 |
| `PlatformLaneReason`, `ResolvedSender`, `ResolveSenderInput`, `resolveSender`, `platformFallbackFrom` verbatim from the index | index contract block | 2 |
| `fromWithDisplayName` moves to the resolver as a pure function over `defaultFrom`; the `EmailService` method is removed | index W01 scope, spec §8.1 | 2 (move), 8 (removal) |
| Fallback From: `default` vs `partner_display_name`, only quote/invoice | spec §8.3 | 1 (pinned), 2 (implemented) |
| `SendEmailBase`, `RawEmailMessage`, `deliverRaw` (today's transport body, explicit `from`), `sendEmail` = resolve → deliver | index contract block, amendment 2 | 3 (introduced), 8 (final form) |
| `SendEmailParams` discriminated union; `from` removed; `purpose` required | index contract block, spec G5 | 8 |
| `partnerName` travels with the send | index amendment 4 | 3 (type), 7 (the two call sites) |
| Named helpers hard-code a purpose, or take one where two audiences share them | spec §8.1 | 4 |
| All 27 production send sites classified per §8.2 | spec §8.2 (normative) | 4 (6 sites), 5 (10), 6 (5 payloads / 1 call), 7 (4) |
| `partnerId` from a row already read or the verified auth context, never request input | spec §8.1 | 4 (orgPortalUsers), 6 (ticket row), 7 (quote/invoice rows) |
| `partnerId: null` where none is in hand, with no new DB read | spec §8.1, plan amendment 5 | 4 (portal reset), 7 (report delivery) |
| Golden test: every purpose × `resend`/`smtp`/`mailgun`, From/Reply-To/headers byte-identical | spec §14 "W01 golden test", §15 | 3 |
| Mailgun `cc` drop pinned as-is, not fixed | index amendment 6 | 3 (golden assertion), 3 (deliverRaw comment) |
| `deliverRaw` reachable only from `services/email.ts` and `services/emailDomains/` | index contract block `@internal` | 9 |
| The three tests pinning the literal platform From updated, keeping their fallback assertions | spec §14 `sendEmail` bullet | 7 (`quoteLifecycle.test.ts`, `invoiceResend.test.ts`), 8 (`email.test.ts`) |
| No rendered email changes; hosted state after merge = no behaviour change | spec §15 row W01 | 3, 7, 10 |
| No new env var, no migration, no boot refusal | spec G7, §15 | 10 (Step 6) |
| Branch, `Closes #6181`, commit trailer, `cd apps/api && npx vitest run <path>` | index "Rules every wave inherits" | Global Constraints, every task |
