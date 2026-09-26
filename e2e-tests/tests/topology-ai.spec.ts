import { test, expect } from '../fixtures';
import { TopologyAiPage } from '../pages/TopologyAiPage';
import { actionSideEffects, MockLlm, mockLlmUrl, seedTopologyAi, type TopologyAiFixture } from '../helpers/topologyAiSeed';

/**
 * Topology M4 "Explain this" (#6000) against the REAL worktree stack, with the
 * LLM mocked at the provider HTTP boundary. No real model is ever called.
 *
 * How the model is mocked
 * -----------------------
 * The API runs with MCP_LLM_PROVIDER=openai-compatible (chat-only transport,
 * apps/api/src/services/llm/openaiCompatibleProvider.ts) pointed at
 * `e2e-tests/fixtures/mockLlmServer.mjs`, which runs as the `mock-llm` service
 * INSIDE the stack network. It cannot run on the host: safeFetch refuses
 * loopback and OrbStack's host.docker.internal (0.250.250.254), while an
 * RFC1918 container address is dialable on a self-hosted (IS_HOSTED=false)
 * stack. docker-compose.yml maps no MCP_LLM_* into the api container, so the
 * overlay at the repo root, `docker-compose.override.yml.topology-ai-e2e`,
 * adds that mapping plus the mock service (image node:22, ./e2e-tests/fixtures
 * mounted, port 8080 published to the host for the counters/mode switch).
 *
 * Run it:
 *   # root .env (untracked) additionally carries:
 *   #   MCP_LLM_PROVIDER=openai-compatible  MCP_LLM_BASE_URL=http://mock-llm:8080/v1
 *   #   MCP_LLM_API_KEY=e2e-mock-key  MCP_LLM_MODEL=e2e-mock-model
 *   #   MCP_LLM_PRICE_INPUT_PER_M_USD=0  MCP_LLM_PRICE_OUTPUT_PER_M_USD=0
 *   pnpm wt-stack up
 *   docker compose -p <project from .breeze-stack.json> --env-file .env --env-file .env.stack \
 *     -f docker-compose.yml -f docker-compose.override.yml.dev -f docker-compose.override.yml.worktree \
 *     -f docker-compose.override.yml.topology-ai-e2e up -d --no-deps api mock-llm
 *   pnpm wt-stack test -- tests/topology-ai.spec.ts
 *   # teardown: `docker compose -p <project> down -v --remove-orphans` (the mock is
 *   # an orphan to `pnpm wt-stack down`, which does not load the overlay)
 * Without the overlay (or E2E_MOCK_LLM_URL) the file skips rather than risk a
 * real provider.
 *
 * The seed (helpers/topologyAiSeed.ts) creates a fresh site in the seeded org
 * with topology flags on, a device-bound node whose label is a prompt-injection
 * string, a peer node and one relationship.
 */
test.describe.configure({ mode: 'serial' });

const mockUrl = mockLlmUrl();
test.skip(!mockUrl, 'needs the mock-llm overlay (docker-compose.override.yml.topology-ai-e2e) — see the header');

let fixture: TopologyAiFixture;
let mock: MockLlm;
/** `#topology/…/explain/<sessionId>` of the answered investigation (set by the first test). */
let investigationHash = '';

test.beforeAll(async () => {
  mock = new MockLlm(mockUrl!);
  await mock.reset();
  fixture = seedTopologyAi();
});

