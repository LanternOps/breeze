import { describe, expect, it } from 'vitest';
import { OEM_LANES, type OemLane } from '@breeze/shared';
import { resolveApplicability } from './applicability';
import { SHIPPED_OEM_LANES } from './toolManifest';

const base = {
  osType: 'windows',
  isVirtual: false,
  deviceRole: 'workstation',
  manufacturer: 'Dell Inc.',
  model: 'Latitude 7420',
  enabledLanes: [...OEM_LANES] as OemLane[],
  shippedLanes: [...OEM_LANES] as OemLane[],
};

function laneOf(manufacturer: string | null, model: string | null = 'Some Model'): OemLane | null {
  const result = resolveApplicability({ ...base, manufacturer, model });
  return result.state === 'applicable' ? result.lane : null;
}

describe('resolveApplicability: manufacturer near-misses never authorize a flash', () => {
  it.each(['Dell Inc.', 'Dell Inc', 'Dell', 'DELL INC.', '  Dell Inc.  '])('%s is Dell', (m) => {
    expect(laneOf(m)).toBe('dell');
  });

  it.each(['HP', 'HP Inc.', 'Hewlett-Packard', 'hp'])('%s is HP', (m) => {
    expect(laneOf(m)).toBe('hp');
  });

  it.each(['LENOVO', 'Lenovo', 'lenovo'])('%s is Lenovo', (m) => {
    expect(laneOf(m)).toBe('lenovo');
  });

  it.each([
    'HPE',
    'Hewlett Packard Enterprise',
    'HP Enterprise',
    'CHP Systems',
    'SHP',
    'Dell EMC',
    'Dell Technologies Storage',
    'Delltron',
    'Not Dell Inc.',
    'Lenovo Group Compatible',
    'Microsoft',
    'ASUSTeK COMPUTER INC.',
    '',
    '   ',
  ])('%j is not a lane', (m) => {
    const result = resolveApplicability({ ...base, manufacturer: m });
    expect(result).toEqual({ state: 'not_applicable', reason: 'unknown_manufacturer' });
  });

  it('null is not a lane', () => {
    expect(resolveApplicability({ ...base, manufacturer: null })).toEqual({
      state: 'not_applicable',
      reason: 'unknown_manufacturer',
    });
  });

  it('Microsoft Corporation with a Surface model is Surface', () => {
    expect(laneOf('Microsoft Corporation', 'Surface Laptop 5')).toBe('surface');
    expect(laneOf('microsoft corporation', 'surface pro 9')).toBe('surface');
  });

  it.each(['Virtual Machine', 'Hyper-V', 'Surfacebook Clone', 'Not a Surface', '', null])(
    'Microsoft Corporation with model %j is not a lane',
    (model) => {
      expect(laneOf('Microsoft Corporation', model)).toBeNull();
    },
  );

  it('a Surface model from another manufacturer is not Surface', () => {
    expect(laneOf('Contoso Ltd', 'Surface Laptop 5')).toBeNull();
  });

  it('a virtual Microsoft guest with a Surface-looking model is not Surface', () => {
    expect(resolveApplicability({
      ...base,
      manufacturer: 'Microsoft Corporation',
      model: 'Surface Laptop 5',
      isVirtual: true,
    })).toEqual({ state: 'not_applicable', reason: 'virtual' });
  });
});

describe('resolveApplicability: device shape', () => {
  it('a Windows Dell workstation applies', () => {
    expect(resolveApplicability(base)).toEqual({ state: 'applicable', lane: 'dell' });
  });

  it.each([
    [{ osType: 'linux' }, 'not_windows'],
    [{ osType: 'macos' }, 'not_windows'],
    [{ isVirtual: true }, 'virtual'],
    [{ deviceRole: 'server' }, 'server'],
    [{ enabledLanes: [] }, 'vendor_disabled'],
    [{ shippedLanes: ['hp'] as OemLane[] }, 'lane_not_shipped'],
  ])('%j is not applicable: %s', (overrides, reason) => {
    expect(resolveApplicability({ ...base, ...overrides })).toEqual({ state: 'not_applicable', reason });
  });

  it('the real shipped list reaches Surface and HP and still stops the lanes not built', () => {
    const real = { ...base, shippedLanes: SHIPPED_OEM_LANES };
    expect(resolveApplicability({ ...real, manufacturer: 'Microsoft Corporation', model: 'Surface Laptop 5' })).toEqual({
      state: 'applicable',
      lane: 'surface',
    });
    expect(resolveApplicability({ ...real, manufacturer: 'HP Inc.', model: 'EliteBook' })).toEqual({
      state: 'applicable',
      lane: 'hp',
    });
    expect(resolveApplicability({ ...real, manufacturer: 'LENOVO', model: 'ThinkPad' })).toEqual({
      state: 'not_applicable',
      reason: 'lane_not_shipped',
    });
  });

  it.each(['HPE', 'Hewlett Packard Enterprise'])('shipping the HP lane does not reach %s', (manufacturer) => {
    expect(resolveApplicability({ ...base, shippedLanes: SHIPPED_OEM_LANES, manufacturer, model: 'ProLiant' })).toEqual({
      state: 'not_applicable',
      reason: 'unknown_manufacturer',
    });
  });

  it('a lane enabled elsewhere does not enable this one', () => {
    expect(resolveApplicability({ ...base, enabledLanes: ['hp'] })).toEqual({
      state: 'not_applicable',
      reason: 'vendor_disabled',
    });
  });
});
