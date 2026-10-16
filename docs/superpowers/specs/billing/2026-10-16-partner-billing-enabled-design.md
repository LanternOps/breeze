# Partner billing toggle (`billingEnabled`) — Design Spec

**Status:** Draft for maintainer review (2026-10-16). Not yet approved.
**Discussion:** LanternOps/breeze#8807 ("Add a Native RMM + Ticketing Mode Without Billing").
**Maintainer comment:** https://github.com/LanternOps/breeze/discussions/8807#discussioncomment-18955440 (2026-10-15).

---

## 1. Summary

Partners can run Breeze for RMM and ticketing without Breeze billing. This is done with a
partner-level `billingEnabled` switch, not a new value in `service_management_mode`.

## 2. Background

`service_management_mode` (`native`, `external`, `off`) decides where tickets live. The web nav
gate `requiresModule === 'service_management'` in `apps/web/src/lib/navGates.ts` also shows the
Service Desk and Billing entries only when the mode is `native`. Because of this, billing cannot
be turned off independently of tickets.

The maintainer's review of #8807 (2026-10-15):
- Approves the capability.
- Does not want a fourth value in `service_management_mode`.
- Proposes a partner-level `billingEnabled` switch, default on, read by the Billing nav gate and
  by the billing routes (404 when off), with the mode left as it is.
- Proposes the setting in Partner settings › Service Management, partner level only.
- Asks for a short spec in `docs/superpowers/specs/billing/`.

## 3. Decisions (from the maintainer's review)

3.1. New partner-level setting `billingEnabled`, default `true`.
3.2. The Billing nav gate reads `billingEnabled` instead of `service_management_mode`.
3.3. Billing routes return 404 when `billingEnabled` is `false`.
3.4. `service_management_mode` keeps its values and its constraints. No schema change to the mode.
3.5. Setting location: Partner settings › Service Management, partner level only, no organisation override.
3.6. The default `true` is intended to change nothing for existing partners (per the maintainer's review).

## 4. Proposal (not yet confirmed by the maintainer)

4.1. Under `off`, billing stays hidden regardless of `billingEnabled`, because `off` already hides
the service desk and billing today. Proposed rule: billing is visible when `billingEnabled` is `true`
and the mode is not `off`.

## 5. Open questions for the maintainer

Q1. The combinations in the maintainer's review include `external` tickets with Breeze billing on.
Today billing is hidden under `external`. Enabling it would show Breeze billing to `external`
partners who turn the switch on. Confirm this is intended.

Q2. Under the default `true`, existing `external` partners would see billing surfaces after deploy,
which conflicts with 3.6. Options: (a) default `true` for all, accepting the visible change for
`external`; (b) derive the default from the current mode (`true` for `native`, `false` for `external`).

Q3. Should billing routes follow the same rule as the nav gate for `external`?

Q4. Confirm the rule in section 4.1 for `off`.

## 6. Affected areas (to confirm during implementation)

- Migration: one new column on `partners` (`billing_enabled`).
- Web: billing entries in `navGates.ts`, Sidebar billing visibility, Partner settings › Service Management.
- API: billing routes gated on `billingEnabled`; partner settings read and write.
- Tests: nav gate, route 404, migration idempotency.

## 7. Testing

- Nav gate: billing visibility for each combination of mode and `billingEnabled`.
- Routes: 404 when `billingEnabled` is `false`; unchanged response when `true`.
- Migration: idempotent; existing rows keep current behaviour under the chosen default.

## 8. Out of scope

- Any change to `service_management_mode` values or CHECK constraints.
- Per-organisation overrides.
- Changes to the Service Desk gate.
- Changes to ticket routing.
