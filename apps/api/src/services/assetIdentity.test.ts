import { describe, expect, it } from 'vitest';
import { maskOidShapedModel, nicVendorFromMac } from './assetIdentity';

describe('maskOidShapedModel', () => {
  it.each([
    ['.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.9.1.1745'],
    ['1.2'],
  ])('masks the raw sysObjectID %s', (model) => {
    expect(maskOidShapedModel(model)).toBeNull();
  });

  it.each([
    ['Xerox C325 Color MFP'],
    ['C3750'],
    // A real model number that merely contains digits and dots must survive.
    ['HL-L2350DW'],
    ['UAP-AC-PRO'],
    ['ET-2.5G'],
    // Only OIDs rooted at 1 (iso) are masked; a version-looking string is not.
    ['2.4.1'],
    ['1'],
  ])('keeps the real model %s', (model) => {
    expect(maskOidShapedModel(model)).toBe(model);
  });

  it('passes null and empty through', () => {
    expect(maskOidShapedModel(null)).toBeNull();
    expect(maskOidShapedModel('')).toBeNull();
  });
});

describe('nicVendorFromMac', () => {
  it('returns the OUI vendor', () => {
    expect(nicVendorFromMac('00:20:00:11:22:33')).toMatch(/LEXMARK/i);
  });

  it('returns null for null, a malformed MAC and a sentinel', () => {
    expect(nicVendorFromMac(null)).toBeNull();
    expect(nicVendorFromMac('not-a-mac')).toBeNull();
    expect(nicVendorFromMac('')).toBeNull();
  });
});

import { resolveAssetIdentity } from './assetIdentity';

const XEROX_C325 = {
  sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
  sysDescr: 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1',
};

describe('resolveAssetIdentity — manufacturer (spec §9, F5)', () => {
  it('prefers the IANA enterprise arc over a mismatched NIC OUI (the Xerox C325 case)', () => {
    const result = resolveAssetIdentity({
      ...XEROX_C325,
      macVendor: 'LEXMARK INTERNATIONAL, INC.',
      current: { manufacturer: null, model: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1' },
    });
    expect(result.manufacturer).toBe('Xerox');
    expect(result.manufacturerSource).toBe('enterprise_oid');
  });

  it('falls back to the sysDescr rules when the PEN is unknown', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.20682.1',
      sysDescr: 'Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 12.2(55)SE12',
      macVendor: null,
    });
    expect(result.manufacturer).toBe('Cisco');
    expect(result.manufacturerSource).toBe('sysdescr');
  });

  it('ignores the net-snmp PEN so a pfSense box is not labelled "net-snmp"', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.8072.3.2.10',
      sysDescr: 'FreeBSD fw.example 14.0-RELEASE',
      macVendor: 'Netgate',
    });
    expect(result.manufacturer).toBe('Netgate');
    expect(result.manufacturerSource).toBe('mac_oui');
  });

  it('falls back to the agent value, then the OUI', () => {
    expect(resolveAssetIdentity({ current: { manufacturer: 'Acme' }, macVendor: 'Other' }))
      .toMatchObject({ manufacturer: 'Acme', manufacturerSource: 'scan' });
    expect(resolveAssetIdentity({ macVendor: 'Other' }))
      .toMatchObject({ manufacturer: 'Other', manufacturerSource: 'mac_oui' });
  });

  it('reproduces every classify.go sysDescr verdict', () => {
    const cases: Array<[string, string]> = [
      ['Cisco IOS Software', 'Cisco'],
      ['Hewlett-Packard J9727A', 'HP'],
      ['HP ETHERNET MULTI-ENVIRONMENT', 'HP'],
      ['Dell EMC Networking OS10', 'Dell'],
      ['Juniper Networks, Inc. ex2300', 'Juniper'],
      ['RouterOS RB750 MikroTik', 'MikroTik'],
      ['Synology DiskStation DS920+', 'Synology'],
      ['QNAP Systems TS-453', 'QNAP'],
      ['Ubiquiti UniFi Switch US-8-150W', 'Ubiquiti'],
      ['FortiGate-60F v7.2.5', 'Fortinet'],
    ];
    for (const [sysDescr, expected] of cases) {
      expect(resolveAssetIdentity({ sysDescr }).manufacturer, sysDescr).toBe(expected);
    }
  });

  it('does not read "Sharp" as "HP" the way classify.go does (deliberate fix)', () => {
    expect(resolveAssetIdentity({ sysDescr: 'Sharp MX-3071 Ver 01.01' }).manufacturer).toBe('Sharp');
  });
});

