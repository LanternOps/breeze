# Hosted QuickBooks Production Registration Design

**Date:** 2026-08-29  
**Status:** Approved for Intuit-side configuration

## Goal

Enable the existing Intuit Developer app named **Breeze** for private production use by Breeze Cloud customers in both hosted regions. This is production OAuth enablement, not a QuickBooks App Marketplace launch.

## Chosen approach

Use one Intuit app for both Breeze Cloud regions. Register a distinct OAuth redirect URI for each region while keeping the US deployment as the primary launch surface in Intuit's single-value app URL fields.

Alternatives considered:

- Separate US and EU Intuit apps: stronger administrative separation, but duplicates credentials, compliance work, monitoring, and support.
- US-only initial registration: simpler, but prevents EU-hosted customers from connecting QuickBooks and creates avoidable follow-up work.

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

## Current product behavior represented to Intuit

Breeze lets an authenticated partner administrator connect one QuickBooks Online company to the partner account using OAuth. Breeze stores encrypted OAuth tokens, refreshes rotated tokens, reads QuickBooks customer records, and lets the administrator import selected customers as Breeze organizations and default sites. Connection changes and customer imports require Breeze authorization controls, including MFA for privileged mutations.

Invoice/item push, payment reconciliation, and QuickBooks webhooks are not represented as live production capabilities because their provider methods remain unimplemented.

## Compliance questionnaire principles

- Answer only for capabilities currently implemented and deployed.
- Describe Breeze as a business-to-business RMM/PSA platform used by MSPs and internal IT teams.
- State that QuickBooks access is initiated by an authenticated partner administrator and is limited to the accounting scope.
- State that OAuth credentials and tokens are encrypted at rest and excluded from logs and user-facing status responses.
- State that customer data is tenant-isolated and access is authorization-controlled.
- Do not claim a certification that Breeze does not hold.
- Do not claim marketplace availability, payment processing, lending, insurance, or investment services.

## Credential handling

Production client credentials are secrets. They must not be pasted into chat, committed to the repository, or written into tracked configuration. After Intuit unlocks them, place them directly into the hosted secret configuration for each region:

- Same `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in both regions.
- Region-specific `QBO_REDIRECT_URI` matching the registered callback for that region.
- `QBO_ENVIRONMENT=production` in both regions.

Credential creation/reveal and any final compliance submission require an explicit action-time confirmation.

## Validation

After Intuit configuration and hosted secret deployment:

1. Confirm both redirect URIs appear exactly in Intuit production settings.
2. Start OAuth from the Accounting integration page in each hosted region.
3. Verify the Intuit consent screen requests only QuickBooks accounting access.
4. Complete a sandbox or controlled production connection in each region.
5. Verify Breeze reports the connection without exposing tokens.
6. Load QuickBooks customers and import one controlled test customer.
7. Disconnect and confirm the Breeze connection record is removed.

## Out of scope

- Public QuickBooks App Marketplace listing.
- Implementing invoice/item push, payment pull-back, or webhooks.
- Changing production infrastructure outside the four QuickBooks environment variables.
- Creating separate regional Intuit apps.
