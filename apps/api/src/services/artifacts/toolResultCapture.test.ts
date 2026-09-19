/**
 * Execution-plane W01, spec §12 "artifactCapture.test.ts": raw bytes persisted,
 * previews raw, threshold boundary, opt-out honoured — plus §9's rule that a
 * blob failure NEVER returns the raw result inline.
 *
 * The capture path has NO database access of its own: `captureContextFrom` is
 * pure and `captureLargeToolResult` only calls `createArtifact`. There is
 * deliberately no db mock here — if one becomes necessary, a run lookup has
 * crept back in and the reconciliation section was violated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createArtifact: vi.fn(),
  aiWorkspaceEnabled: vi.fn(() => true),
  breezeRegion: vi.fn(() => 'us' as const),
}));

vi.mock('./artifactService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createArtifact: mocks.createArtifact,
}));
vi.mock('../../config/env', () => ({
  aiWorkspaceEnabled: mocks.aiWorkspaceEnabled,
  breezeRegion: mocks.breezeRegion,
}));

import { MAX_TOOL_RESULT_CHARS } from '../aiToolOutput';
import { BlobStorageUnavailableError } from './blobStorage';
import {
  captureContextFrom,
  captureLargeToolResult,
  type CaptureContext,
} from './toolResultCapture';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const SESSION = '00000000-0000-4000-8000-0000000000a5';
const HANDLE = '00000000-0000-4000-8000-0000000000a4';

const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  orgId: ORG, runId: RUN, sessionId: null, region: 'us', toolName: 'search_logs', ...over,
});

/** An org-scoped human login. */
const orgAuth = { principal: { kind: 'user_session' }, orgId: ORG, accessibleOrgIds: [ORG] } as never;
/** A partner-scope login: `auth.orgId` is null even though orgs are reachable. */
const partnerAuth = { principal: { kind: 'user_session' }, orgId: null, accessibleOrgIds: [ORG] } as never;
/** The agent run path: agentAuthContext.ts builds exactly this. */
const runAuth = {
  principal: { kind: 'ai_agent', agentId: 'ag1', runId: RUN },
  orgId: ORG, accessibleOrgIds: [ORG],
} as never;

beforeEach(() => {
  mocks.createArtifact.mockReset().mockResolvedValue({
    id: HANDLE, bytes: 30_000, contentType: 'application/json',
  });
  mocks.aiWorkspaceEnabled.mockReturnValue(true);
  mocks.breezeRegion.mockReturnValue('us');
});
afterEach(() => vi.clearAllMocks());

const big = (chars: number) => JSON.stringify({ rows: 'r'.repeat(chars) });

describe('captureContextFrom — run path attributes from the principal (reconciliation R4/R5)', () => {
  it('anchors on the run and takes the org from auth, with no call-site input at all', () => {
    expect(captureContextFrom(runAuth, undefined, 'search_logs'))
      .toEqual({ orgId: ORG, runId: RUN, sessionId: null, region: 'us', toolName: 'search_logs' });
  });

  it('keeps the RUN anchor and stores no session even when a chat scope is also supplied', () => {
    const resolved = captureContextFrom(runAuth, { capture: { orgId: OTHER_ORG, sessionId: SESSION } }, 't');
    expect(resolved).toMatchObject({ runId: RUN, sessionId: null });
  });
});

describe('captureContextFrom — chat path attributes from ExecuteToolOptions.capture', () => {
  it('anchors on the session, with the session org, when auth.orgId is null (partner-scope login)', () => {
    expect(captureContextFrom(partnerAuth, { capture: { orgId: ORG, sessionId: SESSION } }, 'get_event_logs'))
      .toEqual({ orgId: ORG, runId: null, sessionId: SESSION, region: 'us', toolName: 'get_event_logs' });
  });

  it("prefers the session's org over auth.orgId when the two disagree", () => {
    expect(captureContextFrom({ principal: { kind: 'user_session' }, orgId: OTHER_ORG } as never,
      { capture: { orgId: ORG, sessionId: SESSION } }, 't')?.orgId).toBe(ORG);
  });

  it('returns null for a partner-scope call with no capture scope — NEVER guesses from accessibleOrgIds', () => {
    expect(captureContextFrom(partnerAuth, undefined, 't')).toBeNull();
    // Even a single accessible org is a guess, and a guessed org on a
    // tenant-scoped row is a tenancy bug waiting for its second org (R4).
    expect(captureContextFrom({ principal: { kind: 'user_session' }, orgId: null, accessibleOrgIds: [ORG] } as never,
      undefined, 't')).toBeNull();
  });

  it('returns null when there is an org but no anchor — mcpServer / scriptBuilder / intentRelease pass through', () => {
    expect(captureContextFrom(orgAuth, undefined, 't')).toBeNull();
    expect(captureContextFrom(orgAuth, {}, 't')).toBeNull();
  });

  it('reads the region through breezeRegion()', () => {
    mocks.breezeRegion.mockReturnValue('eu' as never);
    expect(captureContextFrom(runAuth, undefined, 't')?.region).toBe('eu');
  });
});