describe('resolveAssetIdentity — model extractors (spec §9)', () => {
  it('Xerox: the segment before the first semicolon', () => {
    const result = resolveAssetIdentity({ ...XEROX_C325, current: { model: XEROX_C325.sysObjectId } });
    expect(result.model).toBe('Xerox(R) C325 Color MFP');
    expect(result.modelSource).toBe('vendor_extractor');
  });

  it('Lexmark: cuts at " version" when there is no semicolon', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.641.1.1',
      sysDescr: 'Lexmark MX611de version NM.MN.N235 kernel 3.2.0 All-N-1',
    });
    expect(result).toMatchObject({ manufacturer: 'Lexmark', model: 'Lexmark MX611de' });
  });

  it('Brother: the MFC-/HL-/DCP- token', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.2435.2.3.9.1',
      sysDescr: 'Brother NC-8300w, Firmware Ver.1.32, MID 8CF-J20, MFC-L8900CDW',
    });
    expect(result).toMatchObject({ manufacturer: 'Brother', model: 'MFC-L8900CDW' });
  });

  it('HP printers: the LaserJet phrase up to the first comma', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.11.2.3.9.1',
      sysDescr: 'HP LaserJet MFP M428fdw, Serial Number: ABC123, Firmware 002.2226A',
    });
    expect(result).toMatchObject({ manufacturer: 'HP', model: 'HP LaserJet MFP M428fdw' });
  });

  it('HP JetDirect with no model phrase yields no model, never the OID', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.11.2.3.9.1',
      sysDescr: 'HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153,EEPROM V.36.23',
      current: { model: '1.3.6.1.4.1.11.2.3.9.1' },
    });
    expect(result.manufacturer).toBe('HP');
    expect(result.model).toBeNull();
  });

  it('Cisco: the platform token out of the IOS banner', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.9.1.516',
      sysDescr: 'Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 12.2(55)SE12',
    });
    expect(result).toMatchObject({ manufacturer: 'Cisco', model: 'C3750' });
  });

  it('falls back to prtGeneralPrinterName when the vendor has no extractor', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.1602.1',
      sysDescr: 'Canon iR-ADV',
      snmpData: { prtGeneralPrinterName: 'iR-ADV C5560' },
    });
    expect(result).toMatchObject({ manufacturer: 'Canon', model: 'iR-ADV C5560', modelSource: 'snmp_name' });
  });

  it('an unknown vendor with an OID-shaped scan model yields a NULL model, not the OID', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.99999.7.1',
      sysDescr: 'Unbranded embedded controller v1',
      macVendor: null,
      current: { manufacturer: null, model: '.1.3.6.1.4.1.99999.7.1' },
    });
    expect(result.manufacturer).toBeNull();
    expect(result.model).toBeNull();
  });

  it('keeps a plausible scan-authored model when nothing better exists', () => {
    const result = resolveAssetIdentity({ current: { manufacturer: 'Acme', model: 'WidgetBox 9000' } });
    expect(result).toMatchObject({ model: 'WidgetBox 9000', modelSource: 'scan' });
  });

  it('never returns a model longer than the column allows', () => {
    const result = resolveAssetIdentity({
      sysObjectId: '1.3.6.1.4.1.253.1',
      sysDescr: `${'X'.repeat(500)}; rest`,
    });
    expect((result.model ?? '').length).toBeLessThanOrEqual(120);
  });
});
