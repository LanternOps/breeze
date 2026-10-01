---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W07: Bedrock / Vertex / Foundry connections — Implementation Plan

Closes #7605

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner admin connects Claude on their own **Amazon Bedrock**, **Google Vertex AI** or **Microsoft Foundry** account (region / project / resource + credentials), gets Bedrock models discovered (Vertex/Foundry entered by hand, with suggestions), verifies each through the fidelity harness, and uses them on every AI surface — funded by the partner's own cloud commitment, pinned to the region they chose.

**Architecture:**
- **W07 adds three adapters to W06's loopback model gateway; it adds no new runtime.** The Agent SDK child runs in its genuine **provider mode** (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`) so the CLI owns each provider's wire format, model-id rules and beta handling — but with that provider's **`CLAUDE_CODE_SKIP_*_AUTH=1`** and its base URL (`ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` / `ANTHROPIC_FOUNDRY_BASE_URL`) pointed at a gateway grant. The gateway adapter checks the path and the bound model, **injects the credential** (AWS SigV4 or a Bedrock API key; a Google OAuth token minted in-process from the service-account JSON; the Foundry API key) and forwards byte-for-byte to the fixed provider host derived from the connection's region/project/resource.
- **Why not hand the credentials to the CLI:** a Vertex service account would have to be written to disk (`GOOGLE_APPLICATION_CREDENTIALS` is a path), AWS keys would sit in a child env, the CLI would dial the provider directly (no SSRF pin, no per-request audit), and a missing credential would let the CLI fall back to the **server's own** ambient cloud identity. Through the gateway: credentials never leave the API process, no file is written, ambient credentials are unreachable (the child env carries no `AWS_*` / `GOOGLE_*` / `AZURE_*`), and every request is audited exactly like W06's.
- **Messages API surfaces** (script reviewer, ticket draft, enrichment, …) use the official `@anthropic-ai/bedrock-sdk` / `vertex-sdk` / `foundry-sdk` clients, constructed only in `connectionFactory`, pointed at the same gateway with auth skipped — so both transports share one signing implementation and one egress path.
- **Credentials** live in the existing encrypted `partner_ai_connections.api_key_encrypted` column (row-bound AAD, W02's spec, rotation walker unchanged) as a per-kind JSON document; non-secret settings in `provider_config` (`excludedOpen` — partner-axis table, no export row). One migration widens the kind CHECK and adds per-kind shape CHECKs.
- **Regional inference** is the connection's region (Bedrock region + inference-profile prefix; Vertex location; Foundry resource). The resolver derives each offering's geography from it and treats it as **endpoint-bound** for residency (no `inference_geo` parameter is ever sent to a cloud provider).

**Tech Stack:** Hono, Drizzle / PostgreSQL, BullMQ, `@anthropic-ai/claude-agent-sdk` 0.3.286 (provider modes), **new:** `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk`, `@smithy/signature-v4`, `@smithy/protocol-http`, `@aws-crypto/sha256-js` (the last three are already in the lockfile via `@aws-sdk/client-s3`; W07 declares them); existing `google-auth-library` ^11. Vitest, Playwright.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3) — §4 (connections: "`bedrock`, `vertex` and `foundry` … W07; `kind` is a CHECK'd text column"), §5.2 (`inference_geo` "for W07 cloud kinds it is the provider region"; `provider_config` "non-secret per-kind settings (region, project id, resource name) for W07 kinds. Export: `excludedOpen`"), §6, §7, §8, §9, §12 ("W07 cloud connections … store cloud credentials under the same row-bound encryption. They get the same security review as W06"), §13 W07 row.

