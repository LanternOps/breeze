---
spec: docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md
tracking_issue: (set by feature-lifecycle register_feature)
---

# Xero Accounting Integration — Program Index

> **For agentic workers:** this is the index. Each wave has its own plan; start with `get_feature_status` (feature-lifecycle), never with this file's status column.

**Goal:** Xero as a second accounting provider at full QuickBooks parity, on a provider-neutral accounting core.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md` (approved 2026-09-26, Codex quorum adopted).

## Waves

| Wave | Plan | Ships | Depends on | Xero capabilities after merge |
|---|---|---|---|---|
| W01 Core neutralization | `2026-09-26-xero-w01-core-neutralization.md` | resolver, one-provider index, neutral errors, capabilities, totals invariant, rate limiter, generic API/web shell, guard test. **No QBO behaviour change.** | — | none (Xero not registered) |
| W02 Xero connection | written at wave start | OAuth + `authEventId` tenant picker, tokens, org settings, 3 new columns, targeted disconnect, env/compose | W01 | `connect` |
| W03 Contacts, items, import | written at wave start | contact/item upsert with adoption, mapping workbench, import | W02 | `+ mapping, customerImport` |
| W04 Invoice push + void | written at wave start | ACCREC push, tax allocation, variant idempotency keys, void | W03 | `+ invoicePush` |
| W05 Payments | written at wave start | `/webhooks/xero`, If-Modified-Since reconcile, payment push/delete | W04 | `+ paymentPull, paymentPush` |

**Why W02–W05 plans are deferred:** they are written against W01's concrete seam (`AccountingProviderError`, `capabilities`, `resolveActiveConnection`, limiter API). Writing them now would bake in names W01 may still change; each is authored (and cross-checked by Codex) when its wave starts, from this index + the spec + W01 as merged.

## Cross-wave contracts (fixed by the spec — do not re-decide per wave)

- One accounting connection per partner (unique `accounting_connections(partner_id)`); 409 `accounting_provider_conflict`.
- Job payloads carry `connectionId`; destination never reinterpreted; legacy (no `connectionId`) jobs are QBO-only.
- Providers own idempotency keys; QBO `requestid`s are byte-identical to pre-W01.
- Adoption lookup (marker/`Reference`/`ContactNumber`/`Code`) before every create and after every uncertain outcome.
- Capabilities gate routes, producers, workers and UI.
- Pushed line totals must equal Breeze totals; both tax and total compared after push.
- Remote entity types stay `Customer`/`Item`/`Invoice`/`Payment`.
- No new tables; `accounting_*` stay partner-axis RLS (shape 3).

## Lab

`docs/integrations/xero-demo-verification.md` (created in W02, extended per wave) against the Xero Demo Company. Settles spec "Open verification items" 1–4.

## Owner actions (not waves)

- Register the hosted Xero app; set `XERO_*` on EU + US droplets (env + compose `environment:` block).
- Choose Xero tier / certification before the 6th hosted connection.
