import type { AiPageContext } from '@breeze/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// W19 (#10065): buildSystemPrompt pre-expands a page's tool domains under
// `## Current Page Context` in lazy mode, and never in full mode. The
// rendering itself is pinned in aiToolIndex.test.ts; this covers the wiring.
// Mocks follow aiAgent.deviceMemory.test.ts.
const selectMock = vi.fn();
vi.mock('../db', () => ({ db: { select: (...args: unknown[]) => selectMock(...args) } }));
vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: { id: 'aiToolExecutions.id' },
  delegantM365Connections: { id: 'delegantM365Connections.id', orgId: 'delegantM365Connections.orgId', status: 'delegantM365Connections.status' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));
vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));

const composeStaticSystemPrompt = vi.fn((_names: readonly string[], mode: string) => `STATIC:${mode}`);
const renderPageContextToolBlocks = vi.fn((page: AiPageContext, _names: readonly string[]) => `BLOCKS:${page.type}`);
const resolveToolIndexMode = vi.fn(() => 'lazy');
vi.mock('./aiToolIndex', () => ({
  composeStaticSystemPrompt: (names: readonly string[], mode: string) => composeStaticSystemPrompt(names, mode),
  renderPageContextToolBlocks: (page: AiPageContext, names: readonly string[]) => renderPageContextToolBlocks(page, names),
  resolveToolIndexMode: () => resolveToolIndexMode(),
}));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => ['query_devices', 'run_script'] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn(async () => []) }));
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'partner-1') }));
vi.mock('./aiModels/sessionModel', () => ({
  chooseSessionModel: vi.fn(async () => ({
    offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null,
    model: 'claude-sonnet-4-6', billingSource: 'platform',
  })),
}));

import { buildSystemPrompt } from './aiAgent';

const auth: any = {
  user: { id: 'user-1', name: 'Tess Tech' },
  scope: 'organization',
  orgId: 'org-111',
  accessibleOrgIds: ['org-111'],
  canAccessOrg: (id: string) => id === 'org-111',
  orgCondition: () => undefined,
};
// The device row lookup finds nothing, so no memory is loaded.
const noDevice = () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) });

describe('buildSystemPrompt page-context tool blocks (W19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveToolIndexMode.mockReturnValue('lazy');
    selectMock.mockImplementation(noDevice);
  });

  it('reads the index mode once and passes it to the static prefix', async () => {
    const prompt = await buildSystemPrompt(auth);
    expect(resolveToolIndexMode).toHaveBeenCalledTimes(1);
    expect(composeStaticSystemPrompt).toHaveBeenCalledWith(['query_devices', 'run_script'], 'lazy');
    expect(prompt.startsWith('STATIC:lazy\n')).toBe(true);
    expect(renderPageContextToolBlocks).not.toHaveBeenCalled();
  });

  it.each([
    ['device', { type: 'device', id: '44444444-4444-4444-4444-444444444444', hostname: 'web-01' }],
    ['alert', { type: 'alert', id: 'alert-1', title: 'Disk full' }],
  ] as const)('appends the %s page\'s blocks at the end of the page-context section', async (page, ctx) => {
    const prompt = await buildSystemPrompt(auth, ctx as never);
    expect(renderPageContextToolBlocks).toHaveBeenCalledWith(ctx, ['query_devices', 'run_script']);
    const section = prompt.slice(prompt.indexOf('## Current Page Context'));
    expect(section).toContain(`\nBLOCKS:${page}`);
    expect(prompt.indexOf(`BLOCKS:${page}`)).toBeGreaterThan(prompt.indexOf('## Current Page Context'));
  });

  it('places the blocks before the approval-mode section', async () => {
    const prompt = await buildSystemPrompt(auth, { type: 'alert', id: 'a', title: 't' } as never, 'action_plan');
    expect(prompt.indexOf('BLOCKS:alert')).toBeLessThan(prompt.indexOf('## Approval Mode'));
  });

  it('adds nothing when the page maps to no domain', async () => {
    renderPageContextToolBlocks.mockReturnValueOnce('');
    const prompt = await buildSystemPrompt(auth, { type: 'dashboard' } as never);
    expect(prompt).toContain('The user is on the main dashboard.');
    expect(prompt.endsWith('The user is on the main dashboard.')).toBe(true);
  });

  it('AI_TOOL_INDEX=full: legacy static prefix and no page blocks', async () => {
    resolveToolIndexMode.mockReturnValue('full');
    const prompt = await buildSystemPrompt(auth, { type: 'device', id: '44444444-4444-4444-4444-444444444444', hostname: 'web-01' } as never);
    expect(composeStaticSystemPrompt).toHaveBeenCalledWith(['query_devices', 'run_script'], 'full');
    expect(renderPageContextToolBlocks).not.toHaveBeenCalled();
    expect(prompt).not.toContain('BLOCKS:');
  });
});