test('Explain calls the model exactly once, renders the cited answer, and never sends raw names or tenant ids', async ({ cleanPage: page }) => {
  test.setTimeout(180_000);
  const topology = new TopologyAiPage(page);
  await topology.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
  await topology.openSelection(fixture.orgId, fixture.siteId, 'edge', fixture.relationshipId);

  // Opening and selecting is passive: no model call until Explain.
  await expect(topology.explain()).toBeVisible();
  await expect(topology.explanation()).toHaveCount(0);
  expect(await mock.count()).toBe(0);

  await topology.explain().click();
  await expect.poll(() => mock.count(), { timeout: 60_000 }).toBe(1);

  // The model request: aliased hosts only, no raw label, no org/site/device ids.
  const [request] = await mock.requests();
  const sent = JSON.stringify(request!.body);
  expect(sent).toContain(fixture.relationshipId);
  expect(sent).toMatch(/host-[0-9a-f]{8}/);
  expect(sent).not.toContain(fixture.injectionLabel);
  expect(sent).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  expect(sent).not.toContain('core-sw-01');
  expect(sent).not.toContain(fixture.orgId);
  expect(sent).not.toContain(fixture.siteId);
  expect(sent).not.toContain(fixture.deviceId);
  expect((request!.body as { tools?: unknown }).tools).toBeUndefined();

  // The server-validated answer renders (the chat-only transport publishes it
  // AFTER `message_end`; the store must still attach it).
  await expect(topology.explanation()).toBeVisible({ timeout: 30_000 });
  expect(await mock.count()).toBe(1);

  // The four structured sections, each from the validated explanation.
  await expect(topology.findings()).toBeVisible();
  await expect(topology.finding()).toHaveCount(1);
  await expect(topology.hypotheses()).toBeVisible();
  await expect(topology.hypothesis()).toHaveCount(1);
  await expect(topology.missingData()).toBeVisible();
  await expect(topology.nextChecks()).toBeVisible();
  await expect(topology.nextCheck()).toHaveCount(1);
  await expect(topology.fallback()).toHaveCount(0);
  // A model suggestion is text, never a proposal: the chat-only transport has no tools.
  await expect(topology.proposedCheck()).toHaveCount(0);


  // The investigation is recorded in the hash for the reopen test below.
  investigationHash = new URL(page.url()).hash;
  expect(investigationHash).toMatch(/\/explain\/[0-9a-f-]{36}/);

  // Citation 0 is the peer node (the mock cites a node first): following it
  // moves the explorer selection to that evidence, and the answer stays as history.
  expect(await topology.hashSelection()).toEqual({ kind: 'edge', id: fixture.relationshipId });
  await topology.citation(0).click();
  await expect.poll(() => topology.hashSelection()).toEqual({ kind: 'node', id: fixture.peerNodeId });
  await expect(topology.inspector()).toBeVisible();
  await expect(topology.historical()).toBeVisible();
  // Following a citation is navigation, not a new investigation.
  expect(await mock.count()).toBe(1);
});

test('reloading with #…/explain/<sessionId> re-shows the stored explanation without a model call', async ({ cleanPage: page }) => {
  test.setTimeout(180_000);
  expect(investigationHash, 'the first test must record an answered investigation').not.toBe('');
  const topology = new TopologyAiPage(page);
  await topology.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
  const before = await mock.count();

  await topology.openHash(fixture.orgId, investigationHash);
  await expect(topology.explanation()).toBeVisible({ timeout: 30_000 });
  await expect(topology.finding()).toHaveCount(1);
  await expect(topology.hypothesis()).toHaveCount(1);
  await expect(topology.fallback()).toHaveCount(0);

  // A second full reload in the same context (the persisted-session path).
  await page.reload();
  await expect(topology.explanation()).toBeVisible({ timeout: 30_000 });
  await expect(topology.finding()).toHaveCount(1);

  // Reopening re-reads the stored answer; it never re-runs the model.
  expect(await mock.count()).toBe(before);
});

test('a provider failure yields the deterministic fallback, no raw text, and Diagnose stays available', async ({ cleanPage: page }) => {
  test.setTimeout(180_000);
  const topology = new TopologyAiPage(page);
  await topology.login(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
  await mock.mode('http500');
  try {
    // A fresh subject (the injected node), so no cached answer can stand in for the model.
    await topology.openSelection(fixture.orgId, fixture.siteId, 'node', fixture.injectedNodeId);
    await expect(topology.explain()).toBeVisible();
    const before = await mock.count();

    await topology.explain().click();
    await expect(topology.fallback()).toBeVisible({ timeout: 60_000 });
    expect(await mock.count()).toBeGreaterThan(before);

    await expect(topology.explanation()).toHaveCount(0);
    await expect(topology.explainPanel()).not.toContainText('mock upstream failure');
    await expect(topology.explainPanel()).not.toContainText('server_error');
    // The ordinary diagnostic path is untouched by the AI failure.
    await expect(topology.diagnose()).toBeVisible();
    await expect(topology.inspector()).toBeVisible();
  } finally {
    await mock.mode('ok');
  }
});

test('nothing the model said became an action: no runs, commands, intents or tool executions', async () => {
  // The chat-only (openai-compatible) transport sends no `tools`, so a
  // diagnose_connectivity proposal / approve / deny flow cannot occur on this
  // path; the model's "run execute_command" text must stay inert text.
  expect(await mock.count()).toBeGreaterThanOrEqual(1);
  expect(actionSideEffects(fixture)).toEqual({ diagnosticRuns: 0, deviceCommands: 0, actionIntents: 0, toolExecutions: 0 });
});
