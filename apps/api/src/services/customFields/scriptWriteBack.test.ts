import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectDefinitions = vi.fn();
const selectDevice = vi.fn();
const persistValues = vi.fn();
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
  // #3257 W05: the writer is now `persistDeviceCustomFieldValues`, which
  // upserts into `device_custom_field_values` and returns the field keys
  // that actually changed — not a boolean "matched a row" flag.
  persistDeviceCustomFieldValues: (...args: unknown[]) => persistValues(...args),
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
  persistValues.mockResolvedValue([]);
});

describe('applyScriptCustomFieldWrites', () => {
  it('returns null and touches no table when there is no marker', async () => {
    const out = await applyScriptCustomFieldWrites(input('plain output'));
    expect(out).toBeNull();
    expect(selectDevice).not.toHaveBeenCalled();
    expect(selectDefinitions).not.toHaveBeenCalled();
    expect(persistValues).not.toHaveBeenCalled();
  });

  it('applies a value for a script-writable field and calls the writer with the resolved write', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-ram-slot-type', fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"ram_slot_type":"DDR5-5600"}')));
    expect(out).toEqual({ applied: ['ram_slot_type'], rejected: [] });
    expect(persistValues).toHaveBeenCalledWith(
      DEVICE.id,
      DEVICE.orgId,
      [{ definitionId: 'def-ram-slot-type', fieldKey: 'ram_slot_type', type: 'text', value: 'DDR5-5600' }],
      'script',
    );
  });

  it('loads definitions for the DEVICE org, never an org named by the caller', async () => {
    selectDefinitions.mockResolvedValue([]);
    await applyScriptCustomFieldWrites(input(marker('{"a":1}')));
    expect(selectDefinitions).toHaveBeenCalledWith(DEVICE.orgId);
  });

  it('rejects a field whose definition does not opt into script writes', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-asset-tag', fieldKey: 'asset_tag', type: 'text', options: null, deviceTypes: null, scriptWrite: false },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"asset_tag":"A-1"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }] });
    expect(persistValues).not.toHaveBeenCalled();
  });

  it('rejects a key with no definition', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: 'nope', reason: 'unknown_field' }] });
  });

  it('rejects a field not applicable to this device OS', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-brew-version', fieldKey: 'brew_version', type: 'text', options: null, deviceTypes: ['macos'], scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"brew_version":"4.0"}')));
    expect(out).toEqual({
      applied: [],
      rejected: [{ key: 'brew_version', reason: 'not_applicable_to_device' }],
    });
  });

  it('rejects a value that fails type validation and still applies the sibling that passes', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-slots', fieldKey: 'slots', type: 'number', options: null, deviceTypes: null, scriptWrite: true },
      { id: 'def-note', fieldKey: 'note', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"slots":"many","note":"ok"}')));
    expect(out).toEqual({ applied: ['note'], rejected: [{ key: 'slots', reason: 'invalid_type' }] });
    expect(persistValues).toHaveBeenCalledWith(
      DEVICE.id,
      DEVICE.orgId,
      [{ definitionId: 'def-note', fieldKey: 'note', type: 'text', value: 'ok' }],
      'script',
    );
  });

  // #3257 W05: the compare-before-write moved OUT of scriptWriteBack.ts and
  // INTO persistDeviceCustomFieldValues (queries.ts), as a `setWhere` on the
  // upsert so all three write paths share it. The no-op skip itself (no
  // UPDATE, no WAL, no trigger fire) is therefore no longer this unit's
  // behaviour to assert — it is covered against real Postgres by
  // deviceCustomFieldValues.integration.test.ts's "is a no-op when the stored
  // value already equals the incoming one". This test only pins that
  // scriptWriteBack still resolves the write and still calls the writer +
  // audits, even for a value that (unknown to this layer) may turn out to be
  // unchanged.
  it('calls the writer with the resolved write for an already-current value, and still audits (no-op skip itself lives in persistDeviceCustomFieldValues)', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-existing', fieldKey: 'existing', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"existing":"keep"}')));
    expect(out).toEqual({ applied: ['existing'], rejected: [] });
    expect(persistValues).toHaveBeenCalledWith(
      DEVICE.id,
      DEVICE.orgId,
      [{ definitionId: 'def-existing', fieldKey: 'existing', type: 'text', value: 'keep' }],
      'script',
    );
    expect(auditCalls).toHaveLength(1);
  });

  it('clears a field when the marker sends null', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-existing', fieldKey: 'existing', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"existing":null}')));
    expect(out).toEqual({ applied: ['existing'], rejected: [] });
    expect(persistValues).toHaveBeenCalledWith(
      DEVICE.id,
      DEVICE.orgId,
      [{ definitionId: 'def-existing', fieldKey: 'existing', type: 'text', value: null }],
      'script',
    );
  });

  it('carries marker parse failures into the rejected list', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(input(marker('{"a":')));
    expect(out?.rejected).toEqual([{ key: '(marker)', reason: 'marker_unparseable' }]);
  });

  it('audits keys only, never values, with actorType agent', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-ram-slot-type', fieldKey: 'ram_slot_type', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
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
      { id: 'def-ok', fieldKey: 'ok', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(
      input(`${marker('{"ok":"v"}')}\n${marker('{"secret_soup":')}`),
    );
    expect(auditCalls).toHaveLength(1);
    expect(JSON.stringify(auditCalls[0])).not.toContain('secret_soup');
  });

  it('reports device_not_found and writes no audit when the device row is invisible', async () => {
    // RLS refused the SELECT, or the device was deleted concurrently.
    selectDevice.mockResolvedValue(null);
    const out = await applyScriptCustomFieldWrites(input(marker('{"a":1}')));
    expect(out).toEqual({ applied: [], rejected: [{ key: '(device)', reason: 'device_not_found' }] });
    expect(selectDefinitions).not.toHaveBeenCalled();
    expect(persistValues).not.toHaveBeenCalled();
    expect(auditCalls).toHaveLength(0);
  });

  // DELETED: "reports device_not_found and writes no audit when the UPDATE
  // matches no row". That path no longer exists — persistDeviceCustomFieldValues
  // has no boolean "matched no row" return (it returns the field keys that
  // actually changed, and a same-value write legitimately returns []), so
  // scriptWriteBack.ts has nothing left to interpret as "the device vanished
  // between the read and the write" and no longer reverts `applied` on that
  // basis. The remaining device_not_found coverage above (loadDeviceForWriteBack
  // returning null) is the only device_not_found path left.

  it('carries an unsupported-envelope failure into the rejected list', async () => {
    selectDefinitions.mockResolvedValue([]);
    const out = await applyScriptCustomFieldWrites(
      input(undefined, { customFieldWrites: { schemaVersion: 2, fields: { a: 1 } } }),
    );
    expect(out?.rejected).toEqual([{ key: '(marker)', reason: 'envelope_unsupported_version' }]);
  });

  it('does not audit when nothing was applied', async () => {
    selectDefinitions.mockResolvedValue([]);
    await applyScriptCustomFieldWrites(input(marker('{"nope":"x"}')));
    expect(auditCalls).toHaveLength(0);
  });

  it('reports failure in the audit result when some keys were rejected', async () => {
    selectDefinitions.mockResolvedValue([
      { id: 'def-ok', fieldKey: 'ok', type: 'text', options: null, deviceTypes: null, scriptWrite: true },
    ]);
    await applyScriptCustomFieldWrites(input(marker('{"ok":"v","nope":"x"}')));
    expect((auditCalls[0] as Record<string, any>).result).toBe('failure');
  });
});
