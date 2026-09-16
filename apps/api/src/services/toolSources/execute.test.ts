import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ToolSourceRow } from '../../db/schema';
import type { TenantToolDescriptor } from './resolver';

const mockCallTool = vi.fn();
const mockMcpClientCtor = vi.fn();

vi.mock('./resolver', () => ({ loadTenantToolForExecution: vi.fn() }));
vi.mock('./guardrails', () => ({ checkTenantToolRateLimit: vi.fn() }));
vi.mock('./mcpClient', () => ({
  McpClient: class {
    constructor(opts: unknown) {
      mockMcpClientCtor(opts);
    }
    callTool(...args: unknown[]) {
      return mockCallTool(...args);
    }
  },
}));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn((snapshot: unknown) => ({ __snapshot: snapshot })),
}));
vi.mock('./secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets')>();
  return { ...actual, decryptToolSourceAuth: vi.fn() };
});
vi.mock('../../config/env', () => ({ toolSourcesAllowPrivateEgress: vi.fn(() => false) }));

import { executeTenantTool } from './execute';
import { loadTenantToolForExecution } from './resolver';
import { checkTenantToolRateLimit } from './guardrails';
import { writeAuditEvent } from '../auditEvents';
import { decryptToolSourceAuth } from './secrets';
import { toolSourcesAllowPrivateEgress } from '../../config/env';

function makeDescriptor(overrides: Partial<TenantToolDescriptor> = {}): TenantToolDescriptor {
  return {
    id: 'tool-1',
    sourceId: 'source-1',
    sourceName: 'Hudu',
    sourceKind: 'mcp',
    ownerRef: { orgId: 'org-1', partnerId: null },
    qualifiedName: 'hudu__get_asset',
    name: 'get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    tier: 1,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true }),
    definition: { name: 'hudu__get_asset', description: 'Get an asset', input_schema: { type: 'object' } },
    ...overrides,
  };
}

function makeSource(overrides: Partial<ToolSourceRow> = {}): ToolSourceRow {
  return {
    id: 'source-1',
    orgId: 'org-1',
    partnerId: null,
    slug: 'hudu',
    name: 'Hudu',
    kind: 'mcp',
    endpointUrl: 'https://hudu.example.com/mcp',
    credentialOrigin: 'https://hudu.example.com',
    authKind: 'none',
    authConfigEncrypted: null,
    authFingerprint: null,
    status: 'active',
    lastDiscoveredAt: null,
    lastError: null,
    rateLimitPerMinute: 60,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ToolSourceRow;
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    ...overrides,
  } as unknown as AuthContext;
}

