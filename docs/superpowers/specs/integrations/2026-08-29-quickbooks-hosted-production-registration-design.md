# Hosted QuickBooks Production Registration Design

**Date:** 2026-08-29  
**Status:** Approved as the production-launch phase of the full QuickBooks sync program

## Goal

Deliver the full QuickBooks accounting loop and then enable the existing Intuit Developer app named **Breeze** for private production use by Breeze Cloud customers in both hosted regions. This is production OAuth enablement, not a QuickBooks App Marketplace launch.

The detailed accounting data model and provider architecture remain governed by `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md`. This document fixes the delivery order and the hosted Intuit registration contract.

## Chosen approach

Use one Intuit app for both Breeze Cloud regions. Register a distinct OAuth redirect URI for each region while keeping the US deployment as the primary launch surface in Intuit's single-value app URL fields.

Alternatives considered:

- Separate US and EU Intuit apps: stronger administrative separation, but duplicates credentials, compliance work, monitoring, and support.
- US-only initial registration: simpler, but prevents EU-hosted customers from connecting QuickBooks and creates avoidable follow-up work.

## Delivery sequence

Production registration is the final phase, not the first:

1. **Customer and item mapping:** preserve the existing QuickBooks customer import; add confirmed external mappings and QuickBooks customer/item upsert behavior.
2. **Invoice push:** push issued invoices through an idempotent, retryable queue; support manual/automatic modes and invoice voiding.
3. **Payment reconciliation:** verify Intuit webhooks, fetch authoritative payment/invoice state, record payments idempotently, and run scheduled CDC reconciliation as a missed-event backstop.
4. **Production launch:** complete an end-to-end sandbox test, submit the Intuit assessment using verified capabilities, register both hosted callbacks, and deploy production credentials securely.

Each implementation phase gets its own plan and verification gate. Do not describe a later phase to Intuit as live until its sandbox verification passes.

## Intuit app configuration

Keep the existing **Breeze** app and its existing App ID. Do not create a duplicate app.

App details:

- App name: `Breeze`
- Product/API: QuickBooks Online Accounting API
- OAuth scope: `com.intuit.quickbooks.accounting`
- Marketplace listing: not part of this work
- Regulated industries: `None of the above`
- Existing legal URLs:
  - End-user terms: `https://breezermm.com/legal/terms-of-service/`
  - Privacy policy: `https://breezermm.com/legal/privacy-policy/`

Primary app URLs:

- Host domain: `us.2breeze.app`
- Launch URL: `https://us.2breeze.app/integrations#accounting`
- Disconnect URL: `https://us.2breeze.app/integrations#accounting`
- Connect/reconnect URL: `https://us.2breeze.app/integrations#accounting`

Production OAuth redirect URIs:

- `https://us.2breeze.app/api/v1/accounting/quickbooks/callback`
- `https://eu.2breeze.app/api/v1/accounting/quickbooks/callback`

The `/api/v1` prefix is required. Both deployed endpoints were verified to reach the API and return validation responses when called without OAuth parameters. The older documentation example without `/api/v1` resolves to the web application and returns 404.

## Required product behavior before production submission

Breeze lets an authenticated partner administrator connect one QuickBooks Online company to the partner account using OAuth. Breeze stores encrypted OAuth tokens, refreshes rotated tokens, reads QuickBooks customer records, and lets the administrator import selected customers as Breeze organizations and default sites. Connection changes and customer imports require Breeze authorization controls, including MFA for privileged mutations.

Before production submission, Breeze must additionally:

- Reconcile and confirm Breeze organization/catalog mappings to QuickBooks Customers and Items.
- Push issued Breeze invoices to QuickBooks idempotently, with dependency ordering, retry visibility, configurable manual/automatic mode, and void support.
- Verify Intuit webhook signatures and reconcile authoritative QuickBooks Payment/Invoice changes back into Breeze.
- Run scheduled CDC reconciliation to catch dropped or delayed webhook events.
- Preserve external IDs and QuickBooks sync tokens in dedicated partner-scoped mapping records rather than core billing tables.

## Compliance questionnaire principles

- Answer only for capabilities implemented and verified in the QuickBooks sandbox.
- Describe Breeze as a business-to-business RMM/PSA platform used by MSPs and internal IT teams.
- State that QuickBooks access is initiated by an authenticated partner administrator and is limited to the accounting scope.
- State that OAuth credentials and tokens are encrypted at rest and excluded from logs and user-facing status responses.
- State that customer data is tenant-isolated and access is authorization-controlled.
- Do not claim a certification that Breeze does not hold.
- Distinguish payment reconciliation from payment processing: Breeze reflects QuickBooks payment state but does not use the QuickBooks Payments API or move money.
- Do not claim marketplace availability, lending, insurance, or investment services.

## Credential handling

Production client credentials are secrets. They must not be pasted into chat, committed to the repository, or written into tracked configuration. After Intuit unlocks them, place them directly into the hosted secret configuration for each region:

- Same `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in both regions.
- Region-specific `QBO_REDIRECT_URI` matching the registered callback for that region.
- `QBO_ENVIRONMENT=production` in both regions.

Credential creation/reveal and any final compliance submission require an explicit action-time confirmation.

## Validation

Before Intuit production submission:

1. Connect a QuickBooks sandbox company.
2. Confirm or create a controlled Customer and Item mapping.
3. Push an issued test invoice and verify amounts, tax, line detail, remote ID, and sync token.
4. Retry the same push and verify no duplicate QuickBooks invoice is created.
5. Void the test invoice and verify QuickBooks reflects the void.
6. Create partial and final payments in QuickBooks and verify webhook-driven reconciliation updates Breeze idempotently.
7. Replay a webhook and run the CDC sweep to verify neither path duplicates payments.

After Intuit configuration and hosted secret deployment:

1. Confirm both redirect URIs appear exactly in Intuit production settings.
2. Start OAuth from the Accounting integration page in each hosted region.
3. Verify the Intuit consent screen requests only QuickBooks accounting access.
4. Complete a controlled production connection in each region.
5. Verify Breeze reports the connection without exposing tokens.
6. Run a controlled customer/item/invoice/payment round trip.
7. Disconnect and confirm the Breeze connection record is removed.

## Out of scope

- Public QuickBooks App Marketplace listing.
- Changing production infrastructure outside the four QuickBooks environment variables.
- Creating separate regional Intuit apps.
