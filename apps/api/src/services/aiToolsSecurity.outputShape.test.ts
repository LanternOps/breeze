// A-W05 Task 5a: get_security_posture offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));

const postureMock = vi.hoisted(() => ({ listLatestSecurityPosture: vi.fn(), getLatestSecurityPostureForDevice: vi.fn() }));
vi.mock('./securityPosture', () => postureMock);

import { aiTools } from './aiToolNames';
import './aiTools';

const POSTURE_ROW = {
  orgId: 'id', deviceId: 'id', deviceName: 'medium', osType: 'short', deviceStatus: 'short',
  capturedAt: 'ts', overallScore: 'num', riskLevel: 'short',
} as const;
function postureFixture(i: number) {
  return {
    ...fixtureRow(i, POSTURE_ROW),
    factors: {
      antivirus: { score: 90, confidence: 1 }, encryption: { score: 90, confidence: 1 },
      firewall: { score: 90, confidence: 1 }, open_ports: { score: 90, confidence: 1 },
      password_policy: { score: 90, confidence: 1 }, os_currency: { score: 90, confidence: 1 },
      admin_exposure: { score: 90, confidence: 1 },
    },
    recommendations: [{ id: `rec-${i}`, text: 'x'.repeat(48) }],
  };
}
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  canAccessOrg: () => true, user: { id: 'u1' },
}) as never;

describe('get_security_posture output shape (A-W05)', () => {
  const tool = aiTools.get('get_security_posture')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 5, max 500)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    postureMock.listLatestSecurityPosture.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => postureFixture(i)),
    );
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['summary', 'worstDevices', 'devices', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(5);
    expect(out.offset).toBe(0);
    expectDefaultPageFits('get_security_posture', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    postureMock.listLatestSecurityPosture.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => postureFixture(i)),
    );
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ riskLevel: 'high', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
