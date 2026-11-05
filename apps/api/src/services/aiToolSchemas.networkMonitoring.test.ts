import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { networkMonitoringToolShapes } from './aiToolSchemasNetworkMonitoring';
import { toolActionEnum } from './aiToolActions';

// W09 (#6779): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W09_TOOLS = Object.keys(networkMonitoringToolShapes);
const MULTIPLEXED = ['manage_snmp_templates', 'get_snmp_metrics', 'manage_known_guests', 'get_unifi_status'];
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;

describe('W09 network monitoring tool input schemas', () => {
  it('covers exactly the six new W09 tools (devices + thresholds routes are 410, so no tools)', () => {
    expect([...W09_TOOLS].sort()).toEqual([
      'get_snmp_metrics', 'get_unifi_status', 'manage_known_guests', 'manage_snmp_templates',
      'probe_network_asset', 'trigger_unifi_sync',
    ]);
    expect(aiTools.has('manage_snmp_devices')).toBe(false);
    expect(aiTools.has('manage_snmp_thresholds')).toBe(false);
  });

  it.each(W09_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W09_TOOLS.filter((n) => n !== 'trigger_unifi_sync'))('%s: every registry-required key is required by Zod too', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it.each(MULTIPLEXED)('%s: action enum agrees with the registry', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: { action: { enum: string[] } } };
    expect([...schema.properties.action.enum].sort()).toEqual([...(toolActionEnum(name) ?? [])].sort());
  });

  it('domains and registry tiers', () => {
    for (const name of W09_TOOLS) expect(aiTools.get(name)!.domain, name).toBe('network');
    expect(aiTools.get('probe_network_asset')!.tier).toBe(2);
    expect(aiTools.get('trigger_unifi_sync')!.tier).toBe(2);
    for (const name of MULTIPLEXED) expect(aiTools.get(name)!.tier, name).toBe(1);
  });

  it('no tool names a device, so none can move one between sites (topology rule)', () => {
    for (const name of W09_TOOLS) {
      expect(aiTools.get(name)!.deviceArgs ?? [], name).toEqual([]);
      for (const key of Object.keys(shapeOf(name))) {
        expect(key, `${name}.${key}`).not.toMatch(/^(deviceId|newSiteId|targetSiteId|moveToSite|destinationSiteId)$/);
      }
    }
  });

  it.each(W09_TOOLS)('%s rejects an unknown key (strict)', (name) => {
    const base = name === 'probe_network_asset' ? { assetId: UUID }
      : name === 'trigger_unifi_sync' ? {}
        : { action: name === 'manage_snmp_templates' ? 'list' : name === 'get_snmp_metrics' ? 'dashboard' : name === 'manage_known_guests' ? 'list' : 'status' };
    expect(validateToolInput(name, base).success).toBe(true);
    expect(validateToolInput(name, { ...base, surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('manage_snmp_templates', { action: 'create', name: 'Edge', oids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'slow' }] }).success).toBe(true);
    expect(validateToolInput('manage_snmp_templates', { action: 'validate_oids', oids: [{ oid: '1.3.6.1.2.1.1.3.0' }] }).success).toBe(true);
    expect(validateToolInput('get_snmp_metrics', { action: 'history', assetId: UUID, oid: '1.3.6.1.2.1.2.2.1.10', bucket: '5m', delta: true }).success).toBe(true);
    expect(validateToolInput('manage_known_guests', { action: 'add', macAddress: 'aa:bb:cc:dd:ee:ff', label: 'Lobby kiosk' }).success).toBe(true);
    expect(validateToolInput('get_unifi_status', { action: 'telemetry', siteId: UUID }).success).toBe(true);
    expect(validateToolInput('trigger_unifi_sync', { partnerId: UUID }).success).toBe(true);
  });

  it('rejects malformed ids, out-of-range numbers and unknown enum values', () => {
    expect(validateToolInput('probe_network_asset', { assetId: 'nope' }).success).toBe(false);
    expect(validateToolInput('probe_network_asset', {}).success).toBe(false);
    expect(validateToolInput('manage_snmp_templates', { action: 'purge' }).success).toBe(false);
    expect(validateToolInput('manage_snmp_templates', { action: 'browse_oids', limit: 101 }).success).toBe(false);
    expect(validateToolInput('manage_snmp_templates', { action: 'create', oids: [] }).success).toBe(false);
    expect(validateToolInput('get_snmp_metrics', { action: 'history', bucket: '2h' }).success).toBe(false);
    expect(validateToolInput('get_unifi_status', { action: 'connect' }).success).toBe(false); // connect/disconnect/mappings writes stay unbuilt
    expect(validateToolInput('manage_known_guests', { action: 'add', guestId: 'x' }).success).toBe(false);
  });
});
