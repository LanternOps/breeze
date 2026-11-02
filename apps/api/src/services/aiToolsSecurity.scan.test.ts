/**
 * #6268 (W05-11): the AI `security_scan scan` action starts the scan through
 * the shared `startDeviceScan` (the "Scan now" route's service) instead of
 * dispatching a raw command and waiting on the agent. The other device actions
 * stay on aiExecuteCommand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: vi.fn(async () => ({ device: { id: 'dev-1' } })) }));
const phase = vi.hoisted(() => ({ open: false }));
vi.mock('./aiToolDbContext', () => ({
  inToolDbPhase: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    phase.open = true;
    try {
      return await fn();
    } finally {
      phase.open = false;
    }
  }),
}));
vi.mock('./securityPosture', () => ({
  getLatestSecurityPostureForDevice: vi.fn(),
  listLatestSecurityPosture: vi.fn(),
  getSecurityPostureCounts: vi.fn(),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
  aiQueueCommand: vi.fn(),
  requireAiOrigin: (a: { aiOrigin?: unknown }) => {
    if (!a.aiOrigin) throw new Error('no aiOrigin');
    return a.aiOrigin;
  },
}));
vi.mock('./sensitiveDataKeys', () => ({ resolveSensitiveDataKeySelection: vi.fn() }));
vi.mock('./securityScanStart', () => ({ startDeviceScan: vi.fn() }));

import { aiExecuteCommand } from './aiDispatch';
import { startDeviceScan } from './securityScanStart';
import { registerSecurityTools } from './aiToolsSecurity';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const DEVICE = '44444444-4444-4444-8444-444444444444';
const aiOrigin = { kind: 'ai_assistant', sessionId: 's-1' };
const auth = { user: { id: 'u-1' }, orgId: 'org-1', scope: 'organization', aiOrigin } as unknown as AuthContext;

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerSecurityTools(reg);
  return reg.get('security_scan')!;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('security_scan scan → startDeviceScan (#6268)', () => {
  it('creates a security_scans row through startDeviceScan with aiOrigin and returns its id', async () => {
    let calledInPhase: boolean | undefined;
    vi.mocked(startDeviceScan).mockImplementation(async () => {
      calledInPhase = phase.open;
      return {
        ok: true,
        scan: {
          id: 'scan-1', deviceId: DEVICE, deviceName: 'WS-01', orgId: 'org-1', scanType: 'quick', status: 'queued',
          startedAt: '2026-10-24T00:00:00.000Z', queueExpiresAt: '2026-10-25T00:00:00.000Z',
        },
      };
    });
    const out = JSON.parse(await tool().handler({ action: 'scan', deviceId: DEVICE }, auth));
    expect(out).toEqual({ scanId: 'scan-1', status: 'queued', deviceName: 'WS-01', scanType: 'quick' });
    expect(startDeviceScan).toHaveBeenCalledWith(auth, { deviceId: DEVICE, scanType: 'quick', mfaSatisfied: false, aiOrigin });
    // #10057 gap 2: startDeviceScan owns its caller-scoped transaction (the row
    // must commit before its claim job is enqueued), so the handler opens none.
    expect(calledInPhase).toBe(false);
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('surfaces a remote-tools policy deny (403) and creates nothing else', async () => {
    vi.mocked(startDeviceScan).mockResolvedValue({ ok: false, status: 403, error: 'AI remote tools policy denies security_scan on this device' });
    const out = JSON.parse(await tool().handler({ action: 'scan', deviceId: DEVICE }, auth));
    expect(out).toEqual({ error: 'AI remote tools policy denies security_scan on this device', status: 403 });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('scan is self-managed again (#10057 gap 2: the service commits its own row), without waiting on the device', () => {
    expect(tool().selfManagedDbContext).toEqual(['scan', 'status', 'quarantine', 'remove', 'restore']);
  });

  it('status still dispatches through aiExecuteCommand', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed' } as never);
    await tool().handler({ action: 'status', deviceId: DEVICE }, auth);
    expect(aiExecuteCommand).toHaveBeenCalledWith(auth, 'security_scan', DEVICE, 'security_collect_status', { threatId: undefined }, expect.anything());
    expect(startDeviceScan).not.toHaveBeenCalled();
  });
});
