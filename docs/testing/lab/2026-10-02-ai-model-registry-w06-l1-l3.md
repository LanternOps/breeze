# AI model registry W06: lab gates L1–L3 (BYO OpenAI-compatible connections through the model gateway)

Feature #7598, wave W06 (#7604, PR #7771). These are release gates for v0.121.

- **Date:** 2026-10-02
- **Build:** `origin/main` at `059f146ab7` (the #7771 merge), in a fresh worktree brought up with `pnpm wt-stack up`.
- **Servers:**
  - **LiteLLM** proxy (`ghcr.io/berriai/litellm:main-stable`) in a container on the stack network.
  - Behind it, **Ollama 0.35.0** and **llama.cpp `llama-server`** (the build bundled with that Ollama release, `--jinja`). Both ran natively on the Mac host for Metal; the API never reached them directly.
  - Models: qwen2.5:3b and qwen2.5:7b (Q4_K_M).
- **Keys:** every provider key in the worktree `.env` was blank (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the billing keys). LiteLLM had a lab-only master key, used as the connection's API key.
- **Spend:** **USD 0.** No Anthropic or other paid call was made. The ledger holds 9 `partner_key` rows, all on local models at lab prices, totalling 5.37¢ notional. The one call to a real provider was L3's discovery against a public endpoint with a dummy key, which got a 401 and cost nothing.
- **Drivers:**
  - the partner settings UI (Playwright MCP) for L1's connection flow, L2's read-only check and all of L3;
  - the API for chat, agent runs and the rest of L1;
  - `docker compose` overlays for L2's env path;
  - SQL for assertions.

  Screenshots are in the worktree's gitignored `.superpowers/lab-w06/`.

## Verdicts

| Gate | Case | Verdict |
|---|---|---|
| **L1** | LiteLLM: add connection → discover → price → verify → enable (UI) | **PASS** |
| L1 | LiteLLM → llama.cpp: chat turn executes a tool; usage recorded | **PASS** |
| L1 | LiteLLM → llama.cpp: AI agent run executes tools | **PASS** |
| L1 | LiteLLM → llama.cpp: two-turn chat recalls turn 1 | **PASS** |
| L1 | LiteLLM → **Ollama**: chat / agent tool calls | **FAIL**: Ollama drops `mcp__…` tool calls (#7795). The 3b model still verified. |
| L1 | Slow first token (> 30 s) on Breeze-sized prompts | **FAIL**: the gateway's 30 s header deadline aborts and retries (#7794) |
| L1 | vLLM | **Not run**: no CUDA GPU. vLLM's server images are CUDA-only, and Apple-silicon support is experimental. |
| L1 | OpenRouter | **Not run**: no key |
| **L2** | First boot: one read-only env connection + offering per partner; chat re-pointed | **PASS** |
| L2 | Two restarts: no duplicates, no second re-point | **PASS** |
| L2 | Admin moves chat elsewhere, then restart: choice kept | **PASS** |
| L2 | Two replicas booting together (5 new partners): exactly one connection each | **PASS** |
| L2 | Non-tool model: clear "can't serve chat (no tool calling)" message | **FAIL**: the UI shows the raw `ai_unavailable` (#7793) |
| L2 | `IS_HOSTED` not explicitly false: refused, fail closed | **PASS** (exact message below) |
| L2 | Env vars removed: connection stays, read-only, not deleted | **PASS** |
| **L3** | Hosted: `http://` public host refused | **PASS** |
| L3 | Hosted: RFC 1918 / loopback / metadata refused (plus 10 additional probes (encodings, DNS names, CGNAT and ULA ranges) via the API) | **PASS** |
| L3 | Hosted: public https accepted by the URL policy (discovery then 401s on the dummy key) | **PASS** |

**Overall:**
- **L3 passes.**
- **L2 passes**, except the non-tool-model message (#7793).
- **L1 passes on LiteLLM in front of llama.cpp** for every case: connection flow, chat tool call, agent tool calls, recall and usage.
- **L1 fails in front of Ollama:** tool calls through Ollama 0.35.0 (qwen2.5 3b/7b) were mostly dropped. `mcp_`-prefixed names parsed 1 of 3 times. The exact parser cause is not established (#7795).
- **Slow local hardware** trips the gateway's 30 s header deadline (#7794).

**Defects filed (not fixed here):**

| # | Severity | Summary |
|---|---|---|
| #7793 | medium | Chat on a model that cannot call tools shows the raw code `ai_unavailable`. The resolver's text ("This AI model cannot use tools, which this feature needs.") is dropped by `routes/ai.ts`. |
| #7794 | medium | The gateway gives the upstream 30 s for response headers. On 29k–69k-token Breeze prompts, local prefill is slower than that, and LiteLLM holds its headers until the first token. The result is repeated abort-and-retry, or "AI request timed out". Nothing is logged in Breeze. |
| #7795 | medium | Tool calls through Ollama 0.35.0 (qwen2.5 3b/7b) were mostly dropped. `mcp_`-prefixed names parsed 1 of 3 times. The exact parser cause is not established (#7795). The harness passed for qwen2.5:3b, so the offering showed **Verified** but could not run tools in chat. |

## Setup

| Step | How |
|---|---|
| Stack | `pnpm wt-stack up` with `BREEZE_WORKSPACE_ENABLED=false`, a free docker subnet, caddy IP and trusted proxy, and `BREEZE_AI_AGENTS_ENABLED=true`. The root `.env` was copied in with every provider and billing key blanked. |
| LiteLLM | `--config` with three model groups: `qwen2.5-3b-tools` and `qwen2.5-7b-tools` (`ollama_chat/…`), and `qwen2.5-7b-llamacpp` (`openai/…` → `llama-server`). A fourth group, `qwen2.5-3b-notools`, used an Ollama model with a template that has no tool support. Master key = the connection key. |
| Ollama | First tried as a container on the stack network. It was CPU-only: 18 threads gave 0.26 tok/s decode, and 8 threads gave 78 tok/s but about 60 tok/s prefill on 29k tokens, so a single chat turn took about 8 min. Moved to the native binary (Metal): 1,177 tok/s prefill. |
| llama.cpp | `llama-server --jinja -c 131072 --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 32768 -ngl 99`. The default 32k context was too small: the jinja-rendered chat prompt is **68,959 tokens**, against 28,760 for the same request in Ollama's template. |
| Network path | API container → `lab-w06-litellm:4000` (an RFC 1918 docker address, cleartext allowed on self-host) → host model server. The model servers were never on a Breeze-reachable address. |

## L1: real OpenAI-compatible servers

### Connection flow (UI): PASS

1. **Add connection.** Partner Settings → AI Providers & Models → Add connection → *OpenAI-compatible endpoint*, with name, `http://<litellm>:4000/v1` and key → **201**. The row shows *OpenAI-compatible*, the host, the key's last 4 and "Your API key" (`l1-01-connection-added.png`).
2. **Discovery** ran on create and again on *Refresh models* (202 "Model refresh queued"). `GET /v1/models` returned the LiteLLM model groups. They landed `source=discovered`, **disabled, unverified and unpriced** (D5), shown as "Not verified · No price · Set a price to enable" (`l1-02-discovered.png`).
   - UX note: the Models card does not refresh when async discovery or verification finishes. A page reload is needed. This is related to #7781.
3. **Price**, in cents per 1M tokens, in the Details drawer → "Model saved".
4. **Verify.** POST verify → 202. The harness ran through the gateway: 4 upstream requests, about 4 s with the 3b model. The record was `passed: true, toolUse: true, harnessVersion: "1"`, bound to the endpoint fingerprint.
5. **Enable.** The toast read "Enabled qwen2.5-3b-tools at $0.10 in / $0.20 out per 1M tokens" (`l1-03-verified-enabled.png`).

### Chat with a tool call: PASS (LiteLLM → llama.cpp); FAIL behind Ollama

- **LiteLLM → llama.cpp, `qwen2.5-7b-llamacpp`** (verified on first try).
  - The prompt was "How many devices do I have? Use your device listing tool…".
  - SSE: `tool_use_start query_devices` → `tool_use_input {search:"", limit:100}` → `tool_result` (2 devices) → 37 `content_delta` → `turn_model {servedModel: qwen2.5-7b-llamacpp, fallbackUsed:false}` → `done`.
  - The answer named both seeded devices and that both are offline.
- **Usage** came from the `ai_invocations` row (chat, `partner_key`, `prompt_profile: generic`):
  - tokens: input 6,266, cache read 131,998, output 70;
  - cost 0.392116¢, which matches the rates exactly: 6,266×20 + 70×40 + 131,998×2, per 1M;
  - the upstream's `prompt_tokens_details.cached_tokens` was carried through LiteLLM as cache-read.
- **Behind Ollama** (both the 3b and the 7b), every chat turn came back as `message_start` / `message_end` (output 16 tokens) twice, then `done`. There was no text, no tool and no error.
  - Captured upstream: Ollama returned `content:""` with no `tool_calls` and `eval_count` 16–25. The CLI then retried with "[Your previous response had no visible output…]" and got the same reply.
  - Replaying the captured request showed the model emits a correct `<tool_call>{"name":"mcp__…"}` that Ollama's parser drops. Renamed tools parse (table in #7795).
  - **The harness passed for the 3b model and failed for the 7b one**, so "Verified" does not guarantee chat tool use on Ollama.

### AI agent run with tool calls: PASS (LiteLLM → llama.cpp)

- **Setup:** a partner baseline plus an org triage agent, `mode=shadow`, cooldown 0. The run was a manual trigger on the seeded macOS device: profile `full` → role `analysis`, which inherits the `ai_agents` default (the llama.cpp offering).
- **Result:** run `completed` in 20 turns, `runVerdict: no_action`. The trace has **16 executed tools**, including `get_device_details`, `analyze_metrics`, `get_cis_device_report`, `analyze_disk_usage` and `get_device_vulnerabilities`. Out-of-scope reads were denied by policy: `get_topology` outside the device's site, and `get_user_risk_scores`. The summary is a coherent offline-device assessment.
- **Ledger:** 1 row, `ai_agents/analysis`, `admitted_offering_id` = the llama.cpp offering. Tokens: input 1,686, cache read 107,031, output 1,867; cost 0.322462¢.
  - The run row's `cost_cents` is `0`, because it is rounded to whole cents (`Math.round`).

### Two-turn recall: PASS

The second message in the same session was "Without calling any tools: what was the operating system of the first device you listed in your previous answer?" The answer was "…an operating system type of macOS."

The OS appeared only in turn 1's **tool result**, not in its text. So turn 2 carried turn 1's transcript, tool output included.

### Per-server quirks

| Server | Quirk |
|---|---|
| **LiteLLM** (`main-stable`) | **Stream:** the tool call arrives as **one chunk** with complete `arguments` and a UUID `id`. `finish_reason: "tool_calls"` comes in its own chunk. Usage follows in a final chunk with `choices:[{index:0, delta:{}}]` (not an empty array) before `[DONE]`. Chunk `id`s differ within one response. |
| LiteLLM | **Headers:** response headers are held until the first upstream chunk, so prefill time counts against the gateway's header deadline (#7794). On a client disconnect it cancels upstream: "client disconnected before first chunk, upstream LLM request cancelled". |
| LiteLLM | **`/v1/models` and pricing:** `/v1/models` lists model-group names, not backend ids. For unmapped local models it logs cost-map errors, which are harmless. |
| LiteLLM → Ollama, non-tool model | Sending tools gets **HTTP 500** `litellm.InternalServerError … tools param requires --jinja flag`. Breeze verification records `passed:false, toolUse:false`, with the 500 in the summary. |
| **Ollama 0.35.0** | **Tool-call parsing:** tool calls through Ollama 0.35.0 (qwen2.5 3b/7b) were mostly dropped. `mcp_`-prefixed names parsed 1 of 3 times. The exact parser cause is not established (#7795). `/api/chat` buffered `done_reason: "stop"`. |
| Ollama in Docker on Apple silicon | CPU only. At the default 18 threads decode collapses to 0.26 tok/s (oversubscription); pin `num_thread`. |
| **llama.cpp** `llama-server --jinja` | **Tool calls:** parses `mcp__…` names correctly (3/3). Returns `prompt_tokens_details.cached_tokens`, so Breeze ledgers cache reads. |
| llama.cpp | **Context:** the jinja render of Breeze's chat request is 68,959 tokens, so it needs more than 32k context. Below that the request gets HTTP 400 "exceeds the available context size", and the chat turn ends with **no error shown to the user** (`turn_model` + `done`, usage 0; the #7785 pattern). |

## L2: self-host env upgrade (the `MCP_LLM_PROVIDER=openai-compatible` path)

**How it was simulated:**
- `docker-compose.yml` maps **none** of `MCP_LLM_*` into the api container. A compose-based self-hoster on the old path must already carry their own override, so the lab used one too: a compose overlay adding `MCP_LLM_PROVIDER/BASE_URL/API_KEY/MODEL/PRICE_*` and `IS_HOSTED`.
- **Before the first boot:** the partner's chat default was set to platform Sonnet 5.5, the pre-upgrade shape, and the L1 manual connection was disconnected.

| Step | Env / action | Result |
|---|---|---|
| 1–2 First boot | `openai-compatible`, base URL = LiteLLM, model `qwen2.5-7b-llamacpp`, price 0.2 / 0.4 USD/M, `IS_HOSTED=false` | **Log:** `[envOpenAiBootstrap] partners=1 created=1 resynced=0 chatRepointed=1 failed=0`.<br>**Connection:** ONE, "Instance OpenAI-compatible endpoint", `provider_config.managedBy=env`.<br>**Offering:** ONE manual offering, enabled, priced **20 / 40 ¢/M** (USD → cents ×100). It was auto-verified (`passed:true`) about 3 s later.<br>**Assignments:** chat re-pointed to it; `ai_agents` untouched (still platform). |
| — | Chat through it | **PASS:** `query_devices` executed and the answer was correct. 2.77¢, because cache reads are priced at the input rate, as Task 15 specifies: the env path has no cache price. |
| 3 Two restarts | `docker restart` ×2 | **Both boots:** `created=0 resynced=0 chatRepointed=0`.<br>Still 1 connection and 1 offering. The chat assignment's `updated_at` is unchanged. |
| 3b Respect admin | Admin moves chat back to platform, then restart | `chatRepointed=0`. Chat stays on platform. |
| 4 Two replicas | 5 new partners inserted. Then `--scale api=2 --force-recreate`, so both replicas boot at once. | **api-1:** `partners=6 created=2 chatRepointed=2`. **api-2:** `partners=6 created=3 chatRepointed=3`.<br>Real interleaving: per-partner SQL shows **exactly 1 env connection and 1 offering for every partner**, and chat on the env offering for each of the 5 new partners.<br>A second concurrent 2-replica boot logged `created=0` on both, with 6 connections and 6 offerings total. |
| 5 Non-tool model | `MCP_LLM_MODEL=qwen2.5-3b-notools` (Default Partner's chat first set to the env offering) | **Resync:** a new offering per partner, enabled and priced. The old one was kept, disabled. Chat re-pointed only where it was exactly the old env offering, which was all 6.<br>**Verification** failed (`direct_tool_use: … HTTP 500 …`).<br>**Chat:** `POST /ai/sessions` → **503 `{"error":"ai_unavailable"}`**, and the panel shows a red **`ai_unavailable`** banner (`l2-05-notools-chat-ai_unavailable.png`). **FAIL: #7793.** |
| 6 `IS_HOSTED` not explicitly false | `IS_HOSTED=` (empty) | **The API refuses to start** (fail closed). The exact message is below. Only the empty value was run. Unset, garbage and truthy values go through the same check (`isRecognizedSelfHostSignal`), per the code. |
| 6b Loopback URL | `IS_HOSTED=false`, `MCP_LLM_BASE_URL=http://127.0.0.1:11434/v1` | **The API starts.** The bootstrap refuses and retries at 1, 5, 15 and 60 minutes, then every 10 minutes (new-partner sync): `MCP_LLM_BASE_URL refused: That host is not reachable from Breeze (loopback, link-local and metadata addresses are never allowed). — no partner was bootstrapped`. Existing rows are untouched. |
| 7 Vars removed | `MCP_LLM_*` absent | **Log:** `MCP_LLM_PROVIDER is not openai-compatible: released 6 env-managed connection(s); nothing deleted, they stay read-only (partners may disconnect them)`.<br>**Rows:** all 6 connections still `active`, offerings intact, `envReleasedAt` stamped.<br>**Read-only:** `PATCH …/gateway` → **409** `managed_by_env`: "This connection was set up from the MCP_LLM_* environment variables, which are no longer set. It cannot be edited; you can disconnect it." The drawer's fields are disabled; *Disconnect* and *Refresh models* stay available (`l2-07-released-env-connection-readonly.png`). |

**Notes:**
- **Pre-existing, not W06:** `MCP_LLM_BASE_URL` set to an **empty** string fails config validation ("MCP_LLM_BASE_URL: Invalid URL") and the API will not start. An operator who "removes" the variable by blanking it, instead of deleting the line, cannot boot. The rule dates from 2026-09-01.
- **UI copy:** the row badge still reads "Managed by environment" after the release, even though the variables are gone.

## L3: hosted URL policy (browser): PASS

The API was rebooted with `IS_HOSTED=true` and no `MCP_LLM_*`. Every case went through Partner Settings → AI Providers & Models → Add connection → *OpenAI-compatible endpoint* with a dummy key. In each case the UI's error toast matched the server body word for word.

| Base URL | Server | UI | Screenshot |
|---|---|---|---|
| `http://api.openai.com/v1` | 400 `{"error":"Hosted Breeze only connects to https endpoints.","code":"egress_blocked"}` | same text | `l3-01-http-public-refused.png` |
| `https://10.0.0.5/v1` | 400 `That host resolves to a private or reserved address, which Breeze does not connect to.` (`egress_blocked`) | same | `l3-02-rfc1918-refused.png` |
| `https://127.0.0.1/v1` | 400, same message | same | `l3-03-loopback-refused.png` |
| `https://169.254.169.254/v1` | 400, same message | same | `l3-04-metadata-refused.png` |
| `https://api.openai.com/v1` | **201 Created**, so the URL policy allowed it. Discovery then stored `The endpoint returned HTTP 401 for /models: … invalid_api_key …`, as expected for a dummy key. | row "Active" + discovery error | `l3-05-public-https-accepted-401-discovery.png` |

**Extra API probes (hosted), all 400 `egress_blocked`:**
- decimal `2130706433` and octal `0177.0.0.1`;
- `[::1]`, `[::ffff:127.0.0.1]` and `[::ffff:a9fe:a9fe]`;
- `localhost`;
- DNS names resolving to 10/8 and to 169.254.169.254;
- CGNAT `100.64.0.1` and ULA `[fd00::1]`.

URLs with userinfo or a query were refused at schema validation: "Enter an http(s) URL with no credentials, query or fragment."

## Operator-facing messages (for the v0.121 release notes)

- **`MCP_LLM_PROVIDER=openai-compatible` without an explicit `IS_HOSTED=false`.** The API does not start:

  > `MCP_LLM_PROVIDER: MCP_LLM_PROVIDER=openai-compatible is for self-hosted Breeze (set IS_HOSTED explicitly to false). On hosted — or with IS_HOSTED unset/invalid — it is refused: it would create a connection for every partner. Add an OpenAI-compatible connection under Partner Settings → AI Providers & Models instead.`

  Stock `docker-compose.yml` maps `IS_HOSTED: ${IS_HOSTED:-false}`, so a compose install that leaves it out of `.env` still gets `false`. Installs without compose (systemd, k8s, bare node) must set it.
- **Env endpoint on loopback, link-local or metadata.** The API starts, but nothing is bootstrapped, and it retries at 1, 5, 15 and 60 minutes, then every 10 minutes (new-partner sync):

  > `[envOpenAiBootstrap] MCP_LLM_BASE_URL refused: That host is not reachable from Breeze (loopback, link-local and metadata addresses are never allowed). — no partner was bootstrapped`

  `http://localhost:11434` (the usual Ollama URL) is refused. Use a private address: the docker service name or the host's LAN IP.
- **Env-managed connection after the variables are removed:**

  > `This connection was set up from the MCP_LLM_* environment variables, which are no longer set. It cannot be edited; you can disconnect it.`

- **Hosted BYO URL refusals:**

  > `Hosted Breeze only connects to https endpoints.`

  > `That host resolves to a private or reserved address, which Breeze does not connect to.`

- **Other release-note points:**
  - The env path now needs a model that can call tools for chat. A non-tool model shows `ai_unavailable` at the time of this lab (#7793).
  - `MCP_LLM_API_KEY` is optional; when set it must be at least 8 characters.
  - Do not blank `MCP_LLM_BASE_URL`; delete the line instead (see the pre-existing note above).
  - **Ollama tool calling was unreliable at the time of this lab** (#7795). llama.cpp `llama-server --jinja`, behind LiteLLM or direct, works.
  - Local servers need at least about 70k context; allow headroom for long chats. The first token must arrive within 30 s (#7794).

## Teardown

- The LiteLLM container was removed. The Ollama container and its volume had already been removed when Ollama moved to the native binary.
- The native Ollama and `llama-server` processes were stopped, and the job-local model store was deleted.
- `pnpm wt-stack down` was run (it drops volumes), and the worktree `.env` was deleted.
