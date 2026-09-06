# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.110.0** (2026-09-05).

---

## AI agent builder (#5048 W01–W03, #5064, #5063)

**Operator-facing (Added / Improved).**
- Settings → AI agents → **New agent** is now a four-step guided flow: Purpose and posture (mode first, kind cards, owner scope) → What it does (triggers + capability picker) → Safety and oversight → Review and create. The review card is evaluated **server-side** (`POST /ai/agents/preview`) with the same guardrail and catalog helpers the run loop uses, so what it says is what enforcement does.
- The tool allowlist textarea is replaced by a **capability picker**: 15 capabilities, per-operation outcome badges (Approval request / Logged proposal / Executes unattended), a "Recommended for <kind>" preset, search across labels and literal names, and an "Always on: read-only tools" disclosure. Organization agents see operations outside the partner baseline as **Not in partner baseline**.
- Truthful act-mode outcomes: **Run a script** stays an approval request until a script is authorized for the agent (`actAssets.scriptIds`); the picker and the review card say so instead of promising an unattended run.
- Recipient roles with no active members are marked in the form, and the act-mode "recipient" error now says the selected roles have no active members instead of "add a recipient".
- The edit drawer renders the same step components as the create flow (one rendering per setting).

**Self-Hosting / Upgrade Notes.**
- No new env vars, no migrations. The whole feature is still behind `BREEZE_AI_AGENTS_ENABLED` (default `false`); `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` unchanged.
- API additions, all additive: `GET /ai/agents/tool-catalog`, `GET /ai/agents/ceiling?kind=` (now also carries the baseline's `scriptIds`), `POST /ai/agents/preview`; `GET /roles` gains `activeUserCount` beside `userCount`; catalog operations gain `actRequiresAuthorizedScripts`.
- Behaviour change (API): a PATCH/POST on an **organization-owned** agent that adds a `supervisedActionKeys` entry the row does not already hold is now refused with `422 supervised_keys_grant_only` — keys reach org rows only through the four-eyes graduation grant. Partner rows are unaffected.
- Behaviour change (API): the partner ∩ org policy merge is now wildcard-aware for `toolAllowlist` / `supervisedActionKeys` (a bare `manage_services` on the baseline no longer erases an org's `manage_services:restart`).
- Known gap: there is no UI yet to authorize scripts for unattended act mode (#5065); until it ships, `actAssets.scriptIds` is set through the API.

---

