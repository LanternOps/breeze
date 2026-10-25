import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_SCAN_SETTINGS_DEFAULTS, type SecurityScanSettings } from '@breeze/shared';
import { tableOf } from '../testUtils/recordingDb';

/**
 * startDeviceScan (#6263 W05-11): the single-device "Scan now" lifted out of
 * POST /security/scan/:deviceId so the route and the AI `security_scan scan`
 * action share it. Ported route cases plus the W05 additions.
 */

const h = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  queueCommand: vi.fn(),
  settings: vi.fn(),
  plan: vi.fn(),
  perms: vi.fn(),
  aiPolicy: vi.fn(),
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb } = await import('../testUtils/recordingDb');
  h.recording = createRecordingDb((op) => (op.kind === 'select' ? (h.device ? [h.device] : []) : []));
  return { db: h.recording.db };
});
vi.mock('./commandQueue', () => ({
  CommandTypes: { SECURITY_SCAN: 'security_scan' },
  queueCommand: (...a: unknown[]) => h.queueCommand(...a),
}));
vi.mock('./featureConfigResolver', () => ({ resolveSecurityScanSettingsForDevice: (...a: unknown[]) => h.settings(...a) }));
vi.mock('./yaraScanRefs', () => ({ planYaraScan: (...a: unknown[]) => h.plan(...a) }));
vi.mock('./permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./permissions')>()),
  getUserPermissions: (...a: unknown[]) => h.perms(...a),
}));
vi.mock('./aiRemoteToolsPolicy', () => ({ checkAiRemoteToolsPolicy: (...a: unknown[]) => h.aiPolicy(...a) }));

import type { AuthContext } from '../middleware/auth';
import { startDeviceScan } from './securityScanStart';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const REF = { id: '44444444-4444-4444-8444-444444444444', version: 2, sha256: 'e'.repeat(64), url: '/api/v1/agents/a/yara/rule-sets/x/2' };

const auth = {
  principal: { kind: 'user_session' },
  scope: 'organization',
  orgId: ORG_ID,
  partnerId: null,
  accessibleOrgIds: [ORG_ID],
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  canAccessOrg: () => true,
  orgCondition: () => undefined,
  token: null,
} as unknown as AuthContext;

const policy = (over: Partial<SecurityScanSettings> = {}): SecurityScanSettings => ({
  ...SECURITY_SCAN_SETTINGS_DEFAULTS,
  exclusions: ['C:\\Backups'],
  maxFileSizeMb: 64,
  scanTimeoutMinutes: 45,
  autoQuarantine: true,
  ...over,
});

const scanInserts = () => h.recording!.ops.filter((o) => o.kind === 'insert' && tableOf(o) === 'security_scans');
const insertedRow = () => (scanInserts()[0]!.chain.find(([m]) => m === 'values')![1][0]) as Record<string, unknown>;
const queued = () => h.queueCommand.mock.calls[0]!;

beforeEach(() => {
  h.recording!.ops.length = 0;
  h.device = { id: DEVICE_ID, hostname: 'test-host', orgId: ORG_ID, siteId: SITE_ID, agentVersion: '0.124.0' };
  h.queueCommand.mockReset().mockImplementation(async (_d: string, _t: string, _p: unknown, _u: string, opts: { commandId: string }) => ({
    id: opts.commandId,
    status: 'pending',
  }));
  h.settings.mockReset().mockResolvedValue(policy());
  h.plan.mockReset().mockResolvedValue({ ruleSets: [REF], engine: 'yara', ruleSetErrors: null });
  h.perms.mockReset().mockResolvedValue({ permissions: [], allowedSiteIds: undefined });
  h.aiPolicy.mockReset().mockResolvedValue({ allowed: true });
});

