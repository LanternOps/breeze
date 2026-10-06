# AI model registry W01: spike findings (#7599)

Run on 2026-09-30 by the W01 implementer (Claude Opus 5.5). `@anthropic-ai/claude-agent-sdk` 0.3.286, `@anthropic-ai/sdk` 0.128.0.
Scripts: `apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts`, `modelsApiProbe.ts`.
Labels: **verified** = observed in this run · **inferred** = from types/docs only · **not checked**.

The passthrough spike ran against a local capture server (no Anthropic traffic). The Models API probe ran with a developer key against `https://api.anthropic.com`: one listing, three 16-token `inference_geo` requests, one 16-token fast-mode request.

## Static evidence (Step 1)

```
$ node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"
0.3.286
$ grep -n "display?:" sdk.d.ts
5034:    thinking_display?: ('summarized' | 'omitted' | 'highlights') | null;
9643:    display?: 'summarized' | 'omitted';
9664:    display?: 'summarized' | 'omitted';
$ grep -n "fastMode\|speed?:\|inference_geo\|inferenceGeo\|export declare type SdkBeta" sdk.d.ts
340:     * Flag-tier settings overlay (e.g. `{ fastMode: true, effortLevel: 'high' }`),
3723:export declare type SdkBeta = 'context-1m-2025-08-07';
8942:    fastMode?: boolean;
8946:    fastModePerSessionOptIn?: boolean;
$ grep -raoh "inference_geo|thinking-display-updates-2026-08-18|fast-mode-2026-02-01|ANTHROPIC_BETAS|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_EXTRA_BODY" <sdk> <sdk parent> | sort | uniq -c
   3 ANTHROPIC_BETAS
  21 ANTHROPIC_CUSTOM_HEADERS
   6 CLAUDE_CODE_EXTRA_BODY
   2 inference_geo
```

`inference_geo` appears only in `sdk-tools.d.ts` and `bridge.mjs`, not in the `Options` type. Line 5034 belongs to the `set_max_thinking_tokens` control request: its doc comment describes a third display mode, `highlights` ("one short title per stretch of thinking"), which "the API accepts only from Claude Code sessions that Anthropic hosts".

## Answers

| # | Question | Answer | Label | Evidence |
|---|---|---|---|---|
| Q1 | Does `query()` put `thinking.display: "updates"` on the wire: typed option, `extraArgs['thinking-display']`, or `ANTHROPIC_BETAS`? Which beta header accompanies it? | **No, by any of the three.** The typed option (cast) and `extraArgs` both become the CLI flag `--thinking-display updates`, which the CLI rejects before any request: `argument 'updates' is invalid. Allowed choices are summarized, omitted, highlights.` `ANTHROPIC_BETAS` appends `thinking-display-updates-2026-08-18` to the `anthropic-beta` header but leaves `thinking` as `{"type":"adaptive"}`. `display: "summarized"` passes through. | verified | rows `display-updates-cast`, `display-updates-extra-arg`, `betas-env` (below) |
| Q2 | Does `query()` send `speed: "fast"` and the `fast-mode-2026-02-01` beta (`settings.fastMode`, `ANTHROPIC_CUSTOM_HEADERS`)? | **Yes, via `settings: { fastMode: true }`**: the body carries `speed: "fast"` and the header gains `fast-mode-2026-02-01`. `ANTHROPIC_CUSTOM_HEADERS: anthropic-beta: …` has no visible effect: no `speed` field, and the captured `anthropic-beta` header lacks the beta. | verified | rows `fast-mode-settings`, `custom-headers-env` |
| Q3 | Can `query()` send `inference_geo` by any option or env var? | **Yes, via `CLAUDE_CODE_EXTRA_BODY={"inference_geo":"us"}`** in the query env: the body carries `inference_geo: "us"`. There is no typed option. | verified (env var) / inferred (no typed option, from `sdk.d.ts`) | row `extra-body-env-geo` + static grep |
| Q4 | Top-level `capabilities` keys for current models. Is there any leaf for fast mode / speed, inference geo, tool use, or disabling thinking? | Every listed model has the same top-level keys: `batch, citations, code_execution, context_management, effort, image_input, pdf_input, structured_outputs, thinking`. Leaves: `thinking.types.{enabled,adaptive}`, `effort.{low,medium,high,xhigh,max}`, `context_management.{clear_tool_uses_20250919,clear_thinking_20251015,compact_20260112}`. **No leaf for speed/fast mode, inference geo, tool use, or disabling thinking.** | verified | `topLevelCapabilityKeys`, `leaves` (below) |
| Q5 | Does `models.list()` return dated ids, aliases, or both for older models? Which of the 10 seeded ids (Task 7) are absent from the listing? | Older models are listed by **dated id only** (`claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-5-20250929`); 4.6+ models are listed by their undated id. **Absent: `claude-haiku-4-5` and `claude-sonnet-4-5`** (the two aliases). The other 8 seeded ids are listed. | verified | `models[].id` (below) |
| Q6 | Which `inference_geo` values does the Messages API accept for this org: `us` / `global` / `eu`? What does `usage.inference_geo` report? | `us` → accepted, `usage.inference_geo: "us"`. `global` → accepted, `"global"`. `eu` → **400** `inference_geo: must be one of ['global', 'us']`. Probed on `claude-sonnet-5-5` only. | verified | `geo` (below) |
| Q7 | Is fast mode accepted for this org (research-preview access)? | **Yes** on `claude-opus-5-5`: accepted, `usage.speed: "fast"`. Other models not probed. | verified | `fast` (below) |

