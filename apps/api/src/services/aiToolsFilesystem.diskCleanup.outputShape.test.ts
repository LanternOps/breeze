// #6745 (A-W05 follow-up): disk_cleanup preview output shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const state = vi.hoisted(() => ({ candidates: [] as Record<string, unknown>[] }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const chain: Record<string, unknown> = {};
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(async () => (name === 'users'
          ? [{ id: 'u1' }]
          : [{ id: DEVICE_ID, orgId: ORG_ID, siteId: 's1', hostname: 'host-1', status: 'online', osType: 'windows', agentVersion: '9.9.9' }]));
        return chain;
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: RUN_ID }]) })) })),
  },
}));
vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(), executeCommandWithSystemPrecheck: vi.fn(),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn(() => ({})) }));
vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    snapshotId: 'snap-1',
    estimatedBytes: state.candidates.reduce((s, c) => s + (c.sizeBytes as number), 0),
    candidateCount: state.candidates.length,
    categories: [{ category: 'temp_files', count: state.candidates.length, estimatedBytes: 1 }],
    candidates: state.candidates,
  })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => ({ id: 'snap-1', scanPath: 'C:\\' })),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  readPlanPreviewCandidates: vi.fn(),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerFilesystemTools(reg);
  return reg.get('disk_cleanup')!;
}
const auth = () => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: ORG_ID, scope: 'organization', accessibleOrgIds: [ORG_ID],
  orgCondition: () => undefined, canAccessOrg: () => true, canAccessSite: () => true,
}) as unknown as AuthContext;

function candidate(i: number) {
  return {
    path: `C:\\Users\\accounting.clerk\\AppData\\Local\\Temp\\{3F2504E0-4F89-11D3-9A0C-0305E82C${String(i).padStart(4, '0')}}\\setup-log-${i}.tmp`,
    category: 'temp_files',
    sizeBytes: 10_000_000 - i,
    safe: true,
    reason: 'Temporary file older than 7 days in a user temp directory',
    modifiedAt: '2026-09-01T10:00:00.000Z',
  };
}

describe('disk_cleanup preview output shape (#6745)', () => {
  beforeEach(() => { vi.clearAllMocks(); state.candidates = []; });

  it('declares the measured maxCandidates default', () => {
    const props = (tool().definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.maxCandidates!.description).toMatch(/default 35\b/);
  });

  it('a default preview of realistic candidates drops safe/reason, reports hasMore, and fits the budget', async () => {
    state.candidates = Array.from({ length: 400 }, (_, i) => candidate(i));
    const raw = await tool().handler({ deviceId: DEVICE_ID, action: 'preview' }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.candidates).toHaveLength(35);
    expect(out.hasMore).toBe(true);
    expect(out.truncatedCandidateCount).toBe(365);
    expect(out.candidates[0].safe).toBeUndefined();
    expect(out.candidates[0].reason).toBeUndefined();
    expect(out.note).toMatch(/maxCandidates|categories/);
    expectDefaultPageFits('disk_cleanup', raw);
  });

  it('includeReasons=true keeps the reason', async () => {
    state.candidates = [candidate(0)];
    const out = JSON.parse(await tool().handler({ deviceId: DEVICE_ID, action: 'preview', includeReasons: true }, auth())) as Record<string, any>;
    expect(out.candidates[0].reason).toMatch(/Temporary file/);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });
});
