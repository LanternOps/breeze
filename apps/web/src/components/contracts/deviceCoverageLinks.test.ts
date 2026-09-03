import { afterEach, describe, expect, it, vi } from 'vitest';
import { devicesUrlForRole } from './deviceCoverageLinks';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readOrgIdFromHash } from '../devices/orgHash';
import { DEVICE_ROLES } from '@/lib/deviceRoles';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

afterEach(() => { vi.unstubAllGlobals(); });

describe('devicesUrlForRole (#3205 W06)', () => {
  it('round-trips EVERY device role through the devices list own decoder', () => {
    for (const role of DEVICE_ROLES) {
      const url = devicesUrlForRole(role, ORG)!;
      expect(url.startsWith(`/devices#orgId=${ORG}&filtersV2=`)).toBe(true);
      const hash = url.slice(url.indexOf('#'));
      expect(decodeFilterFromHash(hash)).toEqual({
        operator: 'AND',
        conditions: [{ field: 'deviceRole', operator: 'equals', value: role }],
      });
      expect(readOrgIdFromHash(hash)).toBe(ORG);
    }
  });

  it("includes 'unknown', the bucket the notice most often shows", () => {
    const hash = devicesUrlForRole('unknown', ORG)!.slice(devicesUrlForRole('unknown', ORG)!.indexOf('#'));
    expect(decodeFilterFromHash(hash)!.conditions[0]).toMatchObject({ field: 'deviceRole', value: 'unknown' });
  });

  it('without an org there is no orgId fragment, and the filter half still decodes', () => {
    const url = devicesUrlForRole('server', null)!;
    expect(url).toBe('/devices#filtersV2=' + url.split('filtersV2=')[1]);
    expect(url).not.toContain('orgId=');
    expect(decodeFilterFromHash(url.slice(url.indexOf('#')))).toMatchObject({ operator: 'AND' });
  });

  it('a role the filter engine does not know returns null, never a dead link', () => {
    expect(devicesUrlForRole('toaster', ORG)).toBeNull();
    expect(devicesUrlForRole('', ORG)).toBeNull();
  });

  it('produces byte-identical output with no window (the isomorphic-encoder guarantee)', () => {
    const withWindow = devicesUrlForRole('server', ORG);
    vi.stubGlobal('window', undefined);
    expect(devicesUrlForRole('server', ORG)).toBe(withWindow);
  });
});
