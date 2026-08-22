# Quote Decline — Completing the Loop

**Date:** 2026-08-21
**Status:** Draft
**Sibling spec:** `2026-08-21-public-invoice-pay-link-design.md` (independent work — separate PR)

## Problem

Declining a quote works mechanically (public `POST /quotes/public/:token/decline` — race-safe, single-use, reason captured; `declineQuoteByActor` for MSP-side marking) but the loop never closes:

1. **The MSP is never notified.** The decline handler writes the row and returns. The reserved `quote-events` bus only defines `quote.viewed`, and nothing consumes it. A tech finds out a proposal died only by opening it.
2. **`decline_reason` is write-only.** Captured from the customer, stored on the row, displayed nowhere — not in `QuoteDetail`, not in any email. The single most actionable piece of sales feedback is discarded.
3. **The customer decline UX is `window.prompt()`** (`PublicQuoteView.tsx` `decline()`): a native browser prompt — single-line, unstyled, untranslatable, jarring against the branded proposal page. Reads as broken.
4. **No visible declined → revised path.** Declined is a settled state (re-send correctly blocked by `assertLinkableQuote`); the recovery path is `cloneQuote` ("Duplicate"), but nothing on a declined quote points at it.

## Changes

### A. Notify the MSP on decline (and on accept, same mechanism)

Post-commit, fire-and-forget email from the decline handler (both public and portal paths), mirroring every other lifecycle email (swallowed failures, never blocks the customer response):

- **To:** the quote's `created_by` user's email; fallback partner `billing_email`.
- **Subject:** `Quote Q-2026-0042 declined — <org name>`
- **Body:** who (signer name if the portal path knows it, else the org), when, the **verbatim reason** (escaped, newlines preserved — same treatment as composer notes), and a button to the quote in the web app (`<appBase>/billing/quotes#<id>` per the hash-state convention).
- Accept gets the same treatment (`Quote accepted — invoice INV-xxxx issued`) — today acceptance is also silent; the MSP notices when an invoice appears. Small, same wiring, do it in the same PR.
- Extend the `QuoteEvent` union with `quote.declined` / `quote.accepted` and emit them too — keeps the reserved bus honest for future webhooks; the email does not wait on a worker.

Explicitly **not** building: per-tech notification preferences, in-app notification center entries, digest batching. One email to the sender is the 90% win.

### B. Surface the reason in the MSP UI

- `QuoteDetail` lifecycle strip: the Declined stage is already rendered (danger token). Underneath it, when `decline_reason` is non-empty, render a quoted block: *"Customer's note: '<reason>'"* — same muted style as the recipients line.
- Declined-state banner at the top of the detail (see D) repeats the reason so it isn't buried.
- No list-view change (status pill already shows Declined).

### C. Replace `window.prompt` with an inline decline flow (public page + portal)

- "Decline" opens an inline panel (not a browser prompt, not a modal — matches the accept panel's inline signature pattern): optional multiline textarea ("Anything you'd like us to know? (optional)", `maxLength` matching the API schema), **Confirm decline** + **Cancel**.
- On success: the existing declined confirmation state, plus *"Thanks — <partner name> has been notified."* (true once A ships).
- Same replacement in the portal's authenticated `QuoteDetailView` if it shares the prompt pattern.
- i18n: all new strings through the billing namespace across all 8 locales (translation-coverage test will enforce).

### D. Declined → revise affordance

- On a declined quote, `QuoteDetail` shows a banner: **Declined <date>** — *"<reason>"* — with a **Duplicate & revise** button that opens the existing clone dialog (title prefilled `<title> (revised)`).
- No new API. No un-decline/reopen state transition — the audit trail of the declined quote stays intact; revision is a new document. If a partner asks for true reopen later, that's its own decision.

## Test contract

- Decline (public + portal) dispatches the notification email — recipient resolution (creator → partner fallback), reason escaping (HTML + newlines), and the swallow-on-failure guarantee (customer still gets 200).
- `quote.declined` / `quote.accepted` events enqueued post-commit only.
- Web: reason renders when present, absent block when null; clone dialog opens prefilled from the banner.
- Public page: decline panel submits reason verbatim; empty reason → `reason: undefined` (not `''`).
