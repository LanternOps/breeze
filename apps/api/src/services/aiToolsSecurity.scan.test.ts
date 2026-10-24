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
vi.mock('./aiToolDbContext', () => ({ inToolDbPhase: vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn()) }));
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
import { inToolDbPhase } from './aiToolDbContext';
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
    vi.mocked(startDeviceScan).mockResolvedValue({
      ok: true,
      scan: { id: 'scan-1', deviceId: DEVICE, deviceName: 'WS-01', orgId: 'org-1', scanType: 'quick', status: 'queued', startedAt: '2026-10-24T00:00:00.000Z' },
    });
    const out = JSON.parse(await tool().handler({ action: 'scan', deviceId: DEVICE }, auth));
    expect(out).toEqual({ scanId: 'scan-1', status: 'queued', deviceName: 'WS-01', scanType: 'quick' });
    expect(startDeviceScan).toHaveBeenCalledWith(auth, { deviceId: DEVICE, scanType: 'quick', mfaSatisfied: false, aiOrigin });
    // In the caller's DB context (joined when held, opened when not), never a raw command.
    expect(inToolDbPhase).toHaveBeenCalled();
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('surfaces a remote-tools policy deny (403) and creates nothing else', async () => {
    vi.mocked(startDeviceScan).mockResolvedValue({ ok: false, status: 403, error: 'AI remote tools policy denies security_scan on this device' });
    const out = JSON.parse(await tool().handler({ action: 'scan', deviceId: DEVICE }, auth));
    expect(out).toEqual({ error: 'AI remote tools policy denies security_scan on this device', status: 403 });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('is no longer a self-managed (device-waiting) action; the others still are', () => {
    expect(tool().selfManagedDbContext).toEqual(['status', 'quarantine', 'remove', 'restore']);
  });

  it('status still dispatches through aiExecuteCommand', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed' } as never);
    await tool().handler({ action: 'status', deviceId: DEVICE }, auth);
    expect(aiExecuteCommand).toHaveBeenCalledWith(auth, 'security_scan', DEVICE, 'security_collect_status', { threatId: undefined }, expect.anything());
    expect(startDeviceScan).not.toHaveBeenCalled();
  });
});
