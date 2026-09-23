import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ findArtifactForCaller: vi.fn(), readArtifactWindow: vi.fn() }));
vi.mock('./artifacts/artifactService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findArtifactForCaller: svc.findArtifactForCaller,
  readArtifactWindow: svc.readArtifactWindow,
}));

const env = vi.hoisted(() => ({ aiWorkspaceEnabled: vi.fn(() => true) }));
vi.mock('../config/env', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  aiWorkspaceEnabled: env.aiWorkspaceEnabled,
}));

import { aiTools } from './aiToolNames';
import './aiTools';
import { executeTool } from './aiTools';
import { compactToolResultForChat } from './aiToolOutput';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { AuthContext } from '../middleware/auth';

const HANDLE = '22222222-2222-4222-8222-222222222222';
const auth = () =>
  ({
    scope: 'organization',
    orgId: 'o1',
    partnerId: 'p1',
    accessibleOrgIds: ['o1'],
    orgCondition: () => undefined,
    user: { id: 'u1' },
  }) as unknown as AuthContext;
const record = { id: HANDLE, name: 'query_devices.json', contentType: 'application/json', bytes: 40_000 };

describe('read_artifact (A-W05 D13a/D13b)', () => {
  const tool = aiTools.get('read_artifact')!;

  beforeEach(() => {
    svc.findArtifactForCaller.mockReset();
    svc.readArtifactWindow.mockReset();
    env.aiWorkspaceEnabled.mockReturnValue(true);
  });

  it('is a Tier-1 ai-domain read, capture-exempt, with a budgeted description and searchHint', () => {
    expect(tool.tier).toBe(1);
    expect(tool.domain).toBe('ai');
    expect(tool.captureExempt).toBe(true);
    expect(tool.definition.description?.length ?? 0).toBeLessThanOrEqual(300);
    expect(tool.searchHint.length).toBeLessThanOrEqual(120);
    const props = (tool.definition.input_schema as { properties: Record<string, { description?: string }> }).properties;
    for (const [key, prop] of Object.entries(props)) {
      expect(prop.description?.length ?? 0, `${key} description too long`).toBeLessThanOrEqual(160);
    }
  });

  it('refuses with a typed error when capture is not enabled on this deployment, without any lookup', async () => {
    env.aiWorkspaceEnabled.mockReturnValue(false);
    const context: ToolExecutionContext = { captureAnchor: { orgId: 'o1', sessionId: 's1' } };
    const out = JSON.parse(await tool.handler({ handle: HANDLE }, auth(), context));
    expect(out).toMatchObject({ error: 'artifact_store_unavailable' });
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid handle before any lookup, even with capture enabled and no anchor', async () => {
    const out = JSON.parse(await tool.handler({ handle: 'nope' }, auth(), undefined));
    expect(out).toEqual({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });

  it('refuses with a typed error when the call has no capture anchor threaded — never an unscoped lookup (Q4)', async () => {
    const out = JSON.parse(await tool.handler({ handle: HANDLE }, auth(), undefined));
    expect(out).toMatchObject({ error: 'no_capture_anchor' });
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });

  it("reads its own chat session's artifact, passing that exact anchor through, and returns a window with continuation fields", async () => {
    const anchor = { orgId: 'o1', sessionId: 's1' };
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: '{"devices":[', nextOffset: 12, hasMore: true });
    const out = JSON.parse(await tool.handler({ handle: HANDLE, maxChars: 12 }, auth(), { captureAnchor: anchor }));
    expect(out).toEqual({
      handle: HANDLE,
      name: 'query_devices.json',
      contentType: 'application/json',
      bytes: 40_000,
      offset: 0,
      nextOffset: 12,
      hasMore: true,
      text: '{"devices":[',
    });
    expect(svc.findArtifactForCaller).toHaveBeenCalledWith(HANDLE, anchor);
    expect(svc.readArtifactWindow).toHaveBeenCalledWith(record, 0, 12);
  });

  it("reads its own agent run's artifact — anchored by runId, never a session", async () => {
    const anchor = { orgId: 'o1', runId: 'r1' };
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: 'x', nextOffset: 1, hasMore: false });
    await tool.handler({ handle: HANDLE }, auth(), { captureAnchor: anchor });
    expect(svc.findArtifactForCaller).toHaveBeenCalledWith(HANDLE, anchor);
  });

  it.each([
    'a different chat session belonging to the same user',
    'a different agent run',
    'a different org',
    'an expired artifact',
  ])(
    'conceals %s as a bare not-found — findArtifactForCaller already excludes these (see artifactService.callerScope.sql.test.ts); the tool must never distinguish why',
    async () => {
      svc.findArtifactForCaller.mockResolvedValue(null);
      const out = JSON.parse(await tool.handler({ handle: HANDLE }, auth(), { captureAnchor: { orgId: 'o1', sessionId: 's1' } }));
      expect(out).toEqual({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
    },
  );

  it('clamps maxChars to ARTIFACT_READ_MAX_CHARS and defaults offset to 0', async () => {
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: 'y', nextOffset: 1, hasMore: false });
    await tool.handler({ handle: HANDLE, maxChars: 999_999 }, auth(), { captureAnchor: { orgId: 'o1', sessionId: 's1' } });
    expect(svc.readArtifactWindow).toHaveBeenCalledWith(record, 0, 6000);
  });

  it('survives compactToolResultForChat intact at a MAXIMUM-size window — escape-heavy text, real default budget — nextOffset/text are never re-cut (Q3)', async () => {
    // Escape-heavy repeating unit (newline, quote, backslash, tab) built out
    // to a near-6000-char window — the largest read_artifact ever returns
    // (ARTIFACT_READ_MAX_CHARS). At this size the tool's own JSON envelope
    // still fits comfortably under MAX_TOOL_RESULT_CHARS (8000) by design —
    // proving that invariant, not merely that a tiny/impossible budget falls
    // back to the row-less digest (expected, separate behaviour).
    const unit = 'line\n"quoted" \\backslash\\ end\ttabé';
    const text = unit.repeat(Math.ceil(5_900 / unit.length)).slice(0, 5_900);
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text, nextOffset: 6_600, hasMore: true });
    const raw = await tool.handler({ handle: HANDLE, offset: 700, maxChars: 5_900 }, auth(), {
      captureAnchor: { orgId: 'o1', sessionId: 's1' },
    });
    expect(raw.length).toBeLessThan(8_000);

    const compacted = compactToolResultForChat('read_artifact', raw);
    const out = JSON.parse(compacted) as { text: string; nextOffset: number; hasMore: boolean; summarized?: boolean };
    expect(out.summarized).toBeUndefined();
    expect(out.text).toBe(text);
    expect(out.nextOffset).toBe(6_600);
    expect(out.hasMore).toBe(true);
  });

  it('falls back to the row-less digest (never a silently-shifted nextOffset) when the budget genuinely cannot fit the window — documented, not a Q3 violation', async () => {
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: 'line1\nline2 "quoted" \\backslash\\ end', nextOffset: 777, hasMore: true });
    const raw = await tool.handler({ handle: HANDLE, offset: 700 }, auth(), { captureAnchor: { orgId: 'o1', sessionId: 's1' } });
    const compacted = compactToolResultForChat('read_artifact', raw, 40);
    const out = JSON.parse(compacted) as { summarized?: boolean; text?: string };
    // A window-shaped tool is never re-cut in place (Q3) — an impossible
    // budget degrades to the honest row-less digest instead, which is
    // structurally distinguishable (`summarized: true`) from a truncated
    // window a caller might mistake for the real nextOffset.
    expect(out.summarized).toBe(true);
    expect(out.text).toBeUndefined();
  });
});

