# UI Test List — increment 2026-06-26 (10 new commits since 61983fbd9)

Head: `6c880e0ce`. Two non-UI commits skipped (#1930 CI smoke, #1928 test-flake fix).

## A. Fix verifications (issues filed yesterday by this QA sweep)
1. **#1937 (fixes #1932) Config Policy → Monitoring: no nested `<button>`** — open a Config Policy → Monitoring tab; expand/collapse rows; toggle/remove an item. Confirm console has **no** `validateDOMNesting <button> cannot be descendant of <button>` / hydration error, and the row toggle + inner actions both work.
2. **#1938 (fixes #1933) Software Library catalog All-Orgs** — set scope to All Orgs → Software Library / catalog loads (aggregated), **no 400**, no raw error banner. Then pick a single org → still loads.
3. **#1939 (fixes #1934) Duplicate default rings deduped** — Patches → Update Rings selector shows a **single** "Default" ring (data layer already confirms 2→1). No duplicate identical entries.
4. **#1940 (fixes #1935) Network Changes empty state** — Discovery → Network Changes with no profiles: empty state now points to creating a discovery profile (not a misleading "no events match filters").
5. **#1941 (fixes #1936) Migration rerun guard** — ALREADY VERIFIED: API booted clean through the a/b/c partner-scope rerun path. (No UI step.)

## B. New features
6. **#1946 EDR operations surfacing (SentinelOne + Huntress), Pillars 1–4a** — find the EDR operations UI (likely device detail / security / integrations). Verify: EDR status/agent surface renders; SentinelOne + Huntress data shown; any actions show feedback or honest "not connected/configured" gating. Note which pillars are visible vs gated.
7. **#1942 AI auto-fill catalog item from product name/SKU** — Software → catalog → add new item → trigger the AI auto-fill from a product name/SKU; verify fields populate, loading + error states are honest, and a result is shown (or graceful "couldn't enrich").
8. **#1931 Tickets: customizable auto-reply + canned responses** — Ticketing settings: configure an auto-reply template; create/edit a canned response; apply a canned response in a ticket reply. Verify template variables render and save feedback is shown.

Logging: append to `docs/testing/FEATURE_TEST_LOG.md` under a new `## UI QA Sweep — 2026-06-26 (increment)` section.
