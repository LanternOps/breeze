/**
 * Wisp W03 Task 6 — the four memory tools. The broker, the human service and
 * the ceiling resolver are mocked: these tests pin the TOOL layer only (grant
 * required, input → broker mapping, error mapping, human-only gate, registry
 * placement). Broker semantics are pinned by memoryBroker.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recallForGrant, rememberForGrant, renderMemoryForPrompt } = vi.hoisted(() => ({
  recallForGrant: vi.fn(),
  rememberForGrant: vi.fn(),
  renderMemoryForPrompt: vi.fn(),
}));
const { confirmBlock, retractBlock } = vi.hoisted(() => ({ confirmBlock: vi.fn(), retractBlock: vi.fn() }));
const { resolveGrantCeiling } = vi.hoisted(() => ({ resolveGrantCeiling: vi.fn() }));

vi.mock('./memoryBroker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryBroker')>()),
  recallForGrant,
  rememberForGrant,
  renderMemoryForPrompt,
}));
vi.mock('./memoryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryService')>()),
  confirmBlock,
  retractBlock,
}));
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling,
}));

import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../aiTools';
import { CeilingViolationError, GrantInactiveError, type GrantCeiling } from './grantAuthority';
import { MemoryValidationError, type MemoryBlock } from './memoryBroker';
import { MemoryServiceError } from './memoryService';
import { registerWispMemoryTools } from './memoryTools';
import { TOOL_TIERS, wispMemoryToolDefinitions } from '../aiAgentSdkTools';
import { isToolEnvGatedOff, WISP_MEMORY_TOOL_NAMES } from '../aiToolEnvGates';
import { AGENT_HUMAN_ONLY_TOOLS, HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { aiTools } from '../aiToolNames';

const GRANT = '00000000-0000-4000-8000-000000000a01';
const REVISION = '00000000-0000-4000-8000-000000000a02';
const SESSION = '00000000-0000-4000-8000-000000000a03';
const PARTNER = '00000000-0000-4000-8000-000000000b01';
const GRANTOR = '00000000-0000-4000-8000-000000000c01';
const ORG = '00000000-0000-4000-8000-000000000d01';
const BLOCK = '00000000-0000-4000-8000-000000000e01';
const OTHER_SESSION = '00000000-0000-4000-8000-000000000a99';

const ceiling: GrantCeiling = {
  grantId: GRANT,
  revisionId: REVISION,
  partnerId: PARTNER,
  grantorUserId: GRANTOR,
  scopeOrgId: null,
  partnerWide: true,
  orgIds: new Set([ORG]),
  siteIds: null,
  permissionKeys: new Set(['ai_sessions:use']),
  toolAllowlist: null,
  deniedTools: new Set(),
  orgTerms: new Map(),
  status: 'active',
};

function block(over: Partial<MemoryBlock> = {}): MemoryBlock {
  return {
    id: BLOCK,
    tenantPartnerId: PARTNER,
    owner: { kind: 'org', orgId: ORG },
    blockType: 'fact',
    subjectKey: 'printer:floor2',
    content: { note: 'x' },
    confidence: 'medium',
    status: 'unconfirmed',
    authoredByGrantId: GRANT,
    authoredByGrantRevisionId: REVISION,
    supersededById: null,
    sourceSessionId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: GRANTOR, email: 't@example.com', name: 'T', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG],
    wispGrant: { grantId: GRANT, grantRevisionId: REVISION, sessionId: SESSION },
    ...over,
  } as AuthContext;
}

/** The RememberInput passed on the nth rememberForGrant call. */
const rememberArg = (n: number) => rememberForGrant.mock.calls[n]![1];

const tools = new Map<string, AiTool>();
registerWispMemoryTools(tools);
const run = (name: string, input: Record<string, unknown>, a: AuthContext = auth()) =>
  tools.get(name)!.handler(input, a);

beforeEach(() => {
  vi.clearAllMocks();
  resolveGrantCeiling.mockResolvedValue(ceiling);
});

