import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), add: vi.fn(), update: vi.fn(), manage: vi.fn() }));
vi.mock('../monitors/monitorService', () => ({ createMonitorDefinition: mocks.create }));
vi.mock('../configurationPolicy', () => ({
  listFeatureLinks: mocks.list, addFeatureLink: mocks.add,
  updateFeatureLink: mocks.update, policyAccessCondition: () => undefined,
}));
vi.mock('../partnerWideAccess', () => ({ canManagePartnerWidePolicies: mocks.manage }));

import { attachFleetMonitors, ruleMonitorInput, snapshotFleetMonitors, watchMonitorInput } from './monitorAttachments';
import type { AuthContext } from '../../middleware/auth';
import type { db } from '../../db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const MONITOR = '33333333-3333-4333-8333-333333333333';
const MONITOR_2 = '44444444-4444-4444-8444-444444444444';
const EXISTING = '55555555-5555-4555-8555-555555555555';
const definition = { name: 'CPU', kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high' };
const executor = (owner: { orgId: string | null; partnerId: string | null }) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'policy', ...owner }] }) }) }),
}) as unknown as Tx;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.manage.mockReturnValue(true);
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: MONITOR });
  mocks.add.mockResolvedValue({ id: 'link' });
  mocks.update.mockResolvedValue({ id: 'link' });
});

describe('Fleet Design monitor attachments', () => {
  it('creates through the service on the policy axis and passes the savepoint everywhere', async () => {
    const tx = executor({ orgId: ORG, partnerId: null });
    const auth = { partnerId: PARTNER } as AuthContext;
    const ids = await attachFleetMonitors('policy', [{ itemRef: 'monitoring:file_server:rule:0', definition }], auth, tx);
    expect(ids).toEqual({ 'monitoring:file_server:rule:0': MONITOR });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'organization', orgId: ORG }), auth, {}, tx);
    expect(mocks.list).toHaveBeenCalledWith('policy', tx);
    expect(mocks.add).toHaveBeenCalledWith('policy', 'monitors', null,
      expect.objectContaining({ inheritance: 'cumulative', items: [{ monitorId: MONITOR, enabled: true, sortOrder: 0 }] }), undefined, tx);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('appends to an existing monitors link, keeping its items and replace inheritance', async () => {
    mocks.list.mockResolvedValue([{ id: 'existing-link', featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { inheritance: 'replace', items: [{ monitorId: EXISTING, enabled: false, sortOrder: 0 }] } }]);
    mocks.create.mockResolvedValueOnce({ id: MONITOR }).mockResolvedValueOnce({ id: MONITOR_2 });
    const tx = executor({ orgId: ORG, partnerId: null });
    await attachFleetMonitors('policy', [
      { itemRef: 'a', definition }, { itemRef: 'b', definition },
    ], {} as AuthContext, tx);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith('existing-link', { inlineSettings: {
      inheritance: 'replace',
      items: [
        { monitorId: EXISTING, enabled: false, sortOrder: 0 },
        { monitorId: MONITOR, enabled: true, sortOrder: 1 },
        { monitorId: MONITOR_2, enabled: true, sortOrder: 2 },
      ],
    } }, 'policy', undefined, tx);
  });

  it('writes partner-owned monitors for a partner-wide policy when the caller may', async () => {
    const auth = { partnerId: PARTNER } as AuthContext;
    await attachFleetMonitors('policy', [{ itemRef: 'x', definition }], auth, executor({ orgId: null, partnerId: PARTNER }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'partner' }), auth, {}, expect.anything());
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('orgId');
  });

  it('refuses partner writes without capability before creating a definition', async () => {
    mocks.manage.mockReturnValue(false);
    await expect(attachFleetMonitors('policy', [{ itemRef: 'x', definition }], { partnerId: PARTNER } as AuthContext,
      executor({ orgId: null, partnerId: PARTNER }))).rejects.toThrow('partner_wide_write_denied');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses a partner-wide policy of another partner', async () => {
    await expect(attachFleetMonitors('policy', [{ itemRef: 'x', definition }], { partnerId: PARTNER } as AuthContext,
      executor({ orgId: null, partnerId: '66666666-6666-4666-8666-666666666666' }))).rejects.toThrow('partner_axis_mismatch');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not create for an invisible policy', async () => {
    const tx = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Tx;
    await expect(attachFleetMonitors('missing', [{ itemRef: 'x', definition }], {} as AuthContext, tx)).rejects.toThrow('policy_missing');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('writes nothing for an empty proposal list', async () => {
    expect(await attachFleetMonitors('policy', [], {} as AuthContext, executor({ orgId: ORG, partnerId: null }))).toEqual({});
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid definition before any write', async () => {
    await expect(attachFleetMonitors('policy', [{ itemRef: 'x', definition: { ...definition, kind: 'service' } }],
      {} as AuthContext, executor({ orgId: ORG, partnerId: null }))).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('maps restart intent to the W05c1 agent-local response', () => {
    expect(watchMonitorInput({ watchType: 'service', name: 'Spooler', alertOnStop: false, autoRestart: true, rationale: 'Print queue' }))
      .toMatchObject({ kind: 'service', condition: { serviceName: 'Spooler' },
        responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300, whenOffline: 'queue' }] });
    expect(watchMonitorInput({ watchType: 'process', name: 'app.exe', alertOnStop: true, autoRestart: false, rationale: 'r' }))
      .toMatchObject({ kind: 'process', condition: { processName: 'app.exe' }, responses: [] });
  });

  it('maps a rule proposal onto the monitor-definition input', () => {
    expect(ruleMonitorInput({
      name: 'Disk', kind: 'disk', condition: { operator: 'gt', value: 85 }, severity: 'high', cooldownMinutes: 30,
      responses: [], deliveryMode: 'inherit', deliveryChannelIds: [], rationale: 'r', action: 'none', paging: 'none',
    }, 'why')).toEqual({
      name: 'Disk', kind: 'disk', condition: { operator: 'gt', value: 85 }, severity: 'high', cooldownMinutes: 30,
      responses: [], deliveryMode: 'inherit', deliveryChannelIds: [], description: 'why',
    });
  });
});

describe('snapshotFleetMonitors', () => {
  it('keeps author fields only, so recompiles do not read as edits', async () => {
    const row = { id: MONITOR, name: 'CPU', condition: { value: 80 }, compiledHash: 'h1', updatedAt: new Date(), enabled: true };
    const exec = { select: () => ({ from: () => ({ where: async () => [row] }) }) } as unknown as Tx;
    const snap = await snapshotFleetMonitors([MONITOR], exec);
    expect(snap[MONITOR]).toMatchObject({ name: 'CPU', condition: { value: 80 }, enabled: true });
    expect(snap[MONITOR]).not.toHaveProperty('compiledHash');
    expect(snap[MONITOR]).not.toHaveProperty('updatedAt');
  });
  it('returns an empty map without querying for no ids', async () => {
    const exec = { select: vi.fn() } as unknown as Tx;
    expect(await snapshotFleetMonitors([], exec)).toEqual({});
    expect((exec as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});
