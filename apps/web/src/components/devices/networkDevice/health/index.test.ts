import { describe, expect, it } from 'vitest';
import { EmptyHealth, GenericHealth, PrinterHealth, resolveHealthCard } from './index';
import type { Collection } from '../types';

const collection: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: '2026-09-16T10:00:00.000Z',
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [],
};

describe('resolveHealthCard', () => {
  it('returns EmptyHealth when no SNMP device exists', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection: null, snmpEnabled: false })).toBe(EmptyHealth);
    expect(resolveHealthCard({ assetType: 'switch', collection: null, snmpEnabled: true })).toBe(EmptyHealth);
  });

  it('returns EmptyHealth when SNMP is configured but switched off', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection, snmpEnabled: false })).toBe(EmptyHealth);
  });

  it('dispatches printers to PrinterHealth', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection, snmpEnabled: true })).toBe(PrinterHealth);
  });

  it('falls back to GenericHealth for every other type', () => {
    for (const type of ['switch', 'router', 'firewall', 'nas', 'iot', 'camera', 'phone', 'server', 'workstation', 'access_point', 'website', 'service', 'unknown'] as const) {
      expect(resolveHealthCard({ assetType: type, collection, snmpEnabled: true })).toBe(GenericHealth);
    }
  });

  it('keeps the type card (not EmptyHealth) when SNMP is on but the template is missing', () => {
    const noTemplate: Collection = { ...collection, templateId: null, status: 'no_template' };
    expect(resolveHealthCard({ assetType: 'printer', collection: noTemplate, snmpEnabled: true })).toBe(PrinterHealth);
    expect(resolveHealthCard({ assetType: 'switch', collection: noTemplate, snmpEnabled: true })).toBe(GenericHealth);
  });
});