### Passthrough spike rows (`sdkOptionPassthroughSpike.ts`, `--model claude-sonnet-5-5 --fast-model claude-opus-5-5`)

Every request went to `/v1/messages?beta=true`. The base beta header on every row was `claude-code-20250219, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, per-turn-control-2026-07-01, effort-2025-11-24, dangerous-tool-use-2026-09-03, afk-mode-2026-01-31`; "extra beta" lists additions to it.

| variant | thinking | output_config | speed | inference_geo | extra beta | error |
|---|---|---|---|---|---|---|
| control-adaptive-medium | `{"type":"adaptive"}` | `{"effort":"medium"}` | – | – | – | – |
| display-summarized | `{"type":"adaptive","display":"summarized"}` | `{"effort":"medium"}` | – | – | – | – |
| display-updates-cast | (no request) | | | | | CLI exit 1: `option '--thinking-display <display>' argument 'updates' is invalid. Allowed choices are summarized, omitted, highlights.` |
| display-updates-extra-arg | (no request) | | | | | same as above |
| fast-mode-settings (opus-5-5) | `{"type":"adaptive"}` | `{"effort":"medium"}` | `"fast"` | – | `mid-conversation-tool-changes-2026-07-01`, `fast-mode-2026-02-01` | – |
| betas-env | `{"type":"adaptive"}` | `{"effort":"medium"}` | – | – | `thinking-display-updates-2026-08-18` | – |
| custom-headers-env (opus-5-5) | `{"type":"adaptive"}` | `{"effort":"medium"}` | – | – | `mid-conversation-tool-changes-2026-07-01` | – |
| extra-body-env-geo | `{"type":"adaptive"}` | `{"effort":"medium"}` | – | `"us"` | – | – |

Side observation (verified, not a question): `display-summarized` and the env variants did not pass `effort`, yet each request carried `output_config.effort: "medium"`. The CLI supplies a default effort when the caller omits one. So "omit effort" on the Agent SDK is not "provider default" on the wire.

### Models API listing (`modelsApiProbe.ts`)

All 13 models listed carry the same nine top-level capability keys. Thinking and effort leaves (1 = supported):

| id | display name | in / out tokens | thinking.adaptive | thinking.enabled | effort low/med/high/xhigh/max |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | Claude Sonnet 5.5 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-opus-5-5 | Claude Opus 5.5 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-fable-5-1 | Claude Fable 5.1 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-opus-5 | Claude Opus 5 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-sonnet-5 | Claude Sonnet 5 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-fable-5 | Claude Fable 5 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-opus-4-8 | Claude Opus 4.8 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-opus-4-7 | Claude Opus 4.7 | 1000000 / 128000 | 1 | 0 | 1/1/1/1/1 |
| claude-sonnet-4-6 | Claude Sonnet 4.6 | 1000000 / 128000 | 1 | 1 | 1/1/1/0/1 |
| claude-opus-4-6 | Claude Opus 4.6 | 1000000 / 128000 | 1 | 1 | 1/1/1/0/1 |
| claude-opus-4-5-20251101 | Claude Opus 4.5 | 200000 / 64000 | 0 | 1 | 1/1/1/0/0 |
| claude-haiku-4-5-20251001 | Claude Haiku 4.5 | 200000 / 64000 | 0 | 1 | 0/0/0/0/0 |
| claude-sonnet-4-5-20250929 | Claude Sonnet 4.5 | 1000000 / 64000 | 0 | 1 | 0/0/0/0/0 |