describe('captureLargeToolResult — threshold boundary (spec §5.2)', () => {
  it('returns the raw string UNCHANGED at exactly MAX_TOOL_RESULT_CHARS', async () => {
    const raw = 'x'.repeat(MAX_TOOL_RESULT_CHARS);
    expect(await captureLargeToolResult(raw, ctx())).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it('captures at MAX_TOOL_RESULT_CHARS + 1', async () => {
    const raw = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 1);
    const out = await captureLargeToolResult(raw, ctx());
    expect(mocks.createArtifact).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(out) as { artifact: { handle: string }; compacted: string };
    expect(parsed.artifact.handle).toBe(HANDLE);
    expect(parsed.compacted).toBe(raw);
  });
});

describe('captureLargeToolResult — passthrough cases', () => {
  it('returns raw for a NULL context — the path both an unattributable call and a captureExempt tool take', async () => {
    // The hook in executeTool (Task 9) passes null for a captureExempt tool and
    // whatever captureContextFrom returned otherwise, so this one branch is the
    // whole passthrough surface.
    const raw = big(30_000);
    expect(await captureLargeToolResult(raw, null)).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("returns raw when the workspace flag is off — self-hosters see today's bytes exactly", async () => {
    mocks.aiWorkspaceEnabled.mockReturnValue(false);
    const raw = big(30_000);
    expect(await captureLargeToolResult(raw, ctx())).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it('captures a session-anchored context (a plain chat with no run)', async () => {
    await captureLargeToolResult(big(30_000), ctx({ runId: null, sessionId: SESSION }));
    expect(mocks.createArtifact).toHaveBeenCalledTimes(1);
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).runId).toBeNull();
  });
});

describe('captureLargeToolResult — what is persisted (spec §5.2)', () => {
  it('persists the RAW bytes as kind input_capture with the calling tool recorded', async () => {
    const raw = big(30_000);
    await captureLargeToolResult(raw, ctx({ toolName: 'get_event_logs' }));
    const arg = mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe('input_capture');
    expect(arg.createdByTool).toBe('get_event_logs');
    expect(arg.orgId).toBe(ORG);
    expect(arg.runId).toBe(RUN);
    expect(arg.sessionId).toBeNull();
    expect(arg.region).toBe('us');
    expect((arg.body as Buffer).toString('utf8')).toBe(raw);   // RAW, not compacted
  });

  it('labels JSON as application/json and non-JSON as text/plain', async () => {
    await captureLargeToolResult(big(30_000), ctx());
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).contentType).toBe('application/json');
    mocks.createArtifact.mockClear();
    await captureLargeToolResult('n'.repeat(30_000), ctx());
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).contentType).toBe('text/plain; charset=utf-8');
  });

  it('names the artifact after the tool, and the envelope carries raw head/tail previews', async () => {
    const raw = `HEAD${'m'.repeat(30_000)}TAIL`;
    const out = await captureLargeToolResult(raw, ctx({ toolName: 'search_logs' }));
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).name).toBe('search_logs.txt');
    const parsed = JSON.parse(out) as { artifact: { head: string; tail: string; bytes: number; contentType: string } };
    expect(parsed.artifact.head.startsWith('HEAD')).toBe(true);
    expect(parsed.artifact.tail.endsWith('TAIL')).toBe(true);
    expect(parsed.artifact.head.length).toBeLessThanOrEqual(2048);
  });
});

describe('captureLargeToolResult — failure (spec §9)', () => {
  it('returns a typed error and NEVER the raw result inline when the blob store is down', async () => {
    const raw = big(30_000);
    mocks.createArtifact.mockRejectedValue(new BlobStorageUnavailableError('bucket down'));
    const out = await captureLargeToolResult(raw, ctx());
    expect(JSON.parse(out)).toEqual({
      error: 'artifact_store_unavailable',
      message: expect.stringContaining('too large'),
    });
    expect(out).not.toContain('rrrrr');
    expect(out.length).toBeLessThan(500);
  });

  it('does the same for any other artifact failure — no fallback bypasses the cap', async () => {
    mocks.createArtifact.mockRejectedValue(new Error('insert boom'));
    const out = await captureLargeToolResult(big(30_000), ctx());
    expect((JSON.parse(out) as { error: string }).error).toBe('artifact_store_unavailable');
  });
});
