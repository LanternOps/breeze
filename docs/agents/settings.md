# Settings — one concept, one home

Moved verbatim from `CLAUDE.md` (2026-10-07).


Rules from the 2026-09-17 billing/ticketing settings audit
(`docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md`),
enforced going forward for every settings surface, not just billing/ticketing:

1. **One concept, one home.** A setting is edited in exactly one place per level.
2. **Settings live with their domain.** Billing settings under Billing, ticketing
   under Ticketing. Actions and reports are not settings.
3. **Two levels, one direction.** Partner default → org override → snapshotted on
   the document. The org always wins; a stated exception must say so in the UI
   where it applies.
4. **One inheritance control.** Blank = inherit; the field always shows the
   inherited *value* and where it comes from.
5. **One resolver per concept**, used by draft, issue and render.
6. **One snapshot moment.** Whatever prints on a customer document is frozen when
   the document becomes customer-visible.
7. **One save pattern per screen type.** Forms: page Save. Lists: row drawer Save.
   Switches with immediate effect: autosave with a toast. Never mixed in a card.
8. **Every screen is in the nav, at one URL.** Old URLs redirect. Enforced by
   `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts`.
9. **A PR that adds a setting states its home, level, resolver, and the number of
   places the concept is configured before and after.** A count that goes up needs
   a removal plan. Required in the PR description for any PR touching
   `pages/settings/**` or a `*Settings*` component — see the PR template.

---

