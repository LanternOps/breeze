import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({
  snmpTemplates: {
    id: 'snmpTemplates.id',
    orgId: 'snmpTemplates.orgId',
    name: 'snmpTemplates.name',
    vendor: 'snmpTemplates.vendor',
    deviceType: 'snmpTemplates.deviceType',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    sysObjectIdPrefixes: 'snmpTemplates.sysObjectIdPrefixes',
  },
}));

import { db } from '../db';
import { normalizeOid, oidHasPrefix, suggestTemplate } from './snmpTemplateSuggest';

const ORG = '11111111-1111-1111-1111-111111111111';

type Row = {
  id: string; name: string; vendor: string | null; deviceType: string | null;
  isBuiltIn: boolean; prefixes: string[];
};

function mockTemplates(rows: Row[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

const XEROX: Row = { id: 'tpl-xerox', name: 'Xerox Printer', vendor: 'Xerox', deviceType: 'printer', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.253'] };
const GENERIC: Row = { id: 'tpl-generic', name: 'Generic Printer (RFC 3805)', vendor: null, deviceType: 'printer', isBuiltIn: true, prefixes: [] };
const CISCO_SW: Row = { id: 'tpl-sw', name: 'Cisco IOS Switch', vendor: 'Cisco', deviceType: 'switch', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const CISCO_RTR: Row = { id: 'tpl-rtr', name: 'Cisco IOS Router', vendor: 'Cisco', deviceType: 'router', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const CISCO_ASA: Row = { id: 'tpl-asa', name: 'Cisco ASA Firewall', vendor: 'Cisco', deviceType: 'firewall', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.9'] };
const MERAKI: Row = { id: 'tpl-meraki', name: 'Cisco Meraki', vendor: 'Meraki', deviceType: 'unknown', isBuiltIn: true, prefixes: ['1.3.6.1.4.1.29671'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
});

describe('normalizeOid', () => {
  it('strips dots and leading zeros', () => {
    expect(normalizeOid('.1.3.6.1.4.1.0253.')).toEqual(['1', '3', '6', '1', '4', '1', '253']);
  });
  it.each(['', '   ', '1.3.x.1', null, undefined])('rejects %s', (v) => {
    expect(normalizeOid(v as string | null | undefined)).toBeNull();
  });
});

describe('oidHasPrefix — component boundaries (spec §15)', () => {
  const xeroxOid = normalizeOid('.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1')!;

  it('1.3.6.1.4.1.25 must NOT match a 1.3.6.1.4.1.253 device', () => {
    expect(oidHasPrefix(xeroxOid, '1.3.6.1.4.1.25')).toBe(0);
  });
  it('1.3.6.1.4.1.253 matches and reports 7 components', () => {
    expect(oidHasPrefix(xeroxOid, '1.3.6.1.4.1.253')).toBe(7);
  });
  it('a prefix longer than the OID never matches', () => {
    expect(oidHasPrefix(normalizeOid('1.3.6.1.4.1.253')!, '1.3.6.1.4.1.253.8')).toBe(0);
  });
  it('an empty or malformed prefix never matches', () => {
    expect(oidHasPrefix(xeroxOid, '')).toBe(0);
    expect(oidHasPrefix(xeroxOid, 'nope')).toBe(0);
  });
});

describe('suggestTemplate', () => {
  it('suggests the Xerox template for a Xerox sysObjectID', async () => {
    mockTemplates([XEROX, GENERIC, CISCO_SW]);
    const result = await suggestTemplate({ sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', assetType: 'printer', orgId: ORG });
    expect(result).toEqual({
      templateId: 'tpl-xerox',
      templateName: 'Xerox Printer',
      reason: 'Detected Xerox printer, using Xerox Printer',
    });
  });

  it('does not match a 25-prefixed template against a 253 device', async () => {
    mockTemplates([{ ...XEROX, id: 'tpl-25', name: 'Bogus 25', prefixes: ['1.3.6.1.4.1.25'] }]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });

  it('breaks a prefix tie by device_type before prefix length', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516', assetType: 'switch', orgId: ORG });
    expect(result?.templateId).toBe('tpl-sw');
  });

  it('prefers the longer prefix when no device_type matches', async () => {
    mockTemplates([
      { ...CISCO_SW, id: 'tpl-broad', name: 'Broad', deviceType: 'switch', prefixes: ['1.3.6.1.4.1.9'] },
      { ...CISCO_SW, id: 'tpl-narrow', name: 'Narrow', deviceType: 'router', prefixes: ['1.3.6.1.4.1.9.1.516'] },
    ]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516.2', assetType: 'printer', orgId: ORG });
    expect(result?.templateId).toBe('tpl-narrow');
  });

  it('prefers the org\'s own template over an equally-ranked built-in', async () => {
    mockTemplates([XEROX, { ...XEROX, id: 'tpl-org', name: 'House Xerox', isBuiltIn: false }]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG });
    expect(result?.templateId).toBe('tpl-org');
  });

  it('returns null rather than guessing when candidates tie on every key', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA]);
    // assetType null: no device_type match, equal prefixes, all built-in.
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.9.1.516', assetType: null, orgId: ORG })).toBeNull();
  });

  it('still resolves an unambiguous vendor when the asset type is unknown', async () => {
    mockTemplates([CISCO_SW, CISCO_RTR, CISCO_ASA, MERAKI]);
    const result = await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.29671.1.1', assetType: null, orgId: ORG });
    expect(result?.templateId).toBe('tpl-meraki');
  });

  it('returns null without querying when there is no sysObjectID', async () => {
    expect(await suggestTemplate({ sysObjectId: null, assetType: 'printer', orgId: ORG })).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null when nothing has a prefix at all', async () => {
    mockTemplates([GENERIC]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });

  it('tolerates a row whose prefixes column is not an array', async () => {
    mockTemplates([{ ...GENERIC, prefixes: null as unknown as string[] }]);
    expect(await suggestTemplate({ sysObjectId: '1.3.6.1.4.1.253.1', assetType: 'printer', orgId: ORG })).toBeNull();
  });
});
