# Per-Partner LLM BYOK Wave 2 Review Fixes Implementation Plan

> **For agentic workers:** Execute inline in this worktree. Preserve the final decisions in the review batch and use regression tests before production changes.

**Goal:** Close the wave-2 tenancy, credential-routing, provider-selection, rotation, and error-observability gaps without changing the approved BYOK contract.

**Architecture:** Resolve provider configuration from the resource owner (device/session organization), not the caller token. Keep helper device partner identity on a dedicated non-RLS auth field, pin partner one-shot Anthropic clients to the public Anthropic endpoint, and preserve live SDK turns across configuration rotation while terminally closing idle subscribers.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Anthropic SDK, Vitest.

## Global Constraints

- Helper synthetic `partnerId` and token `partnerId` remain `null`; only `helperDevicePartnerId` carries the device owner's partner for LLM selection.
- Organization-to-partner lookup runs outside request DB context under system access and fails with `LlmOrgResolutionError` when the organization is missing.
- Partner source never enters the instance-wide OpenAI-compatible path.
- Resolver failures return generic retryable responses and are captured; plaintext keys and raw resolver errors never reach clients.
- Configuration rotation applies on the next idle turn and never kills an actively processing turn.

---

### Task 1: Tenant-safe helper identity and structured resolver failures

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/middleware/helperAuth.ts`
- Modify: `apps/api/src/routes/helper/index.ts`
- Test: `apps/api/src/middleware/helperAuth.test.ts`
- Test: `apps/api/src/routes/helper/index.test.ts`

- [ ] Add failing assertions that helper token/context partner IDs stay null while `helperDevicePartnerId` is populated.
- [ ] Add failing helper-route tests for generic 503 handling when either resolver call throws.
- [ ] Restore null partner scope and thread the dedicated device partner field into helper LLM resolution.
- [ ] Run the two helper test files.

### Task 2: Organization-owned resolution and one-shot credential pinning

**Files:**
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts`
- Modify: `apps/api/src/services/clientAiSessions.ts`
- Test: `apps/api/src/services/llm/llmConfigResolver.test.ts`
- Test: `apps/api/src/services/clientAiSessions.test.ts`

- [ ] Add failing tests for system-context org lookup, typed missing-org failure, client-ai tagged logging, and partner/platform Anthropic constructor options.
- [ ] Implement `resolveLlmConfigForOrg` and `LlmOrgResolutionError`.
- [ ] Pin partner clients with `authToken: null` and the public Anthropic base URL; leave platform construction environment-aware.
- [ ] Delegate client-ai resolution to the shared org resolver and tag missing-org failures.
- [ ] Run resolver and client-ai service tests.

### Task 3: Session-owned technician/script resolution and creation parity

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts`
- Modify: `apps/api/src/services/aiAgent.ts`
- Modify: `apps/api/src/routes/ai.ts`
- Modify: `apps/api/src/routes/scriptAi.ts`
- Test: `apps/api/src/services/aiAgentSdk.test.ts`
- Test: `apps/api/src/services/aiAgent.deviceTask.test.ts`
- Test: `apps/api/src/routes/ai_sessions_crud.test.ts`
- Test: `apps/api/src/routes/ai_sessions_actions.test.ts`
- Test: `apps/api/src/routes/ai.ticket.test.ts`
- Test: `apps/api/src/routes/scriptAi_sessions.test.ts`

- [ ] Add failing tests for session-org preflight resolution, captured resolver throws, session-create model selection/unavailability, ticket-draft org resolution, script org resolution, and partner refusal on OpenAI-compatible turns.
- [ ] Resolve technician preflight and ticket draft from `session.orgId`.
- [ ] Resolve before technician/script session insert; store explicit model or resolved default and map unavailable to the 503 contract.
- [ ] Refuse partner source before entering the OpenAI-compatible turn path.
- [ ] Run all affected service and route suites.

### Task 4: Rotation lifecycle and distributor observability

**Files:**
- Modify: `apps/api/src/services/streamingSessionManager.ts`
- Modify: `apps/api/src/services/catalogEnrichmentService.ts`
- Test: `apps/api/src/services/streamingSessionManager.clientLoop.test.ts`
- Test: `apps/api/src/services/catalogEnrichmentService.test.ts`

- [ ] Add failing tests that a processing mismatch reuses the old session and an idle mismatch publishes error/done, logs versions, removes, and recreates with new credentials.
- [ ] Change mismatch handling so only idle sessions rotate immediately.
- [ ] Add failing test that distributor `AI_UNAVAILABLE` remains a null fallback but logs and captures as operator-visible failure.
- [ ] Route that error code through the unexpected-error branch.
- [ ] Run both suites.

### Task 5: Verification and review

**Files:** All changed files above.

- [ ] Run every requested targeted suite, including AI ticket-draft and Office add-in ticket suites.
- [ ] Run `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit`.
- [ ] Inspect the final diff against all nine review decisions and report exact commands, results, and any unverified behavior.
