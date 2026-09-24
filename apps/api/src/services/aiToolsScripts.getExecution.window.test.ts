// A-W05 Task 5c: get_script_execution stdout/stderr character windows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';
import { compactToolResultForChat } from './aiToolOutput';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'leftJoin', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
  return {
    chain,
    setRows: (r: unknown[]) => { rows = r; },
    selectSpy: chain.select as ReturnType<typeof vi.fn>,
  };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock.chain,
}));

import { aiTools } from './aiToolNames';
import './aiTools';

const EXEC = '11111111-1111-4111-8111-111111111111';
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  canAccessSite: () => true, user: { id: 'u1' },
}) as never;

describe('get_script_execution stdout/stderr window (A-W05 5c)', () => {
  const tool = aiTools.get('get_script_execution')!;
  beforeEach(() => dbMock.setRows([]));

  it('declares the window params on the registry', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.stdoutOffset).toBeDefined();
    expect(props.stdoutMaxChars).toBeDefined();
    expect(props.stderrMaxChars).toBeDefined();
  });

  it('fix 4b: caps stdoutMaxChars at 5000 (not 16000) on the registry description and on all four schema surfaces', async () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.stdoutMaxChars!.description).toBe('Max stdout chars to return (default 5000, max 5000)');

    const { toolInputSchemas } = await import('./aiToolSchemas');
    const zodShape = (toolInputSchemas.get_script_execution as unknown as { shape: Record<string, unknown> }).shape;
    expect((zodShape.stdoutMaxChars as { safeParse: (v: number) => { success: boolean } }).safeParse(5001).success).toBe(false);
    expect((zodShape.stdoutMaxChars as { safeParse: (v: number) => { success: boolean } }).safeParse(5000).success).toBe(true);

    const { buildBreezeSdkTools } = await import('./aiAgentSdkTools');
    const fakeAuth = () => { throw new Error('must not invoke tool handlers'); };
    const sdkTool = buildBreezeSdkTools(fakeAuth as never).find((t) => t.name === 'get_script_execution')!;
    const sdkShape = (sdkTool as { inputSchema: Record<string, { safeParse: (v: number) => { success: boolean } }> }).inputSchema;
    expect(sdkShape.stdoutMaxChars!.safeParse(5001).success).toBe(false);

    const { buildScriptBuilderTools } = await import('./scriptBuilderTools');
    const sbTool = buildScriptBuilderTools(fakeAuth as never).find((t) => t.name === 'get_script_execution')!;
    const sbShape = (sbTool as { inputSchema: Record<string, { safeParse: (v: number) => { success: boolean } }> }).inputSchema;
    expect(sbShape.stdoutMaxChars!.safeParse(5001).success).toBe(false);
  });

  it('returns a bounded stdout window by default with continuation fields, and caps stderr', async () => {
    dbMock.setRows([{
      id: EXEC, sourceKind: 'library', scriptId: 's1', proposalId: null,
      scriptName: 'cleanup', scriptLanguage: 'bash', language: 'bash', timeoutSeconds: 60,
      reviewRiskTier: 'low', reviewSummary: null, approvalMethod: 'auto', deviceId: 'd1',
      deviceHostname: 'host-1', deviceSiteId: 'site-1', status: 'completed', exitCode: 0,
      stdout: 'o'.repeat(5000), stdoutChars: 25_000,
      stderr: 'e'.repeat(1500), stderrChars: 9_000,
      errorMessage: null, startedAt: new Date('2026-09-20T10:00:00Z'), completedAt: new Date('2026-09-20T10:00:05Z'), createdAt: new Date('2026-09-20T09:59:00Z'),
    }]);
    const raw = await tool.handler({ executionId: EXEC }, auth());
    const out = JSON.parse(raw) as { execution: Record<string, unknown> };
    expect(out.execution).toMatchObject({
      stdoutChars: 25_000, stdoutOffset: 0, stdoutNextOffset: 5000, stdoutHasMore: true,
      stderrChars: 9_000, stderrTruncated: true,
    });
    expect((out.execution.stdout as string).length).toBe(5000);
    expect((out.execution.stderr as string).length).toBeLessThanOrEqual(1500);
    expectDefaultPageFits('get_script_execution', raw);
  });

  it('honours stdoutOffset/stdoutMaxChars and clamps to 5000, and selects with substr', async () => {
    dbMock.setRows([{
      id: EXEC, sourceKind: 'library', scriptId: 's1', proposalId: null,
      scriptName: 'cleanup', scriptLanguage: 'bash', language: 'bash', timeoutSeconds: 60,
      reviewRiskTier: 'low', reviewSummary: null, approvalMethod: 'auto', deviceId: 'd1',
      deviceHostname: 'host-1', deviceSiteId: 'site-1', status: 'completed', exitCode: 0,
      stdout: 'o'.repeat(4000), stdoutChars: 25_000, stderr: '', stderrChars: 0,
      errorMessage: null, startedAt: null, completedAt: null, createdAt: new Date('2026-09-20T09:59:00Z'),
    }]);
    const out = JSON.parse(await tool.handler({ executionId: EXEC, stdoutOffset: 21_000, stdoutMaxChars: 99_999 }, auth())) as { execution: Record<string, unknown> };
    expect(out.execution).toMatchObject({ stdoutOffset: 21_000, stdoutNextOffset: 25_000, stdoutHasMore: false });
  });

  it('never truncates the delivered stdout window under compaction pressure from an oversized sibling; escape-heavy content survives byte-for-byte and stdoutNextOffset matches what was actually delivered', async () => {
    const stdoutText = 'result: {"nested":"json-looking but not parseable\\n"} tail\r\n\twith\ttabs "quoted"';
    dbMock.setRows([{
      id: EXEC, sourceKind: 'library', scriptId: 's1', proposalId: null,
      // Oversized sibling forces the compaction tiers to engage without
      // blowing the whole payload past MAX_TOOL_RESULT_CHARS into a digest.
      scriptName: 'z'.repeat(9_000), scriptLanguage: 'bash', language: 'bash', timeoutSeconds: 60,
      reviewRiskTier: 'low', reviewSummary: null, approvalMethod: 'auto', deviceId: 'd1',
      deviceHostname: 'host-1', deviceSiteId: 'site-1', status: 'completed', exitCode: 0,
      stdout: stdoutText, stdoutChars: stdoutText.length,
      stderr: 'e"\n\\'.repeat(50), stderrChars: 150,
      errorMessage: null, startedAt: null, completedAt: null, createdAt: new Date('2026-09-20T09:59:00Z'),
    }]);
    const raw = await tool.handler({ executionId: EXEC }, auth());
    const compacted = JSON.parse(compactToolResultForChat('get_script_execution', raw)) as {
      execution: { stdout: string; stdoutNextOffset: number };
      summarized?: boolean;
    };
    expect(compacted.summarized).toBeUndefined();
    expect(compacted.execution.stdout).toBe(stdoutText);
    expect(compacted.execution.stdoutNextOffset).toBe(stdoutText.length);
  });

  it('fix 5: stdoutNextOffset counts code points, matching the Postgres substr/length units, not JS UTF-16 .length', async () => {
    // '😀' is one code point but two UTF-16 units. Postgres substr/length
    // (which sized this window at the SQL layer) count characters, i.e.
    // code points — stdoutNextOffset must agree, or a continuation request
    // built from it lands mid-character.
    const stdoutText = '😀'.repeat(10);
    dbMock.setRows([{
      id: EXEC, sourceKind: 'library', scriptId: 's1', proposalId: null,
      scriptName: 'cleanup', scriptLanguage: 'bash', language: 'bash', timeoutSeconds: 60,
      reviewRiskTier: 'low', reviewSummary: null, approvalMethod: 'auto', deviceId: 'd1',
      deviceHostname: 'host-1', deviceSiteId: 'site-1', status: 'completed', exitCode: 0,
      stdout: stdoutText, stdoutChars: 100, stderr: '', stderrChars: 0,
      errorMessage: null, startedAt: null, completedAt: null, createdAt: new Date('2026-09-20T09:59:00Z'),
    }]);
    const out = JSON.parse(await tool.handler({ executionId: EXEC }, auth())) as { execution: Record<string, unknown> };
    expect(out.execution.stdoutNextOffset).toBe(10);
  });

  it('fix 4b: shrinks a control-char-heavy stdout window by JSON-escaped length so it never digests, with stdoutNextOffset matching what was actually delivered', async () => {
    // Every '\u0001' escapes to 6 JSON chars. A raw 5000-char window of these
    // would escape to 30 000 chars, blowing MAX_TOOL_RESULT_CHARS on its own.
    const stdoutText = '\u0001'.repeat(5000);
    dbMock.setRows([{
      id: EXEC, sourceKind: 'library', scriptId: 's1', proposalId: null,
      scriptName: 'cleanup', scriptLanguage: 'bash', language: 'bash', timeoutSeconds: 60,
      reviewRiskTier: 'low', reviewSummary: null, approvalMethod: 'auto', deviceId: 'd1',
      deviceHostname: 'host-1', deviceSiteId: 'site-1', status: 'completed', exitCode: 0,
      stdout: stdoutText, stdoutChars: 50_000, stderr: '', stderrChars: 0,
      errorMessage: null, startedAt: null, completedAt: null, createdAt: new Date('2026-09-20T09:59:00Z'),
    }]);
    const raw = await tool.handler({ executionId: EXEC }, auth());
    const out = JSON.parse(raw) as { execution: { stdout: string; stdoutNextOffset: number; stdoutOffset: number } };
    expect(JSON.stringify(out.execution.stdout).length).toBeLessThan(30_000);
    expect(out.execution.stdoutNextOffset).toBe(out.execution.stdoutOffset + out.execution.stdout.length);
    const compacted = JSON.parse(compactToolResultForChat('get_script_execution', raw)) as { summarized?: boolean };
    expect(compacted.summarized).toBeUndefined();
  });
});
