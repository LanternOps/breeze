import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectDefinitions = vi.fn();
const selectDevice = vi.fn();
const updateDevice = vi.fn();
const auditCalls: unknown[] = [];

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  // Real signature is (fn, label?) — NOT (ctx, fn).
  withSystemDbAccessContext: (fn: () => unknown, _label?: string) => fn(),
}));

vi.mock('./queries', () => ({
  loadDeviceForWriteBack: (...args: unknown[]) => selectDevice(...args),
  loadScriptWritableDefinitions: (...args: unknown[]) => selectDefinitions(...args),
  persistDeviceCustomFields: (...args: unknown[]) => updateDevice(...args),
}));

vi.mock('../auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
  writeAuditEventAsync: async (_c: unknown, event: unknown) => {
    auditCalls.push(event);
  },
}));

import { applyScriptCustomFieldWrites } from './scriptWriteBack';

const DEVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  osType: 'windows',
  hostname: 'WS-01',
  displayName: null,
  customFields: { existing: 'keep' },
};

const marker = (json: string) => `::breeze:custom-fields:: ${json}`;

const input = (stdout: string | undefined, resultEnvelope: unknown = undefined) => ({
  deviceId: DEVICE.id,
  agentId: '33333333-3333-4333-8333-333333333333',
  commandId: '44444444-4444-4444-8444-444444444444',
  stdout,
  resultEnvelope,
});

beforeEach(() => {
  vi.clearAllMocks();
  auditCalls.length = 0;
  selectDevice.mockResolvedValue(DEVICE);
  updateDevice.mockResolvedValue(true);
});

describe('applyScriptCustomFieldWrites', () => {
  it('returns null and touches no table when there is no marker', async () => {
    const out = await applyScriptCustomFieldWrites(input('plain output'));
    expect(out).toBeNull();
    expect(selectDevice).not.toHaveBeenCalled();
    expect(selectDefinitions).not.toHaveBeenCalled();
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('applies a value for a script-writable field and merges with existing values', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"ram_slot_type":"DDR5-5600"}')));
    expect(out).toEqual({ applied: ['ram_slot_type'], rejected: [] });
    expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, {
      existing: 'keep',
      ram_slot_type: 'DDR5-5600',
    });
  });

  it('loads definitions for the DEVICE org, never an org named by the caller', async () => {
    selectDefinitions.mockResolvedValue([]);
    await applyScriptCustomFieldWrites(input(marker('{"a":1}')));
    expect(selectDefinitions).toHaveBeenCalledWith(DEVICE.orgId);
  });

  it('rejects a field whose definition does not opt into script writes', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'asset_tag', type: 'text', options: null, deviceTypes: null, scriptWrite: false },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"asset_tag":"A-1"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }] });
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('rejects a key with no definition', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'nope', reason: 'unknown_field' }] });
  });

  it('rejects a field not applicable to this device OS', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'brew_version', type: 'text', options: null, deviceTypes: ['macos'], scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"brew_version":"4.0"}')));
    expect(out).toEqual({
      applied: [],
      rejected: [{ key: 'brew_version', reason: 'not_applicable_to_device' }],
    });
  });

  it('rejects a value that fails type validation and still applies the sibling that passes', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'slots', type: 'number', options: null, deviceTypes: null, scriptWrite: true },
      { fieldKey: 'note', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"slots":"many","note":"ok"}')));
    expect(out).toEqual({ applied: ['note'], rejected: [{ key: 'slots', reason: 'invalid_type' }] });
    expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, { existing: 'keep', note: 'ok' });
  });

  it('skips the UPDATE when the merged object is unchanged', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'existing', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"existing":"keep"}')));
    expect(out).toEqual({ applied: ['existing'], rejected: [] });
    expect(updateDevice).not.toHaveBeenCalled();
  });

  it('clears a field when the marker sends null', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'existing', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"existing":null}')));
    expect(out).toEqual({ applied: ['existing'], rejected: [] });
    expect(updateDevice).toHaveBeenCalledWith(DEVICE.id, DEVICE.orgId, { existing: null });
  });

  it('carries marker parse failures into the rejected list', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"a":')));
    expect(out?.rejected).toEqual([{ key: '(marker)', reason: 'marker_unparseable' }]);
  });

  it('audits keys only, never values, with actorType agent', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(input(marker('{"ram_slot_type":"DDR5-5600"}')));
    expect(auditCalls).toHaveLength(1);
    const event = auditCalls[0] as Record<string, any>;
    expect(event.actorType).toBe('agent');
    expect(event.action).toBe('device.custom_field.update');
    expect(event.resourceId).toBe(DEVICE.id);
    expect(event.orgId).toBe(DEVICE.orgId);
    expect(event.details.changedFields).toEqual(['ram_slot_type']);
    expect(JSON.stringify(event)).not.toContain('DDR5-5600');
  });

  it('never puts a rejected marker sample (raw script output) into the audit', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ok', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(
      input(`${marker('{"ok":"v"}')}\n${marker('{"secret_soup":')}`),
    );
    expect(auditCalls).toHaveLength(1);
    expect(JSON.stringify(auditCalls[0])).not.toContain('secret_soup');
  });

  it('does not audit when nothing was applied', async () => {
    selectDefinitions.mockResolvedValue([]);
    await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(auditCalls).toHaveLength(0);
  });

  it('reports failure in the audit result when some keys were rejected', async () => {
    selectDefinitions.mockResolvedValue([
      { fieldKey: 'ok', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(input(marker('{"ok":"v","nope":"x"}')));
    expect((auditCalls[0] as Record<string, any>).result).toBe('failure');
  });
});