**Builds on:** `2026-10-01-ai-model-registry-w06-openai-compatible.md` (W06, #7604). Every W06 "shared extension point" is consumed here; nothing in W06 is redesigned.

## Out of scope

- **Bedrock Mantle** (`bedrock-mantle.{region}.api.aws`), **temporary / assumed-role AWS credentials** (STS `AssumeRole` with an external id), **Workload Identity Federation**, **Foundry Entra ID** auth. v1: long-lived IAM access keys or a Bedrock API key; a Vertex service-account key; a Foundry API key. See Open questions 1–2.
- **Foundry deployment listing** through Azure Resource Manager (needs a second, management-plane credential). Vertex has no supported Anthropic model-list API. Both are manual entry with suggestions (Open question 3).
- **`inference_geo`, fast mode, server-side refusal `fallbacks`, server tools (web search/fetch/code execution), Files API, batches** on cloud kinds — none is sent; refusal fallback is client-side (W06 `SERVER_SIDE_FALLBACK_KINDS` already excludes gateway kinds).
- **Cloud-provider cost import** (CUR / billing export). Metering uses the admin-entered offering price, like every BYO connection.

## Preconditions

W07 is implemented **after W06 (#7604) is merged** (it extends W06 files) — and therefore after W03 and W04. Before Task 1, check every row; real code wins; adapt only the named adapter.

| # | What W07 consumes | Source | If it differs, adapt only |
|---|---|---|---|
| Q1 | W06 `GATEWAY_CONNECTION_KINDS`, `AI_CONNECTION_ROW_KINDS`, `isGatewayConnectionKind` (`packages/shared/src/constants/aiConnectionKinds.ts`) | W06 Task 1 | Task 1 |
| Q2 | W06 gateway: `GatewayAdapter { kind; dialect; handle; sdkChildEnv }`, `registerGatewayAdapter`, `assertBoundModel`, `GatewayConnectionConfig` (union), `GatewayGrantRecord`, `GatewayError`, `forwardUpstream`, `upstreamOriginFor`, `upstreamAuthHeaders`, `scrubSecrets`, limits; `gateway/index.ts` adapter imports | W06 Task 4, 7 | Tasks 5, 6 |
| Q3 | W06 resolver: `gatewayCandidate`, `gatewayConfigFor` (`switch (conn.kind)` with default `null`), `loadGatewayCredential`, `endpointFingerprint(conn)`, `verifiedGatewayCapabilities`, `verifiedCapabilitiesTree(record, thinkingSource)`; `ResolvedConnection` gateway arm `{ config; credential }` | W06 Task 8 | Task 8 |
| Q4 | W06 dispatch: `prepareSdkChild`, `openGatewayGrant`, `AnthropicClientTarget { kind: 'gateway'; baseUrl; dialect: 'anthropic' }`, `gatewayUpstreamUrl(config)` (`switch` + `never`), `buildGatewaySdkChildEnv` | W06 Task 9 | Task 7 |
| Q5 | W06 writes: `createGatewayConnection`, `updateGatewayConnection`, `deleteGatewayConnection`, `createManualOffering`, `isEnvManaged` | W06 Task 10 | Task 10 |
| Q6 | W06 discovery: `CONNECTION_MODEL_DISCOVERERS`, `discoveryGrantRecord`, `DiscoveredConnectionModel` | W06 Task 11 | Task 9 |
| Q7 | W06 verification: `verifyConnectionOffering` (sets `probeAdaptiveEffort: config.kind !== 'openai_compatible'`; passes the linked platform row as `thinkingSource`) | W06 Task 12 | — |
| Q8 | W06 routes: `POST /connections` `switch (body.kind)`, `PATCH /connections/:id/gateway`, `POST /connections/:id/offerings`, `ownConnection` | W06 Task 13 | Task 10 |
| Q9 | W06 web: `ConnectionKindForm` `switch (kind)` + `never`, `ADDABLE_CONNECTION_KINDS`, `CONNECTION_KIND_LABEL_KEYS`, `ManualModelForm` | W06 Task 14 | Task 11 |
| Q10 | W03 `eligibility.ts` residency rule: `if (ctx.residencyRequired) { if (!ctx.geoCarriable \|\| c.inferenceGeo === null \|\| !c.supportedInferenceGeos.includes(c.inferenceGeo)) return 'residency_unavailable'; }`; `CandidateFacts.connection = { kind; status; keyUsable }` | W03 Task 2 — built | Task 8 |
| Q11 | W03 `resolveModel.wireFor` passes `c.facts.inferenceGeo` to `buildWireParams`, which sends it only when `clampSupport(c, carriage).inferenceGeo` (= `c.optionSupport.inferenceGeo` when carriable) contains it | W03 Task 3 — built | Task 8 |
| Q12 | W02 `encryptConnectionKey(id, plaintext)` / `decryptConnectionKey` (AAD `partner_llm_configs.api_key_encrypted:<row id>`), `reencryptRegisteredSecrets` walks every non-null `api_key_encrypted` | W02 — main | Task 3 |
| Q13 | W01 `derivePromptProfile(modelId)` (`services/aiModel.ts`), `getPlatformModelByModelId` | W01 — main | Task 8 |
| Q14 | The installed Agent SDK honours `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`, `CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY}_AUTH`, `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL`, `AWS_REGION`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK` | Verified by string search in SDK 0.3.181's CLI binary during planning; **re-verify on 0.3.286** | Task 6 env builders |
| Q15 | `@anthropic-ai/bedrock-sdk` / `vertex-sdk` / `foundry-sdk` versions whose peer `@anthropic-ai/sdk` range includes the installed 0.128.x; constructor options `AnthropicBedrock({ awsRegion, skipAuth, baseURL })`, `AnthropicVertex({ region, projectId, accessToken, baseURL })`, `AnthropicFoundry({ apiKey, baseURL })` | npm — check | Task 7 |

```bash
git fetch origin && git log --oneline -1 origin/main
grep -n "GATEWAY_CONNECTION_KINDS" packages/shared/src/constants/aiConnectionKinds.ts
grep -n "export function gatewayConfigFor\|export async function prepareSdkChild\|export function registerGatewayAdapter" -r apps/api/src/services/aiModels
ls apps/api/node_modules/@anthropic-ai/
npm view @anthropic-ai/bedrock-sdk version peerDependencies dependencies --json | head -30
npm view @anthropic-ai/vertex-sdk version peerDependencies dependencies --json | head -30
npm view @anthropic-ai/foundry-sdk version peerDependencies dependencies --json | head -30
SDKBIN=$(node -e "console.log(require.resolve('@anthropic-ai/claude-agent-sdk/package.json', {paths:['apps/api']}))" | xargs dirname)
for v in CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_SKIP_BEDROCK_AUTH ANTHROPIC_BEDROCK_BASE_URL CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_SKIP_VERTEX_AUTH ANTHROPIC_VERTEX_BASE_URL CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_SKIP_FOUNDRY_AUTH ANTHROPIC_FOUNDRY_BASE_URL; do
  printf '%s ' "$v"; grep -rao "$v" "$SDKBIN"/.. 2>/dev/null | wc -l; done
```

If any provider-mode variable count is 0 on 0.3.286, **stop**: Task 6's child env needs a different mechanism; record it as an open question.

## Global Constraints

- **Rigor: high + security review** (spec §12/§13). TDD for every task. Task 13 (security review) gates Task 14.
- **Security review output is private** (same rule as W06: findings go to `~/breeze-security/`, the PR records only counts).
- **Migration slot:** exactly one file, `apps/api/migrations/2026-11-24-100000-ai-cloud-connections.sql`. It must sort after W06's `2026-11-23-100000-…` and every committed migration; re-check with `git ls-tree -r --name-only origin/main -- apps/api/migrations/ | grep -E '/[0-9]{4}-[^/]*\.sql$' | sort | tail -3` and `scripts/check-migration-naming.sh --against-ref origin/main` at commit time. No DML → no system-scope election (say so in the header).
- **No new tenant table, no new tenant column.** `partner_ai_connections` is partner-axis (shape 3, `PARTNER_TENANT_TABLES`), has no `org_id`, and is not in `CORE_ORG_CASCADE_DELETE_ORDER` / `CORE_TENANT_EXPORT_POLICY` / `orgMergeRegistry` — W07 changes only its CHECKs. No registration list changes (verify with `grep -n partner_ai_connections apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` → no hits).
- **No ambient cloud identity, ever.** No code path may construct a cloud credential provider from the environment or instance metadata (`fromEnv`, `fromInstanceMetadata`, default provider chains, Google ADC, `DefaultAzureCredential`). The SDK child env never carries `AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `AZURE_*`, `CLOUDSDK_*`. Pinned by `cloudChildEnv.test.ts` and a contract-test rule (Task 12).
- **Fixed provider hosts only.** Cloud upstream origins are derived from validated `provider_config` (region / location / resource regexes) — never from a user-supplied URL. Egress is the strict public policy (no private networks, even on self-host), DNS-pinned, no redirects.
- **Vertex service-account JSON is never written to disk** and its `token_uri` must be Google's (`https://oauth2.googleapis.com/token`); any other value is rejected at write time (a crafted service account must not turn token minting into an SSRF).
- **Limits** are W06's (`gateway/limits.ts`): 32 MiB request/response, 30 s connect, 120 s idle, 15 min total, 8 concurrent per grant.
- **Funding:** every cloud offering is `partner_key`; it never touches platform credits. A cloud offering needs an **explicit offering price** to be enabled (spec §8 precedence: the linked platform row's price applies to BYOK Anthropic only — Decision D4).
- **Partner-wide writes** use W04's gate (`partnerWrite` + `requirePartnerWide`), audited `ai_models.connection.*` (never with credential material: audit `region` / `projectId` / `location` / `resource` and `credentialHint` only).
- Tests one file at a time (`cd apps/api && npx vitest run <path>`); integration suites need `pnpm test-stack up`; `pnpm test-stack down` at the end.
- **Commits:** one per task, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feature/7598-ai-model-registry/wave-7605` from `origin/main` after W06 merges (`get_feature_status` → `start_wave`).
- **Lab gates are Todd's** (real cloud credentials). Every unit and integration test in this plan runs without them (fake upstreams through `__setUpstreamFetchForTests`; fake credentials; a static SigV4 vector).

## Review Focus

1. **The server's own cloud identity is used for a partner request.** A connection with missing or bad credentials must fail, never fall back to the API host's IAM role / ADC / managed identity. → `cloudChildEnv.test.ts` "no ambient credential variables reach the child" + `cloudAuth.test.ts` "never builds a provider-chain / ADC client" (Tasks 5–6) + contract rule (Task 12).
2. **A crafted Vertex service account redirects token minting** (`token_uri`, `universe_domain`, `type: external_account`). Expected: rejected at write. → `cloudCredentials.test.ts` "rejects a non-Google token_uri / external_account / impersonated SA" (Task 3).
3. **The CLI asks the gateway for another model, project, region or resource than the grant binds** (e.g. a background "small fast" call, or a path naming another GCP project). Expected: 403, audited, never forwarded. → `cloudAdapters.test.ts` "path project/location must equal the connection's" and "Bedrock model in the path must be bound" (Task 6); `cloudSdk.e2e.test.ts` asserts every upstream request names the bound model (Task 12).
4. **Residency silently satisfied by a `global` route.** A Bedrock `global.` inference profile or a Vertex `global` location is not resident. Expected: geography `null` → `residency_unavailable` when residency is required. → `cloudGeography.test.ts` (Task 4) + eligibility rows (Task 8).
5. **SigV4 signature covers a body other than the one forwarded** (re-serialisation between signing and sending, header case changes, chunked encoding). Expected: the exact bytes signed are the bytes sent. → `sigv4.test.ts` "signs and sends identical bytes" + a known-answer vector (Task 5).

## File ownership and wave collisions

| Path | Action | Task | Could collide with | Rule |
|---|---|---|---|---|
| `packages/shared/src/constants/aiConnectionKinds.ts` (+ test) | modify (W06 file) | 1 | W08 | append kinds only |
| `packages/shared/src/validators/aiCloudConnections.ts` (+ test) | create | 1 | — | |
| `packages/shared/src/validators/aiModelRegistryApi.ts` (+ test) | modify (W04/W06 file) | 1 | W09, W10/W11 | additive arms / schemas |
| `packages/shared/src/types/aiModelRegistry.ts` | modify | 1 | W05 | additive `providerSummary` |
| `apps/api/migrations/2026-11-24-100000-ai-cloud-connections.sql` | create | 2 | W06 slot `2026-11-23-…` | sort after it |
| `apps/api/src/db/schema/aiModelRegistry.ts`, `aiModelRegistry.contract.test.ts` | modify (W02 files) | 2 | W08 (drops compat_uq) | CHECK text + kind const only |
| `apps/api/src/services/aiModels/cloudCredentials.ts` (+ test) | create | 3 | — | |
| `apps/api/src/services/aiModels/gateway/cloud/endpoints.ts`, `geography.ts` (+ tests) | create | 4 | — | |
| `apps/api/src/services/aiModels/gateway/cloud/auth/{sigv4,vertexToken,index}.ts` (+ tests) | create | 5 | — | |
| `apps/api/src/services/aiModels/gateway/forward.ts`, `types.ts` | modify (W06 files) | 5 | — | `never` arms gain cloud cases; auth becomes per-request |
| `apps/api/src/services/aiModels/gateway/cloud/{bedrock,vertex,foundry}Adapter.ts` (+ tests) | create | 6 | — | |
| `apps/api/src/services/aiModels/gateway/index.ts` | modify (W06 file) | 6 | — | 3 import lines |
| `apps/api/src/services/aiModels/connectionFactory.ts` (+ test) | modify (W03/W06 file) | 7 | **W05**, W09 | gateway target `dialect` widening + `AnthropicLike` |
| `apps/api/package.json`, `pnpm-lock.yaml` | modify | 5, 7 | every dependency PR | lockfile conflicts: re-run `pnpm install` on rebase |
| `apps/api/src/services/aiModels/eligibility.ts` (+ test) | modify (W03 file) | 8 | W04 (appended gate), W09 | residency clause only |
| `apps/api/src/services/aiModels/gatewayCandidate.ts`, `gatewayCapabilities.ts` (+ tests) | modify (W06 files) | 8 | — | cloud arms |
| `apps/api/src/services/aiModels/gateway/cloud/bedrockDiscovery.ts`, `modelLinking.ts` (+ tests) | create | 9 | — | |
| `apps/api/src/services/aiModels/connectionDiscovery.ts` | modify (W06 file) | 9 | — | registry entry |
| `apps/api/src/services/aiModels/gatewayConnections.ts` (+ tests) | modify (W06 file) | 10 | — | kind-generic create/update |
| `apps/api/src/routes/aiModels/connections.ts` (+ tests) | modify (W04/W06 file) | 10 | W08 | `switch` arms |
| `apps/api/src/services/aiModels/registryView.ts` | modify | 10 | W05 | `providerSummary` |
| `apps/web/src/components/settings/aiModels/connectionForms/{Bedrock,Vertex,Foundry}ConnectionForm.tsx` (+ tests), `ConnectionKindForm.tsx`, `connectionKinds.ts`, `ConnectionsCard.tsx`, `ManualModelForm.tsx` | create / modify | 11 | — | `switch` arms |
| `apps/web/src/locales/*/settings.json` | modify | 11 | every UI wave | key block `aiModels.connections.cloud.*` |
| `apps/api/src/services/aiModels/gateway/cloud/cloudSdk.e2e.test.ts`; `aiModelRegistry.contract.test.ts` | create / modify | 12 | W08 | rule additions |
| `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx` | modify | 14 | W06 | own section |

## Decisions

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **Provider modes behind the gateway** (`CLAUDE_CODE_USE_*` + `CLAUDE_CODE_SKIP_*_AUTH` + `ANTHROPIC_*_BASE_URL` → gateway grant), not credentials in the child. | See Architecture. Keeps the spec's "via the Agent SDK's provider modes" (the CLI still speaks each provider's dialect) while keeping secrets, egress control and audit in the gateway. | Yes — per-kind `sdkChildEnv`. |
| D2 | **Credentials stored in `api_key_encrypted` as a JSON document**, not a new column. | Same row-bound AAD, same rotation walker, same `getConnectionKeyMaterial` path, no registry/export change; the column was always "the connection's secret". A new column would duplicate the key-triplet CHECK and the walker entry for no isolation gain (one connection = one secret either way). | Yes (a later migration can move it). |
| D3 | **Region/project/resource are routing identity**: a change bumps `config_version` **and** changes the endpoint fingerprint (offerings go `stale`, must re-verify). A credential rotation bumps `config_version` (live SDK sessions are recreated, spec §9.2) but **keeps** the fingerprint, so verification survives (Codex review #9; pinned by a test in Task 10). | A different region can serve a different model set and residency; a different key cannot. | — |
| D4 | **Cloud offerings need an explicit price**; the linked platform row is used for capabilities (thinking/effort subtree, only after the harness's adaptive probe passes), token limits and prompt profile — never for price. The UI pre-fills the platform rate and says "check your cloud rate card (regional endpoints are typically ~10% higher)". | Spec §8 restricts linked-platform price inheritance to BYOK Anthropic; cloud list prices differ by route. | Yes. |
| D5 | **Geography derives from the route**: Bedrock `us.`/`us-gov.` → `us`, `eu.` → `eu`, `global.` → none, in-region base id → the region's family (`us-*` → `us`, `eu-*` → `eu`, others none); Vertex `us`/`eu` multi-region and `us-*`/`europe-*` regions → `us`/`eu`, `global` → none; Foundry → none (Open question 4). Cloud geography is **endpoint-bound**: it satisfies W03's residency rule without an `inference_geo` parameter, and none is ever sent. | Spec §5.2: for cloud kinds `inference_geo` "is the provider region". | Yes. |
| D6 | **Bedrock discovery** = `ListFoundationModels(byProvider=anthropic)` (on-demand ids) + `ListInferenceProfiles(type=SYSTEM_DEFINED)` (Anthropic profiles), signed with the connection's credentials, via the gateway's guarded forward to `bedrock.{region}.amazonaws.com`. Vertex and Foundry: manual entry, with suggestions built from `ai_platform_models` ids. | Only Bedrock exposes a usable data-plane-credential listing. | Yes. |

---

## Task 1: Cloud kinds, provider config and credential schemas (shared)

**Files:**
- Modify: `packages/shared/src/constants/aiConnectionKinds.ts` (+ test)
- Create: `packages/shared/src/validators/aiCloudConnections.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/validators/index.ts` (one export line)
- Modify: `packages/shared/src/validators/aiModelRegistryApi.ts` (+ test) — three `connectionCreateSchema` arms; `cloudConnectionPatchSchema`
- Modify: `packages/shared/src/types/aiModelRegistry.ts` — `AiConnectionDto.providerSummary`

**Interfaces:**
- Consumes: Q1; W06 `connectionName`, `connectionCreateSchema`.
- Produces:

```ts
// aiConnectionKinds.ts
AI_CONNECTION_ROW_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible', 'bedrock', 'vertex', 'foundry'];
GATEWAY_CONNECTION_KINDS = ['openai_compatible', 'bedrock', 'vertex', 'foundry'];
export const CLOUD_CONNECTION_KINDS: readonly ['bedrock', 'vertex', 'foundry']; export type CloudConnectionKind;
export function isCloudConnectionKind(kind: string): kind is CloudConnectionKind;

// aiCloudConnections.ts
export const AWS_REGION_PATTERN: RegExp;          // ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$
export const GCP_PROJECT_PATTERN: RegExp;         // ^[a-z][a-z0-9-]{4,28}[a-z0-9]$
export const VERTEX_LOCATION_PATTERN: RegExp;     // ^(global|us|eu|[a-z]+-[a-z]+[0-9]+)$
export const AZURE_RESOURCE_PATTERN: RegExp;      // ^[a-z0-9][a-z0-9-]{1,62}$
export const bedrockProviderConfigSchema; export type BedrockProviderConfig = { region: string };
export const vertexProviderConfigSchema;  export type VertexProviderConfig = { projectId: string; location: string; serviceAccountEmail?: string };
export const foundryProviderConfigSchema; export type FoundryProviderConfig = { resource: string };
export type CloudProviderConfig = BedrockProviderConfig | VertexProviderConfig | FoundryProviderConfig;
export const bedrockCredentialsInputSchema;   // { authType: 'iam'; accessKeyId; secretAccessKey } | { authType: 'api_key'; apiKey }
export const vertexCredentialsInputSchema;    // { authType: 'service_account'; serviceAccountJson: string }  (raw JSON text from the upload)
export const foundryCredentialsInputSchema;   // { authType: 'api_key'; apiKey }

// aiModelRegistryApi.ts
connectionCreateSchema arms: { kind: 'bedrock'; name; region; credentials } | { kind: 'vertex'; name; projectId; location; credentials } | { kind: 'foundry'; name; resource; credentials }
export const cloudConnectionPatchSchema;  // { region? | projectId?/location? | resource?; credentials?; expectedConfigVersion } (kind-checked server-side)

// types
AiConnectionDto.providerSummary: { region?: string; projectId?: string; location?: string; resource?: string; serviceAccountEmail?: string; authType?: string } | null;
```

- [ ] **Step 1: Write the failing tests**

`aiCloudConnections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AWS_REGION_PATTERN, AZURE_RESOURCE_PATTERN, GCP_PROJECT_PATTERN, VERTEX_LOCATION_PATTERN,
  bedrockCredentialsInputSchema, foundryCredentialsInputSchema, vertexCredentialsInputSchema,
} from './aiCloudConnections';

describe('cloud connection patterns', () => {
  it.each([['us-east-1', true], ['eu-central-1', true], ['us-gov-west-1', true], ['ap-southeast-2', true],
    ['US-EAST-1', false], ['us-east-1.evil.com', false], ['us-east', false], ['', false]])('region %j → %s', (r, ok) => {
    expect(AWS_REGION_PATTERN.test(r)).toBe(ok);
  });
  it.each([['my-project-123', true], ['ab', false], ['1project', false], ['proj/evil', false]])('project %j → %s', (p, ok) => {
    expect(GCP_PROJECT_PATTERN.test(p)).toBe(ok);
  });
  it.each([['global', true], ['us', true], ['eu', true], ['us-east5', true], ['europe-west1', true], ['us-east5.evil', false], ['../x', false]])('location %j → %s', (l, ok) => {
    expect(VERTEX_LOCATION_PATTERN.test(l)).toBe(ok);
  });
  it.each([['contoso-ai', true], ['a', false], ['Contoso', false], ['x.y', false], ['evil.com/', false]])('resource %j → %s', (r, ok) => {
    expect(AZURE_RESOURCE_PATTERN.test(r)).toBe(ok);
  });
});

describe('credential input schemas', () => {
  it('bedrock IAM and API key shapes', () => {
    expect(bedrockCredentialsInputSchema.safeParse({ authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'x'.repeat(40) }).success).toBe(true);
    expect(bedrockCredentialsInputSchema.safeParse({ authType: 'api_key', apiKey: 'ABSK' + 'x'.repeat(60) }).success).toBe(true);
    expect(bedrockCredentialsInputSchema.safeParse({ authType: 'iam', accessKeyId: 'nope', secretAccessKey: 'x' }).success).toBe(false);
    // temporary credentials are out of scope (they expire and would silently break)
    expect(bedrockCredentialsInputSchema.safeParse({ authType: 'iam', accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'x'.repeat(40) }).success).toBe(false);
  });
  it('vertex takes the raw service-account JSON text (validated server-side)', () => {
    expect(vertexCredentialsInputSchema.safeParse({ authType: 'service_account', serviceAccountJson: '{"type":"service_account"}' }).success).toBe(true);
    expect(vertexCredentialsInputSchema.safeParse({ authType: 'service_account', serviceAccountJson: 'x'.repeat(20_001) }).success).toBe(false);
  });
  it('foundry api key', () => {
    expect(foundryCredentialsInputSchema.safeParse({ authType: 'api_key', apiKey: 'k'.repeat(32) }).success).toBe(true);
  });
});
```

Append to `aiModelRegistryApi.test.ts`:

```ts
describe('W07 cloud connection arms', () => {
  it('bedrock / vertex / foundry create bodies parse; unknown extra fields are refused (.strict)', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'bedrock', name: 'AWS prod', region: 'eu-central-1',
      credentials: { authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'x'.repeat(40) } }).success).toBe(true);
    expect(connectionCreateSchema.safeParse({ kind: 'vertex', name: 'GCP', projectId: 'my-project-123', location: 'eu',
      credentials: { authType: 'service_account', serviceAccountJson: '{}' } }).success).toBe(true);
    expect(connectionCreateSchema.safeParse({ kind: 'foundry', name: 'Azure', resource: 'contoso-ai',
      credentials: { authType: 'api_key', apiKey: 'k'.repeat(32) } }).success).toBe(true);
    expect(connectionCreateSchema.safeParse({ kind: 'foundry', name: 'Azure', resource: 'contoso-ai', baseUrl: 'https://evil.example.com',
      credentials: { authType: 'api_key', apiKey: 'k'.repeat(32) } }).success).toBe(false);
  });
  it('no cloud arm accepts inferenceGeo (geography comes from the route, D5)', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'bedrock', name: 'x', region: 'us-east-1', inferenceGeo: 'eu',
      credentials: { authType: 'api_key', apiKey: 'k'.repeat(40) } }).success).toBe(false);
  });
  it('cloudConnectionPatchSchema requires a change and the version', () => {
    expect(cloudConnectionPatchSchema.safeParse({ expectedConfigVersion: 2 }).success).toBe(false);
    expect(cloudConnectionPatchSchema.safeParse({ region: 'us-west-2', expectedConfigVersion: 2 }).success).toBe(true);
  });
});
```

Append to `aiConnectionKinds.test.ts`: every cloud kind is a gateway kind and a row kind; `isCloudConnectionKind('openai_compatible') === false`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/aiCloudConnections.test.ts src/validators/aiModelRegistryApi.test.ts src/constants/aiConnectionKinds.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`aiConnectionKinds.ts`:

```ts
export const AI_CONNECTION_ROW_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible', 'bedrock', 'vertex', 'foundry'] as const;
export const GATEWAY_CONNECTION_KINDS = ['openai_compatible', 'bedrock', 'vertex', 'foundry'] as const;
/** W07 (#7605): Claude on the partner's own AWS / GCP / Azure account. */
export const CLOUD_CONNECTION_KINDS = ['bedrock', 'vertex', 'foundry'] as const;
export type CloudConnectionKind = (typeof CLOUD_CONNECTION_KINDS)[number];
const CLOUD_SET: ReadonlySet<string> = new Set(CLOUD_CONNECTION_KINDS);
export function isCloudConnectionKind(kind: string): kind is CloudConnectionKind { return CLOUD_SET.has(kind); }
```

`aiCloudConnections.ts`:

```ts
import { z } from 'zod';

export const AWS_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
export const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const VERTEX_LOCATION_PATTERN = /^(global|us|eu|[a-z]+-[a-z]+[0-9]+)$/;
export const AZURE_RESOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const bedrockProviderConfigSchema = z.object({ region: z.string().regex(AWS_REGION_PATTERN) }).strict();
export const vertexProviderConfigSchema = z.object({
  projectId: z.string().regex(GCP_PROJECT_PATTERN),
  location: z.string().regex(VERTEX_LOCATION_PATTERN),
  /** Display only (from the service account); never used for routing. */
  serviceAccountEmail: z.string().email().max(254).optional(),
}).strict();
export const foundryProviderConfigSchema = z.object({ resource: z.string().regex(AZURE_RESOURCE_PATTERN) }).strict();
export type BedrockProviderConfig = z.infer<typeof bedrockProviderConfigSchema>;
export type VertexProviderConfig = z.infer<typeof vertexProviderConfigSchema>;
export type FoundryProviderConfig = z.infer<typeof foundryProviderConfigSchema>;
export type CloudProviderConfig = BedrockProviderConfig | VertexProviderConfig | FoundryProviderConfig;

const secret = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Long-lived IAM user keys only (AKIA…): temporary ASIA… keys expire silently (Open question 1). */
export const bedrockCredentialsInputSchema = z.discriminatedUnion('authType', [
  z.object({ authType: z.literal('iam'), accessKeyId: z.string().trim().regex(/^AKIA[0-9A-Z]{16}$/), secretAccessKey: secret(30, 128) }).strict(),
  z.object({ authType: z.literal('api_key'), apiKey: secret(20, 2048) }).strict(),
]);
export const vertexCredentialsInputSchema = z.object({
  authType: z.literal('service_account'),
  serviceAccountJson: z.string().min(2).max(20_000),
}).strict();
export const foundryCredentialsInputSchema = z.object({ authType: z.literal('api_key'), apiKey: secret(16, 512) }).strict();
export type BedrockCredentialsInput = z.infer<typeof bedrockCredentialsInputSchema>;
export type VertexCredentialsInput = z.infer<typeof vertexCredentialsInputSchema>;
export type FoundryCredentialsInput = z.infer<typeof foundryCredentialsInputSchema>;
```

`aiModelRegistryApi.ts` — add three arms to `connectionCreateSchema` (after W06's `openai_compatible` arm):

```ts
  // W07 (#7605): Claude on the partner's cloud. No inferenceGeo: geography is the route (D5).
  z.object({ kind: z.literal('bedrock'), name: connectionName, region: bedrockProviderConfigSchema.shape.region,
    credentials: bedrockCredentialsInputSchema }).strict(),
  z.object({ kind: z.literal('vertex'), name: connectionName, projectId: vertexProviderConfigSchema.shape.projectId,
    location: vertexProviderConfigSchema.shape.location, credentials: vertexCredentialsInputSchema }).strict(),
  z.object({ kind: z.literal('foundry'), name: connectionName, resource: foundryProviderConfigSchema.shape.resource,
    credentials: foundryCredentialsInputSchema }).strict(),
```

and:

```ts
/** W07: edit a cloud connection's routing or credentials. Field/kind agreement is checked server-side. */
export const cloudConnectionPatchSchema = z.object({
  region: bedrockProviderConfigSchema.shape.region.optional(),
  projectId: vertexProviderConfigSchema.shape.projectId.optional(),
  location: vertexProviderConfigSchema.shape.location.optional(),
  resource: foundryProviderConfigSchema.shape.resource.optional(),
  credentials: z.union([bedrockCredentialsInputSchema, vertexCredentialsInputSchema, foundryCredentialsInputSchema]).optional(),
  expectedConfigVersion: z.number().int().min(1),
}).strict().refine((v) => Object.keys(v).some((k) => k !== 'expectedConfigVersion'), { message: 'Change at least one setting.' });
export type CloudConnectionPatchInput = z.infer<typeof cloudConnectionPatchSchema>;
```

`types/aiModelRegistry.ts`:

```ts
export interface AiConnectionProviderSummary {
  region?: string; projectId?: string; location?: string; resource?: string;
  serviceAccountEmail?: string; authType?: 'iam' | 'api_key' | 'service_account';
}
export interface AiConnectionDto {
  // …W04/W06 fields…
  /** Cloud kinds only (W07); non-secret routing settings. */
  providerSummary: AiConnectionProviderSummary | null;
}
export interface AiOfferingDto {
  // …W04/W06 fields…
  /** Cloud offerings only (W07, Codex review #4): the geography the ROUTE keeps traffic in. undefined = not a cloud offering. */
  routeGeo?: 'us' | 'eu' | null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/validators/ src/constants/aiConnectionKinds.test.ts && npx tsc --noEmit -p .`
Expected: PASS (downstream `tsc` red on the new DTO field until Task 10 — expected).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/aiConnectionKinds.ts packages/shared/src/constants/aiConnectionKinds.test.ts \
  packages/shared/src/validators/aiCloudConnections.ts packages/shared/src/validators/aiCloudConnections.test.ts \
  packages/shared/src/validators/index.ts packages/shared/src/validators/aiModelRegistryApi.ts \
  packages/shared/src/validators/aiModelRegistryApi.test.ts packages/shared/src/types/aiModelRegistry.ts
git commit -m "feat(ai-models): bedrock / vertex / foundry connection contract (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Migration — widen the kind CHECK; per-kind shape CHECKs

**Files:**
- Create: `apps/api/migrations/2026-11-24-100000-ai-cloud-connections.sql`
- Modify: `apps/api/src/db/schema/aiModelRegistry.ts` (`PARTNER_AI_CONNECTION_KINDS`, CHECK texts)
- Modify: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`
- Create: `apps/api/src/__tests__/integration/aiCloudConnectionsSchema.integration.test.ts`

**Interfaces:** produces constraint names `partner_ai_connections_kind_chk` (re-issued), `partner_ai_connections_shape_chk` (re-issued), `partner_ai_connections_provider_config_chk` (new).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/aiCloudConnectionsSchema.integration.test.ts
// Runs as the migration owner (system scope) — these are CHECK tests, not RLS tests.
describe('partner_ai_connections cloud kinds (W07 migration)', () => {
  it('accepts a bedrock row with provider_config {region} and a credential triplet', async () => {
    await expect(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, provider_config, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${partnerId}, 'bedrock', 'aws', ${sql.json({ region: 'eu-central-1' })}, 'enc:v3:x', 'MNOP', 'fp1:x')`).resolves.toBeDefined();
  });
  it('refuses a cloud row without credentials (no ambient identity, D-global)', async () => {
    await expect(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, provider_config)
      VALUES (${partnerId}, 'vertex', 'gcp', ${sql.json({ projectId: 'my-project-123', location: 'eu' })})`).rejects.toThrow(/shape_chk/);
  });
  it('refuses a cloud row with a base_url (hosts are derived, never supplied)', async () => {
    await expect(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, provider_config, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${partnerId}, 'foundry', 'az', 'https://evil.example.com', ${sql.json({ resource: 'contoso-ai' })}, 'enc:v3:x', 'abcd', 'fp1:x')`).rejects.toThrow(/shape_chk/);
  });
  it.each([
    ['bedrock', { region: 'us-east-1.evil.com' }],
    ['vertex', { projectId: 'my-project-123', location: '../x' }],
    ['vertex', { projectId: 'p/evil', location: 'eu' }],
    ['foundry', { resource: 'evil.com/' }],
    ['bedrock', ['us-east-1']],
  ])('refuses an invalid %s provider_config %j', async (kind, cfg) => {
    await expect(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, provider_config, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${partnerId}, ${kind}, 'x', ${sql.json(cfg)}, 'enc:v3:x', 'abcd', 'fp1:x')`).rejects.toThrow(/provider_config_chk/);
  });
  it('existing kinds still satisfy the re-issued CHECKs (openai_compatible env-managed provider_config is an object)', async () => {
    await expect(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, provider_config)
      VALUES (${partnerId}, 'openai_compatible', 'env', 'http://10.0.0.5:8000/v1', ${sql.json({ managedBy: 'env' })})`).resolves.toBeDefined();
  });
  it('compat_uq predicate is unchanged (cloud kinds are not compat connections)', async () => {
    const [idx] = await sql`SELECT pg_get_indexdef('public.partner_ai_connections_compat_uq'::regclass) AS d`;
    expect(idx!.d).toMatch(/WHERE \(kind = ANY \(ARRAY\['anthropic_byok'::text, 'catalog'::text\]\)\)/);
  });
});
```

(Use the file's seeded `partnerId` and `sql` from the integration `db-utils.ts`; delete inserted rows in `afterEach`.)

Append to `aiModelRegistry.contract.test.ts` (W02's schema contract): `PARTNER_AI_CONNECTION_KINDS` equals `AI_CONNECTION_ROW_KINDS` from `@breeze/shared`, element for element.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiCloudConnectionsSchema.integration.test.ts && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`
Expected: FAIL — `kind_chk` rejects `bedrock`; contract mismatch.

- [ ] **Step 3: Write the migration and schema**

```sql
-- apps/api/migrations/2026-11-24-100000-ai-cloud-connections.sql
-- AI model registry W07 (#7605): Claude on the partner's own Bedrock / Vertex /
-- Foundry account as partner_ai_connections kinds.
--
-- * kind_chk gains bedrock | vertex | foundry (spec §4: "kind is a CHECK'd text
--   column, so adding them needs no table change").
-- * shape_chk: cloud kinds REQUIRE a credential (api_key_encrypted — a per-kind
--   JSON document under the same row-bound AAD, W07 Decision D2) and a
--   provider_config, and NEVER carry base_url or catalog_entry_id: provider hosts
--   are derived from validated provider_config, never supplied. No cloud row may
--   rely on ambient server identity.
-- * provider_config_chk: per-kind routing fields match the same patterns as
--   packages/shared/src/validators/aiCloudConnections.ts (edit both together).
-- * partner_ai_connections_compat_uq is untouched (its predicate lists only
--   anthropic_byok / catalog; W08 drops it with the /ai/provider facade).
--
-- Tenancy unchanged: partner axis (shape 3), PARTNER_TENANT_TABLES, no org_id,
-- no cascade / export / merge registration. No DML in this file, so the
-- breeze.scope=system election rule does not apply. Idempotent: constraints are
-- dropped and re-added.

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_kind_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_kind_chk
  CHECK (kind IN ('anthropic_byok', 'catalog', 'openai_compatible', 'bedrock', 'vertex', 'foundry'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_shape_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_shape_chk CHECK (
  (kind = 'catalog') = (catalog_entry_id IS NOT NULL)
  AND (kind = 'openai_compatible') = (base_url IS NOT NULL)
  AND (kind NOT IN ('anthropic_byok', 'catalog') OR api_key_encrypted IS NOT NULL)
  AND (kind NOT IN ('bedrock', 'vertex', 'foundry') OR (api_key_encrypted IS NOT NULL AND provider_config IS NOT NULL))
);

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_provider_config_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_provider_config_chk CHECK (
  (provider_config IS NULL OR jsonb_typeof(provider_config) = 'object')
  AND (kind <> 'bedrock' OR coalesce(provider_config->>'region', '') ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$')
  AND (kind <> 'vertex' OR (
        coalesce(provider_config->>'projectId', '') ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
    AND coalesce(provider_config->>'location', '') ~ '^(global|us|eu|[a-z]+-[a-z]+[0-9]+)$'))
  AND (kind <> 'foundry' OR coalesce(provider_config->>'resource', '') ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
```

`db/schema/aiModelRegistry.ts`:

```ts
export const PARTNER_AI_CONNECTION_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible', 'bedrock', 'vertex', 'foundry'] as const;
// table checks — replace the kind/shape check texts with the migration's, and add:
  check('partner_ai_connections_provider_config_chk', sql`(${t.providerConfig} IS NULL OR jsonb_typeof(${t.providerConfig}) = 'object') AND (${t.kind} <> 'bedrock' OR coalesce(${t.providerConfig}->>'region', '') ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$') AND (${t.kind} <> 'vertex' OR (coalesce(${t.providerConfig}->>'projectId', '') ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' AND coalesce(${t.providerConfig}->>'location', '') ~ '^(global|us|eu|[a-z]+-[a-z]+[0-9]+)$')) AND (${t.kind} <> 'foundry' OR coalesce(${t.providerConfig}->>'resource', '') ~ '^[a-z0-9][a-z0-9-]{1,62}$')`),
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiCloudConnectionsSchema.integration.test.ts
npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
cd ../.. && bash scripts/check-migration-naming.sh --against-ref origin/main && pnpm db:check-drift
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Expected: PASS; drift clean; RLS coverage unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-24-100000-ai-cloud-connections.sql apps/api/src/db/schema/aiModelRegistry.ts \
  apps/api/src/db/schema/aiModelRegistry.contract.test.ts apps/api/src/__tests__/integration/aiCloudConnectionsSchema.integration.test.ts
git commit -m "feat(ai-models): partner_ai_connections accepts bedrock / vertex / foundry with per-kind shape checks (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Cloud credentials — one encrypted document per connection

Credentials are a per-kind JSON document sealed with W02's `encryptConnectionKey(id, plaintext)` (row-bound AAD `partner_llm_configs.api_key_encrypted:<id>`) into `api_key_encrypted` (Decision D2). This task owns turning the create/patch input into that document, validating it, deriving the display hint (`key_last4`) and fingerprint, and parsing it back with a per-kind schema on decrypt (a document that does not parse is treated exactly like an undecryptable key: connection unusable).

Vertex validation is the security-sensitive part (Review Focus 2): the uploaded JSON must be `type: 'service_account'`, carry `client_email`, `private_key` (PEM), `private_key_id`, and either no `token_uri` or exactly `https://oauth2.googleapis.com/token`, and either no `universe_domain` or `googleapis.com`. `external_account`, `impersonated_service_account`, `authorized_user` are refused. Only the fields needed to mint a token are kept (`client_email`, `private_key`, `private_key_id`, `project_id`); everything else is discarded before encryption.

**Files:**
- Create: `apps/api/src/services/aiModels/cloudCredentials.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: Task 1 schemas; Q12 `encryptConnectionKey`, `decryptConnectionKey`; `hmacFingerprint`.
- Produces:

```ts
export type CloudCredentialDocument =
  | { kind: 'bedrock'; authType: 'iam'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'bedrock'; authType: 'api_key'; apiKey: string }
  | { kind: 'vertex'; authType: 'service_account'; clientEmail: string; privateKey: string; privateKeyId: string; projectId: string | null }
  | { kind: 'foundry'; authType: 'api_key'; apiKey: string };
export class CloudCredentialError extends Error { readonly code: 'invalid_credentials' | 'credentials_mismatch'; readonly status: 400 }
export function normalizeCloudCredentials(kind: CloudConnectionKind, input: unknown): CloudCredentialDocument;   // validates the API input
export function sealCloudCredentials(connectionId: string, doc: CloudCredentialDocument): { apiKeyEncrypted: string; keyLast4: string; keyFingerprint: string };
export function openCloudCredentials(kind: CloudConnectionKind, plaintext: string): CloudCredentialDocument;      // throws CloudCredentialError
export function cloudCredentialSecrets(doc: CloudCredentialDocument): string[];                                   // every secret string, for scrubSecrets
export function credentialAuthType(doc: CloudCredentialDocument): 'iam' | 'api_key' | 'service_account';
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/cloudCredentials.test.ts
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cloudCredentialSecrets, normalizeCloudCredentials, openCloudCredentials, sealCloudCredentials } from './cloudCredentials';
import { decryptConnectionKey } from './connections';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const sa = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'service_account', project_id: 'my-project-123', private_key_id: 'abcdef0123456789', private_key: pem,
  client_email: 'breeze@my-project-123.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', universe_domain: 'googleapis.com', ...over });

describe('cloudCredentials', () => {
  it('bedrock IAM: hint is the access key id last 4; secrets list both parts', () => {
    const doc = normalizeCloudCredentials('bedrock', { authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) });
    const sealed = sealCloudCredentials('00000000-0000-4000-8000-000000000001', doc);
    expect(sealed.keyLast4).toBe('MNOP');
    expect(cloudCredentialSecrets(doc)).toEqual(['s'.repeat(40)]);
  });

  it('round-trips through the row-bound AAD and refuses another row id', () => {
    const doc = normalizeCloudCredentials('foundry', { authType: 'api_key', apiKey: 'k'.repeat(32) });
    const id = '00000000-0000-4000-8000-000000000002';
    const { apiKeyEncrypted } = sealCloudCredentials(id, doc);
    expect(openCloudCredentials('foundry', decryptConnectionKey({ id, apiKeyEncrypted }))).toEqual(doc);
    expect(() => decryptConnectionKey({ id: '00000000-0000-4000-8000-000000000003', apiKeyEncrypted })).toThrow();
  });

  it('vertex: keeps only the token-minting fields', () => {
    const doc = normalizeCloudCredentials('vertex', { authType: 'service_account', serviceAccountJson: sa() });
    expect(doc).toEqual({ kind: 'vertex', authType: 'service_account', clientEmail: 'breeze@my-project-123.iam.gserviceaccount.com',
      privateKey: pem, privateKeyId: 'abcdef0123456789', projectId: 'my-project-123' });
  });

  it.each([
    ['a non-Google token_uri', sa({ token_uri: 'https://evil.example.com/token' })],
    ['a non-Google universe_domain', sa({ universe_domain: 'evil.example.com' })],
    ['external_account (WIF)', sa({ type: 'external_account' })],
    ['impersonated_service_account', sa({ type: 'impersonated_service_account' })],
    ['authorized_user', sa({ type: 'authorized_user' })],
    ['a missing private key', sa({ private_key: undefined })],
    ['a non-PEM private key', sa({ private_key: 'not a key' })],
    ['not JSON', '{nope'],
  ])('vertex: rejects %s', (_l, json) => {
    expect(() => normalizeCloudCredentials('vertex', { authType: 'service_account', serviceAccountJson: json })).toThrowError(/service account/i);
  });

  it('rejects credentials of another kind (credentials_mismatch)', () => {
    expect(() => normalizeCloudCredentials('foundry', { authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) }))
      .toThrowError(expect.objectContaining({ code: 'credentials_mismatch' }));
  });

  it('openCloudCredentials refuses a document of another kind or a malformed one', () => {
    expect(() => openCloudCredentials('bedrock', JSON.stringify({ kind: 'foundry', authType: 'api_key', apiKey: 'x' }))).toThrow();
    expect(() => openCloudCredentials('bedrock', 'sk-plain-key')).toThrow();
  });

  it('error messages never contain secret material', () => {
    try { normalizeCloudCredentials('vertex', { authType: 'service_account', serviceAccountJson: sa({ token_uri: 'https://evil.example.com' }) }); }
    catch (e) { expect(String((e as Error).message)).not.toContain('BEGIN PRIVATE KEY'); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/cloudCredentials.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiModels/cloudCredentials.ts
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import {
  bedrockCredentialsInputSchema, foundryCredentialsInputSchema, vertexCredentialsInputSchema,
  type CloudConnectionKind,
} from '@breeze/shared';
import { hmacFingerprint } from '../secretCrypto';
import { encryptConnectionKey } from './connections';

export type CloudCredentialDocument =
  | { kind: 'bedrock'; authType: 'iam'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'bedrock'; authType: 'api_key'; apiKey: string }
  | { kind: 'vertex'; authType: 'service_account'; clientEmail: string; privateKey: string; privateKeyId: string; projectId: string | null }
  | { kind: 'foundry'; authType: 'api_key'; apiKey: string };

export class CloudCredentialError extends Error {
  readonly status = 400 as const;
  constructor(message: string, readonly code: 'invalid_credentials' | 'credentials_mismatch') { super(message); this.name = 'CloudCredentialError'; }
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().max(64).optional(),
  private_key_id: z.string().min(8).max(128),
  private_key: z.string().min(100).max(10_000),
  client_email: z.string().email().max(254),
  token_uri: z.literal(GOOGLE_TOKEN_URI).optional(),
  universe_domain: z.literal('googleapis.com').optional(),
}).passthrough();

const badSa = (): CloudCredentialError =>
  new CloudCredentialError('That file is not a usable Google service account key (download a JSON key for a service account; workload identity and user credentials are not supported).', 'invalid_credentials');

export function normalizeCloudCredentials(kind: CloudConnectionKind, input: unknown): CloudCredentialDocument {
  switch (kind) {
    case 'bedrock': {
      const p = bedrockCredentialsInputSchema.safeParse(input);
      if (!p.success) throw new CloudCredentialError('Enter an AWS access key id + secret, or a Bedrock API key.', mismatchOr(input, 'invalid_credentials'));
      return p.data.authType === 'iam'
        ? { kind, authType: 'iam', accessKeyId: p.data.accessKeyId, secretAccessKey: p.data.secretAccessKey }
        : { kind, authType: 'api_key', apiKey: p.data.apiKey };
    }
    case 'vertex': {
      const p = vertexCredentialsInputSchema.safeParse(input);
      if (!p.success) throw new CloudCredentialError('Upload a Google service account key.', mismatchOr(input, 'invalid_credentials'));
      let raw: unknown;
      try { raw = JSON.parse(p.data.serviceAccountJson); } catch { throw badSa(); }
      const s = serviceAccountSchema.safeParse(raw);
      if (!s.success) throw badSa();
      try { createPrivateKey(s.data.private_key); } catch { throw badSa(); }
      return { kind, authType: 'service_account', clientEmail: s.data.client_email, privateKey: s.data.private_key,
        privateKeyId: s.data.private_key_id, projectId: s.data.project_id ?? null };
    }
    case 'foundry': {
      const p = foundryCredentialsInputSchema.safeParse(input);
      if (!p.success) throw new CloudCredentialError('Enter the Foundry resource API key.', mismatchOr(input, 'invalid_credentials'));
      return { kind, authType: 'api_key', apiKey: p.data.apiKey };
    }
  }
}

/** A known authType the kind does not accept → mismatch; anything else → invalid. */
function mismatchOr(input: unknown, fallback: 'invalid_credentials'): 'invalid_credentials' | 'credentials_mismatch' {
  const t = (input as { authType?: unknown } | null)?.authType;
  return typeof t === 'string' && ['iam', 'api_key', 'service_account'].includes(t) ? 'credentials_mismatch' : fallback;
}

export function credentialAuthType(doc: CloudCredentialDocument): 'iam' | 'api_key' | 'service_account' { return doc.authType; }

function hint(doc: CloudCredentialDocument): string {
  switch (doc.authType) {
    case 'iam': return doc.accessKeyId.slice(-4);
    case 'api_key': return doc.apiKey.slice(-4);
    case 'service_account': return doc.privateKeyId.slice(-4);
  }
}

export function sealCloudCredentials(connectionId: string, doc: CloudCredentialDocument) {
  const plaintext = JSON.stringify(doc);
  return { apiKeyEncrypted: encryptConnectionKey(connectionId, plaintext), keyLast4: hint(doc), keyFingerprint: hmacFingerprint(plaintext) };
}

const documentSchema = z.discriminatedUnion('authType', [
  z.object({ kind: z.literal('bedrock'), authType: z.literal('iam'), accessKeyId: z.string(), secretAccessKey: z.string() }).strict(),
  z.object({ kind: z.enum(['bedrock', 'foundry']), authType: z.literal('api_key'), apiKey: z.string() }).strict(),
  z.object({ kind: z.literal('vertex'), authType: z.literal('service_account'), clientEmail: z.string(), privateKey: z.string(), privateKeyId: z.string(), projectId: z.string().nullable() }).strict(),
]);

export function openCloudCredentials(kind: CloudConnectionKind, plaintext: string): CloudCredentialDocument {
  let raw: unknown;
  try { raw = JSON.parse(plaintext); } catch { throw new CloudCredentialError('Stored credentials are unreadable.', 'invalid_credentials'); }
  const p = documentSchema.safeParse(raw);
  if (!p.success || p.data.kind !== kind) throw new CloudCredentialError('Stored credentials do not match this connection.', 'credentials_mismatch');
  return p.data as CloudCredentialDocument;
}

export function cloudCredentialSecrets(doc: CloudCredentialDocument): string[] {
  switch (doc.authType) {
    case 'iam': return [doc.secretAccessKey];
    case 'api_key': return [doc.apiKey];
    case 'service_account': return [doc.privateKey];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiModels/cloudCredentials.test.ts src/services/encryptedColumnRegistry.test.ts`
Expected: PASS (the registry test is unchanged — same column, same spec).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/cloudCredentials.ts apps/api/src/services/aiModels/cloudCredentials.test.ts
git commit -m "feat(ai-models): cloud credential documents under the connection's row-bound encryption (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Provider endpoints and geography

Pure functions: from validated `provider_config` to the provider origins the gateway may dial, and from (kind, provider config, wire model) to a geography. These are the only sources of upstream hosts for cloud kinds.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/cloud/endpoints.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/cloud/geography.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:

```ts
// endpoints.ts
export interface CloudOrigins { runtime: string; control?: string }   // control = Bedrock control plane (discovery only)
export function cloudOrigins(kind: CloudConnectionKind, cfg: CloudProviderConfig): CloudOrigins;  // throws on invalid config
export const VERTEX_PATH: RegExp;     // ^/v1/projects/([^/]+)/locations/([^/]+)/publishers/anthropic/models/([^/:]+):(rawPredict|streamRawPredict)$
export const BEDROCK_PATH: RegExp;    // ^/model/([^/]+)/(invoke|invoke-with-response-stream|count-tokens)$
export const FOUNDRY_PATHS: ReadonlySet<string>;   // /anthropic/v1/messages, /anthropic/v1/messages/count_tokens
// geography.ts
export function cloudInferenceGeo(kind: CloudConnectionKind, cfg: CloudProviderConfig, wireModel: string): 'us' | 'eu' | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
// endpoints.test.ts
import { describe, expect, it } from 'vitest';
import { BEDROCK_PATH, cloudOrigins, VERTEX_PATH } from './endpoints';

describe('cloudOrigins', () => {
  it('bedrock runtime + control plane', () => {
    expect(cloudOrigins('bedrock', { region: 'eu-central-1' })).toEqual({
      runtime: 'https://bedrock-runtime.eu-central-1.amazonaws.com', control: 'https://bedrock.eu-central-1.amazonaws.com' });
  });
  it.each([
    [{ projectId: 'p-12345', location: 'global' }, 'https://aiplatform.googleapis.com'],
    [{ projectId: 'p-12345', location: 'us' }, 'https://aiplatform.us.rep.googleapis.com'],
    [{ projectId: 'p-12345', location: 'eu' }, 'https://aiplatform.eu.rep.googleapis.com'],
    [{ projectId: 'p-12345', location: 'us-east5' }, 'https://us-east5-aiplatform.googleapis.com'],
  ])('vertex %j → %s', (cfg, origin) => {
    expect(cloudOrigins('vertex', cfg).runtime).toBe(origin);
  });
  it('foundry', () => {
    expect(cloudOrigins('foundry', { resource: 'contoso-ai' }).runtime).toBe('https://contoso-ai.services.ai.azure.com');
  });
  it('refuses a config that would inject a host', () => {
    expect(() => cloudOrigins('bedrock', { region: 'us-east-1.evil.com' } as never)).toThrow();
    expect(() => cloudOrigins('foundry', { resource: 'evil.com/x' } as never)).toThrow();
  });
});

describe('path patterns', () => {
  it('bedrock', () => {
    expect(BEDROCK_PATH.exec('/model/us.anthropic.claude-sonnet-5-5/invoke-with-response-stream')?.[1]).toBe('us.anthropic.claude-sonnet-5-5');
    expect(BEDROCK_PATH.test('/model/x/converse')).toBe(false);
    expect(BEDROCK_PATH.test('/model/../x/invoke')).toBe(false);
  });
  it('vertex', () => {
    const m = VERTEX_PATH.exec('/v1/projects/p-12345/locations/eu/publishers/anthropic/models/claude-sonnet-5:streamRawPredict')!;
    expect(m.slice(1, 4)).toEqual(['p-12345', 'eu', 'claude-sonnet-5']);
    expect(VERTEX_PATH.test('/v1/projects/p/locations/eu/publishers/google/models/gemini:streamRawPredict')).toBe(false);
  });
});
```

```ts
// geography.test.ts
import { describe, expect, it } from 'vitest';
import { cloudInferenceGeo } from './geography';

describe('cloudInferenceGeo (D5)', () => {
  it.each([
    ['global.anthropic.claude-sonnet-5-5', 'eu-central-1', null],
    ['eu.anthropic.claude-sonnet-5-5', 'eu-central-1', 'eu'],
    ['us.anthropic.claude-sonnet-5-5', 'us-east-1', 'us'],
    ['us-gov.anthropic.claude-sonnet-4-6', 'us-gov-west-1', 'us'],
    ['apac.anthropic.claude-sonnet-4-6', 'ap-southeast-2', null],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'eu-west-1', 'eu'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'us-west-2', 'us'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'ap-northeast-1', null],
    ['arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc', 'eu-west-1', null],
  ])('bedrock %s in %s → %s', (model, region, geo) => {
    expect(cloudInferenceGeo('bedrock', { region }, model)).toBe(geo);
  });
  it.each([['global', null], ['us', 'us'], ['eu', 'eu'], ['us-east5', 'us'], ['europe-west1', 'eu'], ['asia-southeast1', null]])('vertex %s → %s', (location, geo) => {
    expect(cloudInferenceGeo('vertex', { projectId: 'p-12345', location }, 'claude-sonnet-5')).toBe(geo);
  });
  it('foundry is never residency-eligible in v1', () => {
    expect(cloudInferenceGeo('foundry', { resource: 'contoso-ai' }, 'claude-sonnet-5')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// endpoints.ts
import {
  bedrockProviderConfigSchema, foundryProviderConfigSchema, vertexProviderConfigSchema,
  type CloudConnectionKind, type CloudProviderConfig,
} from '@breeze/shared';

export interface CloudOrigins { runtime: string; control?: string }

export function cloudOrigins(kind: CloudConnectionKind, cfg: CloudProviderConfig): CloudOrigins {
  switch (kind) {
    case 'bedrock': {
      const { region } = bedrockProviderConfigSchema.parse(cfg);
      return { runtime: `https://bedrock-runtime.${region}.amazonaws.com`, control: `https://bedrock.${region}.amazonaws.com` };
    }
    case 'vertex': {
      const { location } = vertexProviderConfigSchema.parse(cfg);
      if (location === 'global') return { runtime: 'https://aiplatform.googleapis.com' };
      if (location === 'us' || location === 'eu') return { runtime: `https://aiplatform.${location}.rep.googleapis.com` };
      return { runtime: `https://${location}-aiplatform.googleapis.com` };
    }
    case 'foundry': {
      const { resource } = foundryProviderConfigSchema.parse(cfg);
      return { runtime: `https://${resource}.services.ai.azure.com` };
    }
  }
}

export const BEDROCK_PATH = /^\/model\/([A-Za-z0-9._:%-]+)\/(invoke|invoke-with-response-stream|count-tokens)$/;
export const VERTEX_PATH = /^\/v1\/projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]+)\/publishers\/anthropic\/models\/([A-Za-z0-9._@-]+):(rawPredict|streamRawPredict)$/;
export const FOUNDRY_PATHS: ReadonlySet<string> = new Set(['/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens']);
```

(The Bedrock path allows `%` because ARNs arrive URL-encoded; the adapter decodes with `decodeURIComponent` and re-checks for `/`, `..` and control characters before comparing to the bound model.)

```ts
// geography.ts
import type { CloudConnectionKind, CloudProviderConfig } from '@breeze/shared';

function familyOfAwsRegion(region: string): 'us' | 'eu' | null {
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  return null;
}

/**
 * Geography an offering's traffic stays in, from its ROUTE (spec §5.2; W07 D5).
 * null = not pinned (global routing, or a region family Breeze does not model).
 */
export function cloudInferenceGeo(kind: CloudConnectionKind, cfg: CloudProviderConfig, wireModel: string): 'us' | 'eu' | null {
  switch (kind) {
    case 'bedrock': {
      const region = (cfg as { region: string }).region;
      if (wireModel.startsWith('arn:')) return null;            // application profiles may route anywhere
      const prefix = /^([a-z-]+)\.anthropic\./.exec(wireModel)?.[1];
      if (prefix === undefined) return wireModel.startsWith('anthropic.') ? familyOfAwsRegion(region) : null;
      if (prefix === 'us' || prefix === 'us-gov') return 'us';
      if (prefix === 'eu') return 'eu';
      return null;                                              // global, apac, jp, au, …
    }
    case 'vertex': {
      const location = (cfg as { location: string }).location;
      if (location === 'us' || location.startsWith('us-')) return 'us';
      if (location === 'eu' || location.startsWith('europe-')) return 'eu';
      return null;
    }
    case 'foundry':
      return null;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/cloud/endpoints.ts apps/api/src/services/aiModels/gateway/cloud/endpoints.test.ts \
  apps/api/src/services/aiModels/gateway/cloud/geography.ts apps/api/src/services/aiModels/gateway/cloud/geography.test.ts
git commit -m "feat(ai-models): derived cloud provider hosts and route geography (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Upstream authentication — SigV4, Google token, Foundry key; per-request auth in `forwardUpstream`

W06's `forwardUpstream` takes static auth headers (`upstreamAuthHeaders`). SigV4 signs method + URL + headers + body, so auth becomes a per-request async step. This task generalises the W06 seam (`authorizeUpstream`) and the origin rule (a grant may reach a **set** of origins: Bedrock discovery needs the control plane), and adds the three injectors.

- **Bedrock IAM:** `@smithy/signature-v4` (`service: 'bedrock'`, the connection's region, `@aws-crypto/sha256-js`), signing the exact `Buffer` that will be sent; headers `host`, `x-amz-date`, `x-amz-content-sha256`, `content-type`; `authorization` added by the signer. **Bedrock API key:** `authorization: Bearer <apiKey>`.
- **Vertex:** `new JWT({ email, key, keyId, scopes: ['https://www.googleapis.com/auth/cloud-platform'] })` from `google-auth-library` — **never** `GoogleAuth` (whose fallbacks include ADC/metadata). Tokens cached per `(connectionId, configVersion, keyFingerprint)` until 60 s before expiry; one in-flight mint per key (dedupe concurrent requests). The token endpoint is Google's fixed host (validated in Task 3); `JWT` performs that call through its own transport (gaxios) — acceptable for a fixed, validated Google host, and recorded as an Open-question-free, documented exception in the security review brief.
- **Foundry:** `x-api-key: <key>`.
- **Egress policy for cloud kinds:** strict public (`allowPrivateNetwork: false`, `requirePrivateForCleartext: true`), regardless of self-host.

**Files:**
- Modify: `apps/api/package.json` (+ lockfile): add `@smithy/signature-v4`, `@smithy/protocol-http`, `@aws-crypto/sha256-js` at the versions already resolved in `pnpm-lock.yaml` for `@aws-sdk/client-s3` (`pnpm --filter @breeze/api add @smithy/signature-v4@<v> @smithy/protocol-http@<v> @aws-crypto/sha256-js@<v>`)
- Create: `apps/api/src/services/aiModels/gateway/cloud/auth/sigv4.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/cloud/auth/vertexToken.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/cloud/auth/index.ts` (`authorizeCloudRequest`)
- Modify: `apps/api/src/services/aiModels/gateway/types.ts` — `GatewayConnectionConfig` cloud arms; `GatewayCredential` gains `cloud?: CloudCredentialDocument`
- Modify: `apps/api/src/services/aiModels/gateway/forward.ts` (+ test) — `allowedUpstreamOrigins(grant)`, `authorizeUpstream(grant, req)`, per-kind egress allowances
- Modify: `apps/api/src/services/aiModels/gateway/scrub.ts` (+ test) — generic pattern for Google access tokens `\bya29\.[A-Za-z0-9_.-]{10,}` (Codex review #2; test raw, JSON-escaped and URL-encoded echoes)

**Interfaces:**
- Consumes: Task 3 `CloudCredentialDocument`, `cloudCredentialSecrets`; Task 4 `cloudOrigins`; Q2.
- Produces:

```ts
// types.ts (union widened)
export type GatewayConnectionConfig =
  | { source: 'gateway'; kind: 'openai_compatible'; partnerId; connectionId; configVersion; baseUrl: string }
  | { source: 'gateway'; kind: 'bedrock'; partnerId; connectionId; configVersion; providerConfig: BedrockProviderConfig }
  | { source: 'gateway'; kind: 'vertex'; partnerId; connectionId; configVersion; providerConfig: VertexProviderConfig }
  | { source: 'gateway'; kind: 'foundry'; partnerId; connectionId; configVersion; providerConfig: FoundryProviderConfig };
export interface GatewayCredential { secret: string | null; cloud?: CloudCredentialDocument }   // cloud kinds: secret = null, cloud = parsed document
// forward.ts
export function allowedUpstreamOrigins(grant: GatewayGrantRecord): ReadonlySet<string>;    // replaces upstreamOriginFor
export async function authorizeUpstream(grant: GatewayGrantRecord, req: { url: string; method: string; headers: Record<string, string>; body: Buffer | undefined }): Promise<Record<string, string>>;   // replaces upstreamAuthHeaders
export function grantSecrets(grant: GatewayGrantRecord): string[];   // for scrubSecrets everywhere the gateway scrubs
// sigv4.ts
export async function signBedrockRequest(input: { url: string; method: string; headers: Record<string, string>; body: Buffer | undefined; region: string; accessKeyId: string; secretAccessKey: string; now?: Date }): Promise<Record<string, string>>;
// vertexToken.ts
export async function vertexAccessToken(input: { cacheKey: string; clientEmail: string; privateKey: string; privateKeyId: string }): Promise<string>;
export function __resetVertexTokenCacheForTests(): void;
export function cachedVertexToken(cacheKey: string): string | null;   // for grantSecrets (scrubbing)
export function __setJwtFactoryForTests(fn: ((opts: { email: string; key: string; keyId: string; scopes: string[] }) => { authorize(): Promise<{ access_token?: string | null; expiry_date?: number | null }> }) | null): void;
```

- [ ] **Step 1: Write the failing tests**

`sigv4.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { signBedrockRequest } from './sigv4';

describe('signBedrockRequest', () => {
  const base = { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke',
    method: 'POST', headers: { 'content-type': 'application/json' }, region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2026-11-24T12:00:00Z') };

  it('produces a deterministic AWS4-HMAC-SHA256 signature for a fixed clock (known-answer)', async () => {
    const h = await signBedrockRequest({ ...base, body: Buffer.from('{"messages":[]}') });
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261124\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    expect(h['x-amz-date']).toBe('20261124T120000Z');
    // Codex review #7: compare with an INDEPENDENT oracle (a from-scratch SigV4 in this
    // test using node:crypto), never a value frozen from the implementation's own output.
    expect(h.authorization).toBe(referenceSigV4({ ...base, body: Buffer.from('{"messages":[]}'), signedHeaders: h }));
  });

  it('the oracle itself matches the AWS documentation example (get-vanilla, service "service", us-east-1)', () => {
    // AWS SigV4 test suite vector "get-vanilla": GET / host:example.amazonaws.com x-amz-date:20150830T123600Z,
    // key AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY →
    // Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31
    expect(referenceSigV4Vanilla()).toMatch(/Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
  });

  // referenceSigV4 / referenceSigV4Vanilla: ~40 lines at the bottom of this file implementing the
  // documented algorithm (canonical request → string to sign → HMAC chain kDate/kRegion/kService/kSigning)
  // over exactly the headers the implementation signed (SignedHeaders from its output).

  it('the signature covers the body: a different byte changes it', async () => {
    const a = await signBedrockRequest({ ...base, body: Buffer.from('{"a":1}') });
    const b = await signBedrockRequest({ ...base, body: Buffer.from('{"a":2}') });
    expect(a.authorization).not.toBe(b.authorization);
    expect(a['x-amz-content-sha256']).not.toBe(b['x-amz-content-sha256']);
  });

  it('signs the host of the URL, not a caller-supplied host header', async () => {
    const h = await signBedrockRequest({ ...base, headers: { ...base.headers, host: 'evil.example.com' }, body: Buffer.from('{}') });
    expect(h.host).toBe('bedrock-runtime.us-east-1.amazonaws.com');
  });
});
```

`vertexToken.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetVertexTokenCacheForTests, __setJwtFactoryForTests, vertexAccessToken } from './vertexToken';

afterEach(() => { __setJwtFactoryForTests(null); __resetVertexTokenCacheForTests(); });

describe('vertexAccessToken', () => {
  it('mints with the cloud-platform scope via JWT (never GoogleAuth/ADC) and caches until near expiry', async () => {
    const authorize = vi.fn(async () => ({ access_token: 'ya29.t1', expiry_date: Date.now() + 3600_000 }));
    const factory = vi.fn(() => ({ authorize }));
    __setJwtFactoryForTests(factory);
    const input = { cacheKey: 'c1:1:fp', clientEmail: 'a@p.iam.gserviceaccount.com', privateKey: 'PEM', privateKeyId: 'kid' };
    expect(await vertexAccessToken(input)).toBe('ya29.t1');
    expect(await vertexAccessToken(input)).toBe('ya29.t1');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ email: 'a@p.iam.gserviceaccount.com', key: 'PEM', keyId: 'kid', scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  });

  it('concurrent first requests share one mint', async () => {
    let resolve!: (v: { access_token: string; expiry_date: number }) => void;
    const authorize = vi.fn(() => new Promise<{ access_token: string; expiry_date: number }>((r) => { resolve = r; }));
    __setJwtFactoryForTests(() => ({ authorize }));
    const input = { cacheKey: 'c2:1:fp', clientEmail: 'a@p.iam.gserviceaccount.com', privateKey: 'PEM', privateKeyId: 'kid' };
    const both = Promise.all([vertexAccessToken(input), vertexAccessToken(input)]);
    resolve({ access_token: 'ya29.t2', expiry_date: Date.now() + 3600_000 });
    expect(await both).toEqual(['ya29.t2', 'ya29.t2']);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('a mint failure throws a message without key material and is not cached', async () => {
    __setJwtFactoryForTests(() => ({ authorize: async () => { throw new Error('invalid_grant: -----BEGIN PRIVATE KEY----- PEM'); } }));
    const err = await vertexAccessToken({ cacheKey: 'c3:1:fp', clientEmail: 'a@p', privateKey: '-----BEGIN PRIVATE KEY----- PEM', privateKeyId: 'kid' }).catch((e) => e as Error);
    expect(err.message).not.toContain('BEGIN PRIVATE KEY');
  });
});
```

Append to `forward.test.ts` (W06):

```ts
describe('cloud kinds (W07)', () => {
  it('bedrock IAM: signs the exact bytes it sends; strict egress even on self-host', async () => {
    let sent: { url: string; init: Record<string, unknown> } | null = null;
    __setUpstreamFetchForTests((async (url: string, init: Record<string, unknown>) => { sent = { url, init }; return new Response('{}'); }) as never);
    env.hosted = false;   // self-host: still strict for cloud kinds
    const g = cloudGrant('bedrock', { region: 'us-east-1' }, { kind: 'bedrock', authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) });
    const body = Buffer.from('{"anthropic_version":"bedrock-2023-05-31"}');
    await forwardUpstream(g, { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke', method: 'POST', headers: { 'content-type': 'application/json' }, body, stream: false }, new AbortController().signal);
    expect(sent!.init).toMatchObject({ allowPrivateNetwork: false, body });
    expect((sent!.init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('bedrock control plane is reachable only for discovery grants', async () => {
    __setUpstreamFetchForTests((async () => new Response('{}')) as never);
    const cfg = { region: 'us-east-1' };
    const creds = { kind: 'bedrock', authType: 'api_key', apiKey: 'k'.repeat(40) } as const;
    await expect(forwardUpstream(cloudGrant('bedrock', cfg, creds, 'dispatch'), { url: 'https://bedrock.us-east-1.amazonaws.com/foundation-models', method: 'GET', headers: {}, stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway_origin_mismatch' });
    await expect(forwardUpstream(cloudGrant('bedrock', cfg, creds, 'discovery'), { url: 'https://bedrock.us-east-1.amazonaws.com/foundation-models', method: 'GET', headers: {}, stream: false }, new AbortController().signal))
      .resolves.toBeDefined();
  });

  it('vertex: Bearer token from the minted JWT; foundry: x-api-key', async () => { /* mock vertexAccessToken → 'ya29.x'; assert headers */ });

  it('a grant whose cloud credential is missing never falls back (throws, no dial)', async () => {
    const spy = vi.fn(); __setUpstreamFetchForTests(spy as never);
    const g = cloudGrant('foundry', { resource: 'contoso-ai' }, undefined);
    await expect(forwardUpstream(g, { url: 'https://contoso-ai.services.ai.azure.com/anthropic/v1/messages', method: 'POST', headers: {}, body: Buffer.from('{}'), stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'credentials_missing' });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

(`cloudGrant(kind, providerConfig, cloudDoc, purpose = 'dispatch')` is a local builder returning a `GatewayGrantRecord` with `credential: { secret: null, cloud: cloudDoc }`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/auth/ src/services/aiModels/gateway/forward.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`auth/sigv4.ts`:

```ts
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash } from 'node:crypto';

export async function signBedrockRequest(input: {
  url: string; method: string; headers: Record<string, string>; body: Buffer | undefined;
  region: string; accessKeyId: string; secretAccessKey: string; now?: Date;
}): Promise<Record<string, string>> {
  const u = new URL(input.url);
  const body = input.body ?? Buffer.alloc(0);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) if (k.toLowerCase() !== 'host') headers[k.toLowerCase()] = v;
  headers.host = u.host;
  headers['x-amz-content-sha256'] = createHash('sha256').update(body).digest('hex');
  const signer = new SignatureV4({
    service: 'bedrock', region: input.region, sha256: Sha256,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
  });
  const signed = await signer.sign(new HttpRequest({
    method: input.method, protocol: u.protocol, hostname: u.hostname, path: u.pathname,
    query: Object.fromEntries(u.searchParams), headers, body,
  }), { signingDate: input.now });
  return signed.headers as Record<string, string>;
}
```

`auth/vertexToken.ts`:

```ts
import { JWT } from 'google-auth-library';
import { scrubSecrets } from '../../scrub';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
type JwtLike = { authorize(): Promise<{ access_token?: string | null; expiry_date?: number | null }> };
type Factory = (opts: { email: string; key: string; keyId: string; scopes: string[] }) => JwtLike;

/** JWT, never GoogleAuth: GoogleAuth falls back to ADC / the metadata server (ambient identity). */
const defaultFactory: Factory = (opts) => new JWT(opts);
let factory: Factory = defaultFactory;
export function __setJwtFactoryForTests(fn: Factory | null): void { factory = fn ?? defaultFactory; }

const cache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();
export function __resetVertexTokenCacheForTests(): void { cache.clear(); inflight.clear(); }
export function cachedVertexToken(cacheKey: string): string | null { return cache.get(cacheKey)?.token ?? null; }

export async function vertexAccessToken(input: { cacheKey: string; clientEmail: string; privateKey: string; privateKeyId: string }): Promise<string> {
  const hit = cache.get(input.cacheKey);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  const running = inflight.get(input.cacheKey);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await factory({ email: input.clientEmail, key: input.privateKey, keyId: input.privateKeyId, scopes: [SCOPE] }).authorize();
      if (!res.access_token) throw new Error('no access token returned');
      cache.set(input.cacheKey, { token: res.access_token, expiresAt: res.expiry_date ?? Date.now() + 30 * 60_000 });
      return res.access_token;
    } catch (error) {
      throw new Error(`Google rejected the service account: ${scrubSecrets(error instanceof Error ? error.message : String(error), [input.privateKey], 200)}`);
    } finally {
      inflight.delete(input.cacheKey);
    }
  })();
  inflight.set(input.cacheKey, p);
  return p;
}
```

`auth/index.ts`:

```ts
import { GatewayError, type GatewayGrantRecord } from '../../types';
import { signBedrockRequest } from './sigv4';
import { vertexAccessToken } from './vertexToken';

export async function authorizeCloudRequest(
  grant: GatewayGrantRecord,
  req: { url: string; method: string; headers: Record<string, string>; body: Buffer | undefined },
): Promise<Record<string, string>> {
  const doc = grant.credential.cloud;
  if (!doc || doc.kind !== grant.config.kind) {
    throw new GatewayError(502, 'api_error', 'credentials_missing', 'This connection has no usable credentials.');
  }
  switch (doc.authType) {
    case 'iam': {
      if (grant.config.kind !== 'bedrock') throw new GatewayError(502, 'api_error', 'credentials_missing', 'Credential kind mismatch.');
      return signBedrockRequest({ ...req, region: grant.config.providerConfig.region, accessKeyId: doc.accessKeyId, secretAccessKey: doc.secretAccessKey });
    }
    case 'api_key':
      return doc.kind === 'bedrock' ? { ...req.headers, authorization: `Bearer ${doc.apiKey}` } : { ...req.headers, 'x-api-key': doc.apiKey };
    case 'service_account': {
      const token = await vertexAccessToken({
        cacheKey: `${grant.config.connectionId}:${grant.config.configVersion}:${doc.privateKeyId}`,
        clientEmail: doc.clientEmail, privateKey: doc.privateKey, privateKeyId: doc.privateKeyId,
      });
      return { ...req.headers, authorization: `Bearer ${token}` };
    }
  }
}
```

`forward.ts` (W06) — replace `upstreamOriginFor` / `upstreamAuthHeaders` with:

```ts
export function allowedUpstreamOrigins(grant: GatewayGrantRecord): ReadonlySet<string> {
  const c = grant.config;
  switch (c.kind) {
    case 'openai_compatible': return new Set([new URL(c.baseUrl).origin]);
    case 'bedrock': case 'vertex': case 'foundry': {
      const o = cloudOrigins(c.kind, c.providerConfig);
      return new Set([o.runtime, ...(grant.purpose === 'discovery' && o.control ? [o.control] : [])]);
    }
    default: { const never: never = c; throw new Error(String(never)); }
  }
}

export async function authorizeUpstream(grant: GatewayGrantRecord, req: { url: string; method: string; headers: Record<string, string>; body: Buffer | undefined }): Promise<Record<string, string>> {
  if (grant.config.kind === 'openai_compatible') {
    return grant.credential.secret ? { ...req.headers, authorization: `Bearer ${grant.credential.secret}` } : req.headers;
  }
  return authorizeCloudRequest(grant, req);
}

export function grantSecrets(grant: GatewayGrantRecord): string[] {
  const minted = grant.credential.cloud?.authType === 'service_account'
    ? cachedVertexToken(`${grant.config.connectionId}:${grant.config.configVersion}:${grant.credential.cloud.privateKeyId}`)
    : null;   // Codex review #2: a minted Google access token is a secret too
  return [grant.credential.secret, minted, ...(grant.credential.cloud ? cloudCredentialSecrets(grant.credential.cloud) : [])].filter((s): s is string => !!s);
}

function egressAllowances(grant: GatewayGrantRecord) {
  return grant.config.kind === 'openai_compatible' ? byoEgressAllowances() : { allowPrivateNetwork: false, requirePrivateForCleartext: true as const };
}
```

and in `forwardUpstream`: the origin check uses `allowedUpstreamOrigins(grant).has(target.origin)`; the body is normalised to a `Buffer` once (`const body = req.body === undefined ? undefined : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)`), headers are filtered (W06's `STRIPPED`), then `const headers = await authorizeUpstream(grant, { url, method, headers: filtered, body })`, and **that same `body` Buffer** is passed to the fetch; `allowPrivateNetwork` / `requirePrivateForCleartext` come from `egressAllowances(grant)`. Every `scrubSecrets(..., [grant.credential.secret])` call in the gateway (server, adapters) becomes `scrubSecrets(..., grantSecrets(grant))`. A `CloudCredentialError` / `credentials_missing` thrown before dialling is a `GatewayError` (no audit row with `blocked: false`; it never reached the network).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/`
Expected: PASS (all W06 gateway tests still green). After the first green run, freeze `KNOWN_SIGNATURE` in `sigv4.test.ts` and re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/services/aiModels/gateway/
git commit -m "feat(ai-models): per-request upstream auth — SigV4, Google service-account tokens, Foundry keys (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Bedrock / Vertex / Foundry gateway adapters and provider-mode child env

Pass-through adapters: parse just enough of each request to enforce the path allowlist and the bound model, inject auth (Task 5), forward the **same bytes**, and stream the upstream response back **untouched** (Bedrock's binary event stream, Vertex's and Foundry's Anthropic SSE). Non-2xx upstream bodies are capped (4 KiB), scrubbed with `grantSecrets`, and returned with the upstream status in the Anthropic error envelope (the CLI and SDKs map provider errors themselves; a scrubbed upstream message keeps them useful).

| Kind | Caller base URL (`sdkChildEnv` / in-process client) | Allowed paths (after `/g/<token>`) | Bound model is read from |
|---|---|---|---|
| `bedrock` | `ANTHROPIC_BEDROCK_BASE_URL=<grant>` | `POST /model/{id}/invoke`, `/invoke-with-response-stream`, `/count-tokens` | path `{id}` (URL-decoded) |
| `vertex` | `ANTHROPIC_VERTEX_BASE_URL=<grant>/v1` | `POST /v1/projects/{p}/locations/{l}/publishers/anthropic/models/{m}:(rawPredict\|streamRawPredict)` with `p`/`l` equal to the connection's | path `{m}`; for `count-tokens:rawPredict`, body `model` |
| `foundry` | `ANTHROPIC_FOUNDRY_BASE_URL=<grant>/anthropic` | `POST /anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens` | body `model` |

Child env (all three): the provider switch (`CLAUDE_CODE_USE_BEDROCK=1` / `_VERTEX=1` / `_FOUNDRY=1`), its `CLAUDE_CODE_SKIP_*_AUTH=1`, its base URL, `AWS_REGION` (Bedrock) / `CLOUD_ML_REGION` + `ANTHROPIC_VERTEX_PROJECT_ID` (Vertex), `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` = the wire model, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK=1`. No credential variable of any kind; W06's `buildGatewaySdkChildEnv` already drops every parent `AWS_*` / `GOOGLE_*` (they are not in its allowlist) — the test pins it anyway.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/cloud/passthrough.ts` (shared forward-and-stream helper)
- Create: `apps/api/src/services/aiModels/gateway/cloud/bedrockAdapter.ts`, `vertexAdapter.ts`, `foundryAdapter.ts`
- Create: `apps/api/src/services/aiModels/gateway/cloud/cloudAdapters.test.ts`, `cloudChildEnv.test.ts`
- Modify: `apps/api/src/services/aiModels/gateway/index.ts` (three imports)

**Interfaces:**
- Consumes: Tasks 4–5; Q2.
- Produces: `bedrockAdapter`, `vertexAdapter`, `foundryAdapter: GatewayAdapter` (registered on import, `dialect` = `'bedrock'` / `'vertex'` / `'foundry'`); `passthroughForward(grant, req, upstreamPath): Promise<GatewayResponse>`.

- [ ] **Step 1: Write the failing tests**

`cloudAdapters.test.ts` (real gateway listener, fake upstream via `__setUpstreamFetchForTests`, plain `fetch` as the caller):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const rec = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: Record<string, unknown>) => rec.events.push(e) }));
vi.mock('./auth/vertexToken', () => ({ vertexAccessToken: async () => 'ya29.test' }));
import { __setUpstreamFetchForTests } from '../forward';
import { startModelGateway, type ModelGateway } from '../server';
import './bedrockAdapter'; import './vertexAdapter'; import './foundryAdapter';

let gw: ModelGateway;
const upstream: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
beforeEach(async () => {
  rec.events.length = 0; upstream.length = 0; gw = await startModelGateway();
  __setUpstreamFetchForTests((async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    upstream.push({ url, headers: init.headers, body: init.body });
    return new Response(new Uint8Array([0, 1, 2, 3, 255]), { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  }) as never);
});
afterEach(async () => { __setUpstreamFetchForTests(null); await gw.close(); });

const grant = (kind: 'bedrock' | 'vertex' | 'foundry', providerConfig: object, cloud: object, models: string[]) => gw.grant({
  config: { source: 'gateway', kind, partnerId: 'p', connectionId: 'c', configVersion: 1, providerConfig } as never,
  credential: { secret: null, cloud: cloud as never }, wireModels: models, orgId: 'o', aiSessionId: null, purpose: 'dispatch',
});

describe('bedrock adapter', () => {
  const g = () => grant('bedrock', { region: 'eu-central-1' }, { kind: 'bedrock', authType: 'api_key', apiKey: 'k'.repeat(40) }, ['eu.anthropic.claude-sonnet-5-5']);

  it('forwards a bound invoke-with-response-stream byte-for-byte and streams the binary response back untouched', async () => {
    const { baseUrl } = g();
    const body = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[]}';
    const res = await fetch(`${baseUrl}/model/eu.anthropic.claude-sonnet-5-5/invoke-with-response-stream`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
    expect(upstream[0]!.url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5/invoke-with-response-stream');
    expect(upstream[0]!.body.toString()).toBe(body);
    expect(upstream[0]!.headers.authorization).toBe(`Bearer ${'k'.repeat(40)}`);
  });

  it('Bedrock model in the path must be bound (403, audited, not forwarded)', async () => {
    const { baseUrl } = g();
    const res = await fetch(`${baseUrl}/model/global.anthropic.claude-opus-5-5/invoke`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    expect(upstream).toHaveLength(0);
    expect(rec.events.at(-1)).toMatchObject({ blocked: true, connectionId: 'c' });
  });

  it.each(['/model/x/converse', '/foundation-models', '/model/%2E%2E%2Fx/invoke', '/model/a%2Fb/invoke'])('refuses path %s', async (p) => {
    const { baseUrl } = g();
    expect((await fetch(`${baseUrl}${p}`, { method: 'POST', body: '{}' })).status).toBeGreaterThanOrEqual(400);
    expect(upstream).toHaveLength(0);
  });
});

describe('vertex adapter', () => {
  const g = () => grant('vertex', { projectId: 'my-project-123', location: 'eu' }, { kind: 'vertex', authType: 'service_account', clientEmail: 'a@b', privateKey: 'PEM', privateKeyId: 'kid', projectId: null }, ['claude-sonnet-5']);

  it('forwards to the multi-region host with a Bearer token', async () => {
    const { baseUrl } = g();
    await fetch(`${baseUrl}/v1/projects/my-project-123/locations/eu/publishers/anthropic/models/claude-sonnet-5:streamRawPredict`, { method: 'POST', body: '{"anthropic_version":"vertex-2023-10-16"}' });
    expect(upstream[0]!.url).toBe('https://aiplatform.eu.rep.googleapis.com/v1/projects/my-project-123/locations/eu/publishers/anthropic/models/claude-sonnet-5:streamRawPredict');
    expect(upstream[0]!.headers.authorization).toBe('Bearer ya29.test');
  });

  it('path project/location must equal the connection\'s (another project → 403)', async () => {
    const { baseUrl } = g();
    expect((await fetch(`${baseUrl}/v1/projects/other-project-99/locations/eu/publishers/anthropic/models/claude-sonnet-5:rawPredict`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(`${baseUrl}/v1/projects/my-project-123/locations/us/publishers/anthropic/models/claude-sonnet-5:rawPredict`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(upstream).toHaveLength(0);
  });
});

describe('foundry adapter', () => {
  const g = () => grant('foundry', { resource: 'contoso-ai' }, { kind: 'foundry', authType: 'api_key', apiKey: 'f'.repeat(32) }, ['claude-sonnet-5']);

  it('forwards /anthropic/v1/messages with x-api-key when body.model is bound', async () => {
    const { baseUrl } = g();
    await fetch(`${baseUrl}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [] }) });
    expect(upstream[0]!.url).toBe('https://contoso-ai.services.ai.azure.com/anthropic/v1/messages');
    expect(upstream[0]!.headers['x-api-key']).toBe('f'.repeat(32));
  });

  it('unbound body.model → 403', async () => {
    const { baseUrl } = g();
    expect((await fetch(`${baseUrl}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5' }) })).status).toBe(403);
  });
});

it('upstream error bodies are capped and scrubbed of the credential', async () => {
  __setUpstreamFetchForTests((async () => new Response(`denied for key ${'f'.repeat(32)}`, { status: 403 })) as never);
  const { baseUrl } = grant('foundry', { resource: 'contoso-ai' }, { kind: 'foundry', authType: 'api_key', apiKey: 'f'.repeat(32) }, ['claude-sonnet-5']);
  const res = await fetch(`${baseUrl}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }) });
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain('f'.repeat(32));
});
```

`cloudChildEnv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bedrockAdapter } from './bedrockAdapter';
import { vertexAdapter } from './vertexAdapter';
import { foundryAdapter } from './foundryAdapter';
import { buildGatewaySdkChildEnv } from '../../sdkChildEnv';

const PARENT = { PATH: '/usr/bin', HOME: '/h', AWS_ACCESS_KEY_ID: 'AKIAPARENT', AWS_SECRET_ACCESS_KEY: 'parent', AWS_PROFILE: 'prod', AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/x',
  GOOGLE_APPLICATION_CREDENTIALS: '/etc/sa.json', GCLOUD_PROJECT: 'p', AZURE_CLIENT_SECRET: 'az', ANTHROPIC_API_KEY: 'sk-platform' };
const base = { partnerId: 'p', connectionId: 'c', configVersion: 1, source: 'gateway' } as const;

describe('provider-mode child env', () => {
  it.each([
    [bedrockAdapter, { ...base, kind: 'bedrock', providerConfig: { region: 'eu-central-1' } }, 'eu.anthropic.claude-sonnet-5-5',
      { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', ANTHROPIC_BEDROCK_BASE_URL: 'G', AWS_REGION: 'eu-central-1' }],
    [vertexAdapter, { ...base, kind: 'vertex', providerConfig: { projectId: 'my-project-123', location: 'eu' } }, 'claude-sonnet-5',
      { CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1', ANTHROPIC_VERTEX_BASE_URL: 'G/v1', CLOUD_ML_REGION: 'eu', ANTHROPIC_VERTEX_PROJECT_ID: 'my-project-123' }],
    [foundryAdapter, { ...base, kind: 'foundry', providerConfig: { resource: 'contoso-ai' } }, 'claude-sonnet-5',
      { CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'G/anthropic' }],
  ])('%#: provider switch, skip-auth, gateway base URL, model pins', (adapter, config, wire, expected) => {
    const env = buildGatewaySdkChildEnv({ adapterEnv: adapter.sdkChildEnv({ gatewayBaseUrl: 'G', config: config as never, wireModel: wire }), denyProxyUrl: 'http://breeze:t@127.0.0.1:9', source: PARENT });
    expect(env).toMatchObject({ ...expected, ANTHROPIC_DEFAULT_SONNET_MODEL: wire, ANTHROPIC_DEFAULT_HAIKU_MODEL: wire, ANTHROPIC_SMALL_FAST_MODEL: wire,
      CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1', NO_PROXY: '127.0.0.1,localhost' });
  });

  it('no ambient credential variables reach the child (any kind)', () => {
    for (const [adapter, config] of [[bedrockAdapter, { ...base, kind: 'bedrock', providerConfig: { region: 'us-east-1' } }],
      [vertexAdapter, { ...base, kind: 'vertex', providerConfig: { projectId: 'my-project-123', location: 'us' } }],
      [foundryAdapter, { ...base, kind: 'foundry', providerConfig: { resource: 'contoso-ai' } }]] as const) {
      const env = buildGatewaySdkChildEnv({ adapterEnv: adapter.sdkChildEnv({ gatewayBaseUrl: 'G', config: config as never, wireModel: 'm' }), denyProxyUrl: 'x', source: PARENT });
      for (const k of Object.keys(env)) expect(k).not.toMatch(/^(AWS_(ACCESS|SECRET|SESSION|PROFILE|WEB_IDENTITY|CONTAINER)|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)/);
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/cloudAdapters.test.ts src/services/aiModels/gateway/cloud/cloudChildEnv.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`cloud/passthrough.ts`:

```ts
import { forwardUpstream, grantSecrets } from '../forward';
import { scrubSecrets } from '../scrub';
import { gatewayErrorBody, type AnthropicErrorType, type GatewayGrantRecord, type GatewayIncomingRequest, type GatewayResponse } from '../types';

const PASS_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'x-amzn-bedrock-accept', 'x-amzn-bedrock-trace'];
const RETURN_HEADERS = ['content-type', 'x-amzn-requestid', 'request-id', 'x-request-id', 'retry-after'];

function errType(status: number): AnthropicErrorType {
  if (status === 429) return 'rate_limit_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 400 || status === 422) return 'invalid_request_error';
  if (status === 529 || status === 503) return 'overloaded_error';
  return 'api_error';
}

export async function passthroughForward(grant: GatewayGrantRecord, req: GatewayIncomingRequest, upstreamUrl: string): Promise<GatewayResponse> {
  const headers: Record<string, string> = {};
  for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = req.headers[h]!;
  const streaming = /streamRawPredict|invoke-with-response-stream/.test(upstreamUrl) || /"stream"\s*:\s*true/.test(req.body.toString('utf8', 0, Math.min(req.body.length, 64 * 1024)));
  const res = await forwardUpstream(grant, { url: upstreamUrl, method: 'POST', headers, body: req.body, stream: streaming }, req.signal);
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 4096);
    return { status: res.status, headers: { 'content-type': 'application/json' },
      body: Buffer.from(gatewayErrorBody(errType(res.status), scrubSecrets(text || `HTTP ${res.status}`, grantSecrets(grant), 600))) };
  }
  const out: Record<string, string> = {};
  for (const h of RETURN_HEADERS) { const v = res.headers.get(h); if (v) out[h] = v; }
  return { status: res.status, headers: out, body: res.body ? (res.body as unknown as AsyncIterable<Uint8Array>) : Buffer.alloc(0) };
}
```

`cloud/bedrockAdapter.ts`:

```ts
import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { GatewayError } from '../types';
import { BEDROCK_PATH, cloudOrigins } from './endpoints';
import { passthroughForward } from './passthrough';

const COMMON = (wire: string) => ({
  ANTHROPIC_DEFAULT_OPUS_MODEL: wire, ANTHROPIC_DEFAULT_SONNET_MODEL: wire, ANTHROPIC_DEFAULT_HAIKU_MODEL: wire,
  ANTHROPIC_DEFAULT_FABLE_MODEL: wire, ANTHROPIC_SMALL_FAST_MODEL: wire,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
});
export { COMMON as cloudModelPins };

export const bedrockAdapter: GatewayAdapter = {
  kind: 'bedrock',
  dialect: 'bedrock',
  async handle(req, grant) {
    if (grant.config.kind !== 'bedrock') throw new Error('bedrock adapter on a non-bedrock grant');
    const m = req.method === 'POST' ? BEDROCK_PATH.exec(req.path) : null;
    if (!m) throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
    let modelId: string;
    try { modelId = decodeURIComponent(m[1]!); } catch { throw new GatewayError(400, 'invalid_request_error', 'bad_path', 'Malformed model id.'); }
    if (/[/\s]|\.\./.test(modelId) && !modelId.startsWith('arn:aws')) throw new GatewayError(400, 'invalid_request_error', 'bad_path', 'Malformed model id.');
    assertBoundModel(grant, modelId);
    const { runtime } = cloudOrigins('bedrock', grant.config.providerConfig);
    return passthroughForward(grant, req, `${runtime}${req.path}`);
  },
  sdkChildEnv({ gatewayBaseUrl, config, wireModel }) {
    if (config.kind !== 'bedrock') throw new Error('bedrock env on a non-bedrock config');
    return {
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      ANTHROPIC_BEDROCK_BASE_URL: gatewayBaseUrl, AWS_REGION: config.providerConfig.region,
      ...COMMON(wireModel),
    };
  },
};
registerGatewayAdapter(bedrockAdapter);
```

`cloud/vertexAdapter.ts`:

```ts
import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { GatewayError } from '../types';
import { cloudModelPins } from './bedrockAdapter';
import { cloudOrigins, VERTEX_PATH } from './endpoints';
import { passthroughForward } from './passthrough';

export const vertexAdapter: GatewayAdapter = {
  kind: 'vertex',
  dialect: 'vertex',
  async handle(req, grant) {
    if (grant.config.kind !== 'vertex') throw new Error('vertex adapter on a non-vertex grant');
    const m = req.method === 'POST' ? VERTEX_PATH.exec(req.path) : null;
    if (!m) throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
    const [, project, location, model] = m;
    const cfg = grant.config.providerConfig;
    if (project !== cfg.projectId || location !== cfg.location) {
      throw new GatewayError(403, 'permission_error', 'gateway_model_mismatch', 'This connection is not authorised for that project or location.');
    }
    if (model === 'count-tokens') {
      let body: { model?: unknown };
      try { body = JSON.parse(req.body.toString('utf8')) as { model?: unknown }; } catch { throw new GatewayError(400, 'invalid_request_error', 'bad_json', 'Request body is not JSON.'); }
      assertBoundModel(grant, body.model);
    } else {
      assertBoundModel(grant, model);
    }
    return passthroughForward(grant, req, `${cloudOrigins('vertex', cfg).runtime}${req.path}`);
  },
  sdkChildEnv({ gatewayBaseUrl, config, wireModel }) {
    if (config.kind !== 'vertex') throw new Error('vertex env on a non-vertex config');
    return {
      CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_VERTEX_BASE_URL: `${gatewayBaseUrl}/v1`,
      CLOUD_ML_REGION: config.providerConfig.location, ANTHROPIC_VERTEX_PROJECT_ID: config.providerConfig.projectId,
      ...cloudModelPins(wireModel),
    };
  },
};
registerGatewayAdapter(vertexAdapter);
```

`cloud/foundryAdapter.ts`:

```ts
import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { GatewayError } from '../types';
import { cloudModelPins } from './bedrockAdapter';
import { cloudOrigins, FOUNDRY_PATHS } from './endpoints';
import { passthroughForward } from './passthrough';

export const foundryAdapter: GatewayAdapter = {
  kind: 'foundry',
  dialect: 'foundry',
  async handle(req, grant) {
    if (grant.config.kind !== 'foundry') throw new Error('foundry adapter on a non-foundry grant');
    if (req.method !== 'POST' || !FOUNDRY_PATHS.has(req.path)) throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
    let body: { model?: unknown };
    try { body = JSON.parse(req.body.toString('utf8')) as { model?: unknown }; } catch { throw new GatewayError(400, 'invalid_request_error', 'bad_json', 'Request body is not JSON.'); }
    assertBoundModel(grant, body.model);
    return passthroughForward(grant, req, `${cloudOrigins('foundry', grant.config.providerConfig).runtime}${req.path}`);
  },
  sdkChildEnv({ gatewayBaseUrl, config, wireModel }) {
    if (config.kind !== 'foundry') throw new Error('foundry env on a non-foundry config');
    return {
      CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
      ANTHROPIC_FOUNDRY_BASE_URL: `${gatewayBaseUrl}/anthropic`,
      ...cloudModelPins(wireModel),
    };
  },
};
registerGatewayAdapter(foundryAdapter);
```

`gateway/index.ts`: add `import './cloud/bedrockAdapter'; import './cloud/vertexAdapter'; import './cloud/foundryAdapter';`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/
git commit -m "feat(ai-models): bedrock / vertex / foundry pass-through gateway adapters + provider-mode child env (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: In-process clients for Messages API surfaces (cloud SDK clients pointed at the gateway)

The one-shot surfaces (`messages_api` transport) call `anthropicClientFor(resolved, caller)` then `createMessage`. For cloud kinds the client must speak the provider's wire format; the official Anthropic cloud clients do exactly that. They are pointed at the gateway with authentication skipped (Bedrock `skipAuth`, Vertex/Foundry a placeholder the gateway strips — W06 `STRIPPED` drops `authorization` / `x-api-key` / `api-key` from callers), so signing still happens only in the gateway.

**Files:**
- Modify: `apps/api/package.json` (+ lockfile): `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk` at versions compatible with the installed `@anthropic-ai/sdk` (Q15)
- Modify: `apps/api/src/services/aiModels/connectionFactory.ts` (+ `connectionFactory.test.ts`)
- Modify: `apps/api/src/services/aiModels/offeringVerification.ts` (dialect is no longer always `'anthropic'`)

**Interfaces:**
- Consumes: Q4; Task 6 dialects.
- Produces:

```ts
export type MessagesClient = Pick<Anthropic, 'messages' | 'beta'>;      // what one-shot surfaces need
export type AnthropicClientTarget =
  | …W03/W06 arms…
  | { kind: 'gateway'; baseUrl: string; dialect: 'anthropic' | 'bedrock' | 'vertex' | 'foundry';
      cloud?: { region?: string; projectId?: string; location?: string } };
export function createAnthropicClient(spec): MessagesClient;           // was Anthropic; non-gateway arms still return Anthropic
export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): MessagesClient;
export async function createMessage(client: MessagesClient, …): Promise<MessageOutcome>;
```

- [ ] **Step 1: Write the failing tests** (append to `connectionFactory.test.ts`; uses a real gateway + fake upstream like Task 6)

```ts
describe('cloud gateway clients (W07)', () => {
  it.each([
    ['bedrock', makeResolvedModel('bedrock'), 'https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5/invoke'],
    ['vertex', makeResolvedModel('vertex'), 'https://aiplatform.eu.rep.googleapis.com/v1/projects/my-project-123/locations/eu/publishers/anthropic/models/claude-sonnet-5:rawPredict'],
    ['foundry', makeResolvedModel('foundry'), 'https://contoso-ai.services.ai.azure.com/anthropic/v1/messages'],
  ])('%s: createMessage through anthropicClientFor reaches exactly the provider URL via the gateway', async (_k, resolved, expectedUrl) => {
    await getModelGateway();
    const seen: string[] = [];
    __setUpstreamFetchForTests((async (url: string) => { seen.push(url);
      return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: resolved.wireModel, content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }); }) as never);
    const client = anthropicClientFor(resolved, { orgId: 'org-1', surface: 'one_shot_ticket_draft' } as never);
    const out = await createMessage(client, resolved, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(out.message.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(seen).toEqual([expectedUrl]);
    __setUpstreamFetchForTests(null);
    await closeModelGateway();
  });

  it('cloud clients ignore a poisoned host environment: no ADC/metadata access, no ambient Foundry resource or AWS region (Codex review #1, #6)', async () => {
    const poisoned = { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/adc.json', ANTHROPIC_FOUNDRY_RESOURCE: 'host-resource', AWS_REGION: 'ap-south-1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'host-project', CLOUD_ML_REGION: 'asia-east1', ANTHROPIC_BEDROCK_BASE_URL: 'https://evil.example.com' };
    const saved = { ...process.env }; Object.assign(process.env, poisoned);
    const metadata = vi.spyOn(globalThis, 'fetch');
    try {
      // repeat the three-provider round trip above; assert seen URLs unchanged and that no fetch targeted
      // metadata.google.internal / 169.254.169.254 / oauth2.googleapis.com
      expect(metadata.mock.calls.some(([u]) => /metadata|169\.254|oauth2\.googleapis/.test(String(u)))).toBe(false);
    } finally { process.env = saved; metadata.mockRestore(); }
  });

  it('a gateway client may only target the loopback gateway', () => {
    expect(() => createAnthropicClient({ apiKey: 'x', target: { kind: 'gateway', baseUrl: 'https://evil.example.com/g/x', dialect: 'bedrock' } })).toThrow(/loopback/);
  });
});
```

Extend `__fixtures__/resolvedModel.ts` with `'bedrock' | 'vertex' | 'foundry'` arms (wire models `eu.anthropic.claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-5`; provider configs `{ region: 'eu-central-1' }`, `{ projectId: 'my-project-123', location: 'eu' }`, `{ resource: 'contoso-ai' }`; credentials `{ secret: null, cloud: <doc> }`; `rateSnapshot.source: 'offering'`; `funding: 'partner_key'`; `inferenceGeo: null`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/connectionFactory.test.ts`
Expected: FAIL (`dialect: 'bedrock'` not accepted).

- [ ] **Step 3: Write the implementation**

```ts
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { OAuth2Client } from 'google-auth-library';

export type MessagesClient = Pick<Anthropic, 'messages' | 'beta'>;
const GATEWAY_BASE = /^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/;

// createAnthropicClient, gateway arm:
    case 'gateway': {
      const t = spec.target;
      if (!GATEWAY_BASE.test(t.baseUrl)) throw new Error('A gateway client may only target the loopback gateway.');
      switch (t.dialect) {
        case 'anthropic':
          return new Anthropic({ baseURL: t.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, authToken: null, ...tuning });
        case 'bedrock':
          // skipAuth: the gateway signs (SigV4 / Bedrock API key). Never pass AWS credentials here.
          return new AnthropicBedrock({ baseURL: t.baseUrl, awsRegion: t.cloud?.region, skipAuth: true, ...tuning }) as unknown as MessagesClient;
        case 'vertex':
          // Codex review #1: `accessToken` alone does NOT stop the Vertex SDK from building
          // GoogleAuth().getClient() (ADC / metadata server = the HOST's identity). Pass an
          // explicit static authClient that only ever yields the placeholder; the gateway
          // strips it and injects the real token.
          return new AnthropicVertex({ baseURL: `${t.baseUrl}/v1`, region: t.cloud?.location, projectId: t.cloud?.projectId,
            authClient: placeholderGoogleAuthClient(), ...tuning }) as unknown as MessagesClient;
        case 'foundry':
          // Codex review #6: the constructor defaults `resource` from ANTHROPIC_FOUNDRY_RESOURCE and
          // rejects resource + baseURL together; override it explicitly (the pinned SDK's supported
          // empty value — check its .d.ts; currently `resource: null`/'' ) so host env cannot interfere.
          return new AnthropicFoundry({ baseURL: `${t.baseUrl}/anthropic`, resource: null as never, apiKey: GATEWAY_PLACEHOLDER_KEY, ...tuning }) as unknown as MessagesClient;
        default: { const never: never = t.dialect; throw new Error(String(never)); }
      }
    }

/** A google-auth-library client that never touches ADC, the metadata server or the network. */
function placeholderGoogleAuthClient(): OAuth2Client {
  const c = new OAuth2Client();
  c.setCredentials({ access_token: GATEWAY_PLACEHOLDER_KEY, expiry_date: Date.now() + 10 * 365 * 24 * 3600_000 });
  return c;
}

/** Target for a resolved gateway connection (dialect from its adapter; cloud routing fields). */
export function gatewayTarget(config: GatewayConnectionConfig, baseUrl: string): Extract<AnthropicClientTarget, { kind: 'gateway' }> {
  switch (config.kind) {
    case 'openai_compatible': return { kind: 'gateway', baseUrl, dialect: 'anthropic' };
    case 'bedrock': return { kind: 'gateway', baseUrl, dialect: 'bedrock', cloud: { region: config.providerConfig.region } };
    case 'vertex': return { kind: 'gateway', baseUrl, dialect: 'vertex', cloud: { projectId: config.providerConfig.projectId, location: config.providerConfig.location } };
    case 'foundry': return { kind: 'gateway', baseUrl, dialect: 'foundry' };
    default: { const never: never = config; throw new Error(String(never)); }
  }
}
```

`anthropicClientFor` (W06) uses `gatewayTarget(conn.config, g.baseUrl)` instead of the literal `{ kind: 'gateway', …, dialect: 'anthropic' }`; `gatewayUpstreamUrl(config)` (W06) gains cloud arms returning `cloudOrigins(kind, providerConfig).runtime`. `createMessage`'s `client` parameter becomes `MessagesClient`. In `offeringVerification.ts` replace the client construction with `createAnthropicClient({ apiKey: GATEWAY_PLACEHOLDER_KEY, target: gatewayTarget(config, grant.baseUrl), maxRetries: 1, timeout: 60_000 })` and widen `FidelityTransport.client` to `MessagesClient` (harness uses only `messages.create`).

Run `npx tsc --noEmit -p apps/api`; any caller that used a non-`messages`/`beta` member of the returned client is a real incompatibility for cloud kinds — fix it at the caller (none expected: W03 Tasks 10–14 call `createMessage`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiModels/connectionFactory.test.ts src/services/aiModels/offeringVerification.test.ts src/services/llm/providerFidelityHarness.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/services/aiModels/connectionFactory.ts apps/api/src/services/aiModels/connectionFactory.test.ts \
  apps/api/src/services/aiModels/offeringVerification.ts apps/api/src/services/llm/providerFidelityHarness.ts apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts
git commit -m "feat(ai-models): Bedrock / Vertex / Foundry Messages clients through the gateway (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Resolver — cloud candidates, endpoint-bound geography, no inherited price

**Files:**
- Modify: `apps/api/src/services/aiModels/eligibility.ts` (+ test) — `CandidateFacts.connection.geoBoundByEndpoint?: boolean`; residency clause
- Modify: `apps/api/src/services/aiModels/gatewayCandidate.ts` (+ test) — `gatewayConfigFor` / `loadGatewayCredential` cloud arms; geography; limits / prompt profile from the linked platform row
- Modify: `apps/api/src/services/aiModels/gatewayCapabilities.ts` (+ test) — `endpointFingerprint` routing fields per kind

**Interfaces:**
- Consumes: Tasks 3, 4; Q3, Q10, Q11, Q13.
- Produces: `CandidateFacts.connection.geoBoundByEndpoint`; `cloudProviderConfigOf(conn): CloudProviderConfig | null`.

- [ ] **Step 1: Write the failing tests**

`eligibility.test.ts` (rows; adapt to the table's tuple shape):

```ts
['cloud connection, EU route, residency required, SDK transport cannot carry inference_geo → eligible (endpoint-bound geo)',
  byokFacts({ connection: { kind: 'bedrock', status: 'active', keyUsable: true, geoBoundByEndpoint: true }, inferenceGeo: 'eu', supportedInferenceGeos: ['eu'] }),
  { residencyRequired: true, geoCarriable: false }, null],
['cloud connection on a global route under required residency → residency_unavailable',
  byokFacts({ connection: { kind: 'vertex', status: 'active', keyUsable: true, geoBoundByEndpoint: true }, inferenceGeo: null, supportedInferenceGeos: [] }),
  { residencyRequired: true }, 'residency_unavailable'],
['BYOK (not endpoint-bound) still needs a carriable geo', byokFacts({ inferenceGeo: 'us', supportedInferenceGeos: ['us'] }),
  { residencyRequired: true, geoCarriable: false }, 'residency_unavailable'],
```

`gatewayCandidate.test.ts` (append):

```ts
describe('cloud kinds (W07)', () => {
  it('bedrock EU profile: partner_key, offering price only (linked platform price NOT inherited), geo eu, endpoint-bound, no inference_geo option', async () => {
    keys.material = { id: 'cb', partnerId: 'p1', apiKeyEncrypted: 'enc:x' };
    keys.decrypt = () => JSON.stringify({ kind: 'bedrock', authType: 'api_key', apiKey: 'k'.repeat(40) });
    platform.byId = { id: 'pm1', modelId: 'claude-sonnet-5-5', rates: STD, maxOutputTokens: 64000, maxInputTokens: 1000000, promptProfile: 'claude-frontier', capabilities: TREE };
    const c = await gatewayCandidate({ offering: offering({ modelId: 'eu.anthropic.claude-sonnet-5-5', platformModelId: 'pm1',
      priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null }),
      conn: cloudConn('bedrock', { region: 'eu-central-1' }), platformGeo: 'us' });
    expect(c.facts.rate).toBeNull();                                         // D4
    expect(c.facts).toMatchObject({ inferenceGeo: 'eu', supportedInferenceGeos: ['eu'], connection: { kind: 'bedrock', keyUsable: true, geoBoundByEndpoint: true } });
    expect(c.optionSupport.inferenceGeo).toEqual([]);                       // never sent as a parameter
    expect(c.limits).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 64000 });
    expect(c.promptProfile).toBe('claude-frontier');
    expect(c.connection).toMatchObject({ kind: 'bedrock', config: { kind: 'bedrock', providerConfig: { region: 'eu-central-1' } },
      credential: { secret: null, cloud: { kind: 'bedrock', authType: 'api_key' } } });
  });

  it('a stored document of the wrong kind makes the connection unusable', async () => {
    keys.decrypt = () => JSON.stringify({ kind: 'foundry', authType: 'api_key', apiKey: 'x' });
    const c = await gatewayCandidate({ offering: offering(), conn: cloudConn('bedrock', { region: 'us-east-1' }), platformGeo: null });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
  });

  it('an invalid provider_config (should be impossible past the CHECK) yields no connection', async () => {
    const c = await gatewayCandidate({ offering: offering(), conn: cloudConn('vertex', { projectId: 'x' }), platformGeo: null });
    expect(c.connection).toBeNull();
  });
});
```

`gatewayCapabilities.test.ts` (append):

```ts
it('cloud fingerprint covers routing fields only (not the display e-mail or the credentials)', () => {
  const a = endpointFingerprint({ kind: 'vertex', baseUrl: null, providerConfig: { projectId: 'p-12345', location: 'eu', serviceAccountEmail: 'a@x' } });
  expect(endpointFingerprint({ kind: 'vertex', baseUrl: null, providerConfig: { projectId: 'p-12345', location: 'eu', serviceAccountEmail: 'b@x' } })).toBe(a);
  expect(endpointFingerprint({ kind: 'vertex', baseUrl: null, providerConfig: { projectId: 'p-12345', location: 'us' } })).not.toBe(a);
  expect(endpointFingerprint({ kind: 'bedrock', baseUrl: null, providerConfig: { region: 'us-east-1' } }))
    .not.toBe(endpointFingerprint({ kind: 'bedrock', baseUrl: null, providerConfig: { region: 'us-west-2' } }));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts src/services/aiModels/gatewayCandidate.test.ts src/services/aiModels/gatewayCapabilities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`eligibility.ts`:

```ts
export interface CandidateFacts {
  // …
  connection: { kind: ConnectionKind; status: string; keyUsable: boolean; /** W07: geography fixed by the endpoint (cloud region), not by a parameter. */ geoBoundByEndpoint?: boolean };
}
// residency clause:
  if (ctx.residencyRequired) {
    const carriable = ctx.geoCarriable || c.connection.geoBoundByEndpoint === true;
    if (!carriable || c.inferenceGeo === null || !c.supportedInferenceGeos.includes(c.inferenceGeo)) return 'residency_unavailable';
  }
```

`gatewayCapabilities.ts` `endpointFingerprint`:

```ts
const ROUTING_FIELDS: Record<string, readonly string[]> = {
  openai_compatible: [], bedrock: ['region'], vertex: ['projectId', 'location'], foundry: ['resource'],
};
export function endpointFingerprint(conn: { kind: string; baseUrl: string | null; providerConfig: Record<string, unknown> | null }): string {
  const routing: Record<string, unknown> = { kind: conn.kind, baseUrl: conn.baseUrl ?? null };
  for (const f of ROUTING_FIELDS[conn.kind] ?? []) routing[f] = conn.providerConfig?.[f] ?? null;
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
}
```

(For `openai_compatible` the routing object is unchanged from W06 — `{ kind, baseUrl }` — so W06 verifications stay valid. Pinned by W06's existing fingerprint test.)

`gatewayCandidate.ts`:

```ts
import { bedrockProviderConfigSchema, foundryProviderConfigSchema, isCloudConnectionKind, vertexProviderConfigSchema,
  type CloudProviderConfig } from '@breeze/shared';
import { openCloudCredentials } from './cloudCredentials';
import { cloudInferenceGeo } from './gateway/cloud/geography';
import { derivePromptProfile } from '../aiModel';
import { getPlatformModelById } from './platformModels';

export function cloudProviderConfigOf(conn: PartnerAiConnection): CloudProviderConfig | null {
  const schema = conn.kind === 'bedrock' ? bedrockProviderConfigSchema : conn.kind === 'vertex' ? vertexProviderConfigSchema
    : conn.kind === 'foundry' ? foundryProviderConfigSchema : null;
  if (!schema) return null;
  const p = schema.safeParse(conn.providerConfig);
  return p.success ? p.data : null;
}

export function gatewayConfigFor(conn: PartnerAiConnection): GatewayConnectionConfig | null {
  const base = { source: 'gateway' as const, partnerId: conn.partnerId, connectionId: conn.id, configVersion: conn.configVersion };
  switch (conn.kind) {
    case 'openai_compatible':
      return conn.baseUrl ? { ...base, kind: 'openai_compatible', baseUrl: conn.baseUrl } : null;
    case 'bedrock': case 'vertex': case 'foundry': {
      const providerConfig = cloudProviderConfigOf(conn);
      return providerConfig ? ({ ...base, kind: conn.kind, providerConfig } as GatewayConnectionConfig) : null;
    }
    default:
      return null;
  }
}

export async function loadGatewayCredential(conn: Pick<PartnerAiConnection, 'id' | 'kind'>): Promise<GatewayCredential> {
  const material = await systemRead(() => getConnectionKeyMaterial(conn.id));
  if (!material) throw new ConnectionKeyError('Connection not found.', 'key_missing');
  if (material.apiKeyEncrypted === null) {
    if (isCloudConnectionKind(conn.kind)) throw new ConnectionKeyError('This connection has no credentials.', 'key_missing');
    return { secret: null };
  }
  const plaintext = decryptConnectionKey(material);
  return isCloudConnectionKind(conn.kind) ? { secret: null, cloud: openCloudCredentials(conn.kind, plaintext) } : { secret: plaintext };
}
```

(W06's `loadGatewayCredential(connectionId)` signature takes the id only; change it to take `{ id, kind }` and update its two W06 callers — `discovery.ts` and `offeringVerification.ts` — in this task.)

In `gatewayCandidate`: credential via `loadGatewayCredential(conn)` inside the existing try/catch (any throw → `keyUsable = false`); then:

```ts
  const cloud = isCloudConnectionKind(conn.kind) && config && config.kind !== 'openai_compatible'
    ? { geo: cloudInferenceGeo(conn.kind, (config as { providerConfig: CloudProviderConfig }).providerConfig, wireModel) }
    : null;
  const linked = offering.platformModelId ? await systemRead(() => getPlatformModelById(offering.platformModelId!)) : null;
  // …facts:
      connection: { kind: conn.kind as ConnectionKind, status: conn.status, keyUsable, ...(cloud ? { geoBoundByEndpoint: true } : {}) },
      inferenceGeo: cloud?.geo ?? null,
      supportedInferenceGeos: cloud?.geo ? [cloud.geo] : [],
  // …
    promptProfile: cloud ? toPromptProfile(linked?.promptProfile ?? derivePromptProfile(linked?.modelId ?? wireModel)) : 'generic',
    limits: { maxInputTokens: linked?.maxInputTokens ?? null, maxOutputTokens: linked?.maxOutputTokens ?? null },
```

Price stays `offeringRate(offering)` only (no linked fallback) — D4. `optionSupport.inferenceGeo` stays `[]` for every gateway kind, so `buildWireParams` never sends an `inference_geo` parameter to a cloud provider (Q11).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts src/services/aiModels/gatewayCandidate.test.ts src/services/aiModels/gatewayCapabilities.test.ts src/services/aiModels/resolveModel.test.ts src/services/aiModels/offeringVerification.test.ts src/services/aiModels/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/eligibility.ts apps/api/src/services/aiModels/eligibility.test.ts \
  apps/api/src/services/aiModels/gatewayCandidate.ts apps/api/src/services/aiModels/gatewayCandidate.test.ts \
  apps/api/src/services/aiModels/gatewayCapabilities.ts apps/api/src/services/aiModels/gatewayCapabilities.test.ts \
  apps/api/src/services/aiModels/discovery.ts apps/api/src/services/aiModels/offeringVerification.ts
git commit -m "feat(ai-models): resolver dispatches cloud connections with endpoint-bound geography (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Bedrock discovery and platform-model linking

Bedrock lists its models with the same credentials (control plane `bedrock.{region}.amazonaws.com`, SigV4 service `bedrock`). Discovered and manually entered cloud offerings are **linked** to an `ai_platform_models` row when their id normalises to one (capabilities source for verification, token limits, prompt profile — never price, D4).

Rules (spec §6, same as W06): new ids land `discovered`, disabled, unpriced, unverified; lifecycle applies to `discovered` rows only; a failed sync records a scrubbed `discovery_error` and changes nothing else. A Bedrock API key (bearer) may lack list permissions — a 403 on listing is a **failed sync** with a clear message ("This key cannot list models; add them by hand"), not a broken connection.

Included ids:
- `ListFoundationModels?byProvider=anthropic`: `modelSummaries[]` with `inferenceTypesSupported` containing `ON_DEMAND` and `modelLifecycle.status === 'ACTIVE'` → `modelId`, display `modelName`.
- `GET /inference-profiles?type=SYSTEM_DEFINED&maxResults=1000` (the wire name is `type`; `typeEquals` is the SDK field — Codex review #8) (follow `nextToken`, at most 5 pages; a sixth page → `DiscoveryTruncatedError`): `inferenceProfileSummaries[]` with `status === 'ACTIVE'` and an id matching `^(global|us|us-gov|eu|apac|jp|au)\.anthropic\.` → `inferenceProfileId`, display `inferenceProfileName`.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/cloud/bedrockDiscovery.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/modelLinking.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/aiModels/connectionDiscovery.ts` (register `bedrock`)
- Modify: `apps/api/src/services/aiModels/discovery.ts` (`applyDiscoveredGatewayModels` sets `platform_model_id` via `linkPlatformModel` on insert for cloud kinds)
- Modify: `apps/api/src/services/aiModels/gatewayConnections.ts` (`createManualOffering` links for cloud kinds)

**Interfaces:**
- Produces:

```ts
// modelLinking.ts
export function platformIdCandidates(kind: CloudConnectionKind, wireId: string): string[];   // ordered, most specific first
export async function linkPlatformModel(kind: CloudConnectionKind, wireId: string): Promise<string | null>;   // ai_platform_models.id
export function suggestCloudModelIds(kind: 'vertex' | 'foundry', platformModelIds: readonly string[]): Array<{ wireId: string; platformModelId: string }>;
// bedrockDiscovery.ts
export async function discoverBedrockModels(input: { config: Extract<GatewayConnectionConfig, { kind: 'bedrock' }>; credential: GatewayCredential }): Promise<DiscoveredConnectionModel[]>;
```

- [ ] **Step 1: Write the failing tests**

`modelLinking.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { platformIdCandidates, suggestCloudModelIds } from './modelLinking';

describe('platformIdCandidates', () => {
  it.each([
    ['bedrock', 'eu.anthropic.claude-sonnet-5-5', ['claude-sonnet-5-5']],
    ['bedrock', 'global.anthropic.claude-opus-5-5', ['claude-opus-5-5']],
    ['bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0', ['claude-haiku-4-5-20251001', 'claude-haiku-4-5']],
    ['bedrock', 'arn:aws:bedrock:eu-west-1:1:application-inference-profile/x', []],
    ['vertex', 'claude-haiku-4-5@20251001', ['claude-haiku-4-5-20251001', 'claude-haiku-4-5']],
    ['vertex', 'claude-sonnet-5', ['claude-sonnet-5']],
    ['foundry', 'claude-sonnet-5', ['claude-sonnet-5']],
    ['foundry', 'my-custom-deployment', ['my-custom-deployment']],
  ])('%s %s → %j', (kind, id, out) => {
    expect(platformIdCandidates(kind as never, id)).toEqual(out);
  });

  it('suggestions: vertex re-dates dated ids with @; foundry uses the platform id as the default deployment name', () => {
    expect(suggestCloudModelIds('vertex', ['claude-haiku-4-5-20251001', 'claude-sonnet-5'])).toEqual([
      { wireId: 'claude-haiku-4-5@20251001', platformModelId: 'claude-haiku-4-5-20251001' },
      { wireId: 'claude-sonnet-5', platformModelId: 'claude-sonnet-5' },
    ]);
    expect(suggestCloudModelIds('foundry', ['claude-sonnet-5'])).toEqual([{ wireId: 'claude-sonnet-5', platformModelId: 'claude-sonnet-5' }]);
  });
});
```

`bedrockDiscovery.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));
import { __setUpstreamFetchForTests } from '../forward';
import { discoverBedrockModels } from './bedrockDiscovery';

const config = { source: 'gateway', kind: 'bedrock', partnerId: 'p', connectionId: 'c', configVersion: 1, providerConfig: { region: 'eu-central-1' } } as const;
const credential = { secret: null, cloud: { kind: 'bedrock', authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) } } as const;
afterEach(() => __setUpstreamFetchForTests(null));

describe('discoverBedrockModels', () => {
  it('lists on-demand Anthropic foundation models + active Anthropic system profiles, signed, on the control plane', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    __setUpstreamFetchForTests((async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.authorization ?? '' });
      if (url.includes('/foundation-models')) return Response.json({ modelSummaries: [
        { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', modelName: 'Claude Haiku 4.5', inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } },
        { modelId: 'anthropic.claude-opus-5-5', modelName: 'Claude Opus 5.5', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } },
        { modelId: 'anthropic.claude-old', modelName: 'Old', inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'LEGACY' } },
      ] });
      return Response.json({ inferenceProfileSummaries: [
        { inferenceProfileId: 'eu.anthropic.claude-opus-5-5', inferenceProfileName: 'EU Claude Opus 5.5', status: 'ACTIVE' },
        { inferenceProfileId: 'eu.meta.llama4', inferenceProfileName: 'Llama', status: 'ACTIVE' },
      ] });
    }) as never);
    const models = await discoverBedrockModels({ config, credential: credential as never });
    expect(models.map((m) => m.modelId)).toEqual(['anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.anthropic.claude-opus-5-5']);
    expect(calls.every((c) => c.url.startsWith('https://bedrock.eu-central-1.amazonaws.com/'))).toBe(true);
    expect(calls.every((c) => c.auth.startsWith('AWS4-HMAC-SHA256 '))).toBe(true);
  });

  it('403 on listing → a clear, scrubbed failure (not a broken connection)', async () => {
    __setUpstreamFetchForTests((async () => new Response('{"message":"not authorized"}', { status: 403 })) as never);
    await expect(discoverBedrockModels({ config, credential: credential as never })).rejects.toThrow(/cannot list models/);
  });

  it('follows nextToken for at most 5 pages, then fails as truncated (no lifecycle change — Codex review #3)', async () => {
    let pages = 0;
    __setUpstreamFetchForTests((async (url: string) => url.includes('/foundation-models')
      ? Response.json({ modelSummaries: [] })
      : (pages += 1, Response.json({ inferenceProfileSummaries: [], nextToken: 'n' }))) as never);
    await expect(discoverBedrockModels({ config, credential: credential as never })).rejects.toThrow(/more inference profiles/);
    expect(pages).toBe(5);
  });

  it('sends the wire query name `type`, not the SDK field `typeEquals` (Codex review #8)', async () => {
    const urls: string[] = [];
    __setUpstreamFetchForTests((async (url: string) => { urls.push(url); return Response.json(url.includes('/foundation-models') ? { modelSummaries: [] } : { inferenceProfileSummaries: [] }); }) as never);
    await discoverBedrockModels({ config, credential: credential as never });
    expect(urls).toContain('https://bedrock.eu-central-1.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000');
  });
});
```

Append to `discovery.test.ts`: a Bedrock sync inserts `eu.anthropic.claude-opus-5-5` with `platform_model_id` = the seeded `claude-opus-5-5` row's id, disabled, **all price columns NULL**.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/modelLinking.test.ts src/services/aiModels/gateway/cloud/bedrockDiscovery.test.ts src/services/aiModels/discovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`modelLinking.ts`:

```ts
import type { CloudConnectionKind } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getPlatformModelByModelId } from './platformModels';

const BEDROCK_PREFIX = /^(global|us|us-gov|eu|apac|jp|au)\./;
const DATED = /^(.*)-(\d{8})$/;

export function platformIdCandidates(kind: CloudConnectionKind, wireId: string): string[] {
  let id = wireId;
  if (kind === 'bedrock') {
    if (id.startsWith('arn:')) return [];
    id = id.replace(BEDROCK_PREFIX, '').replace(/^anthropic\./, '').replace(/-v\d+(:\d+)?$/, '');
  } else if (kind === 'vertex') {
    id = id.replace('@', '-');
  }
  const out = [id];
  const dated = DATED.exec(id);
  if (dated) out.push(dated[1]!);
  return out;
}

export async function linkPlatformModel(kind: CloudConnectionKind, wireId: string): Promise<string | null> {
  for (const candidate of platformIdCandidates(kind, wireId)) {
    const row = await runOutsideDbContext(() => withSystemDbAccessContext(() => getPlatformModelByModelId(candidate)));
    if (row) return row.id;
  }
  return null;
}

export function suggestCloudModelIds(kind: 'vertex' | 'foundry', platformModelIds: readonly string[]) {
  return platformModelIds.map((pid) => {
    const dated = DATED.exec(pid);
    return { wireId: kind === 'vertex' && dated ? `${dated[1]}@${dated[2]}` : pid, platformModelId: pid };
  });
}
```

`bedrockDiscovery.ts`:

```ts
import { cloudOrigins } from './endpoints';
import { forwardUpstream, grantSecrets } from '../forward';
import { scrubSecrets } from '../scrub';
import type { GatewayConnectionConfig, GatewayCredential } from '../types';
import { discoveryGrantRecord, type DiscoveredConnectionModel } from '../../connectionDiscovery';
import { DiscoveryTruncatedError } from '../openai/discovery';
import { DISCOVERY_MAX_MODELS, DISCOVERY_MAX_RESPONSE_BYTES } from '../limits';

const PROFILE = /^(global|us|us-gov|eu|apac|jp|au)\.anthropic\.[A-Za-z0-9._:-]+$/;
const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || null : null);

export async function discoverBedrockModels(input: {
  config: Extract<GatewayConnectionConfig, { kind: 'bedrock' }>; credential: GatewayCredential;
}): Promise<DiscoveredConnectionModel[]> {
  const grant = discoveryGrantRecord(input.config, input.credential);
  const control = cloudOrigins('bedrock', input.config.providerConfig).control!;
  const ac = new AbortController();
  const get = async (path: string): Promise<unknown> => {
    const res = await forwardUpstream(grant, { url: `${control}${path}`, method: 'GET', headers: { accept: 'application/json' },
      stream: false, maxBytes: DISCOVERY_MAX_RESPONSE_BYTES }, ac.signal);
    if (res.status === 403 || res.status === 401) throw new Error('These credentials cannot list models in this region; add models by hand.');
    if (!res.ok) throw new Error(scrubSecrets(`Bedrock returned HTTP ${res.status}: ${await res.text().catch(() => '')}`, grantSecrets(grant), 300));
    return res.json();
  };
  const out = new Map<string, DiscoveredConnectionModel>();
  const fm = (await get('/foundation-models?byProvider=anthropic')) as { modelSummaries?: Array<Record<string, unknown>> };
  for (const m of fm.modelSummaries ?? []) {
    const id = m.modelId;
    const onDemand = Array.isArray(m.inferenceTypesSupported) && m.inferenceTypesSupported.includes('ON_DEMAND');
    const active = (m.modelLifecycle as { status?: unknown } | undefined)?.status === 'ACTIVE';
    if (typeof id === 'string' && /^anthropic\.[A-Za-z0-9._:-]+$/.test(id) && onDemand && active) out.set(id, { modelId: id, displayName: clean(m.modelName) });
  }
  let next: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const q = `/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000${next ? `&nextToken=${encodeURIComponent(next)}` : ''}`;
    const r = (await get(q)) as { inferenceProfileSummaries?: Array<Record<string, unknown>>; nextToken?: unknown };
    for (const p of r.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId;
      if (typeof id === 'string' && PROFILE.test(id) && p.status === 'ACTIVE') out.set(id, { modelId: id, displayName: clean(p.inferenceProfileName) });
    }
    next = typeof r.nextToken === 'string' && r.nextToken.length > 0 ? r.nextToken : undefined;
    if (!next) break;
  }
  // Codex review #3: an incomplete inventory must never advance lifecycle counters (W06 Codex #9).
  if (next) throw new DiscoveryTruncatedError('Bedrock lists more inference profiles than Breeze reads; add missing models by hand.');
  if (out.size > DISCOVERY_MAX_MODELS) throw new DiscoveryTruncatedError(`More than ${DISCOVERY_MAX_MODELS} Anthropic models are listed; add the ones you need by hand.`);
  return [...out.values()];
}
```

`connectionDiscovery.ts`: `bedrock: (input) => discoverBedrockModels({ config: input.config as Extract<…, { kind: 'bedrock' }>, credential: input.credential })`. Vertex and Foundry stay absent (manual only, D6).

`discovery.ts` `applyDiscoveredGatewayModels`: for `isCloudConnectionKind(conn.kind)`, set `platformModelId: await linkPlatformModel(conn.kind, m.modelId)` on insert (never on update — an admin may have re-linked). `gatewayConnections.ts` `createManualOffering`: same for cloud kinds.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/modelLinking.test.ts src/services/aiModels/gateway/cloud/bedrockDiscovery.test.ts src/services/aiModels/discovery.test.ts src/services/aiModels/gatewayConnections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/modelLinking.ts apps/api/src/services/aiModels/modelLinking.test.ts \
  apps/api/src/services/aiModels/gateway/cloud/bedrockDiscovery.ts apps/api/src/services/aiModels/gateway/cloud/bedrockDiscovery.test.ts \
  apps/api/src/services/aiModels/connectionDiscovery.ts apps/api/src/services/aiModels/discovery.ts apps/api/src/services/aiModels/discovery.test.ts \
  apps/api/src/services/aiModels/gatewayConnections.ts
git commit -m "feat(ai-models): Bedrock model discovery and platform-model linking for cloud offerings (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Cloud connection writes and `/ai/models` route arms

**Service rules** (`gatewayConnections.ts`, extending W06):
- `createCloudConnection`: `normalizeCloudCredentials` → `sealCloudCredentials(id, doc)` → insert with `provider_config` (`{ region }` / `{ projectId, location, serviceAccountEmail: doc.clientEmail }` / `{ resource }`), `base_url NULL`, `status 'active'`, `config_version 1`. Vertex: if the service account's `project_id` differs from the entered `projectId`, accept it (cross-project service accounts are legitimate) but return a `warnings: ['service_account_other_project']` the UI shows.
- `updateCloudConnection`: kind/field agreement (`region` only on Bedrock; `projectId`/`location` only on Vertex; `resource` only on Foundry; `credentials` must normalise for the connection's kind) → else 422 `field_not_applicable` / 400 `credentials_mismatch`; optimistic `config_version`; any change bumps `config_version`; routing changes make verifications `stale` through the fingerprint (Task 8), credential changes do not.
- Delete / manual offering / env-managed rules: W06's (`deleteGatewayConnection`, `createManualOffering` already accept any gateway kind).

**Routes** (W04 gate `partnerWrite` + `requirePartnerWide`):

| Method + path | Body | Service | Audit details (never secrets) |
|---|---|---|---|
| `POST /connections` arms `bedrock` / `vertex` / `foundry` | `connectionCreateSchema` | `createCloudConnection`; after commit `enqueueConnectionSync` (Bedrock lists; others return `skipped`) | `{ kind, region \| projectId+location \| resource, authType, credentialHint }` |
| `PATCH /connections/:id/cloud` (new) | `cloudConnectionPatchSchema` | `updateCloudConnection`; re-sync after a routing change | `{ kind, routingChanged, credentialsChanged, configVersion }` |
| `GET /connections/:id/suggestions` (new, read gate `partnerRead`) | — | vertex/foundry: `suggestCloudModelIds(kind, listOfferableModelIds())`; others 404 | — |
| `PATCH /connections/:id/gateway` (W06) | — | **404 for cloud kinds** (openai_compatible only) | — |
| `PATCH /connections/:id` | — | W06 rule extended: `inferenceGeo` on any gateway kind → 422 `geo_not_supported` | — |

`registryView.ts`: `providerSummary` for cloud kinds from `provider_config` + `credentialAuthType` is **not** available without decrypting — store `authType` in `provider_config` at write time instead (non-secret; add `authType` to the three provider-config schemas as an optional field written by the service, ignored by routing and the fingerprint). `AiConnectionDto.inferenceGeo` is `null` for cloud connections. W04's offering DTO has **no** geography field (Codex review #4), so W07 adds `AiOfferingDto.routeGeo: 'us' | 'eu' | null | undefined` (Task 1 type; `undefined` for non-cloud offerings) filled in the offering mapper from the candidate's `facts.inferenceGeo` (`cloudInferenceGeo`). It is the route's geography, distinct from W03's `ResolvedModel.inferenceGeo` (the parameter actually sent, always `null` for cloud kinds).

**Files:**
- Modify: `apps/api/src/services/aiModels/gatewayConnections.ts` (+ test, + integration test)
- Modify: `packages/shared/src/validators/aiCloudConnections.ts` (optional `authType` in provider-config schemas)
- Modify: `apps/api/src/routes/aiModels/connections.ts` (+ test)
- Modify: `apps/api/src/services/aiModels/registryView.ts` (+ test)
- Modify: `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts`

**Interfaces:**
- Produces: `createCloudConnection(input: { partnerId; kind: CloudConnectionKind; name; providerConfig: CloudProviderConfig; credentials: unknown; connectedBy }): Promise<{ connection: PartnerAiConnection; warnings: string[] }>`; `updateCloudConnection(input: { partnerId; connectionId; patch: CloudConnectionPatchInput }): Promise<PartnerAiConnection>`.

- [ ] **Step 1: Write the failing tests** (service unit + route matrix + integration)

Service (`gatewayConnections.test.ts`, append):

```ts
describe('cloud connections (W07)', () => {
  it('bedrock create seals the credential document, never stores plaintext, records authType in provider_config', async () => {
    await createCloudConnection({ partnerId: 'p1', kind: 'bedrock', name: 'AWS', providerConfig: { region: 'eu-central-1' },
      credentials: { authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) }, connectedBy: 'u1' });
    const row = h.inserted.at(-1)!;
    expect(row).toMatchObject({ kind: 'bedrock', baseUrl: null, providerConfig: { region: 'eu-central-1', authType: 'iam' }, keyLast4: 'MNOP' });
    expect(String(row.apiKeyEncrypted)).toMatch(/^enc:/);
    expect(JSON.stringify(row)).not.toContain('s'.repeat(40));
  });

  it('vertex: stores serviceAccountEmail (display) and warns on a cross-project service account', async () => {
    const r = await createCloudConnection({ partnerId: 'p1', kind: 'vertex', name: 'GCP', providerConfig: { projectId: 'my-project-123', location: 'eu' },
      credentials: { authType: 'service_account', serviceAccountJson: saJson({ project_id: 'other-project-9' }) }, connectedBy: null });
    expect(r.warnings).toEqual(['service_account_other_project']);
    expect(h.inserted.at(-1)!.providerConfig).toMatchObject({ serviceAccountEmail: 'breeze@other-project-9.iam.gserviceaccount.com' });
  });

  it('update: region change bumps config_version; a Vertex field on a Bedrock connection → 422 field_not_applicable', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'bedrock', configVersion: 2, providerConfig: { region: 'us-east-1', authType: 'iam' }, baseUrl: null };
    await updateCloudConnection({ partnerId: 'p1', connectionId: 'c1', patch: { region: 'us-west-2', expectedConfigVersion: 2 } });
    expect(h.updated.at(-1)).toMatchObject({ providerConfig: { region: 'us-west-2', authType: 'iam' }, configVersion: 3 });
    await expect(updateCloudConnection({ partnerId: 'p1', connectionId: 'c1', patch: { location: 'eu', expectedConfigVersion: 3 } }))
      .rejects.toMatchObject({ code: 'field_not_applicable', status: 422 });
  });

  it('credential rotation bumps config_version but keeps the endpoint fingerprint (verification survives — D3, Codex review #9)', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'foundry', configVersion: 4, providerConfig: { resource: 'contoso-ai', authType: 'api_key' }, baseUrl: null };
    await updateCloudConnection({ partnerId: 'p1', connectionId: 'c1', patch: { credentials: { authType: 'api_key', apiKey: 'n'.repeat(32) }, expectedConfigVersion: 4 } });
    const u = h.updated.at(-1)!;
    expect(u.configVersion).toBe(5);
    expect(endpointFingerprint({ kind: 'foundry', baseUrl: null, providerConfig: u.providerConfig as never }))
      .toBe(endpointFingerprint({ kind: 'foundry', baseUrl: null, providerConfig: { resource: 'contoso-ai' } }));
  });

  it('update: credentials of another kind → credentials_mismatch; no write', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'foundry', configVersion: 1, providerConfig: { resource: 'contoso-ai', authType: 'api_key' }, baseUrl: null };
    const before = h.updated.length;
    await expect(updateCloudConnection({ partnerId: 'p1', connectionId: 'c1',
      patch: { credentials: { authType: 'iam', accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40) }, expectedConfigVersion: 1 } }))
      .rejects.toMatchObject({ code: 'credentials_mismatch' });
    expect(h.updated.length).toBe(before);
  });
});
```

Routes (`connections.test.ts`, append) — authz matrix for `POST /connections` (bedrock arm) and `PATCH /connections/:id/cloud` (same five denied rows as W06); `PATCH /:id/gateway` on a cloud connection → 404; `GET /:id/suggestions` on a Bedrock connection → 404, on a Vertex connection → `[{ wireId, platformModelId }]`; the create audit row contains `{ kind: 'vertex', projectId, location, authType: 'service_account', credentialHint }` and **not** `private_key` / `BEGIN PRIVATE KEY`.

Integration (`aiModelsRoutes.integration.test.ts`, append): partner A cannot PATCH, DELETE, refresh, read suggestions for, or add a manual model to partner B's Bedrock connection (404 each; B's row unchanged, `updated_at` equal).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gatewayConnections.test.ts src/routes/aiModels/connections.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// gatewayConnections.ts (additions)
import { isCloudConnectionKind, type CloudConnectionKind, type CloudConnectionPatchInput, type CloudProviderConfig } from '@breeze/shared';
import { CloudCredentialError, credentialAuthType, normalizeCloudCredentials, sealCloudCredentials } from './cloudCredentials';

const ROUTING_KEYS: Record<CloudConnectionKind, readonly string[]> = {
  bedrock: ['region'], vertex: ['projectId', 'location'], foundry: ['resource'],
};

export async function createCloudConnection(input: {
  partnerId: string; kind: CloudConnectionKind; name: string; providerConfig: CloudProviderConfig; credentials: unknown; connectedBy: string | null;
}): Promise<{ connection: PartnerAiConnection; warnings: string[] }> {
  const doc = normalizeCloudCredentials(input.kind, input.credentials);
  const id = randomUUID();
  const warnings: string[] = [];
  const providerConfig: Record<string, unknown> = { ...input.providerConfig, authType: credentialAuthType(doc) };
  if (doc.kind === 'vertex') {
    providerConfig.serviceAccountEmail = doc.clientEmail;
    if (doc.projectId && doc.projectId !== (input.providerConfig as { projectId: string }).projectId) warnings.push('service_account_other_project');
  }
  try {
    const [row] = await db.insert(partnerAiConnections).values({
      id, partnerId: input.partnerId, kind: input.kind, name: input.name.trim(), baseUrl: null, providerConfig,
      ...sealCloudCredentials(id, doc), status: 'active', configVersion: 1, connectedBy: input.connectedBy, verifiedAt: null,
    }).returning();
    const { apiKeyEncrypted: _k, keyFingerprint: _f, ...pub } = row!;
    return { connection: pub as PartnerAiConnection, warnings };
  } catch (error) {
    if (error instanceof RegistryWriteError || error instanceof CloudCredentialError) throw error;
    toRegistryWriteError(error, 'Could not create the connection.');   // W04: (error, fallbackMessage): never
  }
}

export async function updateCloudConnection(input: { partnerId: string; connectionId: string; patch: CloudConnectionPatchInput }): Promise<PartnerAiConnection> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.select().from(partnerAiConnections)
        .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId))).for('update');
      if (!row || !isCloudConnectionKind(row.kind)) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
      const { credentials, expectedConfigVersion, ...routing } = input.patch;
      const allowed = ROUTING_KEYS[row.kind];
      for (const [k, v] of Object.entries(routing)) {
        if (v !== undefined && !allowed.includes(k)) throw new RegistryWriteError(`${k} does not apply to this connection.`, 'field_not_applicable', 422, { field: k });
      }
      if (row.configVersion !== expectedConfigVersion) throw new RegistryWriteError('This connection changed since you opened it. Reload and try again.', 'stale_write', 409);
      const nextConfig: Record<string, unknown> = { ...(row.providerConfig ?? {}), ...Object.fromEntries(Object.entries(routing).filter(([, v]) => v !== undefined)) };
      const sealed = credentials !== undefined ? (() => {
        const doc = normalizeCloudCredentials(row.kind as CloudConnectionKind, credentials);
        nextConfig.authType = credentialAuthType(doc);
        if (doc.kind === 'vertex') nextConfig.serviceAccountEmail = doc.clientEmail;
        return sealCloudCredentials(row.id, doc);
      })() : {};
      const [updated] = await tx.update(partnerAiConnections).set({
        providerConfig: nextConfig, ...sealed, configVersion: row.configVersion + 1, status: 'active', lastError: null, updatedAt: new Date(),
      }).where(eq(partnerAiConnections.id, row.id)).returning();
      const { apiKeyEncrypted: _k, keyFingerprint: _f, ...pub } = updated!;
      return pub as PartnerAiConnection;
    });
  } catch (error) {
    if (error instanceof RegistryWriteError || error instanceof CloudCredentialError) throw error;
    toRegistryWriteError(error, 'Could not update the connection.');
  }
}
```

(`CloudCredentialError` maps to its `status`/`code` in `toRegistryWriteError`/`registryErrorResponse` — add the mapping beside W06's `ByoEndpointRejected`.)

Routes — in `POST /connections` `switch (body.kind)`:

```ts
      case 'bedrock': case 'vertex': case 'foundry': {
        const providerConfig = body.kind === 'bedrock' ? { region: body.region }
          : body.kind === 'vertex' ? { projectId: body.projectId, location: body.location } : { resource: body.resource };
        const { connection, warnings } = await createCloudConnection({ partnerId, kind: body.kind, name: body.name, providerConfig, credentials: body.credentials, connectedBy: userId });
        audit(c, partnerId, 'created', { kind: body.kind, ...providerConfig, authType: (connection.providerConfig as { authType?: string }).authType, credentialHint: connection.keyLast4 });
        afterCommit(c, () => enqueueConnectionSync(connection.id));
        return c.json({ id: connection.id, warnings }, 201);
      }
```

New `PATCH /:id/cloud` (mirrors W06's `PATCH /:id/gateway`, calling `updateCloudConnection`, re-syncing when a routing key changed); `PATCH /:id/gateway` gains `if (!isGatewayConnectionKind(conn.kind) || isCloudConnectionKind(conn.kind)) throw new HTTPException(404, …)`; `GET /:id/suggestions` (`partnerRead`): `ownConnection` → vertex/foundry → `suggestCloudModelIds(kind, await listOfferableModelIds())` filtered to ids not already offered on the connection; else 404.

`registryView.ts`: cloud connection DTO `providerSummary = pick(provider_config, ['region','projectId','location','resource','serviceAccountEmail','authType'])`; `baseUrl: null`; `inferenceGeo: null`, `supportedInferenceGeos: []` on the connection (geography is per offering).

`mcpCoverage.ts`: `exempt` entries for `PATCH /ai/models/connections/:id/cloud` and `GET /ai/models/connections/:id/suggestions`. `partner-wide-write-coverage.test.ts`: reason text for `gatewayConnections.ts` now mentions cloud kinds.

- [ ] **Step 4: Run to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiModels/gatewayConnections.test.ts src/routes/aiModels/ src/services/aiModels/registryView.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts src/services/mcpCoverage.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts src/__tests__/integration/gatewayConnections.integration.test.ts
npx tsc --noEmit -p .
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/aiCloudConnections.ts apps/api/src/services/aiModels/ apps/api/src/routes/aiModels/ \
  apps/api/src/services/mcpCoverage.ts apps/api/src/__tests__/
git commit -m "feat(ai-models): cloud connection writes and /ai/models route arms (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Web — Bedrock / Vertex / Foundry forms

Same homes and save patterns as W06 (Connections card row drawer Save; Models card). W07 adds three `ConnectionKindForm` cases, three `ADDABLE_CONNECTION_KINDS` entries, row details, and suggestion chips in `ManualModelForm`.

Forms:
- **Bedrock:** Name; Region (text with datalist of common regions, pattern-validated); Authentication radio: "IAM access key" (Access key ID, Secret access key) / "Bedrock API key" (API key). Help: "Use a dedicated IAM user limited to `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles`. Breeze signs every request on the server; the key is never sent to the AI process."
- **Vertex:** Name; Project ID; Location (select: `global`, `us`, `eu`, plus a free-text regional field); Service account key (file input `accept="application/json"`, read client-side with `FileReader` into the request body as `serviceAccountJson`; the file content is never displayed or stored in component state beyond the submit). Help: "Grant the service account `roles/aiplatform.user` on the project. Keys with workload identity federation are not supported."
- **Foundry:** Name; Resource name (the `<resource>` in `https://<resource>.services.ai.azure.com`); API key. Help: "Use the resource key from the Foundry portal; Entra ID sign-in is not supported yet."
- **Edit:** routing fields editable (warning: "Changing the region/project/location/resource requires re-verifying every model on this connection"); credentials replace-only ("Leave blank to keep the current credentials"); PATCH `/ai/models/connections/:id/cloud` with `expectedConfigVersion`; name via W04's `PATCH /:id`.
- **Rows:** kind label, `providerSummary` (region / project · location / resource), auth type, `••••hint`.
- **Models card:** per-offering geography badge ("EU", "US", "Global routing") from the offering DTO; for Vertex/Foundry connections the Add-model form shows suggestion chips from `GET /connections/:id/suggestions` (click fills the model id). Unpriced cloud offerings show "Set a price to enable — check your cloud rate card (regional routes are typically ~10% higher)".

`data-testid`s: `ai-connection-add-kind-{bedrock|vertex|foundry}`, `ai-connection-bedrock-{name,region,auth-iam,auth-api-key,access-key-id,secret-access-key,api-key}`, `ai-connection-vertex-{name,project,location,location-custom,sa-file}`, `ai-connection-foundry-{name,resource,api-key}`, `ai-connection-row-provider-{id}`, `ai-model-geo-{offeringId}`, `ai-manual-model-suggestion-{wireId}`.

**Files:**
- Create: `apps/web/src/components/settings/aiModels/connectionForms/BedrockConnectionForm.tsx`, `VertexConnectionForm.tsx`, `FoundryConnectionForm.tsx` (+ `.test.tsx` each)
- Modify: `ConnectionKindForm.tsx`, `connectionKinds.ts`, `ConnectionDrawer.tsx`, `ConnectionsCard.tsx`, `ModelsCard.tsx`, `ManualModelForm.tsx` (+ tests); `surfaceLabels.ts` (`field_not_applicable`, `credentials_mismatch`, `invalid_credentials`); locales ×8; `no-silent-mutations.test.ts`

**Interfaces:** `ConnectionKindForm` cases `bedrock` | `vertex` | `foundry`; `KindDraft` union gains three arms; `ADDABLE_CONNECTION_KINDS` = `['anthropic_byok', 'openai_compatible', 'bedrock', 'vertex', 'foundry']`.

- [ ] **Step 1: Write the failing tests**

`VertexConnectionForm.test.tsx`:

```tsx
it('reads the uploaded key client-side and POSTs it once; the key text is never rendered', async () => {
  render(<ConnectionDrawer connection={null} initialKind="vertex" catalog={[]} catalogEnabled={false} onClose={() => {}} onSaved={async () => {}} />);
  fireEvent.change(screen.getByTestId('ai-connection-vertex-name'), { target: { value: 'GCP' } });
  fireEvent.change(screen.getByTestId('ai-connection-vertex-project'), { target: { value: 'my-project-123' } });
  fireEvent.change(screen.getByTestId('ai-connection-vertex-location'), { target: { value: 'eu' } });
  const file = new File([JSON.stringify({ type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----X' })], 'sa.json', { type: 'application/json' });
  fireEvent.change(screen.getByTestId('ai-connection-vertex-sa-file'), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByTestId('ai-connection-save')).not.toBeDisabled());
  expect(document.body.textContent).not.toContain('BEGIN PRIVATE KEY');
  fireEvent.click(screen.getByTestId('ai-connection-save'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
  const body = JSON.parse(String(fetchWithAuth.mock.calls.at(-1)![1]!.body));
  expect(body).toMatchObject({ kind: 'vertex', name: 'GCP', projectId: 'my-project-123', location: 'eu', credentials: { authType: 'service_account' } });
  expect(body.credentials.serviceAccountJson).toContain('service_account');
});
```

`BedrockConnectionForm.test.tsx`: IAM path POSTs `{ kind: 'bedrock', name, region, credentials: { authType: 'iam', accessKeyId, secretAccessKey } }`; switching to API key clears the IAM fields from the payload; an `ASIA…` access key id keeps Save disabled with "Temporary credentials are not supported"; edit with blank credentials sends no `credentials` in the PATCH.

`FoundryConnectionForm.test.tsx`: POST shape; resource validation (`Contoso.AI` disables Save).

`ManualModelForm.test.tsx` (append): on a Vertex connection, suggestion chips load from `/ai/models/connections/c1/suggestions` and clicking `ai-manual-model-suggestion-claude-sonnet-5` fills the model id.

`ModelsCard.test.tsx` (append): a cloud offering with `routeGeo: 'eu'` renders `ai-model-geo-{id}` "EU"; `routeGeo: null` renders "Global routing"; `undefined` (non-cloud) renders nothing.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels/`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

The three forms follow `OpenAiCompatibleConnectionForm` (W06 Task 14): local state, `onChange(draft)` with a `valid` flag computed from the shared patterns (`AWS_REGION_PATTERN`, `GCP_PROJECT_PATTERN`, `VERTEX_LOCATION_PATTERN`, `AZURE_RESOURCE_PATTERN` imported from `@breeze/shared`), password inputs with `autoComplete="off"`. The Vertex file input:

```tsx
const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
  const f = e.target.files?.[0];
  if (!f || f.size > 20_000) { setSaError(t('aiModels.connections.cloud.vertex.fileTooLarge')); return; }
  const reader = new FileReader();
  reader.onload = () => { saJsonRef.current = String(reader.result ?? ''); setSaLoaded(true); };
  reader.readAsText(f);
};
```

(`saJsonRef` is a `useRef<string | null>` — not state — so the key text never re-renders into the DOM; it is cleared after Save.) `ConnectionDrawer.handleSave` gains one branch per kind building the POST body (create) or the `PATCH /:id/cloud` body (edit: changed routing fields + `credentials` only when re-entered + `expectedConfigVersion`), each through `runAction`. A 201 with `warnings: ['service_account_other_project']` shows a `showToast({ type: 'warning', … })` after the success toast. `ConnectionKindForm` gains three cases (the `never` default enforces it); `connectionKinds.ts` appends the three kinds and labels.

- [ ] **Step 4: Run to verify they pass**

```bash
cd apps/web && npx vitest run src/components/settings/aiModels/ src/lib/__tests__/no-silent-mutations.test.ts && npx astro check 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels/ apps/web/src/locales/ apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): Bedrock, Vertex and Foundry connection forms; per-model geography (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Real Agent SDK provider modes through the gateway (CI, no cloud credentials) + contract rules

Proves the CLI's provider modes route through the gateway with auth skipped, and pins the request shapes the adapters accept. Fake upstreams answer in each provider's format: **Vertex** and **Foundry** with plain Anthropic SSE; **Bedrock** with an AWS event stream built by `@smithy/eventstream-codec` (already in the lockfile via `@aws-sdk/client-s3`; add it as a **devDependency** of `apps/api`). The suite spawns the bundled CLI and **fails** (does not skip) if it cannot start.

Each case asserts: the tool ran once; the result succeeded; every upstream request URL is the provider host + an allowed path for the **bound** model and the connection's project/location/region/resource; the upstream request carried the injected auth (`AWS4-HMAC-SHA256` / `Bearer ya29.test` / `x-api-key`); the deny-all egress proxy recorded **no allowed** CONNECT (blocked attempts — e.g. a CLI control-plane lookup — are listed in the test output and must not fail the run); `result.modelUsage[wireModel]` equals the fake usage.

**Contract rules** (append to `aiModelRegistry.contract.test.ts`):
- rule 2 widened: `new AnthropicBedrock(`, `new AnthropicVertex(`, `new AnthropicFoundry(` only in `connectionFactory.ts`;
- rule 8: no import of `@aws-sdk/credential-providers`, `@aws-sdk/credential-provider-node`, `@azure/identity`, and no `new GoogleAuth(` anywhere under `apps/api/src/services/aiModels/` (ambient identity, Review Focus 1);
- rule 9: `signBedrockRequest(` only in `gateway/cloud/auth/`; `vertexAccessToken(` only in `gateway/cloud/auth/`.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/cloud/cloudSdk.e2e.test.ts`
- Create: `apps/api/src/services/aiModels/gateway/cloud/__fixtures__/bedrockEventStream.ts` (encodes Anthropic stream events as Bedrock `chunk` frames: `{ bytes: base64(JSON(event)) }`)
- Modify: `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts`
- Modify: `apps/api/package.json` (devDependency `@smithy/eventstream-codec`)

- [ ] **Step 1: Write the test** (structure; one `it` per kind, sharing a helper):

```ts
async function runThroughGateway(resolved: ResolvedModel, upstream: (url: string, init: { headers: Record<string, string>; body: Buffer }) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  __setUpstreamFetchForTests((async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    calls.push({ url, headers: init.headers, body: init.body?.toString() ?? '' });
    return upstream(url, init);
  }) as never);
  const blocked: string[] = [];
  vi.mocked(recordLlmEgressEvent).mockImplementation((e) => { if (e.surface === 'sdk_proxy_connect') blocked.push(e.host); });
  const child = await prepareSdkChild(resolved, { key: `e2e-${resolved.connection.kind}`, orgId: 'org-1', aiSessionId: null });
  let toolRuns = 0;
  const weather = tool('get_weather', 'Weather', { city: z.string() }, async ({ city }) => { toolRuns += 1; return { content: [{ type: 'text', text: `sunny 21C in ${city}` }] }; });
  let result: Record<string, unknown> | null = null;
  try {
    for await (const m of query({ prompt: 'Weather in Oslo? Use the tool.', options: {
      model: resolved.wireModel, maxTurns: 4, tools: [], allowedTools: ['mcp__fidelity__get_weather'],
      mcpServers: { fidelity: createSdkMcpServer({ name: 'fidelity', version: '1.0.0', tools: [weather] }) },
      settingSources: [], persistSession: false, env: child.env } })) {
      if ((m as { type?: string }).type === 'result') result = m as Record<string, unknown>;
    }
  } finally { child.revoke(); }
  return { calls, blocked, toolRuns, result };
}
```

Fake upstream (all kinds): first call (no `tool_result` in body) → a `tool_use` for `mcp__fidelity__get_weather` `{city:"Oslo"}`; second call → text "sunny 21C"; usage `{ input_tokens: 50, output_tokens: 5 }` per call. Vertex/Foundry return `text/event-stream` built with `encodeSse` from W06 `sse.ts`; Bedrock returns `application/vnd.amazon.eventstream` built by the fixture.

Per-kind assertions, e.g. Vertex:

```ts
it('vertex provider mode', async () => {
  const r = makeResolvedModel('vertex');
  const { calls, toolRuns, result, blocked } = await runThroughGateway(r, vertexUpstream);
  expect(toolRuns).toBe(1);
  expect(result).toMatchObject({ subtype: 'success' });
  for (const c of calls) {
    expect(c.url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/my-project-123\/locations\/eu\/publishers\/anthropic\/models\/claude-sonnet-5:(streamRawPredict|rawPredict)$/);
    expect(c.headers.authorization).toBe('Bearer ya29.test');
  }
  expect((result!.modelUsage as Record<string, { inputTokens: number }>)[r.wireModel]!.inputTokens).toBe(50 * calls.length);
  console.log(`[vertex] CLI blocked CONNECT attempts: ${JSON.stringify(blocked)}`);
}, 120_000);
```

(`vertexAccessToken` is mocked to `'ya29.test'`.) Bedrock asserts URLs `https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5/invoke-with-response-stream` and `authorization` starting `AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP/`. Foundry asserts `https://contoso-ai.services.ai.azure.com/anthropic/v1/messages` and `x-api-key`.

- [ ] **Step 2: Run** — Expected: FAIL before Task 6's adapters are registered in this test's import graph (import `'../index'`), then PASS. If a provider mode sends a path the adapter 404s (visible in the gateway log), add the path to that adapter's allowlist **with a test**, never a wildcard.

```bash
cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/cloudSdk.e2e.test.ts src/services/aiModels/aiModelRegistry.contract.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/services/aiModels/gateway/cloud/cloudSdk.e2e.test.ts \
  apps/api/src/services/aiModels/gateway/cloud/__fixtures__/bedrockEventStream.ts apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts
git commit -m "test(ai-models): Agent SDK provider modes through the gateway; no-ambient-identity contract (#7605)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Independent security review (required, spec §12)

Same procedure as W06 Task 17 (Opus + Codex `high`, read-only, in parallel; findings to `~/breeze-security/remediation/<date>-w07-cloud-review.md`; fixes forward with failing-first tests; public record counts only). Brief additions specific to W07:

> 1. **Ambient identity:** any path by which a partner request could be authorised with the API host's own AWS role / instance profile / container credentials, Google ADC / metadata server, or Azure managed identity — in the gateway, the cloud SDK clients (`skipAuth`, placeholder tokens), `google-auth-library` usage, or the CLI child (env, config files under `HOME`, `~/.aws`, `~/.config/gcloud`). Does the CLI in provider mode read `HOME`-based credential files even with `SKIP_*_AUTH`? (If yes: the child's `HOME` must point at an empty per-session directory.)
> 2. **Service-account JSON:** `token_uri` / `universe_domain` / type checks; private-key handling in memory, errors, logs; token cache keying (can one connection's token serve another?).
> 3. **SigV4:** signed bytes == sent bytes; header canonicalisation; replay window; signing a caller-controlled path (path traversal into another Bedrock API); control-plane reachability limited to discovery grants.
> 4. **Routing integrity:** can a crafted model id, project, location or resource (DB row or request) make the gateway dial a host other than the provider's? URL-encoding tricks in Bedrock ARNs; Vertex `count-tokens` model handling.
> 5. **Geography:** can a request be served by a non-resident route while the offering is reported as resident?
> 6. **Credential lifetime and display:** `key_last4` / `providerSummary` / audit rows / `discovery_error` / verification `summary` never contain secrets; rotation re-seals under the row-bound AAD.

Check 1's `HOME` question in the lab (L-gates) if the static review cannot settle it; until then `buildGatewaySdkChildEnv` for cloud kinds sets `HOME` and `USERPROFILE` to a fresh empty `mkdtemp` directory per session (removed on `revoke()`). Implement that hardening in this task **only if** the review cannot rule the risk out — with a test that the child's `HOME` is not the API process's.

---

## Task 14: Lab gates, docs, full verification, PR

- [ ] **Step 1: Lab runbook (Todd gates).** Add `docs/superpowers/plans/ai-mcp/2026-10-01-ai-model-registry-w07-lab-runbook.md` (public-safe: no account ids, no regions tied to Breeze infrastructure, no keys) with, per provider: the minimal IAM/role/permission setup for a **test** account, the connection form values, and the checklist below. Results go into the PR as pass/fail per row (no screenshots containing account ids).

| # | Gate | Bedrock | Vertex | Foundry |
|---|---|---|---|---|
| L1 | Create connection, discovery (Bedrock) / manual entry with suggestion (Vertex, Foundry) | ☐ | ☐ | ☐ |
| L2 | Verify (fidelity harness through the gateway) passes for a current Sonnet; adaptive/effort probe result recorded | ☐ | ☐ | ☐ |
| L3 | Chat with a device tool; ticket draft (Messages API); AI agent run | ☐ | ☐ | ☐ |
| L4 | Regional route: EU route offering shows "EU"; `global.` / `global` shows "Global routing"; residency-required partner can use only the EU one | ☐ | ☐ | n/a |
| L5 | Wrong credentials → clear error, connection status `error`, nothing falls back to Breeze's own cloud identity (run on a host **with** ambient AWS/GCP credentials present to prove it) | ☐ | ☐ | ☐ |
| L6 | Credential rotation keeps verification; region/project/location/resource change marks models "Re-verify" | ☐ | ☐ | ☐ |
| L7 | CLI behaviour in provider mode with `SKIP_*_AUTH`: list any blocked CONNECT attempts recorded for the session (e.g. Bedrock `GetInferenceProfile`) and confirm chat still works | ☐ | ☐ | ☐ |
| L8 | Usage ledger: `ai_invocations` rows with `funding_source = 'partner_key'`, the offering price, the right `connection_id`; platform credits untouched | ☐ | ☐ | ☐ |

- [ ] **Step 2: Docs** — `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx`: section "Use Claude on your AWS, Google Cloud or Azure account" (what it is; required permissions per provider; how credentials are stored and used — on the server only; regional routing and residency; pricing is yours to enter; what is not supported: Mantle, temporary/assumed-role credentials, workload identity, Entra ID, server tools).
- [ ] **Step 3: Full verification** — W06 Task 18 Step 3's command list (shared, api unit by directory, **full** api unit suite, integration, `test:rls-coverage`, `test:rls`, web, both `tsc`, migration naming, drift), plus `cd apps/api && npx vitest run src/services/aiModels/gateway/cloud/`.
- [ ] **Step 4: PR** titled `feat(ai): model registry W07 — Bedrock, Vertex and Foundry connections (#7605)`; body: summary, `Closes #7605`, Preconditions output (incl. Q14/Q15 results), the Settings PR statement (below), the security-review line, the lab-gate table (unchecked until Todd runs it — the PR is **not** merge-ready until L1–L8 pass), migration name, new dependencies with versions. `/pr-review-toolkit:review-pr` once. `complete_wave` on merge.

---

## Settings PR statement (CLAUDE.md rule 9)

- **Concept:** BYO model connection (kinds `bedrock`, `vertex`, `foundry`). **Home:** Partner Settings → AI Providers & Models → Connections card (row drawer Save); models in the Models card. **Level:** partner. **Resolver:** `resolveModel` via `gatewayCandidate`.
- **Places configured, before → after:** 0 → 1 (the same Connections card W04/W06 own; no new home).

## Lab / Todd gates

See Task 14 Step 1 (L1–L8). All require real cloud test accounts; CI covers everything else with fake upstreams and fake credentials.

## Open questions for Todd

1. **AWS credential model.** v1 accepts long-lived IAM user keys or a Bedrock API key.
   - **A — keys only (this plan):** simplest; MSPs are used to scoped IAM users. Con: long-lived secrets in Breeze.
   - **B — cross-account role (STS `AssumeRole` with an external id):** no customer secret stored. Con: Breeze needs its own AWS principal on hosted (an AWS account relationship, per-region STS egress) and self-hosters need theirs — a product/ops decision.
   **Recommend A now, B as a follow-up wave** once hosted has a dedicated AWS principal.
2. **Foundry auth.** v1 API key only. Entra ID (service principal client secret, or managed identity on self-host) would need `@azure/identity` and a token-minting path like Vertex's. **Recommend API key only for v1.**
3. **Foundry / Vertex model lists.** v1 is manual entry with suggestions. Foundry deployments are listable only through Azure Resource Manager with a second credential (subscription + resource group + management-plane role). **Recommend manual** until a partner asks.
4. **Foundry residency.** "US Data Zone" deployments keep inference in the US, but the data-plane API does not expose a deployment's zone, so Breeze cannot verify it. **Recommend** treating Foundry as not residency-eligible in v1 (D5); a later admin attestation field would be a product/legal call.
5. **Cloud price pre-fill.** D4 requires an explicit price and pre-fills the platform rate. **Recommend keep**; alternative is inheriting the linked platform price automatically (spec §8 reserves that for BYOK Anthropic).

## Review

Independent Codex review (`gpt-6-astra`, `model_reasoning_effort=high`, read-only), 2026-10-01, against this plan, the W06 plan, the spec, the index, the W04 plan, `origin/main` and the W03 branch `wave-7601` (it also read the official `anthropic-sdk-typescript` cloud clients and the AWS API reference). **10 findings: 10 adopted (1 with a modified fix), 0 rejected.**

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | High | `AnthropicVertex({ accessToken })` still builds `GoogleAuth().getClient()` → ADC / metadata server (the host's identity). | **Adopted.** In-process Vertex clients get an explicit static `authClient` (an `OAuth2Client` holding only the placeholder); poisoned-environment test asserts no ADC / metadata / token-endpoint access (Task 7). |
| 2 | Med | Minted Google access tokens were not in the redaction set. | **Adopted.** `grantSecrets` includes the cached token; `scrubSecrets` gains a `ya29.` pattern (Task 5). |
| 3 | Med | Bedrock discovery treated a truncated inventory (page cap / model cap) as complete. | **Adopted.** Both caps throw W06's `DiscoveryTruncatedError` (no lifecycle change) + test (Task 9). |
| 4 | Med | W04's offering DTO has no geography field. | **Adopted.** New `AiOfferingDto.routeGeo` (Task 1 type, Task 10 mapper, Task 11 UI). |
| 5 | Med | `toRegistryWriteError(error)` called without W04's fallback message (`never`-returning). | **Adopted** (Task 10). |
| 6 | Med | `AnthropicFoundry` defaults `resource` from `ANTHROPIC_FOUNDRY_RESOURCE` and rejects resource + baseURL. | **Adopted, modified.** Explicit empty `resource` override, verified against the pinned SDK's `.d.ts`; covered by the same poisoned-environment test (Task 7). |
| 7 | Low | The SigV4 "known answer" was frozen from the implementation's own output. | **Adopted.** An independent from-scratch SigV4 oracle in the test, itself checked against the AWS "get-vanilla" vector (Task 5). |
| 8 | Low | `ListInferenceProfiles` wire query is `type=`, not `typeEquals=`. | **Adopted** + URL assertion (Task 9). |
| 9 | Low | D3 said rotation does not bump `config_version`; the code bumps it. | **Adopted.** D3 amended (rotation bumps the version, keeps the fingerprint) + test (Task 10). |
| 10 | Low | Non-recursive `git ls-tree` lists the directory, not migration files. | **Adopted** in both W06 and W07 (`-r … -- apps/api/migrations/` filtered to numbered `.sql`). |

## Index additions

| Where | Name(s) | Why |
|---|---|---|
| `packages/shared/src/constants/aiConnectionKinds.ts` | `CLOUD_CONNECTION_KINDS`, `CloudConnectionKind`, `isCloudConnectionKind`; `AI_CONNECTION_ROW_KINDS` / `GATEWAY_CONNECTION_KINDS` gain `bedrock`, `vertex`, `foundry` | |
| `packages/shared/src/validators/aiCloudConnections.ts` | `AWS_REGION_PATTERN`, `GCP_PROJECT_PATTERN`, `VERTEX_LOCATION_PATTERN`, `AZURE_RESOURCE_PATTERN`, `{bedrock,vertex,foundry}ProviderConfigSchema`, `*ProviderConfig`, `CloudProviderConfig`, `{bedrock,vertex,foundry}CredentialsInputSchema`, `*CredentialsInput` | |
| `packages/shared/src/validators/aiModelRegistryApi.ts` | `connectionCreateSchema` arms `bedrock` / `vertex` / `foundry`; `cloudConnectionPatchSchema`, `CloudConnectionPatchInput` | |
| `packages/shared/src/types/aiModelRegistry.ts` | `AiConnectionDto.providerSummary`, `AiConnectionProviderSummary` | |
| DB | `partner_ai_connections_kind_chk` (6 kinds), `_shape_chk` (cloud: credential + provider_config, no base_url), `_provider_config_chk` (new); `provider_config.authType` / `.serviceAccountEmail` (convention) | Migration `2026-11-24-100000-ai-cloud-connections.sql` |
| `services/aiModels/cloudCredentials.ts` | `CloudCredentialDocument`, `CloudCredentialError`, `normalizeCloudCredentials`, `sealCloudCredentials`, `openCloudCredentials`, `cloudCredentialSecrets`, `credentialAuthType` | Credentials in `api_key_encrypted` (D2) |
| `services/aiModels/gateway/cloud/` | `endpoints.ts` (`cloudOrigins`, `CloudOrigins`, `BEDROCK_PATH`, `VERTEX_PATH`, `FOUNDRY_PATHS`), `geography.ts` (`cloudInferenceGeo`), `auth/sigv4.ts` (`signBedrockRequest`), `auth/vertexToken.ts` (`vertexAccessToken`), `auth/index.ts` (`authorizeCloudRequest`), `passthrough.ts` (`passthroughForward`), `bedrockAdapter.ts` (`bedrockAdapter`, `cloudModelPins`), `vertexAdapter.ts`, `foundryAdapter.ts`, `bedrockDiscovery.ts` (`discoverBedrockModels`) | |
| `services/aiModels/gateway/forward.ts` | `allowedUpstreamOrigins` (replaces W06 `upstreamOriginFor`), `authorizeUpstream` (replaces `upstreamAuthHeaders`), `grantSecrets` | Per-request auth |
| `services/aiModels/gateway/types.ts` | `GatewayConnectionConfig` cloud arms; `GatewayCredential.cloud` | |
| `services/aiModels/connectionFactory.ts` | `MessagesClient`, `gatewayTarget`; `AnthropicClientTarget` gateway `dialect` `'bedrock' \| 'vertex' \| 'foundry'` + `cloud` | |
| `services/aiModels/eligibility.ts` | `CandidateFacts.connection.geoBoundByEndpoint` | Endpoint-bound residency (D5) |
| `services/aiModels/gatewayCandidate.ts` | `cloudProviderConfigOf`; `loadGatewayCredential(conn: { id; kind })` (signature widened) | |
| `services/aiModels/modelLinking.ts` | `platformIdCandidates`, `linkPlatformModel`, `suggestCloudModelIds` | |
| `services/aiModels/gatewayConnections.ts` | `createCloudConnection`, `updateCloudConnection` | |
| `routes/aiModels/` | `PATCH /connections/:id/cloud`, `GET /connections/:id/suggestions` | |
| Web | `BedrockConnectionForm`, `VertexConnectionForm`, `FoundryConnectionForm`; `ADDABLE_CONNECTION_KINDS` += 3 | |
| Dependencies | `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk`, `@smithy/signature-v4`, `@smithy/protocol-http`, `@aws-crypto/sha256-js`; dev `@smithy/eventstream-codec` | |