describe('startDeviceScan', () => {
  it('404 for a device the caller cannot see; nothing written', async () => {
    h.device = null;
    expect(await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true })).toEqual({
      ok: false, status: 404, error: 'Device not found',
    });
    expect(scanInserts()).toEqual([]);
    expect(h.queueCommand).not.toHaveBeenCalled();
  });

  it('403 outside the caller site allowlist', async () => {
    h.perms.mockResolvedValue({ permissions: [], allowedSiteIds: ['other-site'] });
    expect(await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true })).toEqual({
      ok: false, status: 403, error: 'Access to this site denied',
    });
    expect(h.queueCommand).not.toHaveBeenCalled();
  });

  it("attaches the device's resolved policy settings; with MFA keeps auto-quarantine", async () => {
    const result = await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'full', mfaSatisfied: true });
    expect(result).toMatchObject({ ok: true, scan: { deviceId: DEVICE_ID, deviceName: 'test-host', orgId: ORG_ID, scanType: 'full', status: 'queued' } });
    const [deviceId, type, payload, userId] = queued();
    expect([deviceId, type, userId]).toEqual([DEVICE_ID, 'security_scan', 'user-1']);
    expect(payload).toMatchObject({
      scanType: 'full', exclusions: ['C:\\Backups'], maxFileSizeMb: 64, timeoutMinutes: 45, autoQuarantine: true, triggerDefender: true,
    });
    expect(insertedRow().autoQuarantineSuppressedReason).toBeNull();
  });

  it('without MFA: dispatches detect-only and records manual_no_mfa', async () => {
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: false });
    expect(queued()[2]).toMatchObject({ autoQuarantine: false });
    expect(insertedRow().autoQuarantineSuppressedReason).toBe('manual_no_mfa');
  });

  it('omits the settings keys entirely when no policy governs the device', async () => {
    h.settings.mockResolvedValue(null);
    h.plan.mockResolvedValue({ ruleSets: [], engine: 'legacy', ruleSetErrors: null });
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'custom', paths: ['/srv'], mfaSatisfied: true });
    expect(queued()[2]).toEqual({ scanRecordId: insertedRow().id, scanType: 'custom', paths: ['/srv'], triggerDefender: true });
  });

  it('sends the resolved refs and records engine + errors on the scan row', async () => {
    const errors = [{ id: 'x', code: 'disabled' }];
    h.plan.mockResolvedValue({ ruleSets: [REF], engine: 'yara', ruleSetErrors: errors });
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(h.plan).toHaveBeenCalledWith({ deviceId: DEVICE_ID, agentVersion: '0.124.0', ruleSetIds: [] });
    expect(queued()[2]).toMatchObject({ ruleSets: [REF] });
    expect(insertedRow()).toMatchObject({ engine: 'yara', ruleSetErrors: errors, status: 'queued', initiatedBy: 'user-1' });
  });

  it('dispatched_rule_sets and command_id stamped', async () => {
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    const row = insertedRow();
    expect(row.dispatchedRuleSets).toEqual([{ id: REF.id, version: 2, sha256: REF.sha256 }]);
    expect(row.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queued()[4]).toMatchObject({ commandId: row.commandId });
    // The scan row exists before the command row can answer for it.
    const insertIdx = h.recording!.ops.indexOf(scanInserts()[0]!);
    expect(insertIdx).toBeGreaterThan(-1);
  });

  it('a legacy scan records no dispatched refs', async () => {
    h.plan.mockResolvedValue({ ruleSets: [], engine: 'legacy', ruleSetErrors: null });
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(insertedRow().dispatchedRuleSets).toBeNull();
  });

  it('aiOrigin → remote-tools policy checked and aiOrigin on the command', async () => {
    const aiOrigin = { kind: 'chat', sessionId: 's-1' } as never;
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: false, aiOrigin });
    expect(h.aiPolicy).toHaveBeenCalledWith(DEVICE_ID, 'security_scan');
    expect(queued()[4]).toMatchObject({ aiOrigin });
  });

  it('aiOrigin and policy deny → 403, no row', async () => {
    h.aiPolicy.mockResolvedValue({ allowed: false, reason: 'disabled', error: 'REMOTE_TOOLS_DISABLED_BY_POLICY: disabled' });
    const result = await startDeviceScan(auth, {
      deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: false, aiOrigin: { kind: 'chat', sessionId: 's-1' } as never,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'REMOTE_TOOLS_DISABLED_BY_POLICY: disabled' });
    expect(scanInserts()).toEqual([]);
    expect(h.queueCommand).not.toHaveBeenCalled();
  });

  it('a human scan never consults the AI policy', async () => {
    await startDeviceScan(auth, { deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(h.aiPolicy).not.toHaveBeenCalled();
  });
});

