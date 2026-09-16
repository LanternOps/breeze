import type { Collection, CollectionOid } from '../types';
import { PRINTER_OIDS } from './printerMib';

const AT = '2026-09-16T10:00:00.000Z';

export function walkOid(baseOid: string, name: string, rows: Array<[string, string | null]>): CollectionOid {
  return {
    baseOid,
    name,
    mode: 'walk',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    error: null,
    instances: rows.map(([instance, value]) => ({
      oid: `${baseOid}.${instance}`,
      instance,
      value,
      valueType: 'integer',
      observedAt: AT,
    })),
  };
}

// Xerox C325 Color MFP (spec §1 F5, §7.2): four supplies, CMYK, the cyan
// cartridge at 37 %, one supply reporting a negative (unknown) level.
export const xeroxCollection: Collection = {
  templateId: 'tpl-xerox',
  lastPolledAt: AT,
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    walkOid(PRINTER_OIDS.suppliesDescription, 'prtMarkerSuppliesDescription', [
      ['1.1', 'Cyan Toner Cartridge'],
      ['1.2', 'Magenta Toner Cartridge'],
      ['1.3', 'Yellow Toner Cartridge'],
      ['1.4', 'Black Toner Cartridge'],
      ['1.5', 'Waste Toner Container'],
    ]),
    walkOid(PRINTER_OIDS.suppliesMaxCapacity, 'prtMarkerSuppliesMaxCapacity', [
      ['1.1', '100'], ['1.2', '100'], ['1.3', '100'], ['1.4', '100'], ['1.5', '-2'],
    ]),
    walkOid(PRINTER_OIDS.suppliesLevel, 'prtMarkerSuppliesLevel', [
      ['1.1', '37'], ['1.2', '82'], ['1.3', '91'], ['1.4', '64'], ['1.5', '-3'],
    ]),
    walkOid(PRINTER_OIDS.colorantValue, 'prtMarkerColorantValue', [
      ['1.1', 'cyan'], ['1.2', 'magenta'], ['1.3', 'yellow'], ['1.4', 'black'],
    ]),
    walkOid(PRINTER_OIDS.lifeCount, 'prtMarkerLifeCount', [['1.1', '184230']]),
    walkOid(PRINTER_OIDS.printerStatus, 'hrPrinterStatus', [['1', '3']]),
    walkOid(PRINTER_OIDS.deviceStatus, 'hrDeviceStatus', [['1', '3']]),
    walkOid(PRINTER_OIDS.detectedErrorState, 'hrPrinterDetectedErrorState', [['1', '0x0020']]),
  ],
};

