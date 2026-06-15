# Breeze AI for Office — Manual Test Checklist

Playwright cannot drive Excel (spec §13) — the in-host behavior is verified by hand against a Plan 1–4 capable API. Work through the numbered list in order on BOTH hosts where marked; record results in the PR description.

## Prerequisites

- A dev Entra tenant mapped via `client_ai_tenant_mappings`
- A second unmapped tenant
- An org policy you can toggle (`enabled`, `writeMode`, a DLP block rule)
- At least one prompt template row

## CORS prerequisite

Add the add-in origin (`https://localhost:3000`) to the API's `CORS_ALLOWED_ORIGINS` and restart it before running any test. Sanity: a browser-tab fetch from the pane origin to `GET <api>/health` succeeds.

## Checklist

- [ ] **0. CORS prerequisite** — add the add-in origin (`https://localhost:3000`) to the API's `CORS_ALLOWED_ORIGINS` and restart it. Sanity: a browser-tab fetch from the pane origin to `GET <api>/health` succeeds.
- [ ] **1. Sideload — Excel desktop** — `pnpm dev`, sideload `manifest.xml` (README instructions). Ribbon shows the Breeze AI button; the pane opens and renders past "Connecting to Breeze…".
- [ ] **2. Sideload — Excel on the web** — upload the same manifest. Pane loads over https with no mixed-content/CORS console errors.
- [ ] **3. Silent SSO** — in a tenant with admin consent + the Office client app pre-authorized: open the pane → lands directly in chat with **no** sign-in UI. Verify a `client_ai.auth.exchange` success audit row.
- [ ] **4. MSAL popup fallback** — in a consented tenant WITHOUT Office-client pre-authorization (or a fresh sideload where `getAccessToken` 13012s): pane shows the sign-in screen; the button opens the MSAL popup; completing it lands in chat.
- [ ] **5. Unprovisioned tenant** — sign in from the unmapped tenant: "Not set up yet" screen (`tenant_not_provisioned`), no chat UI.
- [ ] **6. Disabled org** — set the org policy `enabled=false`: pane shows the "Disabled" screen on next sign-in/exchange.
- [ ] **7. Read Q&A on selection** — select a numeric range, context chip shows `Selection <range>`, ask "what do these total to?" → tool activity rows appear for read tools, the streamed answer references the selected data.
- [ ] **8. Sheet-context toggle** — switch the context select to "Whole sheet": chip shows `Sheet: <name>`; send a message and verify (server logs / session viewer) the message carried `workbookContext.kind='sheet'` with used-range cells.
- [ ] **9. Write apply** — ask for a small edit ("put 'Reviewed' in D1"): write-preview card shows the before/after diff; Apply → the cell changes in the grid, the model receives the success result and confirms.
- [ ] **10. Write reject** — repeat with Reject: the workbook is untouched, the model acknowledges the rejection (`status:'rejected'` tool result), no retry loop.
- [ ] **11. Readonly org** — set `writeMode='readonly'`: ask for a write → NO `tool_request` for mutating tools ever arrives (Plan 2 removes write tools from the toolset); the model answers in text only; no approval card renders.
- [ ] **12. Template insert** — with an empty thread, the template picker lists the seeded template; clicking inserts its body into the composer (not auto-sent).
- [ ] **13. DLP block banner** — add a `block`-action DLP rule (e.g. credit cards), put a matching value in a cell, ask the model to read it: `tool_completed` arrives with `blockReason`, the purple "Blocked by your IT provider's data policy" banner renders, and the redaction badge appears on redact-action rules.
- [ ] **14. 401 mid-session re-exchange** — delete the Breeze session token key from Redis while the pane is open, then send a message: the single-flight re-exchange runs silently (one new exchange audit row) and the message succeeds with no visible interruption.
- [ ] **15. Network-loss reconnect** — kill the API (or drop the network) mid-turn, restore within ~30s: the stream reconnects with backoff, history resyncs via `GET /sessions/:id` (no duplicated/garbled thread), and chat continues.
- [ ] **16. Idle ping keepalive** — leave the pane idle 3+ minutes: `ping` frames keep the SSE connection alive (network tab), no error banner, and the next message streams without reconnecting.

## SSE Event Reference (Plan 2 contracts)

The SSE stream uses these event names (discriminate on the `event:` field, not the data body):

| `event:` | data payload |
|---|---|
| `message_delta` | `{ "text": string }` |
| `tool_request` | `{ "toolUseId", "toolName", "input", "mutating" }` |
| `tool_completed` | `{ "toolUseId", "toolName", "status": "success"\|"error"\|"rejected"\|"timeout", "redactions": [{rule,count,location}], "blockReason": string\|null }` |
| `turn_complete` | `{ "usage": { "inputTokens", "outputTokens", "costCents" } \| null }` |
| `session_error` | `{ "message": string }` |
| `ping` | `{}` every 25s (server keepalive) |