`geo` (model `claude-sonnet-5-5`):
```json
[
  { "geo": "us", "accepted": true, "servedGeo": "us" },
  { "geo": "global", "accepted": true, "servedGeo": "global" },
  { "geo": "eu", "accepted": false, "status": 400,
    "message": "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"inference_geo: must be one of ['global', 'us']\"}}" }
]
```

`fast` (model `claude-opus-5-5`): `{ "accepted": true, "servedSpeed": "fast" }`

## Decisions this gates

| # | Decision (owner wave) | If yes | If no | Outcome |
|---|---|---|---|---|
| D1 | Chat's default `thinkingDisplay` (spec §7) (W05) | W05 extends `toAgentSdkOptions` to map `display: "updates"` by the Q1 mechanism; the chat assignment defaults `options.thinkingDisplay = "updates"` where supported | Chat shows a "thinking…" indicator; `updates` stays in `option_support` (a model fact) but `toAgentSdkOptions` keeps refusing it | **No** on SDK 0.3.286: chat shows a "thinking…" indicator and `toAgentSdkOptions` keeps refusing `updates`. W05 re-runs the spike after the next SDK bump. The CLI's `highlights` mode is restricted to Anthropic-hosted Claude Code sessions (per its type doc) and was not probed. |
| D2 | Fast mode on Agent SDK surfaces (chat, agents) (W03/W05) | `toAgentSdkOptions` maps `speed: "fast"` by the Q2 mechanism | Fast mode is reachable only from Messages-API one-shots until the SDK carries it; the chat picker hides it | **Yes**: `settings: { fastMode: true }` puts `speed: "fast"` and the fast-mode beta on the wire. W03/W05 map `speed: "fast"` through `settings.fastMode`. Q7 confirms this org has fast-mode access on Opus 5.5. |
| D3 | `inference_geo` values in `option_support` and the EU platform geo (§15 #5) (W03) | The operator enters the values Q6 confirmed on `/admin/ai-models`; W03 sends them where supported | `option_support.inferenceGeo` stays `[]`; EU residency stays open in W03 planning | **Partly**: `us` and `global` are accepted; **`eu` is rejected**. The seed keeps `inferenceGeo: []` (Task 7); the operator may enter `us`/`global`. An EU platform geo is not available, so §15 #5's condition fails and EU residency stays open in W03 planning. The Agent SDK can carry the value only through `CLAUDE_CODE_EXTRA_BODY` (Q3). |
| D4 | `supportsTools` derivation (W01 Task 3) | An explicit tools leaf exists and `deriveCapabilities` reads it (already coded) | No leaf: Anthropic trees default to `supportsTools: true` (already coded) | **No leaf** (Q4): Anthropic trees default to `supportsTools: true`. |
| D5 | Lifecycle never-seen guard (W01 Task 13) | Aliases are listed: the guard is defensive only | Aliases absent: the guard is load-bearing for the seeded alias rows | **Aliases absent** (Q5: `claude-haiku-4-5`, `claude-sonnet-4-5`): the guard is load-bearing. Without it, both seeded alias rows would go `missing` after three syncs. |

## 2026-10-06: re-run on Agent SDK 0.3.288

Run on 2026-10-06 by the SDK-bump runner (Claude Opus 5.5) for dependabot PR #7999: `@anthropic-ai/claude-agent-sdk` 0.3.286 → **0.3.288** (bundled Claude Code 2.1.288), `@anthropic-ai/sdk` 0.128.0 → 0.131.0. Passthrough spike against the local capture server (`--model claude-sonnet-5-5 --fast-model claude-opus-5-5`), with four new variants added for this run. The Models API probe was not re-run: it does not go through the Agent SDK.

### What changed: the CLI now defaults to thinking display `updates`

| variant | thinking on the wire | `thinking-display-updates-2026-08-18` beta | vs 0.3.286 |
|---|---|---|---|
| control-adaptive-medium (display unset, raw env) | `{"type":"adaptive","display":"updates"}` | **yes** | **changed** (was `{"type":"adaptive"}`, no beta) |
| display-summarized | `{"type":"adaptive","display":"summarized"}` | no | same |
| display-omitted (new) | `{"type":"adaptive","display":"updates"}` | **yes** | new variant: explicit `omitted` is rewritten to `updates` |
| display-unset-updates-env-0 / -env-false (new) | `{"type":"adaptive"}` | no | reproduces 0.3.286 |
| display-omitted-updates-env-0 (new) | `{"type":"adaptive","display":"omitted"}` | no | – |
| **breeze-guarded-unset-display** (new; display unset + `SDK_CHILD_HOST_CONTEXT_GUARDS`) | `{"type":"adaptive"}` | no | **reproduces 0.3.286**; the script exits non-zero otherwise |
| display-updates-cast / -extra-arg | (no request) CLI exit 1: `argument 'updates' is invalid. Allowed choices are summarized, omitted, highlights.` | – | same |
| fast-mode-settings (opus-5-5) | `speed: "fast"` + `fast-mode-2026-02-01` | (yes, raw env) | same for fast |
| custom-headers-env | no `speed`, no fast beta | (yes, raw env) | same |
| extra-body-env-geo | `inference_geo: "us"` | (yes, raw env) | same |

Mechanism (**verified** by reading the bundled CLI 2.1.288, minified names): the request builder classifies the session's display. `summarized`/`highlights` are left alone; `omitted` that the CLI chose itself is left alone; anything else, **including an `omitted` the SDK passes as `--thinking-display omitted`** (that counts as explicit), is rewritten to `display: "updates"` plus the beta, unless `CLAUDE_CODE_THINKING_DISPLAY_UPDATES` is falsy (default on). If the API rejects `updates`, the CLI drops it for the rest of the conversation (`retry:thinking-display-updates-unclaimed`).

**Breeze keeps the 0.3.286 behaviour.** `SDK_CHILD_HOST_CONTEXT_GUARDS` (`apps/api/src/services/llm/sdkChildEnvGuards.ts`) now carries `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0`, so every SDK child (chat, agent runs incl. failover hops, tool capture, fidelity harness, offering verification, both spikes) sends `{"type":"adaptive"}` with no updates beta. An explicit `display: 'omitted'` would **not** have been enough (row above). D1 stays **No**: `toAgentSdkOptions` still refuses `updates`. Real-API check (resume spike, Sonnet 5.5, guarded env): every `/v1/messages` request carried `{"type":"adaptive"}` and no updates beta, and the persisted thinking blocks are signed with empty text (`thinking(sig=true,len=0)`), the same shape as 0.3.286. Without the guard (raw env, same day), the API accepted `updates` with 200s; the persisted blocks also read `len=0`, so the transcript alone does not distinguish the two modes, only the wire does.

### Other observations (verified unless labelled)

- **`mid-conversation-tool-changes-2026-07-01` is now in the base beta header on Sonnet 5.5 too.** On 0.3.286 it appeared only on the Opus 5.5 rows. Base header on 0.3.288 (raw env): `claude-code-20250219, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, per-turn-control-2026-07-01, mid-conversation-tool-changes-2026-07-01, effort-2025-11-24, dangerous-tool-use-2026-09-03, thinking-display-updates-2026-08-18, afk-mode-2026-01-31`.
- **`ANTHROPIC_BETAS=thinking-display-updates-2026-08-18` no longer has a visible effect**: with the raw env the beta is already present, and `thinking` already carries `display: "updates"`. ANTHROPIC_BETAS combined with the guard was **not checked**. Breeze never sets ANTHROPIC_BETAS.
- **`GET /api/hello` preflight.** Each `query()` makes one `GET /api/hello` to `ANTHROPIC_BASE_URL` before its first `/v1/messages` (27 in the full resume run, all 200 from api.anthropic.com). **Unknown whether new**: the 0.3.286 runs did not report non-Messages paths.
- Default effort, D2 (fast via `settings.fastMode`) and D3 (`inference_geo` only via `CLAUDE_CODE_EXTRA_BODY`): unchanged.

### Outcome

`VERIFIED_AGENT_SDK_VERSION` moves to `0.3.288`. D1 **No** (unchanged, now enforced by the env guard rather than by the CLI's default), D2 **Yes** (unchanged), D3 unchanged. The W05 resume spike was re-run in full on 0.3.288 with the guard; see `2026-10-01-ai-model-registry-w05-resume-spike-findings.md`.