describe('wisp memory tools', () => {
  it('registers remember, recall, confirm_memory, retract_memory in the aiTools map', () => {
    expect([...tools.keys()].sort()).toEqual(['confirm_memory', 'recall', 'remember', 'retract_memory']);
    for (const [name, t] of tools) {
      expect(t.definition.name).toBe(name);
      expect(t.domain).toBe('ai');
      expect(t.deviceArgs).toEqual([]);
    }
    expect(tools.get('recall')!.tier).toBe(1);
    expect(tools.get('remember')!.tier).toBe(2);
  });

  it('recall/remember return {"error":"wisp_grant_required"} when auth.wispGrant is absent and call nothing', async () => {
    const noGrant = auth({ wispGrant: undefined });
    for (const name of ['recall', 'remember', 'confirm_memory', 'retract_memory']) {
      const out = await run(name, { ownerKind: 'partner', blockType: 'fact', subjectKey: 'k', content: {}, blockId: BLOCK }, noGrant);
      expect(JSON.parse(out)).toEqual({ error: 'wisp_grant_required' });
    }
    expect(resolveGrantCeiling).not.toHaveBeenCalled();
    expect(recallForGrant).not.toHaveBeenCalled();
    expect(rememberForGrant).not.toHaveBeenCalled();
    expect(confirmBlock).not.toHaveBeenCalled();
    expect(retractBlock).not.toHaveBeenCalled();
  });

  it('recall resolves the ceiling from auth.wispGrant and renders via renderMemoryForPrompt', async () => {
    const blocks = [block()];
    recallForGrant.mockResolvedValue(blocks);
    renderMemoryForPrompt.mockReturnValue('<rendered>');
    const out = await run('recall', { ownerKinds: ['org'], subjectKeyPrefix: 'printer:', blockTypes: ['fact'], orgId: ORG, limit: 10 });
    expect(resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REVISION);
    expect(recallForGrant).toHaveBeenCalledWith(ceiling, {
      owners: ['org'], subjectKeyPrefix: 'printer:', blockTypes: ['fact'], orgId: ORG, limit: 10,
    });
    expect(renderMemoryForPrompt).toHaveBeenCalledWith(blocks);
    expect(out).toBe('<rendered>');

    recallForGrant.mockResolvedValue([]);
    expect(await run('recall', {})).toBe('No memory blocks match.');
  });

  it('remember maps ownerKind/orgId to a MemoryOwner and surfaces CeilingViolationError as {"error":"ceiling_violation","code":"org"}', async () => {
    rememberForGrant.mockResolvedValue(block());
    const base = { blockType: 'preference', subjectKey: 'reboot:window', content: { v: 1 } };

    await run('remember', { ...base, ownerKind: 'user' });
    expect(rememberArg(0).owner).toEqual({ kind: 'user', userId: GRANTOR });
    await run('remember', { ...base, ownerKind: 'org', orgId: ORG });
    expect(rememberArg(1).owner).toEqual({ kind: 'org', orgId: ORG });
    const ok = await run('remember', { ...base, ownerKind: 'partner', confidence: 'high' });
    expect(rememberArg(2)).toMatchObject({ owner: { kind: 'partner' }, confidence: 'high' });
    expect(ok).toBe(`Remembered as unconfirmed (ID: ${BLOCK}). The owner can confirm or retract it on the Wisp memory page.`);

    // org without orgId is refused before the broker.
    rememberForGrant.mockClear();
    const missing = JSON.parse(await run('remember', { ...base, ownerKind: 'org' }));
    expect(missing.error).toBe('invalid_memory');
    expect(rememberForGrant).not.toHaveBeenCalled();

    rememberForGrant.mockRejectedValueOnce(new CeilingViolationError('org', 'org outside ceiling'));
    expect(JSON.parse(await run('remember', { ...base, ownerKind: 'org', orgId: ORG })))
      .toEqual({ error: 'ceiling_violation', code: 'org' });

    rememberForGrant.mockRejectedValueOnce(new MemoryValidationError('content too large'));
    expect(JSON.parse(await run('remember', { ...base, ownerKind: 'partner' })))
      .toEqual({ error: 'invalid_memory', message: 'content too large' });

    // Anything else is not swallowed.
    rememberForGrant.mockRejectedValueOnce(new Error('db down'));
    await expect(run('remember', { ...base, ownerKind: 'partner' })).rejects.toThrow('db down');
  });

  it('remember surfaces GrantInactiveError as {"error":"grant_inactive"}', async () => {
    resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(GRANT, 'revoked'));
    expect(JSON.parse(await run('remember', { ownerKind: 'partner', blockType: 'fact', subjectKey: 'k', content: {} })))
      .toEqual({ error: 'grant_inactive' });
    rememberForGrant.mockRejectedValueOnce(new GrantInactiveError(GRANT, 'paused'));
    expect(JSON.parse(await run('remember', { ownerKind: 'partner', blockType: 'fact', subjectKey: 'k', content: {} })))
      .toEqual({ error: 'grant_inactive' });
    recallForGrant.mockRejectedValueOnce(new GrantInactiveError(GRANT, 'paused'));
    expect(JSON.parse(await run('recall', {}))).toEqual({ error: 'grant_inactive' });
  });

  it('remember passes sourceSessionId = auth.wispGrant.sessionId to rememberForGrant, null when the grant carries no sessionId, and ignores a sourceSessionId supplied in the input', async () => {
    rememberForGrant.mockResolvedValue(block());
    const input = { ownerKind: 'org', orgId: ORG, blockType: 'work_summary', subjectKey: 'work:2026-10-23:printer', content: { evidence: [] } };

    await run('remember', { ...input, sourceSessionId: OTHER_SESSION });
    expect(rememberArg(0).sourceSessionId).toBe(SESSION);

    await run('remember', { ...input, sourceSessionId: OTHER_SESSION }, auth({ wispGrant: { grantId: GRANT, grantRevisionId: REVISION } }));
    expect(rememberArg(1).sourceSessionId).toBeNull();

    await run('remember', input, auth({ wispGrant: { grantId: GRANT, grantRevisionId: REVISION, sessionId: null } }));
    expect(rememberArg(2).sourceSessionId).toBeNull();
  });

  it('confirm_memory / retract_memory refuse an ai_agent principal with {"error":"human_only"} and otherwise call memoryService', async () => {
    const agent = auth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });
    for (const name of ['confirm_memory', 'retract_memory']) {
      expect(JSON.parse(await run(name, { blockId: BLOCK }, agent))).toEqual({ error: 'human_only' });
    }
    expect(confirmBlock).not.toHaveBeenCalled();
    expect(retractBlock).not.toHaveBeenCalled();

    const a = auth();
    confirmBlock.mockResolvedValue(block({ status: 'confirmed' }));
    const confirmed = await run('confirm_memory', { blockId: BLOCK }, a);
    expect(confirmBlock).toHaveBeenCalledWith(a, BLOCK);
    expect(confirmed).toContain(BLOCK);
    expect(confirmed).toContain('confirmed');

    retractBlock.mockResolvedValue(block({ status: 'retracted' }));
    const retracted = await run('retract_memory', { blockId: BLOCK }, a);
    expect(retractBlock).toHaveBeenCalledWith(a, BLOCK);
    expect(retracted).toContain(BLOCK);
    expect(retracted).toContain('retracted');

    confirmBlock.mockRejectedValueOnce(new MemoryServiceError('retracted', 'nope'));
    expect(JSON.parse(await run('confirm_memory', { blockId: BLOCK }, a))).toEqual({ error: 'retracted' });

    expect(JSON.parse(await run('retract_memory', { blockId: 'not-a-uuid' }, a)).error).toBe('invalid_memory');
  });

  it('stays dark while wispEnabled() is off: no chat declaration, gated off the MCP server', () => {
    const fakeAuth = (): AuthContext => { throw new Error('handlers must not run'); };
    vi.stubEnv('IS_HOSTED', '');
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', '');
    vi.stubEnv('BREEZE_WISP_ENABLED', '');
    try {
      expect(wispMemoryToolDefinitions(fakeAuth, undefined)).toEqual([]);
      for (const name of WISP_MEMORY_TOOL_NAMES) expect(isToolEnvGatedOff(name)).toBe(true);
    } finally { vi.unstubAllEnvs(); }

    vi.stubEnv('IS_HOSTED', 'true');
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
    try {
      expect(wispMemoryToolDefinitions(fakeAuth, undefined).map((t) => t.name).sort()).toEqual(['recall', 'remember']);
      for (const name of WISP_MEMORY_TOOL_NAMES) expect(isToolEnvGatedOff(name)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
    expect([...WISP_MEMORY_TOOL_NAMES].sort()).toEqual([...tools.keys()].sort());
  });

  it('recall is tier 1 and remember tier 2 in TOOL_TIERS; confirm_memory and retract_memory are in HUMAN_ONLY_TOOLS and not in TOOL_TIERS', () => {
    const tiers = TOOL_TIERS as Record<string, number>;
    expect(tiers.recall).toBe(1);
    expect(tiers.remember).toBe(2);
    for (const name of ['confirm_memory', 'retract_memory']) {
      expect(HUMAN_ONLY_TOOLS.has(name)).toBe(true);
      expect(HUMAN_ONLY_TOOLS.get(name)!.trim().length).toBeGreaterThanOrEqual(20);
      // Agents never confirm/retract: denied to the ai_agent principal above any allowlist, and
      // assertWithinCeiling (W02) refuses AGENT_HUMAN_ONLY_TOOLS for every grant.
      expect(AGENT_HUMAN_ONLY_TOOLS.has(name)).toBe(true);
      expect(name in tiers).toBe(false);
      // Registry tier 3 (operator_plan precedent): wholly gated over external MCP, so never advertised there.
      expect(aiTools.get(name)!.tier).toBe(3);
    }
    for (const name of ['recall', 'remember', 'confirm_memory', 'retract_memory']) {
      expect(aiTools.has(name)).toBe(true);
    }
  });
});