describe('read_artifact anchor threading through executeTool (A-W05 Q4)', () => {
  beforeEach(() => {
    svc.findArtifactForCaller.mockReset();
    svc.readArtifactWindow.mockReset();
    env.aiWorkspaceEnabled.mockReturnValue(true);
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: 't', nextOffset: 1, hasMore: false });
  });

  it('an agent-run caller is scoped by runId, region and toolName included, never a session', async () => {
    const runAuth = { ...auth(), principal: { kind: 'ai_agent', runId: 'run-1' } } as unknown as AuthContext;
    await executeTool('read_artifact', { handle: HANDLE }, runAuth);
    expect(svc.findArtifactForCaller).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ orgId: 'o1', runId: 'run-1', sessionId: null, toolName: 'read_artifact' }),
    );
  });

  it("a chat caller is scoped by the CURRENT session from opts.capture — never guessed from auth alone", async () => {
    await executeTool('read_artifact', { handle: HANDLE }, auth(), { capture: { orgId: 'o1', sessionId: 'chat-session-9' } });
    expect(svc.findArtifactForCaller).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ orgId: 'o1', runId: null, sessionId: 'chat-session-9', toolName: 'read_artifact' }),
    );
  });

  it('a caller with no attributable org/run/session gets the typed refusal, never an unscoped lookup', async () => {
    const bareAuth = { scope: 'system', orgId: null, orgCondition: () => undefined } as unknown as AuthContext;
    const out = JSON.parse(await executeTool('read_artifact', { handle: HANDLE }, bareAuth));
    expect(out).toMatchObject({ error: 'no_capture_anchor' });
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });
});