describe('executeTenantTool', () => {
  beforeEach(() => {
    mockCallTool.mockReset();
    mockMcpClientCtor.mockReset();
    vi.mocked(loadTenantToolForExecution).mockReset();
    vi.mocked(checkTenantToolRateLimit).mockReset();
    vi.mocked(writeAuditEvent).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReset();
    vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'none' });
    vi.mocked(toolSourcesAllowPrivateEgress).mockReset();
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(false);
  });

  // #6023: `opts.orgId` used to be audit-attribution-only. It is now ALSO the
  // `targetOrgId` the dispatch-time reload re-derives ownership against, so a
  // dropped/mis-threaded `opts.orgId` would silently deny a partner-scoped
  // caller's otherwise-valid org-owned tool. Pin the forwarding explicitly —
  // nothing else in this file asserts `loadTenantToolForExecution`'s args.
  it('threads opts.orgId through to loadTenantToolForExecution as the targetOrgId for the dispatch-time reload', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });

    const descriptor = makeDescriptor();
    const auth = makeAuth({ scope: 'partner', orgId: null, partnerId: 'partner-1' });
    await executeTenantTool(descriptor, { id: 'a1' }, auth, { surface: 'test', orgId: 'org-1' });

    expect(loadTenantToolForExecution).toHaveBeenCalledWith(descriptor.id, auth, 'org-1');
  });

  it('passes undefined targetOrgId through when the caller omits opts.orgId (partner-wide-only reload)', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });

    const descriptor = makeDescriptor();
    const auth = makeAuth();
    await executeTenantTool(descriptor, { id: 'a1' }, auth, { surface: 'test' });

    expect(loadTenantToolForExecution).toHaveBeenCalledWith(descriptor.id, auth, undefined);
  });

  it('wires TOOL_SOURCES_ALLOW_PRIVATE_EGRESS into the McpClient it constructs for dispatch', async () => {
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(true);
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });

    await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(mockMcpClientCtor).toHaveBeenCalledWith(expect.objectContaining({ allowPrivateNetwork: true }));
  });

  it('validation error: short-circuits before rate-limit/load/call, returns a JSON error', async () => {
    const descriptor = makeDescriptor({ validate: () => ({ success: false, error: 'id is required' }) });

    const result = await executeTenantTool(descriptor, {}, makeAuth(), { surface: 'chat' });

    expect(JSON.parse(result)).toEqual({ error: 'id is required' });
    expect(checkTenantToolRateLimit).not.toHaveBeenCalled();
    expect(loadTenantToolForExecution).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('rate-limit error: short-circuits before load/call, returns a JSON error', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue('Tool rate limit exceeded for hudu__get_asset. Try again at 2026-01-01T00:00:00.000Z');

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(JSON.parse(result)).toEqual({
      error: 'Tool rate limit exceeded for hudu__get_asset. Try again at 2026-01-01T00:00:00.000Z',
    });
    expect(loadTenantToolForExecution).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('tool revoked at dispatch (loadTenantToolForExecution returns null): reports an error without calling the remote server', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue(null);

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(JSON.parse(result).error).toContain('hudu__get_asset');
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('success path: structuredContent is returned as the result string', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [], structuredContent: { assetId: 'a1', name: 'Widget' }, isError: false });

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(JSON.parse(result)).toEqual({ assetId: 'a1', name: 'Widget' });
    expect(mockCallTool).toHaveBeenCalledWith('get_asset', { id: 'a1' });
  });

  it('success path: falls back to concatenated text parts when structuredContent is absent', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'Asset: ' }, { type: 'text', text: 'Widget' }], isError: false });

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(result).toBe('Asset: Widget');
  });

  it('isError result: wraps the (redacted, truncated) text as { error }', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'upstream boom' }], isError: true });

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(JSON.parse(result)).toEqual({ error: 'upstream boom' });
  });

  it('redacts the decrypted bearer token out of the tool output before returning it', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(decryptToolSourceAuth).mockReturnValue({ authKind: 'bearer', token: 'sekret-token-abc123' });
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({
      descriptor: makeDescriptor(),
      source: makeSource({ authKind: 'bearer' }),
    });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'echoed Authorization: Bearer sekret-token-abc123 back to you' }],
      isError: false,
    });

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(result).not.toContain('sekret-token-abc123');
    expect(result).toContain('[REDACTED]');
  });

  it('truncates a result over 262,144 chars and appends the truncation marker', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    const huge = 'x'.repeat(300_000);
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: huge }], isError: false });

    const result = await executeTenantTool(makeDescriptor(), { id: 'a1' }, makeAuth(), { surface: 'chat' });

    expect(result.startsWith('x'.repeat(262_144))).toBe(true);
    expect(result.endsWith('\n…[truncated]')).toBe(true);
    expect(result.length).toBe(262_144 + '\n…[truncated]'.length);
  });

  it('audits the call with metadata only — never the input values or the output', async () => {
    vi.mocked(checkTenantToolRateLimit).mockResolvedValue(null);
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: makeDescriptor(), source: makeSource() });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'Widget details: super-secret-value-9' }], isError: false });

    const auth = makeAuth();
    await executeTenantTool(makeDescriptor(), { id: 'a1', apiToken: 'do-not-log-me' }, auth, {
      surface: 'chat',
      orgId: 'org-1',
    });

    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = vi.mocked(writeAuditEvent).mock.calls[0]!;
    expect(event).toMatchObject({
      orgId: 'org-1',
      action: 'ai.external_tool.call',
      resourceType: 'tool_source_tool',
      resourceId: 'tool-1',
      resourceName: 'hudu__get_asset',
      actorId: 'user-1',
      actorEmail: 'tech@example.com',
    });
    expect(event.details).toMatchObject({
      sourceId: 'source-1',
      tier: 1,
      revision: 'rev-1',
      surface: 'chat',
      inputKeys: ['id', 'apiToken'],
      isError: false,
    });
    const serializedDetails = JSON.stringify(event.details);
    expect(serializedDetails).not.toContain('do-not-log-me');
    expect(serializedDetails).not.toContain('super-secret-value-9');
    expect(serializedDetails).not.toContain('a1');
  });
});
